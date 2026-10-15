import {DEFAULT_MODEL_ID, DEFAULT_AGENTS} from '@shared/models';
import type { InstallResult } from '../workers/prepare-game';
import type { PlayStats, ProtonPackage } from '@shared/types';
// Typed data access over SQLite. No Electron imports, so it is testable in Node.
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import type { Db } from './db';
import { Statements, tx } from './db';
import { NSFW_IMAGE_THRESHOLD, visibleRatings, type VisibilityPolicy } from '@shared/policy';
import { hostOf } from '@shared/urls';
import type { SiteRecipe } from '@shared/site-recipe';
import { compareVersions, findVersion, type InstalledVersion, type VersionFingerprint } from '@shared/game-version';
import { popularScore, trendingScore, usefulTag, type PopularitySignals, type RankKind } from '@shared/popularity';
import { titleSimilarity } from '@shared/fuzzy';
import { DEFAULT_LAUNCH, type LaunchOptions, type SteamMedia } from '@shared/types';
import type {
  CatalogEntry,
  CatalogQuery,
  ConsentRecord,
  ContentRating,
  DownloadCandidate,
  DownloadErrorCode,
  DownloadItem,
  DownloadState,
  Game,
  GameStatus,
  InstallState,
  Platform,
  Runner,
  Settings,
  Source,
  SourceStatus,
  UserPrompt,
} from '@shared/types';

const now = () => new Date().toISOString();
const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function defaultSettings(dirs: { games: string; downloads: string }): Settings {
  const cores = cpus().length || 4;
  return {
    showNsfw: false,
    policyRevision: 1,
    libraryDir: dirs.games,
    downloadsDir: dirs.downloads,
    aiModelId: DEFAULT_MODEL_ID,
    aiAgents: {...DEFAULT_AGENTS},
    aiThreads: Math.max(2, Math.min(8, Math.floor(cores / 2))),
    aiContextSize: 16384,
    aiAcceleration: 'auto',
    aiImageTokens: 1536,
    aiIdleUnloadMinutes: 10,
    classifierThreads: Math.max(1, Math.min(4, Math.floor(cores / 2))),
    maxConcurrentDownloads: 2,
    downloadConnections: 8,
    downloadSpeedLimit: 0,
    downloadWindow: { enabled: false, start: '01:00', end: '07:00' },
    pauseDownloadsWhilePlaying: false,
    winePath: '',
    protonPath: '',
    umuPath: '',
    effects: 'full',
    motion: 'system',
    uiSounds: true,
    uiVolume: 0.5,
    uiAmbient: true,
    uiAmbientVolume: 0.5,
    uiSoundGroups: { hover: true, click: true, navigation: true, downloads: true, alerts: true },
    crawlRefreshHours: 3,
    gameUpdates: 'notify',
    afterInstall: 'ask',
    saveBackups: true,
    saveBackupsKeep: 5,
    closeToTray: true,
    freeGpuWhilePlaying: true,
    checkLauncherUpdates: true,
    language: 'en',
    clearBrowserDataOnExit: false,
    sendDoNotTrack: true,
  };
}

export class SettingsRepo {
  private st: Statements;
  constructor(
    private db: Db,
    private defaults: Settings,
  ) {
    this.st = new Statements(db);
  }

  get(): Settings {
    const rows = this.st.get('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const out: Record<string, unknown> = { ...this.defaults };
    for (const r of rows) if (r.key in this.defaults) out[r.key] = json(r.value, (this.defaults as unknown as Record<string, unknown>)[r.key]);
    return out as unknown as Settings;
  }

  update(patch: Partial<Settings>): Settings {
    tx(this.db, () => {
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in this.defaults) || v === undefined) continue;
        this.st.get('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
      }
    });
    return this.get();
  }

  policy(): VisibilityPolicy {
    const s = this.get();
    return { showNsfw: s.showNsfw, revision: s.policyRevision };
  }

  /** Changes NSFW visibility and bumps the policy revision atomically. */
  setShowNsfw(show: boolean): Settings {
    const cur = this.get();
    if (cur.showNsfw === show) return cur;
    return this.update({ showNsfw: show, policyRevision: cur.policyRevision + 1 });
  }
}

export function warningHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class ConsentRepo {
  private st: Statements;
  constructor(db: Db) {
    this.st = new Statements(db);
  }

  current(): ConsentRecord {
    const row = this.st.get(`SELECT accepted_at FROM consent WHERE kind = 'nsfw' AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`).get() as
      | { accepted_at: string }
      | undefined;
    return { accepted: !!row, acceptedAt: row?.accepted_at ?? null };
  }

  accept(hash: string) {
    this.revoke();
    this.st.get(`INSERT INTO consent (kind, accepted_at, warning_hash) VALUES ('nsfw', ?, ?)`).run(now(), hash);
  }

  revoke() {
    this.st.get(`UPDATE consent SET revoked_at = ? WHERE kind = 'nsfw' AND revoked_at IS NULL`).run(now());
  }
}

interface SourceRow {
  id: number;
  url: string;
  name: string;
  enabled: number;
  max_pages: number;
  rate_limit_ms: number;
  status: SourceStatus;
  status_detail: string | null;
  last_crawl_at: string | null;
  cursor_json: string | null;
  recipe_json?: string | null;
  created_at: string;
  entry_count?: number;
}

export interface CrawlCursor {
  /** Listing pages still to visit, in order. */
  pending: string[];
  visited: string[];
  pagesDone: number;
  startedAt: string;
  /** Current listing viewport and in-flight detail survive process restarts. */
  page?: { url: string; scrollY: number };
  detailId?: number;
  failures?: number;
  retryAt?: number;
  verification?: { url: string; entryId: number | null };
  /** A re-check of an already indexed site: stop once listings show nothing new. */
  refresh?: boolean;
  /** Consecutive refresh pages without a new game. */
  staleRun?: number;
}

export class SourcesRepo {
  private st: Statements;
  constructor(private db: Db) {
    this.st = new Statements(db);
  }

  private map(r: SourceRow): Source {
    return {
      id: r.id,
      url: r.url,
      name: r.name,
      enabled: !!r.enabled,
      maxPages: r.max_pages,
      rateLimitMs: r.rate_limit_ms,
      status: r.status,
      statusDetail: r.status_detail,
      lastCrawlAt: r.last_crawl_at,
      entryCount: r.entry_count ?? 0,
      createdAt: r.created_at,
      learned: (() => {
        const recipe = json<SiteRecipe | null>(r.recipe_json ?? null, null);
        return recipe?.version === 1 ? { at: recipe.learnedAt, browser: recipe.listingMode === 'browser' } : null;
      })(),
    };
  }

  list(): Source[] {
    const rows = this.st
      .get(`SELECT s.*, (SELECT COUNT(*) FROM catalog c WHERE c.source_id = s.id) AS entry_count FROM sources s ORDER BY s.id`)
      .all() as unknown as SourceRow[];
    return rows.map((r) => this.map(r));
  }

  get(id: number): Source | null {
    const r = this.st.get(`SELECT s.*, (SELECT COUNT(*) FROM catalog c WHERE c.source_id = s.id) AS entry_count FROM sources s WHERE id = ?`).get(id) as SourceRow | undefined;
    return r ? this.map(r) : null;
  }

  add(url: string, name?: string): Source {
    const n = name?.trim() || hostOf(url) || url;
    const r = this.st.get('INSERT INTO sources (url, name, rate_limit_ms) VALUES (?, ?, 300) RETURNING id').get(url, n) as { id: number };
    return this.get(r.id)!;
  }

  update(id: number, patch: { name?: string; enabled?: boolean; maxPages?: number; rateLimitMs?: number }): Source {
    if (patch.name !== undefined) this.st.get('UPDATE sources SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.enabled !== undefined) this.st.get('UPDATE sources SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    if (patch.maxPages !== undefined) this.st.get('UPDATE sources SET max_pages = ? WHERE id = ?').run(patch.maxPages, id);
    if (patch.rateLimitMs !== undefined) this.st.get('UPDATE sources SET rate_limit_ms = ? WHERE id = ?').run(patch.rateLimitMs, id);
    return this.get(id)!;
  }

  remove(id: number) {
    this.st.get('DELETE FROM sources WHERE id = ?').run(id);
  }

  setStatus(id: number, status: SourceStatus, detail: string | null = null) {
    this.st.get('UPDATE sources SET status = ?, status_detail = ? WHERE id = ?').run(status, detail, id);
  }

  cursor(id: number): CrawlCursor | null {
    const r = this.st.get('SELECT cursor_json FROM sources WHERE id = ?').get(id) as { cursor_json: string | null } | undefined;
    return json<CrawlCursor | null>(r?.cursor_json, null);
  }

  saveCursor(id: number, cursor: CrawlCursor | null) {
    this.st.get('UPDATE sources SET cursor_json = ? WHERE id = ?').run(cursor ? JSON.stringify(cursor) : null, id);
  }

  checkpoint<T>(id: number, cursor: CrawlCursor, work: () => T): T {
    return tx(this.db, () => {
      const result = work();
      this.saveCursor(id, cursor);
      return result;
    });
  }

  markCrawled(id: number) {
    this.st.get('UPDATE sources SET last_crawl_at = ?, cursor_json = NULL WHERE id = ?').run(now(), id);
  }

  resetCrawl(id: number) {
    this.st.get('UPDATE sources SET last_crawl_at = NULL, cursor_json = NULL WHERE id = ?').run(id);
  }

  recipe(id: number): SiteRecipe | null {
    const r = this.st.get('SELECT recipe_json FROM sources WHERE id = ?').get(id) as { recipe_json: string | null } | undefined;
    const recipe = json<SiteRecipe | null>(r?.recipe_json, null);
    return recipe?.version === 1 ? recipe : null;
  }

  saveRecipe(id: number, recipe: SiteRecipe | null) {
    this.st.get('UPDATE sources SET recipe_json = ? WHERE id = ?').run(recipe ? JSON.stringify(recipe) : null, id);
  }
}

interface CatalogRow {
  id: number;
  source_id: number;
  page_url: string;
  title: string;
  title_key: string;
  description: string | null;
  author: string | null;
  price_text: string | null;
  platforms_json: string;
  tags_json: string;
  categories_json: string;
  download_status: 'pending' | 'listed' | 'available' | 'unavailable';
  thumbnail_url: string | null;
  artwork_file: string | null;
  screenshots_json: string;
  screenshot_files_json: string;
  candidates_json: string;
  rating: ContentRating;
  rating_score: number;
  rating_reasons_json: string;
  classifier_version: string | null;
  classify_attempts: number;
  text_signals_json: string;
  discovered_at: string;
  updated_at: string;
  detail_fetched_at: string | null;
  version_json?: string | null;
  listing_title?: string | null;
  popularity_json?: string | null;
  published_at?: string | null;
  rank_popular?: number | null;
  rank_trending?: number | null;
  description_source?: string | null;
  steam_json?: string | null;
  game_update?: string | null;
  wishlisted?: number;
  source_name?: string;
  source_url?: string;
  game_id?: number | null;
  download_id?: number | null;
}

export interface CatalogRaw {
  id: number;
  sourceId: number;
  pageUrl: string;
  title: string;
  description: string | null;
  author: string | null;
  priceText: string | null;
  platforms: Platform[];
  tags: string[];
  categories: string[];
  downloadStatus: 'pending' | 'listed' | 'available' | 'unavailable';
  thumbnailUrl: string | null;
  artworkFile: string | null;
  screenshots: string[];
  /** Cached, classified screenshot files with their NSFW score. */
  screenshotFiles: Array<{ file: string; score: number }>;
  candidates: DownloadCandidate[];
  rating: ContentRating;
  ratingReasons: string[];
  classifierVersion: string | null;
  classifyAttempts: number;
  textSignals: string[];
  detailFetchedAt: string | null;
  /** The build the game page offered at its last verification. */
  version: VersionFingerprint | null;
}

export interface ListingInput {
  pageUrl: string;
  title: string;
  titleKey: string;
  description?: string | null;
  author?: string | null;
  priceText?: string | null;
  platforms?: Platform[];
  tags?: string[];
  categories?: string[];
  thumbnailUrl?: string | null;
  textSignals?: string[];
}

const CATALOG_ORDER: Record<NonNullable<CatalogQuery['sort']>, string> = {
  new: '(c.artwork_file IS NULL), c.discovered_at DESC, c.id DESC',
  popular: '(c.artwork_file IS NULL), c.pop_score DESC, c.discovered_at DESC, c.id DESC',
  trending: '(c.artwork_file IS NULL), c.trend_score DESC, c.discovered_at DESC, c.id DESC',
  title: 'c.title COLLATE NOCASE, c.id',
};

export class CatalogRepo {
  private st: Statements;
  constructor(private db: Db) {
    this.st = new Statements(db);
  }

  private toRaw(r: CatalogRow): CatalogRaw {
    return {
      id: r.id,
      sourceId: r.source_id,
      pageUrl: r.page_url,
      title: r.title,
      description: r.description,
      author: r.author,
      priceText: r.price_text,
      platforms: json(r.platforms_json, []),
      tags: json(r.tags_json, []),
      categories: json(r.categories_json, []),
      downloadStatus: r.download_status,
      thumbnailUrl: r.thumbnail_url,
      artworkFile: r.artwork_file,
      screenshots: json(r.screenshots_json, []),
      screenshotFiles: json(r.screenshot_files_json, []),
      candidates: json(r.candidates_json, []),
      rating: r.rating,
      ratingReasons: json(r.rating_reasons_json, []),
      classifierVersion: r.classifier_version,
      classifyAttempts: r.classify_attempts,
      textSignals: json(r.text_signals_json, []),
      detailFetchedAt: r.detail_fetched_at,
      version: json(r.version_json ?? null, null),
    };
  }

  private toEntry(r: CatalogRow): CatalogEntry {
    const raw = this.toRaw(r);
    return {
      id: r.id,
      verifying: r.download_status === 'listed',
      sourceId: r.source_id,
      sourceName: r.source_name ?? '',
      sourceHost: hostOf(r.source_url ?? r.page_url),
      pageUrl: r.page_url,
      title: r.title,
      description: r.description,
      author: r.author,
      priceText: r.price_text,
      platforms: raw.platforms,
      tags: raw.tags,
      categories: raw.categories,
      artwork: r.artwork_file ? `cgl-media://artwork/${encodeURIComponent(r.artwork_file)}` : null,
      screenshots: [],
      rating: r.rating,
      ratingReasons: raw.ratingReasons,
      discoveredAt: r.discovered_at,
      updatedAt: r.updated_at,
      detailFetched: !!r.detail_fetched_at,
      installedGameId: r.game_id ?? null,
      wishlisted: !!r.wishlisted,
      updateAvailable: json<{ state?: string } | null>(r.game_update ?? null, null)?.state === 'available',
      popularity: json(r.popularity_json ?? null, null),
      rankPopular: r.rank_popular ?? null,
      rankTrending: r.rank_trending ?? null,
      descriptionSource: r.description_source ?? null,
      // Lists carry artwork only; screenshots and trailers come with the detail view.
      steam: ((m: SteamMedia | null) => (m ? { ...m, screenshots: [], trailers: [] } : null))(json<SteamMedia | null>(r.steam_json ?? null, null)),
      downloadId: r.download_id ?? null,
    };
  }

  /**
   * Inserts a newly discovered listing, or refreshes basic fields of a known
   * one. `changed` marks a verified game whose listing now announces a newer
   * build (retitled "Game v1.3", or the new build posted on a new page): it is
   * queued for re-verification so installed copies learn about the update.
   */
  upsertListing(sourceId: number, l: ListingInput): { id: number; created: boolean; changed?: boolean } {
    type Existing = { id: number; detail_fetched_at: string | null; download_status: string; listing_title: string | null; title: string; page_url: string };
    const cols = 'id, detail_fetched_at, download_status, listing_title, title, page_url';
    const byUrl = this.st.get(`SELECT ${cols} FROM catalog WHERE source_id = ? AND page_url = ?`).get(sourceId, l.pageUrl) as Existing | undefined;
    const existing = byUrl ?? (this.st.get(`SELECT ${cols} FROM catalog WHERE source_id = ? AND title_key = ? AND title_key != '' ORDER BY id DESC`).get(sourceId, l.titleKey) as Existing | undefined);
    if (existing) {
      // A listing is provisional evidence. Never replace classified detail,
      // taxonomy, artwork or download routes with a weaker repeat observation.
      if (existing.detail_fetched_at || existing.download_status === 'available') {
        const was = findVersion({ titles: [existing.listing_title ?? existing.title] });
        const now_ = findVersion({ titles: [l.title] });
        const newer = !!now_ && now_ !== was && (was ? (compareVersions(now_, was) ?? 1) > 0 : true);
        if (!byUrl) {
          // Same game on another page: only a newer announced build moves the entry there.
          if (!newer) return { id: existing.id, created: false };
          this.st.get('UPDATE catalog SET page_url = ?, listing_title = ?, detail_fetched_at = NULL, detail_attempts = 0 WHERE id = ?').run(l.pageUrl, l.title, existing.id);
          return { id: existing.id, created: false, changed: true };
        }
        if (existing.listing_title !== null && newer) {
          this.st.get('UPDATE catalog SET listing_title = ?, detail_fetched_at = NULL, detail_attempts = 0 WHERE id = ?').run(l.title, existing.id);
          return { id: existing.id, created: false, changed: true };
        }
        if (existing.listing_title !== l.title) this.st.get('UPDATE catalog SET listing_title = ? WHERE id = ?').run(l.title, existing.id);
        return { id: existing.id, created: false };
      }
      this.st
        .get(
          `UPDATE catalog SET title = COALESCE(NULLIF(?, ''), title), description = COALESCE(description, ?), author = COALESCE(author, ?),
             price_text = COALESCE(?, price_text), thumbnail_url = COALESCE(thumbnail_url, ?),
             platforms_json = CASE WHEN ? != '[]' THEN ? ELSE platforms_json END, listing_title = ?, updated_at = ? WHERE id = ?`,
        )
        .run(l.title, l.description ?? null, l.author ?? null, l.priceText ?? null, l.thumbnailUrl ?? null, JSON.stringify(l.platforms ?? []), JSON.stringify(l.platforms ?? []), l.title, now(), existing.id);
      this.mergeTaxonomy(existing.id, l.categories ?? [], l.tags ?? []);
      if (l.textSignals?.length) this.addTextSignals(existing.id, l.textSignals);
      return { id: existing.id, created: false };
    }
    const r = this.st
      .get(
        `INSERT INTO catalog (source_id, page_url, title, title_key, description, author, price_text, platforms_json, tags_json, thumbnail_url, text_signals_json, listing_title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        sourceId,
        l.pageUrl,
        l.title,
        l.titleKey,
        l.description ?? null,
        l.author ?? null,
        l.priceText ?? null,
        JSON.stringify(l.platforms ?? []),
        JSON.stringify(l.tags ?? []),
        l.thumbnailUrl ?? null,
        JSON.stringify(l.textSignals ?? []),
        l.title,
      ) as { id: number };
    this.mergeTaxonomy(r.id, l.categories ?? [], l.tags ?? []);
    return { id: r.id, created: true };
  }

  private mergeTaxonomy(id: number, categories: string[], tags: string[]) {
    const cur = this.raw(id);
    if (!cur) return;
    const normalize = (values: string[]) => [...new Set(values.map((v) => v.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 60)).filter(Boolean))].slice(0, 40);
    this.st.get('UPDATE catalog SET categories_json = ?, tags_json = ? WHERE id = ?')
      .run(JSON.stringify(normalize([...cur.categories, ...categories])), JSON.stringify(normalize([...cur.tags, ...tags])), id);
  }

  /**
   * The local AI confirmed these listing cards are games: show them right away
   * (once their cover passes the content check) while the full download-route
   * verification continues in the background.
   */
  markListed(ids: number[]) {
    for (const id of ids) this.st.get("UPDATE catalog SET download_status = 'listed' WHERE id = ? AND download_status = 'pending'").run(id);
  }

  setVersion(id: number, version: VersionFingerprint) {
    this.st.get('UPDATE catalog SET version_json = ? WHERE id = ?').run(JSON.stringify(version), id);
  }

  /** Available games, most popular first, for description repair. */
  idsNeedingDescription(limit: number): number[] {
    return (this.db.prepare(`SELECT id FROM catalog WHERE download_status = 'available' ORDER BY (tags_json LIKE '%"top"%' OR tags_json LIKE '%"popular"%') DESC, discovered_at DESC, id DESC LIMIT ?`).all(limit) as Array<{ id: number }>).map((r) => r.id);
  }

  /** Re-verify these game pages (their site says they changed); they stay listed meanwhile. */
  markStale(ids: number[]) {
    for (const id of ids) this.st.get('UPDATE catalog SET detail_fetched_at = NULL, detail_attempts = 0 WHERE id = ? AND detail_fetched_at IS NOT NULL').run(id);
  }

  /** Verified entries of a source by page URL, for sitemap <lastmod> comparison. */
  verifiedByUrl(sourceId: number): Map<string, { id: number; fetchedAt: string }> {
    const rows = this.st.get('SELECT id, page_url, detail_fetched_at FROM catalog WHERE source_id = ? AND detail_fetched_at IS NOT NULL').all(sourceId) as Array<{ id: number; page_url: string; detail_fetched_at: string }>;
    return new Map(rows.map((r) => [r.page_url, { id: r.id, fetchedAt: r.detail_fetched_at }]));
  }

  recordDetailFailure(id: number) {
    this.st.get('UPDATE catalog SET detail_attempts = detail_attempts + 1 WHERE id = ?').run(id);
  }

  retryUnfinishedDetails(sourceId: number) {
    this.st.get('UPDATE catalog SET detail_attempts = 0 WHERE source_id = ? AND detail_fetched_at IS NULL').run(sourceId);
    this.st.get("UPDATE catalog SET classify_attempts = 0 WHERE source_id = ? AND rating = 'unknown'").run(sourceId);
  }

  addTextSignals(id: number, signals: string[]) {
    const cur = this.raw(id);
    if (!cur) return;
    const merged = [...new Set([...cur.textSignals, ...signals])];
    this.st.get('UPDATE catalog SET text_signals_json = ? WHERE id = ?').run(JSON.stringify(merged), id);
  }

  invalidateRating(id: number) {
    this.st.get("UPDATE catalog SET rating = 'unknown', classifier_version = NULL, classify_attempts = 0 WHERE id = ?").run(id);
  }

  setDetail(
    id: number,
    d: {
      title?: string | null;
      description?: string | null;
      author?: string | null;
      priceText?: string | null;
      platforms?: Platform[];
      tags?: string[];
      categories?: string[];
      thumbnailUrl?: string | null;
      screenshots?: string[];
      candidates?: DownloadCandidate[];
      downloadStatus?: 'available' | 'unavailable';
      version?: VersionFingerprint | null;
      popularity?: PopularitySignals | null;
      published?: string | null;
    },
  ) {
    this.mergeTaxonomy(id, d.categories ?? [], d.tags ?? []);
    this.st
      .get(
        `UPDATE catalog SET title = COALESCE(NULLIF(?, ''), title), description = COALESCE(?, description), author = COALESCE(?, author),
           price_text = COALESCE(?, price_text), platforms_json = CASE WHEN ? != '[]' THEN ? ELSE platforms_json END,
           tags_json = CASE WHEN ? != '[]' THEN ? ELSE tags_json END, thumbnail_url = COALESCE(?, thumbnail_url),
           screenshots_json = ?, candidates_json = ?, download_status = ?, version_json = COALESCE(?, version_json), detail_fetched_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        d.title ?? '',
        d.description ?? null,
        d.author ?? null,
        d.priceText ?? null,
        JSON.stringify(d.platforms ?? []),
        JSON.stringify(d.platforms ?? []),
        JSON.stringify(this.raw(id)?.tags ?? []),
        JSON.stringify(this.raw(id)?.tags ?? []),
        d.thumbnailUrl ?? null,
        JSON.stringify(d.screenshots ?? []),
        JSON.stringify(d.candidates ?? []),
        d.downloadStatus ?? ((d.candidates?.length ?? 0) > 0 ? 'available' : 'unavailable'),
        d.version ? JSON.stringify(d.version) : null,
        now(),
        now(),
        id,
      );
    if (d.popularity !== undefined || d.published !== undefined) {
      this.st.get('UPDATE catalog SET popularity_json = COALESCE(?, popularity_json), published_at = COALESCE(?, published_at) WHERE id = ?')
        .run(d.popularity ? JSON.stringify(d.popularity) : null, d.published ?? null, id);
    }
    // A description chosen from the page itself replaces one looked up elsewhere.
    if (d.description) this.st.get('UPDATE catalog SET description_source = NULL WHERE id = ?').run(id);
    this.rescore(id);
  }

  /** A real description found after verification (the page's article, or a public game database). */
  setDescription(id: number, description: string, source: string | null) {
    this.st.get('UPDATE catalog SET description = ?, description_source = ? WHERE id = ?').run(description.slice(0, 1500), source, id);
  }

  setSteamMedia(id: number, media: SteamMedia) {
    this.st.get('UPDATE catalog SET steam_json = ? WHERE id = ?').run(JSON.stringify(media), id);
  }

  steamMedia(id: number): SteamMedia | null {
    const r = this.st.get('SELECT steam_json FROM catalog WHERE id = ?').get(id) as { steam_json: string | null } | undefined;
    return json<SteamMedia | null>(r?.steam_json ?? null, null);
  }

  /** Popularity from the game's Steam page: players' recommendations, Metacritic, release date. */
  setSteamInfo(id: number, info: { recommendations: number | null; metacritic: number | null; released: string | null }) {
    const row = this.st.get('SELECT popularity_json FROM catalog WHERE id = ?').get(id) as { popularity_json: string | null } | undefined;
    if (!row) return;
    const cur = json<PopularitySignals | null>(row.popularity_json, null) ?? { downloads: null, views: null, ratings: null, rating: null };
    const next: PopularitySignals = {
      ...cur,
      ratings: Math.max(cur.ratings ?? 0, info.recommendations ?? 0) || null,
      rating: cur.rating ?? (info.metacritic ? Math.round(info.metacritic / 2) / 10 : null),
    };
    // A game's release date says more about what is trending than the download page's post date.
    this.st.get('UPDATE catalog SET popularity_json = ?, published_at = COALESCE(?, published_at) WHERE id = ?').run(JSON.stringify(next), info.released, id);
    this.rescore(id);
  }

  /** The site's own Popular / Trending list for a source, best first; replaces the previous list. */
  setRanks(sourceId: number, kind: RankKind, ids: number[]) {
    const col = kind === 'popular' ? 'rank_popular' : 'rank_trending';
    tx(this.db, () => {
      this.db.prepare(`UPDATE catalog SET ${col} = NULL WHERE source_id = ? AND ${col} IS NOT NULL`).run(sourceId);
      const set = this.db.prepare(`UPDATE catalog SET ${col} = ? WHERE id = ? AND source_id = ?`);
      ids.forEach((id, i) => set.run(i + 1, id, sourceId));
    });
    this.rescoreWhere('source_id = ?', [sourceId]);
  }

  private scoreRow(r: Pick<CatalogRow, 'popularity_json' | 'rank_popular' | 'rank_trending' | 'tags_json' | 'published_at' | 'discovered_at'>, at: number) {
    const signals = json<PopularitySignals | null>(r.popularity_json ?? null, null);
    const tags = json<string[]>(r.tags_json, []);
    return {
      pop: popularScore({ signals, rank: r.rank_popular ?? null, tags }),
      trend: trendingScore({ signals, rank: r.rank_trending ?? null, popularRank: r.rank_popular ?? null, tags, published: r.published_at ?? null, discovered: r.discovered_at, now: at }),
    };
  }

  rescore(id: number) {
    this.rescoreWhere('id = ?', [id]);
  }

  /** Recomputes sort scores (trending decays with age, so this also runs daily). */
  rescoreWhere(where = '1 = 1', params: Array<string | number> = []) {
    const rows = this.db.prepare(`SELECT id, popularity_json, rank_popular, rank_trending, tags_json, published_at, discovered_at FROM catalog WHERE ${where}`).all(...params) as unknown as Array<CatalogRow>;
    const at = Date.now();
    const set = this.db.prepare('UPDATE catalog SET pop_score = ?, trend_score = ? WHERE id = ?');
    tx(this.db, () => { for (const r of rows) { const s = this.scoreRow(r, at); set.run(s.pop, s.trend, r.id); } });
  }

  setArtwork(id: number, file: string | null) {
    this.st.get('UPDATE catalog SET artwork_file = ? WHERE id = ?').run(file, id);
  }

  setScreenshotFiles(id: number, files: Array<{ file: string; score: number }>) {
    this.st.get('UPDATE catalog SET screenshot_files_json = ? WHERE id = ?').run(JSON.stringify(files), id);
  }

  setRating(id: number, rating: ContentRating, score: number, reasons: string[], classifierVersion: string) {
    this.st
      .get('UPDATE catalog SET rating = ?, rating_score = ?, rating_reasons_json = ?, classifier_version = ?, classify_attempts = classify_attempts + 1, updated_at = ? WHERE id = ?')
      .run(rating, score, JSON.stringify(reasons), classifierVersion, now(), id);
  }

  raw(id: number): CatalogRaw | null {
    const r = this.st.get('SELECT * FROM catalog WHERE id = ?').get(id) as CatalogRow | undefined;
    return r ? this.toRaw(r) : null;
  }

  /** Entries that still need classification (new, failed or classified by an older model). */
  needingClassification(classifierVersion: string, limit = 50, downloadableOnly = false): CatalogRaw[] {
    const rows = this.st
      .get(
        `SELECT * FROM catalog WHERE (rating = 'unknown' OR classifier_version IS NULL OR classifier_version != ?) AND classify_attempts < 4 ${downloadableOnly ? "AND download_status IN ('available', 'listed')" : ''}
         ORDER BY discovered_at DESC LIMIT ?`,
      )
      .all(classifierVersion, limit) as unknown as CatalogRow[];
    return rows.map((r) => this.toRaw(r));
  }

  needingDetail(sourceId: number, policy: VisibilityPolicy, limit: number): CatalogRaw[] {
    // Adult entries get detail pages only while adult content may be shown.
    const ratings = policy.showNsfw ? `('safe','adult','unknown')` : `('safe','unknown')`;
    const rows = this.st
      .get(`SELECT * FROM catalog WHERE source_id = ? AND detail_fetched_at IS NULL AND detail_attempts < 3 AND rating IN ${ratings} ORDER BY detail_attempts, discovered_at, id LIMIT ?`)
      .all(sourceId, limit) as unknown as CatalogRow[];
    return rows.map((r) => this.toRaw(r));
  }

  /** Columns every Store listing adds to a catalog row. */
  private static readonly LIST_COLUMNS = `c.*, s.name AS source_name, s.url AS source_url,
           (SELECT g.id FROM games g WHERE g.catalog_id = c.id LIMIT 1) AS game_id,
           (SELECT g.update_json FROM games g WHERE g.catalog_id = c.id LIMIT 1) AS game_update,
           (SELECT d.id FROM downloads d WHERE d.catalog_id = c.id AND d.state != 'cancelled' ORDER BY d.id DESC LIMIT 1) AS download_id,
           EXISTS (SELECT 1 FROM wishlist w WHERE w.catalog_id = c.id) AS wishlisted`;

  query(policy: VisibilityPolicy, q: CatalogQuery): { total: number; entries: CatalogEntry[]; fuzzy?: boolean } {
    const where: string[] = ["c.download_status IN ('available', 'listed')", `c.rating IN (${visibleRatings(policy).map((r) => `'${r}'`).join(',')})`];
    const params: Array<string | number> = [];
    if (q.sourceIds?.length) {
      where.push(`c.source_id IN (${q.sourceIds.map(() => '?').join(',')})`);
      params.push(...q.sourceIds);
    }
    if (q.platforms?.length) {
      where.push(`(${q.platforms.map(() => `c.platforms_json LIKE ?`).join(' OR ')})`);
      params.push(...q.platforms.map((p) => `%"${p}"%`));
    }
    for (const [column, values] of [['categories_json', q.categories], ['tags_json', q.tags]] as const) {
      if (values?.length) {
        where.push(`EXISTS (SELECT 1 FROM json_each(c.${column}) facet WHERE lower(facet.value) IN (${values.map(() => '?').join(',')}))`);
        params.push(...values.map((v) => v.trim().toLowerCase()));
      }
    }
    if (q.wishlist) where.push('EXISTS (SELECT 1 FROM wishlist w WHERE w.catalog_id = c.id)');
    const base = { where: [...where], params: [...params] };
    const search = q.search?.trim();
    if (search) {
      where.push('(c.title LIKE ? ESCAPE \'\\\' OR c.description LIKE ? ESCAPE \'\\\' OR c.tags_json LIKE ? ESCAPE \'\\\')');
      const like = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like, like);
    }
    const w = where.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM catalog c WHERE ${w}`).get(...params) as { n: number }).n;
    // Nothing contains the typed text: the closest titles instead ("witcer" → "The Witcher").
    if (search && total === 0) return this.fuzzyQuery(search, base, q);
    const rows = this.db
      .prepare(`SELECT ${CatalogRepo.LIST_COLUMNS} FROM catalog c JOIN sources s ON s.id = c.source_id WHERE ${w}
         ORDER BY ${CATALOG_ORDER[q.sort ?? 'new']} LIMIT ? OFFSET ?`)
      .all(...params, q.limit ?? 120, q.offset ?? 0) as unknown as CatalogRow[];
    return { total, entries: rows.map((r) => this.toEntry(r)) };
  }

  private fuzzyQuery(search: string, base: { where: string[]; params: Array<string | number> }, q: CatalogQuery) {
    const titles = this.db.prepare(`SELECT c.id, c.title FROM catalog c WHERE ${base.where.join(' AND ')}`).all(...base.params) as Array<{ id: number; title: string }>;
    const ranked = titles.map((t) => ({ id: t.id, score: titleSimilarity(search, t.title) })).filter((t) => t.score >= 0.7).sort((a, b) => b.score - a.score).slice(0, 200);
    const page = ranked.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 120));
    if (!page.length) return { total: 0, entries: [], fuzzy: true };
    const rows = this.db.prepare(`SELECT ${CatalogRepo.LIST_COLUMNS} FROM catalog c JOIN sources s ON s.id = c.source_id WHERE c.id IN (${page.map(() => '?').join(',')})`).all(...page.map((p) => p.id)) as unknown as CatalogRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { total: ranked.length, entries: page.flatMap((p) => (byId.has(p.id) ? [this.toEntry(byId.get(p.id)!)] : [])), fuzzy: true };
  }

  /** Games sharing genres (weighted) and tags with this one, most popular first. */
  similar(id: number, policy: VisibilityPolicy, limit = 8): CatalogEntry[] {
    const ratings = visibleRatings(policy).map((r) => `'${r}'`).join(',');
    const rows = this.db.prepare(`SELECT * FROM (
        SELECT ${CatalogRepo.LIST_COLUMNS},
          2 * (SELECT COUNT(*) FROM json_each(c.categories_json) a WHERE lower(a.value) IN (SELECT lower(m.value) FROM catalog me, json_each(me.categories_json) m WHERE me.id = ?))
            + (SELECT COUNT(*) FROM json_each(c.tags_json) a WHERE lower(a.value) IN (SELECT lower(m.value) FROM catalog me, json_each(me.tags_json) m WHERE me.id = ?)) AS overlap
        FROM catalog c JOIN sources s ON s.id = c.source_id
        WHERE c.id != ? AND c.download_status = 'available' AND c.rating IN (${ratings})
      ) WHERE overlap > 0 ORDER BY overlap DESC, pop_score DESC, discovered_at DESC LIMIT ?`).all(id, id, id, limit) as unknown as CatalogRow[];
    return rows.map((r) => this.toEntry(r));
  }

  /** Filter values with how many visible games carry them, most common first; noise tags are left out. */
  facets(policy: VisibilityPolicy): { categories: Array<{ name: string; count: number }>; tags: Array<{ name: string; count: number }>; ranked: number } {
    const ratings = visibleRatings(policy).map((r) => `'${r}'`).join(',');
    const values = (column: string) => this.db.prepare(`SELECT lower(trim(f.value)) AS name, COUNT(DISTINCT c.id) AS count FROM catalog c, json_each(c.${column}) f
      WHERE c.download_status IN ('available', 'listed') AND c.rating IN (${ratings}) GROUP BY lower(trim(f.value)) ORDER BY count DESC, name COLLATE NOCASE`).all() as Array<{ name: string; count: number }>;
    const ranked = (this.db.prepare(`SELECT COUNT(*) AS n FROM catalog c WHERE c.download_status IN ('available', 'listed') AND c.rating IN (${ratings}) AND (c.pop_score > 0 OR c.rank_trending IS NOT NULL)`).get() as { n: number }).n;
    return { categories: values('categories_json').filter((c) => c.name), tags: values('tags_json').filter((t) => usefulTag(t.name)).slice(0, 1500), ranked };
  }

  /** Returns the entry only if visible under the policy. */
  get(id: number, policy: VisibilityPolicy): CatalogEntry | null {
    const r = this.st
      .get(
        `SELECT ${CatalogRepo.LIST_COLUMNS} FROM catalog c JOIN sources s ON s.id = c.source_id WHERE c.id = ?`,
      )
      .get(id) as CatalogRow | undefined;
    if (!r || (r.download_status !== 'available' && r.download_status !== 'listed') || !visibleRatings(policy).includes(r.rating)) return null;
    const entry = this.toEntry(r);
    entry.steam = json<SteamMedia | null>(r.steam_json ?? null, null);
    entry.screenshots = this.toRaw(r)
      .screenshotFiles.filter((f) => policy.showNsfw || f.score < NSFW_IMAGE_THRESHOLD)
      .map((f) => `cgl-media://artwork/${encodeURIComponent(f.file)}`);
    return entry;
  }

  /** Ids that are not visible under the policy (sent to the renderer to purge caches). */
  hiddenIds(policy: VisibilityPolicy): number[] {
    const visible = visibleRatings(policy);
    return (this.db.prepare(`SELECT id FROM catalog WHERE download_status NOT IN ('available', 'listed') OR rating NOT IN (${visible.map((r) => `'${r}'`).join(',')})`).all() as Array<{ id: number }>).map((r) => r.id);
  }

  /** Whether an artwork file may be served under the policy. */
  artworkVisible(file: string, policy: VisibilityPolicy): boolean {
    const ratings = visibleRatings(policy)
      .map((r) => `'${r}'`)
      .join(',');
    const viaCatalog = this.st.get(`SELECT 1 FROM catalog WHERE artwork_file = ? AND rating IN (${ratings}) LIMIT 1`).get(file);
    if (viaCatalog) return true;
    // Screenshots: the entry must be visible and the image itself must pass on its own score.
    const shots = this.db
      .prepare(`SELECT screenshot_files_json AS j FROM catalog WHERE rating IN (${ratings}) AND screenshot_files_json LIKE ? LIMIT 5`)
      .all(`%${file}%`) as Array<{ j: string }>;
    for (const row of shots) {
      const hit = json<Array<{ file: string; score: number }>>(row.j, []).find((f) => f.file === file);
      if (hit && (policy.showNsfw || hit.score < NSFW_IMAGE_THRESHOLD)) return true;
    }
    const viaGame = this.st
      .get(`SELECT 1 FROM games g LEFT JOIN catalog c ON c.id = g.catalog_id WHERE g.artwork_file = ? AND (c.id IS NULL OR c.rating IN (${ratings})) LIMIT 1`)
      .get(file);
    return !!viaGame;
  }

  ratingOfPage(url: string): ContentRating | null {
    const r = this.st.get('SELECT rating FROM catalog WHERE page_url = ? LIMIT 1').get(url) as { rating: ContentRating } | undefined;
    return r?.rating ?? null;
  }

  clearAll() {
    this.db.exec('DELETE FROM catalog');
  }

  count(sourceId: number): number {
    return (this.st.get('SELECT COUNT(*) AS n FROM catalog WHERE source_id = ?').get(sourceId) as { n: number }).n;
  }
}

interface DownloadRow {
  id: number;
  catalog_id: number | null;
  title: string;
  source_host: string | null;
  url: string | null;
  headers_json: string;
  file_name: string | null;
  part_path: string | null;
  final_path: string | null;
  total_bytes: number | null;
  received_bytes: number;
  etag: string | null;
  last_modified: string | null;
  resumable: number;
  state: DownloadState;
  error_code: DownloadErrorCode | null;
  error_detail: string | null;
  retries: number;
  position: number;
  user_prompt_json: string | null;
  resolution_json: string | null;
  compat_json: string | null;
  model_json: string | null;
  install_state: InstallState;
  install_detail: string | null;
  preparation_json: string | null;
  game_id: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  update_game_id?: number | null;
  group_id?: number | null;
  part_index?: number | null;
  part_total?: number | null;
  artwork_file?: string | null;
}

export interface DownloadRecord {
  id: number;
  catalogId: number | null;
  title: string;
  sourceHost: string | null;
  url: string | null;
  headers: Record<string, string>;
  fileName: string | null;
  partPath: string | null;
  finalPath: string | null;
  totalBytes: number | null;
  receivedBytes: number;
  etag: string | null;
  lastModified: string | null;
  resumable: boolean;
  state: DownloadState;
  errorCode: DownloadErrorCode | null;
  errorDetail: string | null;
  retries: number;
  position: number;
  userPrompt: UserPrompt | null;
  resolution: ResolutionCheckpoint | null;
  compatPackage: ProtonPackage | null;
  modelAsset: {modelId:string;role:'model'|'vision'} | null;
  installState: InstallState;
  installDetail: string | null;
  preparation: InstallResult | null;
  gameId: number | null;
  /** This download is a newer build of an installed game, not a new install. */
  updateGameId: number | null;
  /** Part of a game split into several files: the group is the first part's download id. */
  groupId: number | null;
  partIndex: number | null;
  /** Number of parts, or null while it is not known yet. */
  partTotal: number | null;
  createdAt: string;
  completedAt: string | null;
  artworkFile: string | null;
}

/** Saved progress of AI download resolution, so it can resume after leaving the Store. */
export interface ResolutionCheckpoint {
  pageUrl: string;
  steps: number;
  history: string[];
  /** Mirror hosts that showed a human check; the agent tries others first. */
  gatedHosts?: string[];
  /** A direct link to this part seen next to an earlier part. */
  partUrl?: string;
  /** Example file name of the wanted part ("game.part2.rar"), for the AI's instructions. */
  partName?: string;
}

export class DownloadsRepo {
  private st: Statements;
  constructor(private db: Db) {
    this.st = new Statements(db);
  }

  private map(r: DownloadRow): DownloadRecord {
    return {
      id: r.id,
      catalogId: r.catalog_id,
      title: r.title,
      sourceHost: r.source_host,
      url: r.url,
      headers: json(r.headers_json, {}),
      fileName: r.file_name,
      partPath: r.part_path,
      finalPath: r.final_path,
      totalBytes: r.total_bytes,
      receivedBytes: r.received_bytes,
      etag: r.etag,
      lastModified: r.last_modified,
      resumable: !!r.resumable,
      state: r.state,
      errorCode: r.error_code,
      errorDetail: r.error_detail,
      retries: r.retries,
      position: r.position,
      userPrompt: json(r.user_prompt_json, null),
      resolution: json(r.resolution_json, null),
      compatPackage: json(r.compat_json, null),
      modelAsset: json(r.model_json, null),
      installState: r.install_state,
      installDetail: r.install_detail,
      preparation: json(r.preparation_json, null),
      gameId: r.game_id,
      updateGameId: r.update_game_id ?? null,
      groupId: r.group_id ?? null,
      partIndex: r.part_index ?? null,
      partTotal: r.part_total ?? null,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      artworkFile: r.artwork_file ?? null,
    };
  }

  create(d: { catalogId: number | null; title: string; sourceHost: string | null; state: DownloadState }): DownloadRecord {
    const pos = (this.st.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM downloads').get() as { p: number }).p;
    const r = this.st
      .get('INSERT INTO downloads (catalog_id, title, source_host, state, position) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .get(d.catalogId, d.title, d.sourceHost, d.state, pos) as { id: number };
    return this.get(r.id)!;
  }

  get(id: number): DownloadRecord | null {
    const r = this.st
      .get('SELECT d.*, c.artwork_file FROM downloads d LEFT JOIN catalog c ON c.id = d.catalog_id WHERE d.id = ?')
      .get(id) as DownloadRow | undefined;
    return r ? this.map(r) : null;
  }

  list(): DownloadRecord[] {
    const rows = this.st
      .get(`SELECT d.*, c.artwork_file FROM downloads d LEFT JOIN catalog c ON c.id = d.catalog_id WHERE d.state != 'cancelled' ORDER BY d.position`)
      .all() as unknown as DownloadRow[];
    return rows.map((r) => this.map(r));
  }

  byState(...states: DownloadState[]): DownloadRecord[] {
    return this.list().filter((d) => states.includes(d.state));
  }

  /** Every part of a split game, in part order. */
  group(groupId: number): DownloadRecord[] {
    return this.list().filter((d) => d.groupId === groupId || d.id === groupId).sort((a, b) => (a.partIndex ?? 1) - (b.partIndex ?? 1));
  }

  activeForCatalog(catalogId: number): DownloadRecord | null {
    const r = this.st
      .get(`SELECT d.*, NULL AS artwork_file FROM downloads d WHERE catalog_id = ? AND state NOT IN ('cancelled','completed','failed') ORDER BY id DESC LIMIT 1`)
      .get(catalogId) as DownloadRow | undefined;
    return r ? this.map(r) : null;
  }

  update(id: number, patch: Partial<Omit<DownloadRecord, 'id' | 'createdAt' | 'artworkFile'>>) {
    const cols: Record<string, string> = {
      catalogId: 'catalog_id',
      title: 'title',
      sourceHost: 'source_host',
      url: 'url',
      headers: 'headers_json',
      fileName: 'file_name',
      partPath: 'part_path',
      finalPath: 'final_path',
      totalBytes: 'total_bytes',
      receivedBytes: 'received_bytes',
      etag: 'etag',
      lastModified: 'last_modified',
      resumable: 'resumable',
      state: 'state',
      errorCode: 'error_code',
      errorDetail: 'error_detail',
      retries: 'retries',
      position: 'position',
      userPrompt: 'user_prompt_json',
      resolution: 'resolution_json',
      compatPackage: 'compat_json',
      modelAsset: 'model_json',
      installState: 'install_state',
      installDetail: 'install_detail',
      preparation: 'preparation_json',
      gameId: 'game_id',
      updateGameId: 'update_game_id',
      groupId: 'group_id',
      partIndex: 'part_index',
      partTotal: 'part_total',
      completedAt: 'completed_at',
    };
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      if (k === 'headers' || k === 'userPrompt' || k === 'resolution' || k === 'compatPackage' || k === 'modelAsset' || k === 'preparation') vals.push(v === null ? null : JSON.stringify(v));
      else if (typeof v === 'boolean') vals.push(v ? 1 : 0);
      else vals.push(v as string | number | null);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    vals.push(now());
    this.db.prepare(`UPDATE downloads SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  remove(id: number) {
    this.st.get('DELETE FROM downloads WHERE id = ?').run(id);
  }

  move(id: number, direction: 'up' | 'down') {
    tx(this.db, () => {
      const list = this.list();
      const i = list.findIndex((d) => d.id === id);
      const j = direction === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= list.length) return;
      this.st.get('UPDATE downloads SET position = ? WHERE id = ?').run(list[j].position, list[i].id);
      this.st.get('UPDATE downloads SET position = ? WHERE id = ?').run(list[i].position, list[j].id);
    });
  }
}

interface GameRow {
  id: number;
  catalog_id: number | null;
  download_id: number | null;
  title: string;
  kind: 'linux' | 'windows';
  install_dir: string | null;
  executable: string | null;
  args: string;
  runner: Runner;
  prefix_dir: string | null;
  managed: number;
  favorite: number;
  artwork_file: string | null;
  source_host: string | null;
  status: GameStatus;
  candidates_json: string;
  added_at: string;
  last_played_at: string | null;
  playtime_seconds: number;
  catalog_rating?: ContentRating | null;
  catalog_steam?: string | null;
  installed_version_json: string | null;
  update_json: string | null;
  previous_json: string | null;
  update_checked_at: string | null;
  archive_kept?: number;
  launch_json?: string | null;
  redist_json?: string | null;
}

/** The build an update replaced, kept until the new one has been played. */
export interface PreviousBuild {
  installDir: string | null;
  executable: string | null;
  kind: 'linux' | 'windows';
  runner: Runner;
  candidates: string[];
  version: InstalledVersion | null;
  replacedAt: string;
}

export interface GameRecord extends Omit<Game, 'running' | 'artwork' | 'executableCandidates' | 'version' | 'previousVersion' | 'canRollback' | 'archive' | 'launch' | 'art'> {
  downloadId: number | null;
  artworkFile: string | null;
  candidates: string[];
  catalogRating: ContentRating | null;
  installedVersion: InstalledVersion | null;
  previous: PreviousBuild | null;
  updateCheckedAt: string | null;
  /** The user chose to keep the downloaded archive. */
  archiveKept: boolean;
  launch: LaunchOptions;
  art: Game['art'];
  /** Runtime installers already run in the game's prefix (relative paths), or null before the first start. */
  redistDone: string[] | null;
}

export class GamesRepo {
  private st: Statements;
  constructor(private db: Db) {
    this.st = new Statements(db);
  }

  private map(r: GameRow): GameRecord {
    return {
      id: r.id,
      catalogId: r.catalog_id,
      downloadId: r.download_id,
      title: r.title,
      kind: r.kind,
      installDir: r.install_dir,
      executable: r.executable,
      args: r.args,
      runner: r.runner,
      prefixDir: r.prefix_dir,
      managed: !!r.managed,
      favorite: !!r.favorite,
      artworkFile: r.artwork_file,
      sourceHost: r.source_host,
      addedAt: r.added_at,
      lastPlayedAt: r.last_played_at,
      playtimeSeconds: r.playtime_seconds,
      status: r.status,
      candidates: json(r.candidates_json, []),
      catalogRating: r.catalog_rating ?? null,
      installedVersion: json(r.installed_version_json, null),
      update: json(r.update_json, null),
      previous: json(r.previous_json, null),
      updateCheckedAt: r.update_checked_at,
      archiveKept: !!r.archive_kept,
      launch: { ...DEFAULT_LAUNCH, ...json<Partial<LaunchOptions>>(r.launch_json ?? null, {}) },
      redistDone: json<string[] | null>(r.redist_json ?? null, null),
      art: ((m: SteamMedia | null) => (m ? { hero: m.hero, logo: m.logo, capsule: m.capsule, appid: m.appid } : null))(json<SteamMedia | null>(r.catalog_steam ?? null, null)),
    };
  }

  create(g: Omit<GameRecord, 'id' | 'addedAt' | 'lastPlayedAt' | 'playtimeSeconds' | 'favorite' | 'catalogRating' | 'installedVersion' | 'update' | 'previous' | 'updateCheckedAt' | 'archiveKept' | 'launch' | 'art' | 'redistDone'> & { installedVersion?: InstalledVersion | null }): GameRecord {
    const r = this.st
      .get(
        `INSERT INTO games (catalog_id, download_id, title, kind, install_dir, executable, args, runner, prefix_dir, managed, artwork_file, source_host, status, candidates_json, installed_version_json, update_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        g.catalogId,
        g.downloadId,
        g.title,
        g.kind,
        g.installDir,
        g.executable,
        g.args,
        g.runner,
        g.prefixDir,
        g.managed ? 1 : 0,
        g.artworkFile,
        g.sourceHost,
        g.status,
        JSON.stringify(g.candidates),
        g.installedVersion ? JSON.stringify(g.installedVersion) : null,
        now(),
      ) as { id: number };
    return this.get(r.id)!;
  }

  get(id: number): GameRecord | null {
    const r = this.st.get('SELECT g.*, c.rating AS catalog_rating, c.steam_json AS catalog_steam FROM games g LEFT JOIN catalog c ON c.id = g.catalog_id WHERE g.id = ?').get(id) as GameRow | undefined;
    return r ? this.map(r) : null;
  }

  list(): GameRecord[] {
    const rows = this.st
      .get('SELECT g.*, c.rating AS catalog_rating, c.steam_json AS catalog_steam FROM games g LEFT JOIN catalog c ON c.id = g.catalog_id ORDER BY g.favorite DESC, COALESCE(g.last_played_at, g.added_at) DESC')
      .all() as unknown as GameRow[];
    return rows.map((r) => this.map(r));
  }

  update(id: number, patch: Partial<Pick<GameRecord, 'title' | 'executable' | 'args' | 'runner' | 'prefixDir' | 'favorite' | 'status' | 'candidates' | 'kind' | 'installDir' | 'artworkFile' | 'installedVersion' | 'update' | 'previous' | 'updateCheckedAt' | 'downloadId' | 'archiveKept' | 'launch' | 'redistDone'>>) {
    const cols: Record<string, string> = {
      title: 'title',
      executable: 'executable',
      args: 'args',
      runner: 'runner',
      prefixDir: 'prefix_dir',
      favorite: 'favorite',
      status: 'status',
      candidates: 'candidates_json',
      kind: 'kind',
      installDir: 'install_dir',
      artworkFile: 'artwork_file',
      installedVersion: 'installed_version_json',
      update: 'update_json',
      previous: 'previous_json',
      updateCheckedAt: 'update_checked_at',
      downloadId: 'download_id',
      archiveKept: 'archive_kept',
      launch: 'launch_json',
      redistDone: 'redist_json',
    };
    const jsonCols = new Set(['candidates', 'installedVersion', 'update', 'previous', 'launch', 'redistDone']);
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!cols[k] || v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      vals.push(jsonCols.has(k) ? (v === null ? null : JSON.stringify(v)) : typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null));
    }
    if (sets.length) this.db.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  recordPlay(id: number, seconds: number, endedAt = new Date()) {
    const s = Math.max(0, Math.round(seconds));
    this.st.get('UPDATE games SET last_played_at = ?, playtime_seconds = playtime_seconds + ? WHERE id = ?').run(endedAt.toISOString(), s, id);
    if (s > 0) this.st.get('INSERT INTO play_sessions (game_id, started_at, seconds) VALUES (?, ?, ?)').run(id, new Date(endedAt.getTime() - s * 1000).toISOString(), s);
  }

  /** Play time of the last seven days (local days, today last), per day and per game. */
  playStats(today = new Date()): PlayStats {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
    const rows = this.st.get('SELECT s.game_id AS gameId, s.started_at AS startedAt, s.seconds AS seconds FROM play_sessions s JOIN games g ON g.id = s.game_id WHERE s.started_at >= ? ORDER BY s.started_at')
      .all(start.toISOString()) as Array<{ gameId: number; startedAt: string; seconds: number }>;
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, seconds: 0 };
    });
    const games = new Map<number, { seconds: number; sessions: number }>();
    for (const r of rows) {
      const at = new Date(r.startedAt);
      const i = Math.floor((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - start.getTime()) / 86_400_000);
      if (i >= 0 && i < 7) days[i].seconds += r.seconds;
      const g = games.get(r.gameId) ?? { seconds: 0, sessions: 0 };
      g.seconds += r.seconds;
      g.sessions++;
      games.set(r.gameId, g);
    }
    return {
      days,
      weekSeconds: days.reduce((n, d) => n + d.seconds, 0),
      games: [...games].map(([gameId, g]) => ({ gameId, ...g })).sort((a, b) => b.seconds - a.seconds),
    };
  }

  remove(id: number) {
    this.st.get('DELETE FROM play_sessions WHERE game_id = ?').run(id);
    this.st.get('DELETE FROM games WHERE id = ?').run(id);
  }
}

interface WishRow { id: number; catalog_id: number | null; title: string; title_key: string; version_key: string | null; created_at: string; notified_at: string | null }

export class WishlistRepo {
  private st: Statements;
  constructor(private db: Db) {
    this.st = new Statements(db);
  }
  private map(r: WishRow) {
    return { id: r.id, catalogId: r.catalog_id, title: r.title, titleKey: r.title_key, versionKey: r.version_key, createdAt: r.created_at, notifiedAt: r.notified_at };
  }
  list() {
    return (this.st.get('SELECT * FROM wishlist ORDER BY created_at DESC').all() as unknown as WishRow[]).map((r) => this.map(r));
  }
  forCatalog(catalogId: number) {
    const r = this.st.get('SELECT * FROM wishlist WHERE catalog_id = ?').get(catalogId) as WishRow | undefined;
    return r ? this.map(r) : null;
  }
  /** Titles wanted but not in the catalog yet. */
  waiting() {
    return (this.st.get('SELECT * FROM wishlist WHERE catalog_id IS NULL').all() as unknown as WishRow[]).map((r) => this.map(r));
  }
  add(w: { catalogId: number | null; title: string; titleKey: string; versionKey?: string | null }) {
    if (w.catalogId !== null && this.forCatalog(w.catalogId)) return this.forCatalog(w.catalogId)!;
    const r = this.st.get('INSERT INTO wishlist (catalog_id, title, title_key, version_key) VALUES (?, ?, ?, ?) RETURNING *').get(w.catalogId, w.title, w.titleKey, w.versionKey ?? null) as unknown as WishRow;
    return this.map(r);
  }
  remove(id: number) {
    this.st.get('DELETE FROM wishlist WHERE id = ?').run(id);
  }
  removeCatalog(catalogId: number) {
    this.st.get('DELETE FROM wishlist WHERE catalog_id = ?').run(catalogId);
  }
  link(id: number, catalogId: number, versionKey: string | null) {
    this.st.get('UPDATE wishlist SET catalog_id = ?, version_key = ?, notified_at = ? WHERE id = ?').run(catalogId, versionKey, now(), id);
  }
  setVersion(id: number, versionKey: string | null, notified: boolean) {
    this.st.get('UPDATE wishlist SET version_key = ?, notified_at = COALESCE(?, notified_at) WHERE id = ?').run(versionKey, notified ? now() : null, id);
  }
}

export class AiCacheRepo {
  private st: Statements;
  constructor(private db: Db) {
    this.st = new Statements(db);
  }
  get<T>(key: string, maxAgeHours = 24 * 7): T | null {
    const r = this.st.get(`SELECT value FROM ai_cache WHERE key = ? AND created_at > ?`).get(key, new Date(Date.now() - maxAgeHours * 3600_000).toISOString()) as
      | { value: string }
      | undefined;
    return r ? json<T | null>(r.value, null) : null;
  }
  set(key: string, value: unknown) {
    this.st.get('INSERT INTO ai_cache (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at').run(key, JSON.stringify(value));
  }
  clear() {
    this.db.exec('DELETE FROM ai_cache');
  }
}

export class ImageClassRepo {
  private st: Statements;
  constructor(private db: Db) {
    this.st = new Statements(db);
  }
  get(url: string, version: string): { score: number | null; failed: boolean } | null {
    const r = this.st.get('SELECT score, failed FROM image_class WHERE url = ? AND classifier_version = ?').get(url, version) as
      | { score: number | null; failed: number }
      | undefined;
    return r ? { score: r.score, failed: !!r.failed } : null;
  }
  set(url: string, version: string, score: number | null) {
    this.st
      .get('INSERT INTO image_class (url, score, classifier_version, failed) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET score = excluded.score, classifier_version = excluded.classifier_version, failed = excluded.failed, created_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')')
      .run(url, score, version, score === null ? 1 : 0);
  }
  clear() {
    this.db.exec('DELETE FROM image_class');
  }
}

export function toDownloadItem(d: DownloadRecord, live?: { speedBps: number; etaSeconds: number | null; connections?: number }): DownloadItem {
  return {
    id: d.id,
    catalogId: d.catalogId,
    title: d.title,
    sourceHost: d.sourceHost,
    fileName: d.fileName,
    url: d.url,
    totalBytes: d.totalBytes,
    receivedBytes: d.receivedBytes,
    speedBps: live?.speedBps ?? 0,
    connections: live?.connections ?? 0,
    etaSeconds: live?.etaSeconds ?? null,
    state: d.state,
    errorCode: d.errorCode,
    errorDetail: d.errorDetail,
    resumable: d.resumable,
    retries: d.retries,
    position: d.position,
    installState: d.installState,
    installDetail: d.installDetail,
    gameId: d.gameId,
    updateFor: d.updateGameId,
    groupId: d.groupId,
    partIndex: d.partIndex,
    partTotal: d.partTotal,
    createdAt: d.createdAt,
    completedAt: d.completedAt,
    userPrompt: d.userPrompt,
    artwork: null,
  };
}
