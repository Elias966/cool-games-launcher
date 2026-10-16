// Game information beyond what download sites publish. Many sites put the same
// SEO sentence in every page's description ("X Free Download … Get X PC game
// for free") and publish no popularity at all. For those games the page is
// read again for its own "About the game" text, and the game's public Steam
// store page supplies a short description, how many players recommend it
// (Popular) and its release date (Trending). Games the user opens are handled
// at once; the rest are filled in slowly in the background.
import { isBoilerplate, pickDescription } from '@shared/popularity';
import { hostOf, siteKey, titleKey } from '@shared/urls';
import type { AiCacheRepo, CatalogRepo, SourcesRepo } from './repos';
import type { SteamMedia } from '@shared/types';
import type { PageFetcher } from './page-fetcher';
import type { HostRateLimiter } from './rate-limit';

// Cache keys carry a version: results from older, weaker title matching are not reused.
const RETRY_AFTER_HOURS = 24 * 7;
const STEAM_REFRESH_HOURS = 24 * 14;

const STEAM_SPACING_MS = 1600; // Steam's store API allows roughly 200 requests per 5 minutes.

function decodeHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

const EDITION = /\b(?:digital\s+)?(?:deluxe|ultimate|gold|premium|standard|complete|definitive|special|collector'?s|anniversary|goty|game of the year|director'?s cut|enhanced|remastered|legendary|royal|launch)(?:\s+edition)?\b|\bedition\b|\bbundle\b/gi;

/** A store title without editions, versions and download-site noise. */
export function baseTitle(s: string): string {
  return s
    .replace(/\bfree download\b/gi, '')
    .replace(/[™®©]/g, '')
    .replace(/\((?:v|ver|build)[^)]*\)|\[[^\]]*\]/gi, '')
    .replace(/\b(?:v\d+(?:\.\d+)+|build\s*\d{3,})\b/gi, '')
    .replace(/\s*\+\s*\d*\s*dlcs?\b.*$/i, '')
    .replace(EDITION, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same game: titles equal once punctuation, editions and "Free Download" noise are ignored (numbers matter). */
export function sameGame(a: string, b: string): boolean {
  const norm = (s: string) => titleKey(baseTitle(s)).replace(/\bthe\b/g, '').replace(/[^a-z0-9]+/g, '');
  const x = norm(a), y = norm(b);
  return x.length >= 2 && x === y;
}

/** "24 Feb, 2022" / "Feb 24, 2022" → ISO; "Coming soon" → null. */
export function steamDate(s: string | null | undefined): string | null {
  const t = Date.parse(String(s ?? '').replace(/(\d+)(st|nd|rd|th)/, '$1'));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export class GameInfoService {
  private queue: number[] = [];
  private running = false;
  private stopped = false;
  private steamAt = 0;
  private backfillTimer: NodeJS.Timeout | null = null;
  private urgent = new Set<number>();
  private dirty = new Set<number>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private deps: { catalog: CatalogRepo; sources: SourcesRepo; cache: AiCacheRepo; fetcher: PageFetcher | null; limiter: HostRateLimiter; changed: (sourceId: number) => void }) {}

  /** Does this game still lack a real description? */
  needs(id: number): boolean {
    const e = this.deps.catalog.raw(id);
    return !!e && e.downloadStatus === 'available' && isBoilerplate(e.description, hostOf(e.pageUrl));
  }

  /** Steam data (popularity, release date, artwork, media) not looked up recently. */
  private needsSteam(id: number): boolean {
    const looked = this.deps.cache.get<{ appid: number | null }>(`steam2:${id}`, STEAM_REFRESH_HOURS);
    if (!looked) return true;
    return !!looked.appid && !this.deps.catalog.steamMedia(id);
  }

  private wanted(id: number): boolean {
    return (this.needs(id) && !this.deps.cache.get(`desc2:${id}`, RETRY_AFTER_HOURS)) || this.needsSteam(id);
  }

  /** The user opened this game: fill it in first. */
  prioritize(id: number) {
    if (!this.wanted(id)) return;
    this.queue = [id, ...this.queue.filter((x) => x !== id)];
    this.urgent.add(id);
    void this.pump();
  }

  /** Opened games show their new data at once; background results are published in batches so the Store does not reshuffle constantly. */
  private notify(id: number, sourceId: number) {
    if (this.urgent.delete(id)) { this.deps.changed(sourceId); return; }
    this.dirty.add(sourceId);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const ids = [...this.dirty];
      this.dirty.clear();
      for (const s of ids) this.deps.changed(s);
    }, 120_000);
    this.flushTimer.unref?.();
  }

  /** Fills in every game in the background, newest finds first. */
  startBackfill(delayMs = 30_000) {
    this.backfillTimer = setTimeout(() => {
      for (const id of this.deps.catalog.idsNeedingDescription(20000)) {
        if (!this.queue.includes(id) && this.wanted(id)) this.queue.push(id);
      }
      if (this.queue.length) console.log(`[gameinfo] ${this.queue.length} games need a description or popularity data; filling in the background`);
      void this.pump();
    }, delayMs);
    this.backfillTimer.unref?.();
  }

  /** Games still waiting for popularity data, for the Store's progress note. */
  pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  stop() {
    this.stopped = true;
    if (this.backfillTimer) clearTimeout(this.backfillTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  /** Works through the queue in chunks: one search per game, then one batch request for their Steam details. */
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        // An opened game goes alone, at once; the background fills 30 at a time.
        const size = this.urgent.has(this.queue[0]) ? 1 : 30;
        const chunk = this.queue.splice(0, size);
        try { await this.repairChunk(chunk); } catch (e) { console.warn('[gameinfo]', (e as Error).message); }
      }
    } finally { this.running = false; }
  }

  private async repairChunk(ids: number[]) {
    const signal = AbortSignal.timeout(10 * 60_000);
    const work: Array<{ id: number; sourceId: number; title: string; appid: number | null; needsText: boolean; description: { text: string; source: string | null } | null }> = [];
    for (const id of ids) {
      if (this.stopped) return;
      const e = this.deps.catalog.raw(id);
      if (!e || e.downloadStatus !== 'available') continue;
      const needsText = this.needs(id) && !this.deps.cache.get(`desc2:${id}`, RETRY_AFTER_HOURS);
      let description: { text: string; source: string | null } | null = null;
      // 1. The game's own page, read again with the current description finder.
      if (needsText && this.deps.fetcher) {
        const source = this.deps.sources.get(e.sourceId);
        await this.deps.limiter.wait(siteKey(hostOf(e.pageUrl)), source?.rateLimitMs ?? 1000, signal);
        const r = await this.deps.fetcher.fetch(e.pageUrl, signal).catch(() => null);
        if (r?.ok) {
          const ld = (r.extract.jsonLd as Array<Record<string, unknown>>).find((o) => /VideoGame|SoftwareApplication|Product/.test(String(o?.['@type'] ?? '')));
          const text = pickDescription([typeof ld?.description === 'string' ? ld.description : null, r.extract.about, r.extract.meta['og:description']], hostOf(e.pageUrl));
          if (text) description = { text, source: null };
        }
      }
      // 2. Which Steam app it is (searched once, remembered).
      let looked = this.deps.cache.get<{ appid: number | null }>(`steam2:${id}`, STEAM_REFRESH_HOURS);
      if (!looked) {
        const appid = await this.findAppId(e.title, signal).catch(() => null);
        looked = { appid };
        this.deps.cache.set(`steam2:${id}`, { at: new Date().toISOString(), appid });
      }
      work.push({ id, sourceId: e.sourceId, title: e.title, appid: looked.appid, needsText, description });
    }
    // 3. Everything Steam knows about these apps, in one request.
    const appids = [...new Set(work.map((w) => w.appid).filter((a): a is number => !!a))];
    const items = appids.length ? await this.steamItems(appids, signal).catch((err) => { console.warn('[gameinfo] Steam details failed:', (err as Error).message); return new Map<number, SteamItem>(); }) : new Map<number, SteamItem>();
    for (const w of work) {
      const item = w.appid ? items.get(w.appid) : undefined;
      if (item) {
        this.deps.catalog.setSteamMedia(w.id, item.media);
        this.deps.catalog.setSteamInfo(w.id, { recommendations: item.media.reviews?.count ?? null, metacritic: item.media.reviews ? item.media.reviews.percent : null, released: item.media.released });
        if (!w.description && w.needsText && item.description) w.description = { text: item.description, source: 'steam' };
      }
      if (w.needsText) this.deps.cache.set(`desc2:${w.id}`, { at: new Date().toISOString(), found: !!w.description, source: w.description?.source ?? null });
      if (w.description) this.deps.catalog.setDescription(w.id, w.description.text, w.description.source);
      if (w.description || item) this.notify(w.id, w.sourceId);
      else this.urgent.delete(w.id);
    }
  }

  private async steamJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
    const wait = this.steamAt + STEAM_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.steamAt = Date.now();
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    return res.ok ? ((await res.json()) as T) : null;
  }

  /** Steam store search for a name, rate-limited like every Steam request (at most 10 results). */
  async searchSteam(term: string, signal: AbortSignal = new AbortController().signal): Promise<SteamResult[]> {
    const q = term.trim();
    if (q.length < 2) return [];
    const search = await this.steamJson<{ items?: Array<{ id: number; name: string; type?: string; tiny_image?: string }> }>(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=US`, signal);
    return (search?.items ?? []).filter((i) => i.id && i.name && (!i.type || i.type === 'app')).slice(0, 10).map((i) => ({ appid: i.id, name: i.name, image: i.tiny_image ?? null }));
  }

  /** Steam's all-ages artwork for one app, or null. */
  async steamMediaFor(appid: number, signal: AbortSignal = new AbortController().signal): Promise<SteamMedia | null> {
    const wait = this.steamAt + STEAM_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.steamAt = Date.now();
    return (await this.steamItems([appid], signal)).get(appid)?.media ?? null;
  }

  /** The Steam app for a catalog title (same game, any edition), or null. */
  private async findAppId(title: string, signal: AbortSignal): Promise<number | null> {
    const term = baseTitle(title);
    if (term.length < 2) return null;
    const search = await this.steamJson<{ items?: Array<{ id: number; name: string; type?: string }> }>(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`, signal);
    return search?.items?.find((i) => sameGame(i.name, title))?.id ?? null;
  }

  /** Steam's store data for up to ~50 apps per request: artwork, reviews, release, description, screenshots, trailers. */
  private async steamItems(appids: number[], signal: AbortSignal): Promise<Map<number, SteamItem>> {
    const out = new Map<number, SteamItem>();
    for (let i = 0; i < appids.length; i += 50) {
      const input = { ids: appids.slice(i, i + 50).map((appid) => ({ appid })), context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true, include_release: true, include_reviews: true, include_basic_info: true, include_screenshots: true, include_trailers: true } };
      const res = await fetch(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`, { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { response?: { store_items?: RawStoreItem[] } };
      for (const raw of body.response?.store_items ?? []) {
        const item = steamItem(raw);
        if (item) out.set(item.media.appid, item);
      }
    }
    return out;
  }
}

interface RawStoreItem {
  appid?: number;
  success?: number;
  assets?: Record<string, string>;
  release?: { steam_release_date?: number; original_release_date?: number };
  reviews?: { summary_filtered?: { review_count?: number; percent_positive?: number; review_score_label?: string } };
  basic_info?: { short_description?: string };
  screenshots?: { all_ages_screenshots?: Array<{ filename: string; ordinal?: number }> };
  trailers?: { highlights?: RawTrailer[]; other_trailers?: RawTrailer[] };
}

interface RawTrailer {
  trailer_name?: string;
  all_ages?: boolean;
  microtrailer?: Array<{ filename: string; type: string }>;
  adaptive_trailers?: Array<{ cdn_path: string; encoding: string }>;
  screenshot_medium?: string;
  trailer_url_format?: string;
}

interface SteamItem { media: SteamMedia; description: string | null }

export interface SteamResult { appid: number; name: string; image: string | null }

const ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/';
const VIDEO = 'https://video.akamai.steamstatic.com/store_trailers/';

/** Steam store data → the launcher's media record (all-ages media only). */
export function steamItem(raw: RawStoreItem): SteamItem | null {
  if (!raw.appid) return null;
  const a = raw.assets ?? {};
  const asset = (key: string) => (a[key] && a.asset_url_format ? ASSETS + a.asset_url_format.replace('${FILENAME}', a[key]) : null);
  const reviews = raw.reviews?.summary_filtered;
  const released = raw.release?.steam_release_date ?? raw.release?.original_release_date;
  const trailers = [...(raw.trailers?.highlights ?? []), ...(raw.trailers?.other_trailers ?? [])]
    .filter((t) => t.all_ages !== false)
    .slice(0, 4)
    .map((t) => ({
      name: t.trailer_name ?? 'Trailer',
      hls: (() => { const h = t.adaptive_trailers?.find((x) => x.encoding === 'hls_h264'); return h ? VIDEO + h.cdn_path : null; })(),
      preview: (() => { const m = t.microtrailer?.find((x) => x.type === 'video/mp4'); return m ? VIDEO + m.filename : null; })(),
      poster: t.screenshot_medium && t.trailer_url_format ? ASSETS + t.trailer_url_format.replace('${FILENAME}', t.screenshot_medium) : null,
    }));
  const text = decodeHtml(raw.basic_info?.short_description ?? '').slice(0, 1500);
  return {
    description: text.length >= 40 ? text : null,
    media: {
      appid: raw.appid,
      hero: asset('library_hero'),
      // Not every app publishes a logo through this API; the classic path exists for most.
      logo: a.library_logo ? asset('library_logo') : `${ASSETS}steam/apps/${raw.appid}/logo.png`,
      capsule: asset('main_capsule') ?? asset('header'),
      header: asset('header'),
      background: asset('page_background'),
      reviews: reviews?.review_count ? { label: reviews.review_score_label ?? '', percent: reviews.percent_positive ?? 0, count: reviews.review_count } : null,
      released: released ? new Date(released * 1000).toISOString() : null,
      screenshots: (raw.screenshots?.all_ages_screenshots ?? []).sort((x, y) => (x.ordinal ?? 0) - (y.ordinal ?? 0)).slice(0, 12).map((s) => ASSETS + s.filename),
      trailers,
    },
  };
}
