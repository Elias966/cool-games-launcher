// Inference utility process: owns the bundled llama-server (GUI-Owl / Qwen3-VL) and the
// ONNX NSFW image classifier. Runs one LLM task at a time; every task can be
// cancelled, which disconnects from llama-server and stops generation.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { emit, log, serve, throwIfAborted } from './rpc';
import { createClassifier, type Classifier, type Region } from './classifier';
import type { ModelPin } from '@shared/models';
import {faraMessages,parseFaraCall} from '@shared/fara-chat';
import {recordAllocation, type ModelRuntime} from './inference-runtime';
import { imageWouldBeStale, promptPieces } from './prompt-cache';
import { createCoverScorer, type CoverScorer } from './cover-score';

process.title = 'cgl-inference';

interface InitParams {
  llamaDir: string; // contains cpu/ and vulkan/
  modelPath: string;
  mmprojPath: string;
  thinking?: boolean;
  family?: ModelPin['family'];
  defaultModelId?: string;
  models?: Record<string, {modelPath:string;mmprojPath:string;thinking:boolean;family?:ModelPin['family']}>;
  classifierPath: string;
  runtimeDir: string;
  threads: number;
  contextSize: number;
  accel: 'auto' | 'vulkan' | 'cpu';
  imageTokens: number;
  classifierThreads: number;
  idleUnloadMinutes: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  tool_calls?: unknown[];
  tool_call_id?: string;
  reasoning_content?: string;
}

interface ChatParams {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  priority?: number;
  modelId?: string;
  tools?: unknown[];
  toolChoice?: unknown;
  toolName?: string;
  think?: boolean;
}

let config: InitParams | null = null;
let server: ChildProcess | null = null;
let socketPath: string | null = null;
let apiKey = randomBytes(24).toString('hex');
let serverReady: Promise<void> | null = null;
let activeAccel: 'cpu' | 'vulkan' | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let vulkanProbe: boolean | null = null;
let vulkanDevice: string | null = null;
let loadedModelId: string | null = null;
let modelRuntime: ModelRuntime | null = null;
let modelStarts = 0;

function status(phase: string, detail: string | null = null) {
  emit('status', { phase, detail, modelLoaded: !!server && serverReady !== null, accel: activeAccel });
}

function hasVulkanDevice(llamaDir: string): boolean {
  if (vulkanProbe !== null) return vulkanProbe;
  const bin = join(llamaDir, 'vulkan', 'llama-server');
  if (!existsSync(bin)) return (vulkanProbe = false);
  try {
    const r = spawnSync(bin, ['--list-devices'], {
      env: { ...process.env, LD_LIBRARY_PATH: `${join(llamaDir, 'vulkan')}:${join(llamaDir, 'runtime/usr/lib/x86_64-linux-gnu')}` },
      timeout: 15000,
      encoding: 'utf8',
    });
    const out = `${r.stdout}\n${r.stderr}`;
    const devices=out.split('\n').filter(line=>/Vulkan\d+/.test(line)&&!/llvmpipe/i.test(line));
    const preferred=devices.find(line=>/NVIDIA|Radeon RX|AMD Radeon Pro|Arc\(TM\)/i.test(line))??devices[0];
    vulkanDevice=preferred?.match(/Vulkan\d+/)?.[0]??null;
    vulkanProbe = r.status === 0 && /Vulkan\d+/.test(out) && !/llvmpipe/i.test(out.split(/Vulkan\d+/)[1] ?? '');
  } catch {
    vulkanProbe = false;
  }
  return vulkanProbe;
}

function chooseAccel(c: InitParams): 'cpu' | 'vulkan' {
  if (c.accel === 'cpu') return 'cpu';
  return hasVulkanDevice(c.llamaDir) ? 'vulkan' : 'cpu';
}

function stopServer() {
  if (server) {
    server.removeAllListeners('exit');
    server.kill('SIGTERM');
    const s = server;
    setTimeout(() => s.exitCode === null && s.kill('SIGKILL'), 3000).unref();
  }
  server = null;
  serverReady = null;
  activeAccel = null;
  modelRuntime = null;
  if (socketPath) rmSync(socketPath, { force: true });
  status('idle');
}

function scheduleIdleUnload() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!config || config.idleUnloadMinutes <= 0) return;
  idleTimer = setTimeout(() => {
    if (queue.length === 0 && !running) {
      log('unloading model after idle timeout');
      stopServer();
    }
  }, config.idleUnloadMinutes * 60_000);
  idleTimer.unref();
}

function httpJson(method: string, path: string, body: unknown, signal?: AbortSignal, timeoutMs = 0): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!socketPath) return reject(new Error('Model server not running'));
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`llama-server ${res.statusCode}: ${text.slice(0, 300)}`));
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch (e) {
            reject(e);
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', (e) => reject(signal?.aborted ? Object.assign(new Error('Cancelled'), { code: 'cancelled' }) : e));
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        return reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' }));
      }
      // Closing the connection makes llama-server cancel the slot.
      signal.addEventListener('abort', () => req.destroy(), { once: true });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureServer(signal: AbortSignal): Promise<void> {
  if (!config) throw new Error('Inference worker not initialised');
  if (serverReady) return serverReady;
  const c = config;
  let startingChild: ChildProcess | null = null;
  serverReady = (async () => {
    const accel = chooseAccel(c);
    const dir = join(c.llamaDir, accel);
    const bin = join(dir, 'llama-server');
    if (!existsSync(bin)) throw new Error(`llama-server missing at ${bin}`);
    if (!existsSync(c.modelPath)) throw new Error('Download a local vision model in Settings → Local AI before opening Store');
    mkdirSync(c.runtimeDir, { recursive: true, mode: 0o700 });
    socketPath = join(c.runtimeDir, `llama-${process.pid}.sock`);
    rmSync(socketPath, { force: true });
    apiKey = randomBytes(24).toString('hex');
    const args = [
      '-m', c.modelPath,
      '--mmproj', c.mmprojPath,
      '-c', String(c.contextSize),
      '-t', String(c.threads),
      '-np', '1',
      '--host', socketPath,
      '--api-key', apiKey,
      '--no-webui',
      // This bundled runtime prints layer/buffer placement at verbosity 4.
      // Only allocation evidence is forwarded; prompts and raw logs are not.
      '--log-verbosity', '4',
      // Preserve Fara's trained 1440x900 screen detail; downsampling small links
      // to the legacy 768-token budget made distinct controls indistinguishable.
      '--image-max-tokens', String(c.family==='fara'?Math.max(1536,c.imageTokens):c.imageTokens),
      '--jinja',
    ];
    if (c.thinking && !c.family) {
      // GUI-Owl's exported tokenizer uses an Instruct generation prefix.
      // Its Qwen3-VL base Thinking template restores the native <think> channel
      // so JSON grammar constrains the final decision after reasoning.
      const template = JSON.parse(readFileSync(join(c.llamaDir,'../templates/qwen3-vl-thinking.json'),'utf8')).chat_template;
      const templatePath = join(c.runtimeDir,'thinking.jinja');
      writeFileSync(templatePath,template,{mode:0o600});
      args.push('--chat-template-file',templatePath,'--reasoning','on','--reasoning-format','deepseek','--reasoning-budget','1024');
    }
    if(c.family) args.push('--reasoning','on','--reasoning-format','deepseek','--reasoning-budget','1024');
    if (accel === 'vulkan') {
      args.push('-ngl', 'auto');
      if(vulkanDevice)args.push('--device',vulkanDevice);
    }
    else args.push('-ngl', '0');
    status('loading', accel === 'vulkan' ? 'Loading model (Vulkan)' : 'Loading model (CPU)');
    log('starting llama-server', accel);
    const child = spawn(bin, args, {
      env: { ...process.env, LD_LIBRARY_PATH: `${dir}:${join(c.llamaDir, 'runtime/usr/lib/x86_64-linux-gnu')}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server = child;
    startingChild = child;
    activeAccel = accel;
    const startedAt=Date.now();modelStarts++;
    const runtime:ModelRuntime={modelId:loadedModelId,device:accel==='vulkan'?vulkanDevice:null,gpuLayers:null,totalLayers:null,loadMs:null,allocations:[]};
    modelRuntime=runtime;
    let stderrTail = '';
    const captureAllocation = () => {
      let pending='';
      return (d:Buffer) => {
        const lines=(pending+d.toString()).split('\n');pending=lines.pop()!.slice(-4000);
        for(const line of lines)recordAllocation(runtime,line);
      };
    };
    child.stdout!.on('data',captureAllocation());
    child.stderr!.on('data',captureAllocation());
    child.stderr!.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    child.on('exit', (code) => {
      if(server!==child)return;
      log('llama-server exited', code);
      server = null;
      serverReady = null;
      activeAccel = null;
      modelRuntime = null;
      status('idle', code ? `Model server stopped (code ${code})` : null);
    });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (child.exitCode !== null || child.signalCode !== null) {
        if (accel === 'vulkan') {
          // Fall back to CPU when the Vulkan build cannot start on this system.
          vulkanProbe = false;
          serverReady = null;
          return ensureServer(signal);
        }
        throw new Error(`Model server failed to start: ${stderrTail.split('\n').slice(-4).join(' ')}`);
      }
      try {
        const h = await httpJson('GET', '/health', undefined, undefined, 2000);
        if (h?.status === 'ok') {
          runtime.loadMs=Date.now()-startedAt;
          log('model allocation',JSON.stringify(runtime));
          status('idle');
          return;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Model server did not become ready in time');
  })();
  serverReady.catch(() => {
    if (startingChild && server === startingChild) stopServer();
    else serverReady = null;
  });
  return serverReady;
}

// --- single-task LLM queue -------------------------------------------------

interface QueueItem {
  priority: number;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  signal: AbortSignal;
}

const queue: QueueItem[] = [];
const warmed = new Set<string>();
let running = false;

function enqueue<T>(priority: number, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const item: QueueItem = { priority, run, resolve: resolve as (v: unknown) => void, reject, signal };
    signal.addEventListener(
      'abort',
      () => {
        const i = queue.indexOf(item);
        if (i >= 0) {
          queue.splice(i, 1);
          reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' }));
        }
      },
      { once: true },
    );
    queue.push(item);
    queue.sort((a, b) => b.priority - a.priority);
    void pump();
  });
}

async function pump() {
  if (running) return;
  const item = queue.shift();
  if (!item) {
    scheduleIdleUnload();
    return;
  }
  running = true;
  try {
    item.resolve(await item.run());
  } catch (e) {
    item.reject(e);
  } finally {
    running = false;
    void pump();
  }
}

async function stopAndWait() {
  const child=server;
  cachedPrompt = null;
  stopServer();
  if(child&&child.exitCode===null&&child.signalCode===null)await new Promise<void>(resolve=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3500);
    child.once('exit',()=>{clearTimeout(timer);resolve();});
  });
}

async function selectModel(id:string|undefined,signal:AbortSignal) {
  if(!config)throw Error('Inference worker not initialised');
  const modelId=id??config.defaultModelId;
  if(!config.models)return;
  const target=modelId?config.models[modelId]:undefined;
  if(!target)throw Error('Unknown agent model');
  if(!existsSync(target.modelPath)||!existsSync(target.mmprojPath))throw Error('Download the assigned agent and vision component in Settings → Local AI.');
  if(loadedModelId!==modelId){
    await stopAndWait();throwIfAborted(signal);
    config={...config,...target};loadedModelId=modelId!;
    log('agent model selected',modelId);
  }
}

/** The prompt the server has cached (one slot): to avoid reusing an image from it by mistake. */
let cachedPrompt: string[] | null = null;

async function chat(p: ChatParams, signal: AbortSignal) {
  return enqueue(p.priority ?? 0, signal, async () => {
    throwIfAborted(signal);
    await selectModel(p.modelId,signal);
    await ensureServer(signal);
    throwIfAborted(signal);
    status('thinking');
    // Extraction-style answers (site learning, page checks) skip hidden
    // reasoning: same model, a fraction of the latency.
    const thinking = !!config?.thinking && p.think !== false;
    const body: Record<string, unknown> = {
      messages: p.messages,
      max_tokens: (p.maxTokens ?? 512) + (thinking ? 1024 : 0),
      temperature: p.temperature ?? (thinking ? 0.6 : 0.1),
      cache_prompt: true,
    };
    if (p.think === false) body.chat_template_kwargs = { enable_thinking: false };
    const toolName=p.toolName??'launcher_decision';
    const nativeFara=config?.family==='fara'&&!!p.tools;
    if(nativeFara){
      body.messages=faraMessages(p.messages,p.tools!);
    }else if(p.tools){
      body.tools=p.tools;body.tool_choice=p.toolChoice??'required';body.parallel_tool_calls=false;
    } else if (p.jsonSchema && thinking) {
      body.tools=[{type:'function',function:{name:toolName,description:'Return exactly one decision for the current launcher task, using only observed tool arguments.',parameters:p.jsonSchema}}];
      body.tool_choice={type:'function',function:{name:toolName}};
      body.parallel_tool_calls=false;
    } else if (p.jsonSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', schema: p.jsonSchema, strict: true } };
    // Never let the prompt cache answer about the previous image.
    const pieces = [`F:${JSON.stringify(body.tools ?? null)}`, ...promptPieces(body.messages as never)];
    if (imageWouldBeStale(cachedPrompt, pieces)) body.cache_prompt = false;
    cachedPrompt = pieces;
    try {
      const sent = Date.now();
      log('chat request', { model: loadedModelId, messages: p.messages.length, thinking, schema: !!p.jsonSchema, tools: p.tools?.length ?? 0, cache: body.cache_prompt });
      const res = await httpJson('POST', '/v1/chat/completions', body, signal);
      const t = res?.timings;
      // Prompt/generation token counts and speeds, never prompt text.
      log('chat done', { ms: Date.now() - sent, promptTokens: t?.prompt_n, promptMs: Math.round(t?.prompt_ms ?? 0), genTokens: t?.predicted_n, genMs: Math.round(t?.predicted_ms ?? 0) });
      const choice = res?.choices?.[0];
      if (thinking) log('thinking decision', {reasoningCharacters:choice?.message?.reasoning_content?.length??0,finish:choice?.finish_reason});
      if (choice?.finish_reason === 'length') throw new Error('Local model response exceeded its token budget; no browser action was taken');
      if(nativeFara){
        const call=parseFaraCall(choice?.message?.content??'',p.tools!.map((tool:any)=>tool.function.name));
        return {message:{role:'assistant',content:choice?.message?.content??'',reasoning_content:choice?.message?.reasoning_content,tool_calls:[{id:'fara_'+randomBytes(8).toString('hex'),type:'function',function:call}]},modelId:loadedModelId,timings:res?.timings??null};
      }
      const calls=choice?.message?.tool_calls;
      if(p.tools){
        if(!Array.isArray(calls)||calls.length!==1||!p.tools.some((tool:any)=>tool.function?.name===calls[0].function?.name))throw Error('Agent returned no single supported tool call; no action was taken.');
        return {message:choice.message,modelId:loadedModelId,timings:res?.timings??null};
      }
      if(thinking&&p.jsonSchema&&(!Array.isArray(calls)||calls.length!==1||calls[0].function?.name!==toolName))throw new Error('Local model returned no valid tool decision; no browser action was taken');
      const args=thinking&&p.jsonSchema?calls[0].function.arguments:null;
      const content: string = args!==null?(typeof args==='string'?args:JSON.stringify(args)):(choice?.message?.content??'');
      if (!content.trim()) throw new Error('Local model returned no completed decision; no browser action was taken');
      return { content, timings: res?.timings ?? null };
    } finally {
      status('idle');
    }
  });
}

// --- NSFW classifier -------------------------------------------------------

let classifier: Promise<Classifier> | null = null;

function getClassifier(): Promise<Classifier> {
  if (!config) throw new Error('Inference worker not initialised');
  classifier ??= createClassifier(config.classifierPath, config.classifierThreads, log);
  classifier.catch(() => (classifier = null));
  return classifier;
}

interface ClassifyParams {
  path?: string;
  base64?: string;
  /** Pixel regions to classify individually; the whole image when omitted. */
  regions?: Region[];
  includeWhole?: boolean;
}

let vips: Promise<any> | null = null;

// --- Cover filter (CLIP) -----------------------------------------------------
let coverScorer: { path: string; scorer: Promise<CoverScorer> } | null = null;
async function coverScore(p: { modelPath: string; imagePath: string }, signal: AbortSignal): Promise<{ score: number }> {
  if (coverScorer?.path !== p.modelPath) {
    vips ??= (require('wasm-vips') as (o: object) => Promise<any>)({ dynamicLibraries: [] }).then((v) => { v.concurrency(1); return v; });
    const scorer = vips.then((v) => createCoverScorer(p.modelPath, v, log));
    scorer.catch(() => { if (coverScorer?.scorer === scorer) coverScorer = null; });
    coverScorer = { path: p.modelPath, scorer };
  }
  const scorer = await coverScorer.scorer;
  throwIfAborted(signal);
  return { score: await scorer.score(p.imagePath, signal) };
}

async function classify(p: ClassifyParams, signal: AbortSignal): Promise<{ scores: number[] }> {
  const c = await getClassifier();
  throwIfAborted(signal);
  const t = Date.now();
  const buf = p.base64 ? Buffer.from(p.base64, 'base64') : readFileSync(p.path!);
  const scores = await c.score(buf, p.regions, p.includeWhole, signal);
  if (process.env.CGL_DEBUG) log('classified', { ms: Date.now() - t, regions: scores.length });
  return { scores };
}

serve({
  init(p: InitParams) {
    const prev = config;
    config = p;
    loadedModelId=null;
    const restart =
      prev &&
      (prev.modelPath !== p.modelPath || prev.mmprojPath !== p.mmprojPath || prev.thinking !== p.thinking || prev.threads !== p.threads || prev.contextSize !== p.contextSize || prev.accel !== p.accel || prev.imageTokens !== p.imageTokens || JSON.stringify(prev.models)!==JSON.stringify(p.models));
    if (restart && server) stopServer();
    if (prev && prev.classifierThreads !== p.classifierThreads) classifier = null;
    scheduleIdleUnload();
    return { ok: true };
  },
  async warmup(p: {modelId?:string} | undefined, signal: AbortSignal) {
    return enqueue(0,signal,async()=>{
      if(p?.modelId)await selectModel(p.modelId,signal);
      await ensureServer(signal);
      // One tiny generation compiles the GPU shader pipelines now (tens of
      // seconds on a cold driver cache) instead of during the first real task.
      if(!warmed.has(loadedModelId??'')){
        const t=Date.now();
        await httpJson('POST','/v1/chat/completions',{messages:[{role:'user',content:'Reply with OK.'}],max_tokens:2,chat_template_kwargs:{enable_thinking:false},cache_prompt:false},signal).catch(()=>undefined);
        cachedPrompt = null;
        warmed.add(loadedModelId??'');
        log('warmed up',{ms:Date.now()-t});
      }
      return { accel: activeAccel, runtime:modelRuntime };
    });
  },
  chat,
  classify,
  coverScore,
  async unload() {
    await stopAndWait();loadedModelId=null;
    // The image classifier's GPU memory goes too; it loads again on its next use.
    const c = classifier;
    classifier = null;
    if (c) await c.then((x) => x.release()).catch(() => undefined);
    const cs = coverScorer;
    coverScorer = null;
    if (cs) await cs.scorer.then((x) => x.release()).catch(() => undefined);
    return { ok: true };
  },
  status() {
    return { modelLoaded: !!server, modelId:loadedModelId, accel: activeAccel, device:activeAccel==='vulkan'?vulkanDevice:null, queued: queue.length, running, runtime:modelRuntime, modelStarts };
  },
});

process.on('exit', () => {
  if (server) server.kill('SIGKILL');
  if (socketPath) rmSync(socketPath, { force: true });
});
