// The image model behind the cover filter: CLIP ViT-B/32's image encoder
// (OpenAI, MIT licence; ONNX fp16 conversion by Xenova). Downloaded once, from a
// pinned Hugging Face revision, and checked against its SHA-256 before use.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tm } from './i18n';

export const COVER_MODEL = {
  url: 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/onnx/vision_model_fp16.onnx',
  sha256: '35c4e0fb0aeee527dcde1693520b214a34424a786babd530f35366bad5844efd',
  size: 176080659,
  dir: 'clip-vit-b32',
  file: 'vision_model_fp16.onnx',
};

export interface CoverModelStatus {
  state: 'missing' | 'downloading' | 'ready' | 'error';
  received: number;
  size: number;
  error: string | null;
}

export class CoverModel {
  private state: CoverModelStatus;
  private running: Promise<void> | null = null;

  constructor(private deps: { modelsDir: string; fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>; changed?: () => void; pin?: typeof COVER_MODEL }) {
    this.state = { state: this.ready() ? 'ready' : 'missing', received: 0, size: this.pin.size, error: null };
  }

  private get pin() {
    return this.deps.pin ?? COVER_MODEL;
  }

  /** Where the model file lives once installed. */
  get path(): string {
    return join(this.deps.modelsDir, this.pin.dir, this.pin.file);
  }

  private get marker() {
    return `${this.path}.verified`;
  }

  /** Installed and verified (the marker records the hash, so it is not re-hashed at every start). */
  ready(): boolean {
    try {
      return statSync(this.path).size === this.pin.size && readFileSync(this.marker, 'utf8').trim() === this.pin.sha256;
    } catch {
      return false;
    }
  }

  status(): CoverModelStatus {
    return { ...this.state };
  }

  private set(patch: Partial<CoverModelStatus>) {
    this.state = { ...this.state, ...patch };
    this.deps.changed?.();
  }

  /** Downloads and verifies the model unless it is already installed. */
  ensure(): Promise<void> {
    if (this.ready()) { if (this.state.state !== 'ready') this.set({ state: 'ready', error: null }); return Promise.resolve(); }
    this.running ??= this.download().finally(() => { this.running = null; });
    return this.running;
  }

  private async download() {
    const dir = join(this.deps.modelsDir, this.pin.dir);
    const part = `${this.path}.part`;
    mkdirSync(dir, { recursive: true });
    this.set({ state: 'downloading', received: 0, error: null });
    try {
      const res = await this.deps.fetch(this.pin.url);
      if (!res.ok || !res.body) throw new Error(tm('The download failed (HTTP {code}).', { code: res.status }));
      const hash = createHash('sha256');
      const out = createWriteStream(part);
      let received = 0, last = 0;
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          received += value.length;
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
          if (Date.now() - last > 400) { last = Date.now(); this.set({ received }); }
        }
      } finally {
        await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
      }
      if (received !== this.pin.size || hash.digest('hex') !== this.pin.sha256) throw new Error(tm('The downloaded cover model does not match its checksum. It will be downloaded again.'));
      renameSync(part, this.path);
      writeFileSync(this.marker, this.pin.sha256);
      this.set({ state: 'ready', received, error: null });
    } catch (e) {
      rmSync(part, { force: true });
      this.set({ state: 'error', error: (e as Error).message });
      throw e;
    }
  }

  /** Whether a model file is present at all (for diagnostics). */
  exists(): boolean {
    return existsSync(this.path);
  }
}
