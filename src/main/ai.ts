// AI facade over the inference worker. Every LLM call is bound to a Store
// session token: it is refused when the Store is not active, cancelled when
// the user leaves, and its result is discarded if it arrives afterwards.
import { createHash } from 'node:crypto';
import type { WorkerHost } from './worker-host';
import type { StoreSession, SessionToken } from './store-session';
import type { AiCacheRepo } from './repos';
import type { AiStatus } from '@shared/types';
import { publish } from './bus';
import { isCancelled } from '@shared/worker-protocol';
import {AGENT_LABELS, MODEL_CATALOG, type AgentRole, type ModelPin} from '@shared/models';

export type ChatContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
export interface ToolCall { id:string;type:'function';function:{name:string;arguments:string} }
export interface AgentMessage {role:'system'|'user'|'assistant'|'tool';content:ChatContent;tool_calls?:ToolCall[];tool_call_id?:string;reasoning_content?:string}
export interface AgentTool {type:'function';function:{name:string;description:string;parameters:Record<string,unknown>}}

export interface ChatRequest {
  system: string;
  user: ChatContent;
  schema: Record<string, unknown>;
  maxTokens?: number;
  priority?: number;
  cacheKey?: string;
  agent?: AgentRole;
  toolName?: string;
  /** false skips the model's hidden reasoning: much faster for extraction-style answers. */
  think?: boolean;
}

// fp16 matches the fp32 reference (max |Δ| 0.002); the old int8 build flipped
// 10% of verdicts in testing, so its cached results are re-checked.
export const CLASSIFIER_VERSION = 'vit-base-nsfw-detector@8587de9/fp16';

export class AiService {
  private status: AiStatus = { phase: 'idle', detail: null, context: null, storeActive: false, modelLoaded: false, accel: null };

  constructor(
    private worker: WorkerHost,
    private session: StoreSession,
    private cache: AiCacheRepo,
    private agents?: () => Record<AgentRole,string>,
  ) {
    worker.on('event:status', (s: { phase: AiStatus['phase']; detail: string | null; modelLoaded: boolean; accel: AiStatus['accel'] }) => {
      // The inference worker becoming idle does not finish the browser task.
      // Preserve its context/ownership while a decision is being applied or
      // a human prompt is pending (the drawer uses this to lock AI input).
      // Model loading is the worker's own phase: its end must clear it, or the
      // badge stays on "Loading model" although the model is ready.
      if (s.phase === 'idle' && session.active && this.status.phase !== 'idle' && this.status.phase !== 'loading') {
        this.setStatus({ modelLoaded: s.modelLoaded, accel: s.accel });
        return;
      }
      if (this.gaming) { this.setStatus({ modelLoaded: s.modelLoaded, accel: s.accel }); return; }
      this.setStatus({ phase: s.phase, detail: s.detail, modelLoaded: s.modelLoaded, accel: s.accel });
    });
    session.on('enter', () => this.setStatus({ storeActive: true }));
    session.on('leave', () => this.setStatus({ storeActive: false, phase: 'idle', detail: null, context: null }));
  }

  setStatus(patch: Partial<AiStatus>) {
    this.status = { ...this.status, ...patch };
    if (this.status.phase === 'idle') this.status.context = null;
    publish('ai:status', this.status);
  }

  getStatus(): AiStatus {
    return this.status;
  }

  get specialists() { return !!this.agents; }

  private gaming: { done: Promise<void>; release: () => void } | null = null;

  /**
   * While a game runs the model is unloaded and every AI request waits for the
   * game to close, so the game has the whole GPU (the model needs ~6 GB).
   */
  async pauseForGame(playing: boolean) {
    if (playing && !this.gaming) {
      let release!: () => void;
      const done = new Promise<void>((r) => { release = r; });
      this.gaming = { done, release };
      this.setStatus({ phase: 'paused', detail: 'A game is running — the AI waits so the game has the whole GPU', context: null });
      await this.unload();
    } else if (!playing && this.gaming) {
      const g = this.gaming;
      this.gaming = null;
      this.setStatus({ phase: 'idle', detail: null });
      g.release();
    }
  }

  get paused() { return this.gaming !== null; }

  /** Holds a request until no game is running (or the request is cancelled). */
  private async waitForGame(signal?: AbortSignal) {
    while (this.gaming) {
      const g = this.gaming;
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' }));
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        void g.done.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
      });
    }
  }

  /** Catalog pin of the model assigned to a role (prompt formats differ per model). */
  modelFor(role: AgentRole): ModelPin | undefined {
    const id = this.agents?.()[role];
    return MODEL_CATALOG.find((m) => m.id === id);
  }

  async chatTools(token:SessionToken,role:AgentRole,messages:AgentMessage[],tools:AgentTool[],maxTokens=1800,temperature=0):Promise<{message:AgentMessage;modelId:string}> {
    await this.waitForGame(token.signal);
    this.session.assertLive(token,'agent tool request');
    const modelId=this.agents?.()[role];
    if(!modelId)throw Error('No local model is assigned to this agent');
    this.setStatus({phase:'thinking',detail:AGENT_LABELS[role]});
    const response=await this.worker.call<{message:AgentMessage;modelId:string}>('chat',{modelId,messages,tools,temperature,maxTokens,priority:role==='browsing'?10:5},token.signal);
    this.session.assertLive(token,'agent tool response');
    return response;
  }

  /** Runs a JSON-constrained chat for the live Store session. */
  async chatJson<T>(token: SessionToken, req: ChatRequest): Promise<T> {
    await this.waitForGame(token.signal);
    this.session.assertLive(token, 'AI request');
    const modelId=this.agents?.()[req.agent??'analysis'];
    const key=req.cacheKey?cacheKey(modelId,req.cacheKey):undefined;
    if (key) {
      const hit = this.cache.get<T>(key);
      if (hit) return hit;
    }
    let res: { content: string };
    try {
      res = await this.worker.call<{ content: string }>(
        'chat',
        {
          modelId,
          toolName:req.toolName,
          think:req.think,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          maxTokens: req.maxTokens ?? 400,
          temperature: 0.1,
          jsonSchema: req.schema,
          priority: req.priority ?? 0,
        },
        token.signal,
      );
    } catch (e) {
      if (isCancelled(e)) this.session.assertLive(token, 'AI response');
      throw e;
    }
    // A response that raced with leaving the Store is dropped here.
    this.session.assertLive(token, 'AI response');
    const parsed = parseJsonLoose<T>(res.content);
    if (key) this.cache.set(key, parsed);
    return parsed;
  }

  /** NSFW probabilities for an image file or base64 data; one score per region (or the whole image). */
  async classify(input: { path?: string; base64?: string; regions?: Array<{ x: number; y: number; w: number; h: number }>; includeWhole?: boolean }, signal?: AbortSignal): Promise<number[]> {
    await this.waitForGame(signal);
    const r = await this.worker.call<{ scores: number[] }>('classify', input, signal);
    return r.scores;
  }

  async unload() {
    await this.worker.call('unload').catch(() => undefined);
  }
}

export function cacheKey(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function parseJsonLoose<T>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(t) as T;
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1)) as T;
    throw new Error('The AI returned an unreadable answer');
  }
}
