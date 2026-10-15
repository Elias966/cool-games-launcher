import type {ModelList} from './models';
// IPC contract between renderer and main. Every request payload is validated
// in main against these schemas; anything that does not parse is rejected.
import { z } from 'zod';
import type {
  AiStatus,
  StoreSearchResult,
  ProtonReleaseList,
  BrowserSnapshot,
  CatalogEntry,
  CatalogFacets,
  SaveBackup,
  ProtonDbSummary,
  WishItem,
  CatalogPage,
  ConsentRecord,
  CrawlProgress,
  DownloadItem,
  Game,
  Settings,
  Source,
  SystemInfo,
} from './types';

const id = z.number().int().positive();
const platform = z.enum(['linux', 'windows', 'macos', 'android', 'web']);
const httpUrl = z
  .string()
  .max(2048)
  .refine((u) => {
    try {
      const p = new URL(u);
      return p.protocol === 'http:' || p.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Must be an http(s) URL');
const absPath = z.string().min(1).max(4096).startsWith('/');

export const settingsPatch = z
  .object({
    libraryDir: absPath,
    downloadsDir: absPath,
    aiModelId: z.string().min(1).max(100),
    aiThreads: z.number().int().min(1).max(64),
    aiContextSize: z.number().int().min(2048).max(32768),
    aiAcceleration: z.enum(['auto', 'vulkan', 'cpu']),
    aiImageTokens: z.number().int().min(256).max(2048),
    aiIdleUnloadMinutes: z.number().int().min(0).max(240),
    classifierThreads: z.number().int().min(1).max(16),
    maxConcurrentDownloads: z.number().int().min(1).max(6),
    downloadConnections: z.number().int().min(1).max(16),
    winePath: z.string().max(4096),
    protonPath: z.string().max(4096),
    umuPath: z.string().max(4096),
    effects: z.enum(['full', 'low']),
    motion: z.enum(['system', 'reduced', 'full']),
    uiSounds: z.boolean(),
    uiVolume: z.number().min(0).max(1),
    uiAmbient: z.boolean(),
    uiAmbientVolume: z.number().min(0).max(1),
    uiSoundGroups: z.object({ hover: z.boolean(), click: z.boolean(), navigation: z.boolean(), downloads: z.boolean(), alerts: z.boolean() }).strict(),
    crawlRefreshHours: z.number().int().min(1).max(24 * 30),
    gameUpdates: z.enum(['notify', 'auto']),
    afterInstall: z.enum(['ask', 'delete', 'keep']),
    saveBackups: z.boolean(),
    saveBackupsKeep: z.number().int().min(1).max(50),
    closeToTray: z.boolean(),
    freeGpuWhilePlaying: z.boolean(),
    clearBrowserDataOnExit: z.boolean(),
    sendDoNotTrack: z.boolean(),
  })
  .partial()
  .strict();

/** Request schemas, keyed by channel. */
export const requests = {
  'app:info': z.undefined(),
  'models:list': z.undefined(),
  'models:download': z.object({id:z.string().min(1).max(100)}).strict(),
  'models:select': z.object({id:z.string().min(1).max(100)}).strict(),
  'models:assign': z.object({role:z.enum(['browsing','computer','analysis']),id:z.string().min(1).max(100)}).strict(),
  'models:assignAll': z.object({id:z.string().min(1).max(100)}).strict(),
  'app:openFolder': z.object({ which: z.enum(['logs', 'data', 'games', 'downloads', 'cache']) }).strict(),
  'compat:status': z.undefined(),
  'compat:releases': z.object({ refresh: z.boolean().default(false) }).strict(),
  'compat:installVersion': z.object({ id: z.string().min(1).max(160) }).strict(),
  'compat:openRelease': z.object({ id: z.string().min(1).max(160) }).strict(),
  'compat:installProton': z.undefined(),
  'settings:get': z.undefined(),
  'settings:update': settingsPatch,
  'settings:pickDirectory': z.object({ title: z.string().max(200) }).strict(),
  'settings:clearCache': z.object({ what: z.enum(['artwork', 'ai', 'browser', 'catalog']) }).strict(),
  'consent:get': z.undefined(),
  /** Enabling requires the explicit acceptance flag that only the consent dialog sends. */
  'consent:enableNsfw': z.object({ acceptedWarning: z.literal(true) }).strict(),
  'consent:disableNsfw': z.undefined(),
  'sources:list': z.undefined(),
  'sources:add': z.object({ url: httpUrl, name: z.string().max(120).optional() }).strict(),
  'sources:update': z
    .object({
      id,
      name: z.string().min(1).max(120).optional(),
      enabled: z.boolean().optional(),
      maxPages: z.number().int().min(1).max(50).optional(),
      rateLimitMs: z.number().int().min(100).max(60000).optional(),
    })
    .strict(),
  'sources:remove': z.object({ id }).strict(),
  'sources:recrawl': z.object({ id }).strict(),
  'sources:resume': z.object({ id }).strict(),
  'sources:skipCheck': z.object({ id }).strict(),
  'store:searchFocus': z.object({ focused:z.boolean() }).strict(),
  'store:searchCancel': z.undefined(),
  'store:search': z.object({ query:z.string().trim().min(1).max(200),sourceIds:z.array(id).max(100).optional() }).strict(),
  'store:setActive': z.object({ active: z.boolean() }).strict(),
  'catalog:facets': z.undefined(),
  'catalog:list': z
    .object({
      search: z.string().max(200).optional(),
      sourceIds: z.array(id).max(100).optional(),
      platforms: z.array(platform).max(5).optional(),
      categories: z.array(z.string().min(1).max(60)).max(12).optional(),
      tags: z.array(z.string().min(1).max(60)).max(20).optional(),
      sort: z.enum(['popular', 'trending', 'new', 'title']).optional(),
      wishlist: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .strict(),
  'catalog:get': z.object({ id }).strict(),
  'catalog:similar': z.object({ id }).strict(),
  'compat:protondb': z.object({ appid: z.number().int().positive().max(100_000_000) }).strict(),
  /** Opens ProtonDB / Steam store pages in the user's own browser (nothing else). */
  'app:openExternal': z.object({ url: z.string().regex(/^https:\/\/(?:www\.protondb\.com|store\.steampowered\.com|github\.com\/Elias966\/cool-games-launcher)\//) }).strict(),
  'wishlist:list': z.undefined(),
  'wishlist:add': z.object({ catalogId: id.optional(), title: z.string().min(1).max(200).optional() }).strict(),
  'wishlist:remove': z.object({ id: id.optional(), catalogId: id.optional() }).strict(),
  'catalog:refreshDetail': z.object({ id }).strict(),
  'download:start': z.object({ catalogId: id }).strict(),
  'download:pause': z.object({ id }).strict(),
  'download:resume': z.object({ id }).strict(),
  'download:cancel': z.object({ id }).strict(),
  'download:retry': z.object({ id }).strict(),
  'download:remove': z.object({ id, deleteFile: z.boolean() }).strict(),
  'download:move': z.object({ id, direction: z.enum(['up', 'down']) }).strict(),
  'download:list': z.undefined(),
  'download:chooseFile': z.object({ id, url: httpUrl }).strict(),
  'download:continueResolution': z.object({ id }).strict(),
  'download:resolveAgain': z.object({ id }).strict(),
  'download:install': z.object({ id }).strict(),
  'download:reveal': z.object({ id }).strict(),
  'browser:open': z.object({ url: httpUrl }).strict(),
  'browser:show': z.undefined(),
  'browser:humanStart': z.undefined(),
  'browser:humanFinish': z.undefined(),
  'browser:close': z.undefined(),
  'browser:click': z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), button: z.enum(['left', 'middle', 'right']).default('left') }).strict(),
  'browser:scroll': z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), dy: z.number().min(-5000).max(5000), dx: z.number().min(-5000).max(5000).default(0) }).strict(),
  'browser:type': z.object({ text: z.string().max(2000) }).strict(),
  'browser:key': z.object({ key: z.enum(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Delete']) }).strict(),
  'browser:navigate': z.object({ action: z.enum(['back', 'forward', 'reload']) }).strict(),
  'library:list': z.undefined(),
  'library:launch': z.object({ id }).strict(),
  'library:stop': z.object({ id }).strict(),
  'library:favorite': z.object({ id, favorite: z.boolean() }).strict(),
  'library:uninstall': z.object({ id, removePrefix: z.boolean() }).strict(),
  'library:configure': z
    .object({
      id,
      title: z.string().min(1).max(200).optional(),
      executable: z.string().max(4096).optional(),
      args: z.string().max(2000).optional(),
      runner: z.enum(['native', 'wine', 'proton']).optional(),
      launch: z.object({
        protonPath: z.string().max(4096).nullable(),
        gamescope: z.boolean(),
        resolution: z.string().regex(/^\d{3,5}x\d{3,5}$/).nullable(),
        upscale: z.enum(['off', 'fsr', 'nis']),
        fpsLimit: z.number().int().min(10).max(500).nullable(),
        mangohud: z.boolean(),
        gamemode: z.boolean(),
        nvapi: z.boolean(),
        wined3d: z.boolean(),
        env: z.string().max(4000),
      }).partial().strict().optional(),
    })
    .strict(),
  'library:import': z.undefined(),
  'library:pickExecutable': z.object({ id }).strict(),
  'library:runInstaller': z.object({ id }).strict(),
  'library:reveal': z.object({ id }).strict(),
  'library:update': z.object({ id }).strict(),
  'library:ignoreUpdate': z.object({ id }).strict(),
  'library:rollback': z.object({ id }).strict(),
  'library:checkUpdates': z.undefined(),
  'library:deleteArchive': z.object({ id }).strict(),
  'library:saves': z.object({ id }).strict(),
  'library:backupSaves': z.object({ id }).strict(),
  'library:restoreSaves': z.object({ id, stamp: z.string().regex(/^[0-9TZ-]{10,40}$/) }).strict(),
  'library:openSaves': z.object({ id }).strict(),
  'library:shortcut': z.object({ id, where: z.enum(['menu', 'desktop']) }).strict(),
  'library:keepArchive': z.object({ id }).strict(),
} as const;

export type Channel = keyof typeof requests;
export type RequestOf<C extends Channel> = z.input<(typeof requests)[C]>;

/** Response types, keyed by channel. */
export interface Responses {
  'app:info': SystemInfo;
  'models:list': ModelList;
  'models:download': ModelList;
  'models:select': ModelList;
  'models:assign': ModelList;
  'models:assignAll': ModelList;
  'app:openFolder': void;
  'compat:releases': ProtonReleaseList;
  'compat:installVersion': Responses['compat:status'];
  'compat:openRelease': void;
  'compat:status': { protonPath: string | null; provisioning: boolean; python3: boolean };
  'compat:installProton': Responses['compat:status'];
  'settings:get': Settings;
  'settings:update': Settings;
  'settings:pickDirectory': string | null;
  'settings:clearCache': { freedBytes: number };
  'consent:get': ConsentRecord & { showNsfw: boolean; policyRevision: number };
  'consent:enableNsfw': Settings;
  'consent:disableNsfw': Settings;
  'sources:list': Source[];
  'sources:add': Source;
  'sources:update': Source;
  'sources:remove': void;
  'sources:recrawl': void;
  'sources:resume': void;
  'sources:skipCheck': void;
  'store:searchFocus': void;
  'store:searchCancel': void;
  'store:search': StoreSearchResult;
  'store:setActive': AiStatus;
  'catalog:facets': CatalogFacets;
  'catalog:list': CatalogPage;
  'catalog:similar': { policyRevision: number; entries: CatalogEntry[] };
  'compat:protondb': ProtonDbSummary | null;
  'app:openExternal': void;
  'wishlist:list': WishItem[];
  'wishlist:add': WishItem;
  'wishlist:remove': void;
  'catalog:get': { policyRevision: number; entry: CatalogEntry | null };
  'catalog:refreshDetail': void;
  'download:start': DownloadItem;
  'download:pause': void;
  'download:resume': void;
  'download:cancel': void;
  'download:retry': void;
  'download:remove': void;
  'download:move': void;
  'download:list': DownloadItem[];
  'download:chooseFile': void;
  'download:continueResolution': void;
  'download:resolveAgain': void;
  'download:install': void;
  'download:reveal': void;
  'browser:open': void;
  'browser:show': void;
  'browser:humanStart': void;
  'browser:humanFinish': void;
  'browser:close': void;
  'browser:click': void;
  'browser:scroll': void;
  'browser:type': void;
  'browser:key': void;
  'browser:navigate': void;
  'library:list': Game[];
  'library:launch': void;
  'library:stop': void;
  'library:favorite': void;
  'library:uninstall': void;
  'library:configure': Game;
  'library:import': Game | null;
  'library:pickExecutable': Game | null;
  'library:runInstaller': void;
  'library:reveal': void;
  'library:update': void;
  'library:ignoreUpdate': void;
  'library:rollback': void;
  'library:checkUpdates': { checking: number };
  'library:deleteArchive': { freed: number };
  'library:saves': SaveBackup[];
  'library:backupSaves': SaveBackup | null;
  'library:restoreSaves': { files: number };
  'library:openSaves': void;
  'library:shortcut': { path: string };
  'library:keepArchive': void;
}

/** Events pushed from main to the renderer. */
export interface Events {
  'policy:changed': { showNsfw: boolean; policyRevision: number };
  'settings:changed': Settings;
  'catalog:changed': { policyRevision: number; sourceId: number | null };
  'catalog:hidden': { policyRevision: number; ids: number[] };
  'sources:changed': Source[];
  'crawl:progress': CrawlProgress;
  'downloads:changed': DownloadItem[];
  'download:progress': Pick<DownloadItem, 'id' | 'receivedBytes' | 'totalBytes' | 'speedBps' | 'etaSeconds' | 'state' | 'connections'>;
  'library:changed': Game[];
  'ai:status': AiStatus;
  'models:changed': ModelList;
  'browser:snapshot': BrowserSnapshot & { policyRevision: number };
  'browser:humanMode': { active: boolean };
  'browser:closed': { reason: string | null };
  'browser:attention': { downloadId: number; sourceId?: number; message: string };
  'browser:verificationResolved': { sourceId: number };
  'toast': { kind: 'info' | 'success' | 'warning' | 'error'; message: string };
  'app:visibility': { visible: boolean };
  /** The tray asked for couch mode. */
  'app:couch': { on: boolean };
  /** A notification was clicked: show this game. */
  'app:openGame': { catalogId: number };
  'wishlist:changed': WishItem[];
}

export type EventName = keyof Events;

export interface InvokeResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** API exposed to the renderer by the preload script. */
export interface CglApi {
  invoke<C extends Channel>(channel: C, ...payload: RequestOf<C> extends undefined ? [] : [RequestOf<C>]): Promise<Responses[C]>;
  on<E extends EventName>(event: E, listener: (payload: Events[E]) => void): () => void;
  windowControl(action: 'minimize' | 'maximize' | 'close' | 'fullscreen-on' | 'fullscreen-off'): void;
}
