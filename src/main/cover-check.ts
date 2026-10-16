// The cover filter (Settings → Content): an image model (CLIP, see
// cover-model.ts) scores each Store game's cover for how likely it shows a
// woman or girl, including drawn and anime characters. While the filter is on,
// games scoring at or above the chosen strictness are hidden, and so are games
// whose cover has not been scored yet. Scoring takes milliseconds per cover on
// the GPU, so thousands of games are done in minutes: all of them when the
// filter is turned on (and at start-up), then each new game as indexing finds it.
import type { AiService } from './ai';
import type { ArtworkCache } from './classification';
import type { CatalogRepo, SettingsRepo } from './repos';
import type { CoverModel } from './cover-model';

export class CoverCheckService {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  /** Covers whose check failed, with how often; after three tries they wait for the next start. */
  private failures = new Map<number, number>();

  constructor(private deps: {
    ai: Pick<AiService, 'coverScore'>;
    artwork: ArtworkCache;
    catalog: CatalogRepo;
    settings: SettingsRepo;
    model: CoverModel;
    /** Covers were scored: entries may have become visible or hidden. */
    changed: () => void;
  }) {}

  get enabled() {
    return this.deps.settings.get().hideWomenCovers;
  }

  /** Covers still to score while the filter is on. */
  pending(): number {
    if (!this.enabled) return 0;
    const given = [...this.failures.values()].filter((n) => n >= 3).length;
    return Math.max(0, this.deps.catalog.coverCounts().pending - given);
  }

  /** Starts scoring if the filter is on and covers are waiting (downloading the model first if needed). */
  poke() {
    if (this.running || !this.enabled) return;
    void this.run();
  }

  private async run() {
    this.running = true;
    let scored = 0;
    try {
      if (this.deps.catalog.coverCounts().pending === 0) return;
      await this.deps.model.ensure();
      while (this.enabled) {
        const skip = [...this.failures].filter(([, n]) => n >= 3).map(([id]) => id);
        const batch = this.deps.catalog.needingCoverCheck(50, skip);
        if (!batch.length) break;
        for (const entry of batch) {
          if (!this.enabled) break;
          const score = await this.score(entry.artworkFile, entry.thumbnailUrl, entry.pageUrl).catch((e) => {
            console.warn('[covers] check failed', entry.id, (e as Error).message);
            return null;
          });
          if (score === null) { this.failures.set(entry.id, (this.failures.get(entry.id) ?? 0) + 1); continue; }
          this.deps.catalog.setCoverScore(entry.id, score);
          if (++scored % 40 === 0) this.deps.changed();
        }
      }
    } catch (e) {
      console.warn('[covers]', (e as Error).message);
    } finally {
      this.running = false;
      if (scored) this.deps.changed();
      // New games keep arriving from indexing; look again in a while.
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.poke(), 60_000);
      this.timer.unref();
    }
  }

  /** 0..1; 0 for a game without a cover; null when the cover could not be read. */
  private async score(file: string | null, url: string | null, referer: string): Promise<number | null> {
    let cover = file;
    if (!cover && url) cover = await this.deps.artwork.fetch(url, referer).catch(() => null);
    if (!cover) return url ? null : 0;
    const score = await this.deps.ai.coverScore(this.deps.model.path, this.deps.artwork.path(cover));
    if (process.env.CGL_DEBUG) console.log(`[covers] ${cover} ${score.toFixed(3)}`);
    return score;
  }
}
