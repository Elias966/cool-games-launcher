// The cover filter (Settings → Content): the local AI looks at each Store
// game's cover and notes whether its main subject is a woman or a female
// (anime) character. While the filter is on, such games are hidden, and so
// are games whose cover has not been looked at yet. Covers are checked in the
// background: all of them when the filter is turned on (or at start-up), then
// each new game as indexing finds it.
import type { AiService } from './ai';
import type { ArtworkCache } from './classification';
import type { CatalogRepo, SettingsRepo } from './repos';
import type { StoreSession } from './store-session';
import { isCancelled } from '@shared/worker-protocol';

const SYSTEM = `You look at video game cover art and answer one question: is the main subject of the image a woman or girl?
Count a woman as the main subject when she is the single most prominent figure, or the clear focus of the cover. This includes drawn, anime, manga, cartoon and 3D-rendered female characters.
Answer false when the main subject is a man or boy, a non-human creature or robot, a group where no woman stands out, a vehicle, a landscape, an object, text or a logo.`;

const SCHEMA = {
  type: 'object',
  properties: { mainSubject: { type: 'string', maxLength: 60 }, woman: { type: 'boolean' } },
  required: ['mainSubject', 'woman'],
  additionalProperties: false,
};

export class CoverCheckService {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  /** Covers whose check failed, with how often; after three tries they wait for the next start. */
  private failures = new Map<number, number>();

  constructor(private deps: {
    ai: AiService;
    artwork: ArtworkCache;
    catalog: CatalogRepo;
    settings: SettingsRepo;
    session: StoreSession;
    /** Covers were checked: entries may have become visible or hidden. */
    changed: () => void;
    /** Whether there is still work (keeps the AI session open outside the Store). */
    pendingChanged: () => void;
  }) {
    deps.session.on('enter', () => this.poke());
  }

  get enabled() {
    return this.deps.settings.get().hideWomenCovers;
  }

  /** Covers still to look at while the filter is on. */
  pending(): number {
    if (!this.enabled) return 0;
    const given = [...this.failures.values()].filter((n) => n >= 3).length;
    return Math.max(0, this.deps.catalog.coverCounts().pending - given);
  }

  /** Starts checking if the filter is on and covers are waiting. */
  poke() {
    if (this.running || !this.enabled) return;
    void this.run();
  }

  private async run() {
    this.running = true;
    let checked = 0;
    try {
      while (this.enabled) {
        const token = this.deps.session.token();
        if (!token) break; // continues when the AI session starts (session 'enter')
        const skip = [...this.failures].filter(([, n]) => n >= 3).map(([id]) => id);
        const batch = this.deps.catalog.needingCoverCheck(10, skip);
        if (!batch.length) break;
        for (const entry of batch) {
          if (!this.enabled) break;
          const woman = await this.check(entry.id, entry.artworkFile, entry.thumbnailUrl, entry.pageUrl, token).catch((e) => {
            if (isCancelled(e) || token.signal.aborted) throw e;
            console.warn('[covers] check failed', entry.id, (e as Error).message);
            return null;
          });
          // Only a real answer is stored; a failed check is tried again (up to three times per run of the launcher).
          if (woman === null) { this.failures.set(entry.id, (this.failures.get(entry.id) ?? 0) + 1); continue; }
          this.deps.catalog.setCoverWoman(entry.id, woman);
          if (++checked % 5 === 0) this.deps.changed();
        }
      }
    } catch (e) {
      if (!isCancelled(e)) console.warn('[covers]', (e as Error).message);
    } finally {
      this.running = false;
      if (checked) this.deps.changed();
      this.deps.pendingChanged();
      // New games keep arriving from indexing; look again in a while.
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.poke(), 60_000);
      this.timer.unref();
    }
  }

  /** True when a woman is the cover's main subject; false otherwise (also for games without a cover). */
  private async check(id: number, file: string | null, url: string | null, referer: string, token: NonNullable<ReturnType<StoreSession['token']>>): Promise<boolean | null> {
    let cover = file;
    if (!cover && url) cover = await this.deps.artwork.fetch(url, referer, token.signal).catch(() => null);
    if (!cover) return url ? null : false;
    const data = await this.deps.ai.coverJpeg(this.deps.artwork.path(cover), token.signal);
    const r = await this.deps.ai.chatJson<{ mainSubject: string; woman: boolean }>(token, {
      system: SYSTEM,
      user: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } },
        { type: 'text', text: 'This is the cover of a video game. What is its main subject, and is it a woman or girl (including a female anime or cartoon character)?' },
      ],
      schema: SCHEMA,
      maxTokens: 60,
      think: false,
      priority: 0,
      temperature: 0,
      cacheKey: `cover-woman:v3:${cover}`,
    });
    if (process.env.CGL_DEBUG) console.log(`[covers] ${id} ${JSON.stringify(r)}`);
    return !!r.woman;
  }
}
