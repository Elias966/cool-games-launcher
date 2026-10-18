// CLIP cover checks run independently of website/browser verification. Keep
// several images in flight so a slow host cannot hold up every other cover.
import { existsSync } from 'node:fs';
import type { AiService } from './ai';
import type { ArtworkCache } from './classification';
import type { CatalogRaw, CatalogRepo, SettingsRepo } from './repos';
import type { CoverModel } from './cover-model';

const CONCURRENCY = 8;
const NOTIFY_MS = 250;

export class CoverCheckService {
  private running = false;
  private queued = false;
  private stopped = false;
  private rerun = false;
  private controller: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private unsubscribe: () => void;
  private wake: () => void = () => undefined;
  /** Unreadable covers stay hidden; retry after an artwork change or restart. */
  private failures = new Map<number, number>();

  constructor(private deps: {
    ai: Pick<AiService, 'coverScore'>;
    artwork: ArtworkCache;
    catalog: CatalogRepo;
    settings: SettingsRepo;
    model: CoverModel;
    changed: () => void;
  }) {
    this.unsubscribe = deps.catalog.onCoverPending((id) => {
      this.failures.delete(id);
      this.poke();
    });
  }

  get enabled() { return this.deps.settings.get().hideWomenCovers; }

  failed(): number {
    return [...this.failures].filter(([id, n]) => {
      const e = n >= 3 ? this.deps.catalog.raw(id) : null;
      return e && ['safe', 'adult'].includes(e.rating) && ['available', 'listed'].includes(e.downloadStatus);
    }).length;
  }

  pending(): number {
    return this.enabled ? Math.max(0, this.deps.catalog.coverCounts().pending - this.failed()) : 0;
  }

  poke() {
    if (this.stopped) return;
    if (!this.enabled) { this.controller?.abort(); return; }
    if (this.running) { this.rerun = true; this.wake(); return; }
    if (this.queued) return;
    this.queued = true;
    // Repo changes can happen inside a transaction. Read after it commits and
    // coalesce a whole listing batch into one wake-up.
    queueMicrotask(() => {
      this.queued = false;
      if (!this.stopped && this.enabled && !this.running) void this.run();
    });
  }

  stop() {
    this.stopped = true;
    this.unsubscribe();
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.timer = this.notifyTimer = null;
  }

  private notify() {
    this.dirty = true;
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => this.flush(), NOTIFY_MS);
    this.notifyTimer.unref();
  }

  private flush() {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    if (this.dirty && !this.stopped) this.deps.changed();
    this.dirty = false;
  }

  private async run() {
    this.running = true;
    this.rerun = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const controller = this.controller = new AbortController();
    const signal = controller.signal;
    const started = Date.now();
    let scored = 0;
    try {
      if (this.pending() === 0) return;
      await this.deps.model.ensure();
      const active = new Set<number>();
      const waiting = new Set<() => void>();
      const wake = this.wake = () => { for (const resolve of waiting) resolve(); waiting.clear(); };
      signal.addEventListener('abort', wake, { once: true });
      let todo: CatalogRaw[] = [];
      const take = () => {
        if (!todo.length) {
          const skip = [...active, ...[...this.failures].filter(([, n]) => n >= 3).map(([id]) => id)];
          todo = this.deps.catalog.needingCoverCheck(100, skip);
        }
        const entry = todo.shift();
        if (entry) active.add(entry.id);
        return entry;
      };
      const worker = async () => {
        while (this.enabled && !signal.aborted) {
          const entry = take();
          if (!entry) {
            if (!active.size) return;
            // Stay available for indexing arrivals while another host is slow.
            // Leaving every idle worker here would make the next batch wait
            // for that one host's timeout despite the free GPU.
            await new Promise<void>(resolve => waiting.add(resolve));
            continue;
          }
          try {
            const result = await this.score(entry, signal);
            if (signal.aborted || !this.enabled) return;
            const current = this.deps.catalog.raw(entry.id);
            // A page refresh may have replaced the image during inference.
            if (!current || current.thumbnailUrl !== entry.thumbnailUrl || current.artworkFile !== entry.artworkFile) continue;
            if (result === null) {
              this.failures.set(entry.id, (this.failures.get(entry.id) ?? 0) + 1);
              continue;
            }
            if (result.file && result.file !== entry.artworkFile) this.deps.catalog.setArtwork(entry.id, result.file);
            this.deps.catalog.setCoverScore(entry.id, result.score);
            this.failures.delete(entry.id);
            scored++;
            this.notify();
          } catch (e) {
            if (signal.aborted) return;
            console.warn('[covers] check failed', entry.id, (e as Error).message);
            this.failures.set(entry.id, (this.failures.get(entry.id) ?? 0) + 1);
          } finally { active.delete(entry.id); wake(); }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } catch (e) {
      if (!signal.aborted) console.warn('[covers]', (e as Error).message);
    } finally {
      this.running = false;
      this.controller = null;
      this.wake = () => undefined;
      this.flush();
      if (scored) console.log('[covers] batch', { scored, ms: Date.now() - started, failed: this.stopped ? 0 : this.failed() });
      if (!this.stopped) {
        // Event-driven for new games; this is only a recovery/model retry.
        this.timer = setTimeout(() => this.poke(), 60_000);
        this.timer.unref();
        if (this.rerun && this.enabled) this.poke();
      }
    }
  }

  private async score(entry: CatalogRaw, signal: AbortSignal): Promise<{ score: number; file: string | null } | null> {
    let file = entry.artworkFile;
    const started = Date.now();
    if (file && !existsSync(this.deps.artwork.path(file))) file = null;
    if (!file && entry.thumbnailUrl) file = await this.deps.artwork.fetch(entry.thumbnailUrl, entry.pageUrl, signal).catch((e) => {
      signal.throwIfAborted();
      if (process.env.CGL_DEBUG) console.warn('[covers] image unavailable', entry.id, (e as Error).message);
      return null;
    });
    signal.throwIfAborted();
    if (!file) return entry.thumbnailUrl || entry.artworkFile ? null : { score: 0, file: null };
    const fetched = Date.now();
    const score = await this.deps.ai.coverScore(this.deps.model.path, this.deps.artwork.path(file), signal);
    if (!Number.isFinite(score)) throw new Error('Invalid cover score');
    if (process.env.CGL_DEBUG) console.log('[covers] checked', { id: entry.id, fetchMs: fetched - started, modelAndQueueMs: Date.now() - fetched });
    return { score, file };
  }
}
