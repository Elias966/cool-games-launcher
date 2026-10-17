// Domain types shared by the main process, workers and renderer.

export type TabId = 'library' | 'store' | 'settings' | 'downloads';

/** Content classification of a catalog entry. `unknown` covers pending and failed checks. */
export type ContentRating = 'safe' | 'adult' | 'unknown';

export type Platform = 'linux' | 'windows' | 'macos' | 'android' | 'web';

export type SourceStatus = 'idle' | 'crawling' | 'ok' | 'blocked' | 'unsupported' | 'error';

export interface Source {
  id: number;
  url: string;
  name: string;
  enabled: boolean;
  maxPages: number;
  rateLimitMs: number;
  status: SourceStatus;
  statusDetail: string | null;
  lastCrawlAt: string | null;
  entryCount: number;
  createdAt: string;
  /** Set once the local AI has learned this site's layout. */
  learned: { at: string; browser: boolean } | null;
}

export interface DownloadCandidate {
  url: string;
  label: string;
  fileName: string | null;
  platform: Platform | null;
  sizeText: string | null;
}

/** Catalog entry as shown in the Store. Adult or unclassified entries are never sent unless permitted. */
export interface CatalogEntry {
  id: number;
  /** Listed by the AI; its download route is still being verified in the background. */
  verifying?: boolean;
  sourceId: number;
  sourceName: string;
  sourceHost: string;
  pageUrl: string;
  title: string;
  description: string | null;
  author: string | null;
  priceText: string | null;
  platforms: Platform[];
  tags: string[];
  categories: string[];
  /** cgl-media:// URL for the cached cover artwork, if any. */
  artwork: string | null;
  screenshots: string[];
  rating: ContentRating;
  ratingReasons: string[];
  discoveredAt: string;
  updatedAt: string;
  detailFetched: boolean;
  installedGameId: number | null;
  downloadId: number | null;
  /** The installed copy of this game has a newer build on the site. */
  updateAvailable?: boolean;
  /** Counters the game page publishes. */
  popularity?: { downloads: number | null; views: number | null; ratings: number | null; rating: number | null } | null;
  /** Position in the site's own Popular / Trending lists (1 = first). */
  rankPopular?: number | null;
  rankTrending?: number | null;
  /** Where the description came from when not the site itself ("steam"). */
  descriptionSource?: string | null;
  /** Artwork, reviews, screenshots and trailers from the game's Steam store page. */
  steam?: SteamMedia | null;
  wishlisted?: boolean;
}

export interface WishItem {
  id: number;
  title: string;
  /** Set once the game is in the catalog. */
  catalogId: number | null;
  createdAt: string;
}

/** Game stores whose accounts the launcher can use. */
export type StoreId = 'gog' | 'epic';

/** A game the person owns on GOG or Epic. */
export interface OwnedGame {
  store: StoreId;
  /** GOG product id or Epic app name. */
  id: string;
  title: string;
  /** Wide image for the card, and a big one for the background. */
  cover: string | null;
  hero: string | null;
  /** The Library game it is installed as, if any. */
  gameId: number | null;
}

/** What a store is doing for one game. */
export interface StoreJob {
  store: StoreId; id: string; kind: 'install' | 'update' | 'import';
  progress: number | null; detail: string | null;
  state: 'queued' | 'active' | 'paused' | 'failed' | 'completed' | 'cancelled';
  title: string; gameId: number | null; basePath: string;
  speedBps: number; receivedBytes: number; totalBytes: number | null;
  workers: number; createdAt: string;
}

export interface StoreAccount { loggedIn: boolean; user: string | null; error: string | null }
export interface StoresState { accounts: Record<StoreId, StoreAccount>; owned: OwnedGame[]; jobs: StoreJob[]; refreshing: boolean }

/** Images the person chose for a game; null means the default one. */
export interface GameImages { cover: string | null; hero: string | null }

/** What a game's images can be changed to. */
export interface ImageOptions { covers: string[]; heroes: string[] }

export interface SteamMedia {
  appid: number;
  /** Wide library banner (3840×1240). */
  hero: string | null;
  /** Transparent game logo. */
  logo: string | null;
  /** Store capsule (616×353), used for cards. */
  capsule: string | null;
  header: string | null;
  background: string | null;
  reviews: { label: string; percent: number; count: number } | null;
  released: string | null;
  screenshots: string[];
  trailers: Array<{ name: string; hls: string | null; preview: string | null; poster: string | null }>;
}

export interface CatalogQuery {
  search?: string;
  sourceIds?: number[];
  platforms?: Platform[];
  categories?: string[];
  tags?: string[];
  /** popular / trending: what people download and play most (from the sites' own lists and counters). */
  sort?: CatalogSort;
  /** Only wishlisted games. */
  wishlist?: boolean;
  limit?: number;
  offset?: number;
}

export type CatalogSort = 'popular' | 'trending' | 'new' | 'title';

export interface FacetValue {
  name: string;
  count: number;
}

export interface CatalogFacets {
  policyRevision: number;
  categories: FacetValue[];
  tags: FacetValue[];
  /** Games with any popularity information (site lists or counters); 0 means Popular falls back to newest. */
  ranked: number;
  /** Games still waiting for popularity data from their Steam page. */
  gathering?: number;
}

export interface CatalogPage {
  /** The policy revision the page was produced under. The renderer drops pages with an older revision. */
  policyRevision: number;
  total: number;
  entries: CatalogEntry[];
  /** No exact title matched; these are the closest titles (typo-tolerant search). */
  fuzzy?: boolean;
}

export type DownloadState =
  | 'queued'
  | 'resolving'
  | 'needs-user'
  | 'needs-resolution'
  | 'active'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'cancelled';

export type DownloadErrorCode =
  | 'network'
  | 'link-expired'
  | 'disk-full'
  | 'http'
  | 'not-a-file'
  | 'size-mismatch'
  | 'browser-only'
  | 'resolution-failed'
  | 'interrupted'
  | 'io';

export type InstallState = 'none' | 'installing' | 'installed' | 'failed';

export interface DownloadItem {
  /** Result of bounded, real transfer measurements for equivalent file mirrors. */
  mirrorChoice?: { host: string; speedBps: number; tested: number; measured?: number; unavailable?: number } | null;
  id: number;
  catalogId: number | null;
  /** Set for a Proton build the launcher is installing (its version name). */
  compatVersion?: string | null;
  title: string;
  sourceHost: string | null;
  fileName: string | null;
  url: string | null;
  totalBytes: number | null;
  receivedBytes: number;
  /** HTTP range connections used by this transfer; zero while connecting. */
  connections?: number;
  speedBps: number;
  etaSeconds: number | null;
  state: DownloadState;
  errorCode: DownloadErrorCode | null;
  errorDetail: string | null;
  resumable: boolean;
  retries: number;
  position: number;
  installState: InstallState;
  installDetail: string | null;
  gameId: number | null;
  /** A newer build for this installed game, not a new install. */
  updateFor?: number | null;
  /** Part of a game split into several files (group = the first part's download id). */
  groupId?: number | null;
  partIndex?: number | null;
  partTotal?: number | null;
  createdAt: string;
  completedAt: string | null;
  /** Human prompt while resolution waits for the user (login, CAPTCHA, payment, file choice). */
  userPrompt: UserPrompt | null;
  artwork: string | null;
}

export type UserPromptKind = 'login' | 'captcha' | 'payment' | 'choose-file' | 'blocked' | 'confirm';

export interface UserPrompt {
  kind: UserPromptKind;
  message: string;
  choices?: DownloadCandidate[];
}

export type Runner = 'native' | 'wine' | 'proton';

export type GameStatus = 'installed' | 'needs-executable' | 'installer-pending' | 'installing' | 'broken';

export interface Game {
  id: number;
  catalogId: number | null;
  title: string;
  kind: 'linux' | 'windows';
  installDir: string | null;
  executable: string | null;
  args: string;
  runner: Runner;
  prefixDir: string | null;
  managed: boolean;
  favorite: boolean;
  artwork: string | null;
  sourceHost: string | null;
  addedAt: string;
  lastPlayedAt: string | null;
  playtimeSeconds: number;
  status: GameStatus;
  running: boolean;
  executableCandidates: string[];
  /** Installed build ("v1.2", "build 1234"), when the site publishes one. */
  version: string | null;
  update: GameUpdateInfo | null;
  /** The previous build is kept after an update until the new one has been played. */
  previousVersion: string | null;
  canRollback: boolean;
  /** Downloaded files the installed game no longer needs (shown when Settings says "Ask"). */
  archive: { bytes: number; files: number } | null;
  launch: LaunchOptions;
  /** Steam artwork for the Library (banner, logo, capsule), when the game is on Steam. */
  art: { hero: string | null; logo: string | null; capsule: string | null; appid: number } | null;
  /** Images the person chose: the Library card's cover and the big background (null: the default). */
  images: GameImages;
  /** Installed from (or linked to) a GOG or Epic account; null for games from disk or websites. */
  store: StoreId | null;
  storeId: string | null;
  /** The store has a newer build than the installed one. */
  storeUpdate: boolean;
}

/** Per-game launch settings (Heroic-style). */
export interface LaunchOptions {
  /** Proton build for this game; null = the launcher's default. */
  protonPath: string | null;
  /** Run inside Gamescope: real fullscreen, resolution and upscaling. */
  gamescope: boolean;
  /** Gamescope output resolution; null = the screen's own. */
  resolution: string | null;
  upscale: 'off' | 'fsr' | 'nis';
  /** Frames per second cap; null = no limit. */
  fpsLimit: number | null;
  mangohud: boolean;
  gamemode: boolean;
  /** NVIDIA DLSS/Reflex through NVAPI (Proton). */
  nvapi: boolean;
  /** Proton's OpenGL renderer for games that crash with DXVK/VKD3D. */
  wined3d: boolean;
  /** Extra environment variables, one KEY=VALUE per line. */
  env: string;
}

/** ProtonDB's community summary for a Steam game. */
export interface ProtonDbSummary {
  tier: string;
  trendingTier: string | null;
  bestReportedTier: string | null;
  confidence: string | null;
  total: number;
}

export interface SaveBackup {
  stamp: string;
  at: string;
  reason: string;
  files: number;
  bytes: number;
  version: string | null;
}

export const DEFAULT_LAUNCH: LaunchOptions = { protonPath: null, gamescope: false, resolution: null, upscale: 'off', fpsLimit: null, mangohud: false, gamemode: false, nvapi: false, wined3d: false, env: '' };

export type GameUpdateState = 'available' | 'downloading' | 'preparing' | 'waiting' | 'updated' | 'failed' | 'ignored';

export interface GameUpdateInfo {
  /** The imported build has no recoverable version; offer a manual refresh only. */
  unverified?: boolean;
  state: GameUpdateState;
  from: string | null;
  to: string | null;
  reason: string;
  detectedAt: string;
  /** fingerprintKey of the offered build (ignored/rolled-back builds are not offered again). */
  key: string;
  downloadId?: number | null;
  detail?: string | null;
  /** Save and settings files carried into the new build. */
  carried?: number;
  /** Prepared new build waiting for the game to close (main process only). */
  prepared?: { installDir: string; executable: string; kind: 'linux' | 'windows'; candidates: string[]; downloadId: number } | null;
}

export type EffectsLevel = 'full' | 'low';
export type MotionPreference = 'system' | 'reduced' | 'full';
export type AccelPreference = 'auto' | 'vulkan' | 'cpu';

export type SoundGroup = 'hover' | 'click' | 'navigation' | 'downloads' | 'alerts' | 'funny';
export type SoundGroups = Record<SoundGroup, boolean>;

/** Interface sounds that can be replaced with the user's own audio file. */
export const CUSTOM_SOUNDS = ['hover', 'click', 'toggle', 'warp', 'open', 'close', 'download', 'success', 'notify', 'error', 'quit'] as const;
export type CustomSound = (typeof CUSTOM_SOUNDS)[number];
/** The copy kept in the launcher's data folder, and the name of the file it came from. */
export interface CustomSoundFile { file: string; name: string }

export interface Settings {
  showNsfw: boolean;
  policyRevision: number;
  libraryDir: string;
  downloadsDir: string;
  aiModelId: string;
  aiAgents: Record<import('./models').AgentRole, string>;
  aiThreads: number;
  aiContextSize: number;
  aiAcceleration: AccelPreference;
  aiImageTokens: number;
  aiIdleUnloadMinutes: number;
  classifierThreads: number;
  maxConcurrentDownloads: number;
  downloadConnections: number;
  winePath: string;
  protonPath: string;
  /** Proton folders added by hand (Settings → Windows games). */
  protonFolders: string[];
  umuPath: string;
  effects: EffectsLevel;
  motion: MotionPreference;
  /** Synthesized interface sounds (hover, click, tab, download events). */
  uiSounds: boolean;
  /** 0..1 */
  uiVolume: number;
  /** Individual sound groups (all on by default). */
  uiSoundGroups: SoundGroups;
  /** The user's own audio files for individual sounds (set through Settings → Sound only). */
  customSounds: Partial<Record<CustomSound, CustomSoundFile>>;
  crawlRefreshHours: number;
  /** Installed games: tell me about updates, or update them automatically. */
  gameUpdates: 'notify' | 'auto';
  /** The downloaded archive once its game is installed: ask, delete it, or keep it. */
  afterInstall: 'ask' | 'delete' | 'keep';
  /** Back up each game's saves after playing (and before updates, rollbacks and uninstalls). */
  saveBackups: boolean;
  /** Backups kept per game. */
  saveBackupsKeep: number;
  /** Closing the window keeps the launcher running in the system tray. */
  closeToTray: boolean;
  /** Unload the AI and pause indexing while a game runs (the GPU is the game's). */
  freeGpuWhilePlaying: boolean;
  /** Hide Store games whose cover's main subject is a woman (the local AI checks every cover). */
  hideWomenCovers: boolean;
  /** Strict hides more covers (some without a woman); Balanced hides fewer by mistake but misses more. */
  coverStrictness: 'strict' | 'balanced';
  /** Look for new launcher versions on GitHub. */
  checkLauncherUpdates: boolean;
  /** The page the app was on when it closed; it opens there again (the Store the very first time). */
  lastTab: TabId;
  /** Interface language (Arabic lays the interface out right to left). */
  language: 'en' | 'ar';
  clearBrowserDataOnExit: boolean;
  sendDoNotTrack: boolean;
}

export interface ConsentRecord {
  accepted: boolean;
  acceptedAt: string | null;
}

export interface SystemInfo {
  appVersion: string;
  cpuCount: number;
  totalMemGb: number;
  vulkanAvailable: boolean;
  vendorReady: Record<string, boolean>;
  detectedProton: string[];
  detectedWine: string | null;
  /** Optional helpers found on the system (for per-game launch options). */
  tools: { gamescope: boolean; mangohud: boolean; gamemode: boolean };
  dataDir: string;
  cacheDir: string;
  configDir: string;
}

export type AiPhase = 'idle' | 'loading' | 'thinking' | 'navigating' | 'classifying' | 'paused';

export interface AiStatus {
  phase: AiPhase;
  detail: string | null;
  /** Which browser window the AI is driving: the user's drawer or the background discovery window. */
  context: 'interactive' | 'discovery' | null;
  storeActive: boolean;
  modelLoaded: boolean;
  accel: 'cpu' | 'vulkan' | null;
}

export interface CrawlProgress {
  sourceId: number;
  status: SourceStatus;
  detail: string | null;
  pagesDone: number;
  entriesFound: number;
}

export interface BrowserSnapshot {
  verificationRequired?: boolean;
  seq: number;
  url: string;
  title: string;
  /** cgl-media://snapshot/... URL, or null when masked. */
  image: string | null;
  masked: boolean;
  maskReason: string | null;
  width: number;
  height: number;
  loading: boolean;
  nsfw: boolean;
}

export interface ProtonPackage {
  provider: string;
  version: string;
  url: string;
  sha256: string;
  size: number;
  dir: string;
}
export interface ProtonRelease {
  id: string;
  provider: string;
  version: string;
  name: string;
  publishedAt: string | null;
  prerelease: boolean;
  pageUrl: string;
  url: string | null;
  sha256: string | null;
  size: number | null;
  unavailableReason: string | null;
}
export interface ProtonInstall {
  path: string;
  /** Display name, e.g. "GE-Proton10-25". */
  name: string;
  provider: 'ge' | 'cachyos' | 'valve' | 'other';
  /** launcher: installed by the launcher; system: Steam or system folders; folder: added by hand. */
  source: 'launcher' | 'system' | 'folder';
  /** Launcher installs can be deleted, hand-added folders forgotten; Steam's are never touched. */
  removable: boolean;
  /** How many games use this version instead of the default. */
  usedBy?: number;
}

export interface ProtonReleaseList {
  providers: Array<{ id: string; name: string; checkedAt: string | null; error: string | null }>;
  releases: ProtonRelease[];
  installed?: ProtonInstall[];
  /** The build Windows games use when they do not choose one. */
  defaultPath?: string | null;
}

export interface StoreSearchResult { id: number | null; message: string; cancelled?: boolean }

/** The launcher's own update, from the project's GitHub releases. */
export interface LauncherUpdate {
  current: string;
  state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error';
  latest: string | null;
  notes: string | null;
  pageUrl: string;
  size: number | null;
  received: number;
  error: string | null;
  checkedAt: string | null;
  /** Running from an AppImage that this user may replace. */
  canInstall: boolean;
  /**
   * How the download goes: 'scanning' looks for the parts the installed copy
   * already has (`received`/`size` count scanned bytes), 'changed' downloads only
   * the rest, 'whole' downloads the full file.
   */
  phase?: 'scanning' | 'changed' | 'whole' | null;
  /** Size of the whole new AppImage while only its changed parts download. */
  fullSize?: number | null;
}

/** Play time of the last seven days. */
export interface PlayStats {
  /** Seven local days, oldest first; date is YYYY-MM-DD. */
  days: Array<{ date: string; seconds: number }>;
  weekSeconds: number;
  /** Games played this week, most played first. */
  games: Array<{ gameId: number; seconds: number; sessions: number }>;
}
