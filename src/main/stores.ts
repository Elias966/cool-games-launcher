// GOG and Epic accounts, like Heroic: the person logs in once in a window of
// the store's own site; the launcher then lists the games they own, installs
// and updates them with the store's tools (gogdl for GOG, legendary for Epic,
// both bundled), and can adopt a copy already on disk. Installed store games
// are ordinary Library games run through Proton; Epic games get their login
// tokens from legendary at every start.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OwnedGame, StoreAccount, StoreId, StoreJob, StoresState } from '@shared/types';
import type { GameRecord, GamesRepo } from './repos';
import { atomicJson, installedExecutable, readGogInfo, readJsonFile, sameInstall, seedGogRepairManifest, type GogBuildInfo } from './store-builds';

export const GOG_CLIENT_ID = '46899977096215655';
export const GOG_LOGIN_URL = `https://auth.gog.com/auth?client_id=${GOG_CLIENT_ID}&redirect_uri=${encodeURIComponent('https://embed.gog.com/on_login_success?origin=client')}&response_type=code&layout=galaxy`;
export const EPIC_LOGIN_URL = `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent('https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code')}`;

/** The login code in GOG's redirect after a successful login, if this is it. */
export function gogLoginCode(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'embed.gog.com' || !u.pathname.startsWith('/on_login_success')) return null;
    return u.searchParams.get('code');
  } catch {
    return null;
  }
}

/** Epic's redirect page shows JSON with the authorization code after a successful login. */
export function epicLoginCode(pageText: string): string | null {
  try {
    const j = JSON.parse(pageText.trim()) as { authorizationCode?: string | null };
    return typeof j.authorizationCode === 'string' && j.authorizationCode ? j.authorizationCode : null;
  } catch {
    return null;
  }
}

/** Percent done from a gogdl or legendary progress line ("= Progress: 12.34% (…)"). */
export function parseProgress(line: string): number | null {
  const m = /Progress:\s*([\d.]+)/.exec(line);
  if (!m) return null;
  const p = Number(m[1]);
  return Number.isFinite(p) ? Math.max(0, Math.min(100, p)) / 100 : null;
}

/** Both bundled clients print transfer telemetry on separate lines from progress. */
export function parseStoreTelemetry(line: string): Partial<Pick<StoreJob, 'speedBps' | 'receivedBytes' | 'totalBytes'>> {
  const bytes = (n: string, unit: string) => Number(n) * (unit.includes('i') ? 1024 : 1000) ** ({ B: 0, K: 1, M: 2, G: 3, T: 4 }[unit[0].toUpperCase()] ?? 0);
  const result: ReturnType<typeof parseStoreTelemetry> = {};
  const speed = /(?:Download(?:\s+speed)?|Speed)\s*[:\-]\s*([\d.]+)\s*([KMGT]?i?B)\/s/i.exec(line);
  if (speed) result.speedBps = bytes(speed[1], speed[2]);
  const received = /Downloaded\s*:\s*([\d.]+)\s*([KMGT]?i?B)(?:\s*\/\s*([\d.]+)\s*([KMGT]?i?B))?/i.exec(line);
  if (received) {
    result.receivedBytes = bytes(received[1], received[2]);
    if (received[3]) result.totalBytes = bytes(received[3], received[4]);
  }
  return result;
}

/** GOG image ids come without scheme or size: a wide card image and a big one. */
export function gogImages(image: string | null | undefined): { cover: string | null; hero: string | null } {
  if (!image) return { cover: null, hero: null };
  const base = image.startsWith('//') ? `https:${image}` : image;
  return { cover: `${base}_392.jpg`, hero: `${base}.jpg` };
}

type EpicKeyImage = { type?: string; url?: string };
export function epicImages(keyImages: EpicKeyImage[] | undefined): { cover: string | null; hero: string | null } {
  const find = (...types: string[]) => types.map((t) => keyImages?.find((k) => k.type === t)?.url).find(Boolean) ?? null;
  return { cover: find('DieselGameBox', 'OfferImageWide', 'Thumbnail', 'DieselGameBoxTall'), hero: find('DieselGameBox', 'OfferImageWide', 'DieselGameBoxTall') };
}

interface GogTask { isPrimary?: boolean; type?: string; path?: string; arguments?: string; workingDir?: string; category?: string }
/** The main executable of a GOG install, from its goggame-<id>.info file. */
export function gogPrimaryTask(info: { playTasks?: GogTask[] }): { path: string; args: string } | null {
  const tasks = (info.playTasks ?? []).filter((t) => (t.type ?? 'FileTask') === 'FileTask' && t.path);
  const t = tasks.find((x) => x.isPrimary) ?? tasks.find((x) => x.category === 'game') ?? tasks[0];
  return t?.path ? { path: t.path.replace(/\\/g, '/'), args: t.arguments ?? '' } : null;
}

/** Arguments of `legendary launch <app> --json`: the game's own, Epic's login tokens, and the person's. */
export function epicLaunchArgs(json: { game_parameters?: string[]; egl_parameters?: string[]; user_parameters?: string[] }): string[] {
  return [...(json.game_parameters ?? []), ...(json.egl_parameters ?? []), ...(json.user_parameters ?? [])].filter((a) => typeof a === 'string' && a.length);
}

/** Finds goggame-<id>.info under a folder (a few levels deep): the game's install folder. */
export function findGogInfo(root: string, id: string, depth = 3): string | null {
  const name = `goggame-${id}.info`;
  const walk = (dir: string, d: number): string | null => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return null; }
    if (entries.includes(name)) return join(dir, name);
    if (d <= 0) return null;
    for (const e of entries) {
      const p = join(dir, e);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      const hit = walk(p, d - 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, depth);
}

export interface ToolResult { code: number | null; stdout: string; stderr: string }
export type RunTool = (cmd: string, args: string[], opts?: { env?: Record<string, string>; onLine?: (line: string) => void; signal?: AbortSignal }) => Promise<ToolResult>;

/** Runs a store tool, passing every output line to onLine (both tools report progress on stderr). */
export const runTool: RunTool = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  if (opts.signal?.aborted) { reject(Object.assign(new Error('Transfer interrupted'), { name: 'AbortError' })); return; }
  // SIGINT lets the clients flush their resume manifests. Signal the entire
  // process group so their download workers cannot outlive the launcher.
  const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let killTimer: NodeJS.Timeout | undefined;
  const signal = (sig: NodeJS.Signals) => {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { /* already exited */ }
  };
  const abort = () => { signal('SIGINT'); killTimer = setTimeout(() => signal('SIGKILL'), 5000); killTimer.unref(); };
  opts.signal?.addEventListener('abort', abort, { once: true });
  let stdout = '', stderr = '';
  const lines = (chunk: string, buf: { rest: string }) => {
    const all = (buf.rest + chunk).split(/\r?\n|\r/);
    buf.rest = all.pop() ?? '';
    for (const l of all) if (l.trim()) opts.onLine?.(l);
  };
  const outBuf = { rest: '' }, errBuf = { rest: '' };
  child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; lines(c, outBuf); });
  child.stderr.setEncoding('utf8').on('data', (c: string) => { if (stderr.length < 200_000) stderr += c; lines(c, errBuf); });
  child.on('error', reject);
  child.on('close', (code) => {
    opts.signal?.removeEventListener('abort', abort);
    if (killTimer) clearTimeout(killTimer);
    for (const buf of [outBuf, errBuf]) if (buf.rest.trim()) opts.onLine?.(buf.rest);
    if (opts.signal?.aborted) reject(Object.assign(new Error('Transfer interrupted'), { name: 'AbortError' }));
    else resolve({ code, stdout, stderr });
  });
});

const lastLine = (s: string) => s.trim().split('\n').filter((l) => l.trim()).pop()?.replace(/^\[[^\]]*\]\s*\w+:\s*/, '') ?? '';

export interface StoreDeps {
  tools: { legendary: string; gogdl: string };
  dataDir: string;
  /** Where new store installs go (the launcher's games folder). */
  gamesDir: () => string;
  games: Pick<GamesRepo, 'list' | 'get' | 'create' | 'update'>;
  run?: RunTool;
  fetch?: typeof fetch;
  /** Opens the store's login page and resolves with its login code (null when closed). */
  login: (store: StoreId) => Promise<string | null>;
  /** Prepares a newly added Windows game (its prefix folder and runner). */
  prepareGame: (gameId: number) => void;
  changed: () => void;
  publish: (s: StoresState) => void;
  publishJobs?: (jobs: StoreJob[]) => void;
  /** Saves an image into the launcher's artwork cache once; returns its cgl-media address. */
  cacheImage?: (url: string) => Promise<string | null>;
  /** Lets the launcher serve a cached store image. */
  allowArtwork?: (file: string) => void;
  cachedImage?: (url: string) => string | null;
  downloadConnections?: () => number;
  legacyGogConfigDir?: string;
  isRunning?: (gameId: number) => boolean;
}

export class StoreService {
  private accounts: Record<StoreId, StoreAccount> = { gog: { loggedIn: false, user: null, error: null }, epic: { loggedIn: false, user: null, error: null } };
  private owned: OwnedGame[] = [];
  private jobs = new Map<string, StoreJob>();
  private running = new Map<string, { abort: AbortController; settled: Promise<void>; finish: () => void }>();
  private closing = false;
  private stopping = new AbortController();
  private resuming = new Set<string>();
  private imageWork: Promise<void> | null = null;
  private updates = new Set<number>();
  private refreshing = false;
  private run: RunTool;
  private http: typeof fetch;

  constructor(private deps: StoreDeps) {
    this.run = deps.run ?? runTool;
    this.http = deps.fetch ?? fetch;
    mkdirSync(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(join(this.dir, 'owned.json'), 'utf8')) as OwnedGame[];
      if (Array.isArray(saved)) this.owned = saved;
    } catch { /* first start */ }
    try {
      const saved = JSON.parse(readFileSync(join(this.dir, 'jobs.json'), 'utf8')) as StoreJob[];
      if (Array.isArray(saved)) for (const j of saved) {
        if (!['gog', 'epic'].includes(j.store) || !j.id || !['install', 'update'].includes(j.kind)) continue;
        this.jobs.set(`${j.store}:${j.id}`, { ...j, speedBps: 0, state: j.state === 'active' ? 'queued' : j.state });
      }
    } catch { /* first start */ }
    this.restoreCachedImages();
  }

  private allowCached(u: string | null) {
    const m = u && /^cgl-media:\/\/artwork\/(.+)$/.exec(u);
    if (m) this.deps.allowArtwork?.(decodeURIComponent(m[1]));
  }

  private restoreCachedImages() {
    for (const o of this.owned) for (const key of ['cover', 'hero'] as const) {
      const url = o[key];
      if (url?.startsWith('https://')) o[key] = this.deps.cachedImage?.(url) ?? url;
      this.allowCached(o[key]);
    }
    for (const g of this.deps.games.list()) {
      if (!g.store) continue;
      const o = this.owned.find((o) => o.store === g.store && o.id === g.storeId);
      const images = { ...g.images };
      for (const key of ['cover', 'hero'] as const) {
        const url = images[key];
        if (url?.startsWith('https://')) images[key] = this.deps.cachedImage?.(url) ?? url;
        else if (!url && !g.art && o?.[key]?.startsWith('cgl-media:')) images[key] = o[key];
        this.allowCached(images[key]);
      }
      if (images.cover !== g.images.cover || images.hero !== g.images.hero) this.deps.games.update(g.id, { images });
    }
  }

  /** Bounded concurrency and disk lookup avoid serial downloads and remote URL flashes. */
  cacheImages(): Promise<void> {
    return this.imageWork ??= this.cacheAllImages().finally(() => { this.imageWork = null; });
  }

  private async cacheAllImages() {
    if (!this.deps.cacheImage || this.closing) return;
    const urls = new Set<string>();
    for (const o of this.owned) for (const u of [o.cover, o.hero]) if (u?.startsWith('https://')) urls.add(u);
    for (const g of this.deps.games.list()) if (g.store) for (const u of [g.images.cover, g.images.hero]) if (u?.startsWith('https://')) urls.add(u);
    const queue = [...urls];
    const worker = async () => {
      while (queue.length && !this.closing) {
        const url = queue.shift()!;
        const local = this.deps.cachedImage?.(url) ?? await this.deps.cacheImage!(url).catch(() => null);
        if (!local || this.closing) continue;
        this.allowCached(local);
        for (const o of this.owned) for (const key of ['cover', 'hero'] as const) if (o[key] === url) o[key] = local;
        for (const g of this.deps.games.list()) if (g.store && (g.images.cover === url || g.images.hero === url)) {
          this.deps.games.update(g.id, { images: { cover: g.images.cover === url ? local : g.images.cover, hero: g.images.hero === url ? local : g.images.hero } });
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (this.closing) return;
    this.restoreCachedImages();
    this.save();
    this.deps.changed();
    this.publish();
  }

  private get dir() { return join(this.deps.dataDir, 'stores'); }
  private get gogAuth() { return join(this.dir, 'gog-auth.json'); }
  private get legendaryEnv() { return { LEGENDARY_CONFIG_PATH: join(this.dir, 'legendary') }; }

  private gogdl(args: string[], opts: Parameters<RunTool>[2] = {}) { return this.run(this.deps.tools.gogdl, ['--auth-config-path', this.gogAuth, ...args], { ...opts, signal: AbortSignal.any([this.stopping.signal, opts.signal ?? AbortSignal.timeout(60_000)]), env: { ...opts.env, GOGDL_CONFIG_PATH: join(this.dir, 'gogdl') } }); }
  private legendary(args: string[], opts: Parameters<RunTool>[2] = {}) { return this.run(this.deps.tools.legendary, args, { ...opts, signal: AbortSignal.any([this.stopping.signal, opts.signal ?? AbortSignal.timeout(60_000)]), env: { ...this.legendaryEnv, ...opts.env } }); }

  state(): StoresState {
    const installed = new Map(this.deps.games.list().filter((g) => g.store && g.storeId).map((g) => [`${g.store}:${g.storeId}`, g.id]));
    return {
      accounts: this.accounts,
      owned: this.owned.map((o) => ({ ...o, gameId: installed.get(`${o.store}:${o.id}`) ?? null })),
      jobs: [...this.jobs.values()].map((j) => ({ ...j })),
      refreshing: this.refreshing,
    };
  }

  private publish() { if (!this.closing) this.deps.publish(this.state()); }

  private publishJobs() {
    if (this.closing) return;
    if (this.deps.publishJobs) this.deps.publishJobs([...this.jobs.values()].map((j) => ({ ...j })));
    else this.publish();
  }

  private saveJobs() {
    const file = join(this.dir, 'jobs.json');
    writeFileSync(`${file}.tmp`, JSON.stringify([...this.jobs.values()].filter((j) => j.kind !== 'import')));
    renameSync(`${file}.tmp`, file);
  }

  /** Resume only jobs interrupted by exit; deliberate pauses remain paused. */
  recover() {
    void this.cacheImages();
    for (const j of this.jobs.values()) if (j.state === 'queued') this.resume(j.store, j.id);
  }

  async shutdown() {
    this.closing = true;
    for (const [key, run] of this.running) {
      const j = this.jobs.get(key)!;
      if (j.state === 'active') j.state = 'queued';
      j.speedBps = 0;
      run.abort.abort();
    }
    this.stopping.abort();
    this.saveJobs();
    await Promise.all([...this.running.values()].map((run) => run.settled));
  }

  pause(store: StoreId, id: string) {
    const key = `${store}:${id}`, j = this.jobs.get(key);
    if (!j || !['active', 'queued'].includes(j.state)) return;
    j.state = 'paused'; j.speedBps = 0;
    this.saveJobs(); this.publish();
    this.running.get(key)?.abort.abort();
  }

  resume(store: StoreId, id: string) {
    const key = `${store}:${id}`, j = this.jobs.get(key);
    if (!j || this.closing || this.resuming.has(key) || ['active', 'completed'].includes(j.state)) return;
    this.resuming.add(key);
    j.state = 'queued';
    this.saveJobs(); this.publishJobs();
    const start = () => {
      this.resuming.delete(key);
      if (this.closing || this.jobs.get(key)?.state !== 'queued') return;
      const work = j.kind === 'update' ? (j.gameId === null ? Promise.reject(new Error('The Library game for this update is missing.')) : this.update(j.gameId)) : this.install(store, id);
      void work.catch((e: unknown) => {
        // Failures before job creation (removed game or account) must not leave a queued job forever.
        if (this.jobs.get(key)?.state === 'queued') { j.state = 'failed'; j.detail = (e as Error).message; this.saveJobs(); this.publishJobs(); }
      });
    };
    const running = this.running.get(key);
    if (running) void running.settled.then(start); else start();
  }

  remove(store: StoreId, id: string) {
    const key = `${store}:${id}`;
    if (this.running.has(key)) return;
    this.jobs.delete(key); this.saveJobs(); this.publish();
  }

  isBusy(gameId: number): boolean {
    return [...this.jobs.values()].some((j) => j.gameId === gameId && ['active', 'queued', 'paused'].includes(j.state));
  }

  hasUpdate(g: GameRecord): boolean { return this.updates.has(g.id); }

  // ── Accounts ─────────────────────────────────────────────────────────

  /** GOG's access token; null when not logged in. Throws when logged in but GOG cannot be reached (offline). */
  private async gogToken(): Promise<string | null> {
    if (!existsSync(this.gogAuth)) return null;
    const r = await this.gogdl(['auth']);
    let token: string | undefined;
    try { token = (JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { access_token?: string }).access_token; } catch { /* below */ }
    if (!token) throw new Error(lastLine(r.stderr) || 'GOG could not be reached');
    return token;
  }

  private async gogJson<T>(url: string, token: string): Promise<T> {
    const res = await this.http(url, { signal: AbortSignal.any([this.stopping.signal, AbortSignal.timeout(30_000)]), headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GOG answered HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async login(store: StoreId): Promise<StoresState> {
    const code = await this.deps.login(store);
    if (!code) return this.state();
    const r = store === 'gog' ? await this.gogdl(['auth', '--code', code]) : await this.legendary(['auth', '--code', code]);
    if (r.code !== 0) {
      this.accounts[store] = { ...this.accounts[store], error: lastLine(r.stderr || r.stdout) || 'Login failed' };
      this.publish();
      throw new Error(`${store === 'gog' ? 'GOG' : 'Epic'} login failed: ${this.accounts[store].error}`);
    }
    await this.refresh();
    return this.state();
  }

  async logout(store: StoreId): Promise<StoresState> {
    if ([...this.running.keys()].some((key) => key.startsWith(`${store}:`))) throw new Error('Pause or cancel this store’s transfers before logging out.');
    if (store === 'gog') rmSync(this.gogAuth, { force: true });
    else await this.legendary(['auth', '--delete']);
    this.accounts[store] = { loggedIn: false, user: null, error: null };
    this.owned = this.owned.filter((o) => o.store !== store);
    this.save();
    this.publish();
    return this.state();
  }

  private save() {
    try { writeFileSync(join(this.dir, 'owned.json'), JSON.stringify(this.owned)); } catch { /* not fatal */ }
  }

  /** Who is logged in, and every owned game (the lists are kept for offline starts). */
  async refresh(): Promise<StoresState> {
    if (this.refreshing) return this.state();
    this.refreshing = true;
    this.publish();
    try {
      const [gog, epic] = await Promise.all([this.refreshGog().catch((e) => ({ error: (e as Error).message })), this.refreshEpic().catch((e) => ({ error: (e as Error).message }))]);
      for (const [store, result] of [['gog', gog], ['epic', epic]] as const) {
        if ('error' in result) { this.accounts[store] = { ...this.accounts[store], error: result.error }; continue; }
        this.accounts[store] = result.account;
        if (result.games) {
          // The URL hash resolves synchronously on disk, before any renderer sees the list.
          for (const o of result.games) for (const key of ['cover', 'hero'] as const) {
            const url = o[key];
            if (url) o[key] = this.deps.cachedImage?.(url) ?? url;
          }
          this.owned = [...this.owned.filter((o) => o.store !== store), ...result.games];
          this.restoreCachedImages();
        }
        else if (!result.account.loggedIn) this.owned = this.owned.filter((o) => o.store !== store);
      }
      this.save();
      void this.cacheImages();
      await this.checkUpdates().catch(() => undefined);
    } finally {
      this.refreshing = false;
      this.publish();
    }
    return this.state();
  }

  private async refreshGog(): Promise<{ account: StoreAccount; games: OwnedGame[] | null }> {
    const token = await this.gogToken();
    if (!token) return { account: { loggedIn: false, user: null, error: null }, games: null };
    const me = await this.gogJson<{ username?: string }>('https://embed.gog.com/userData.json', token).catch(() => ({ username: undefined }));
    const games: OwnedGame[] = [];
    for (let page = 1, pages = 1; page <= pages && page <= 50; page++) {
      const r = await this.gogJson<{ totalPages?: number; products?: Array<{ id: number; title: string; image?: string; isGame?: boolean; worksOn?: Record<string, boolean> }> }>(`https://embed.gog.com/account/getFilteredProducts?mediaType=1&sortBy=title&page=${page}`, token);
      pages = r.totalPages ?? 1;
      for (const p of r.products ?? []) {
        if (p.isGame === false) continue;
        games.push({ store: 'gog', id: String(p.id), title: p.title, ...gogImages(p.image), gameId: null });
      }
    }
    return { account: { loggedIn: true, user: me.username ?? null, error: null }, games };
  }

  private async refreshEpic(): Promise<{ account: StoreAccount; games: OwnedGame[] | null }> {
    const st = await this.legendary(['status', '--json']);
    let account: string | null = null;
    try { account = (JSON.parse(st.stdout) as { account?: string }).account ?? null; } catch {
      // No answer at all (offline): keep the games known so far.
      throw new Error(lastLine(st.stderr) || 'Epic could not be reached');
    }
    if (!account || account.includes('not logged in')) return { account: { loggedIn: false, user: null, error: null }, games: null };
    const list = await this.legendary(['list', '--json']);
    let games: OwnedGame[] = [];
    try {
      const raw = JSON.parse(list.stdout) as Array<{ app_name: string; app_title: string; metadata?: { keyImages?: EpicKeyImage[]; categories?: Array<{ path?: string }> } }>;
      games = raw.filter((g) => g.app_name && g.app_title).map((g) => ({ store: 'epic' as const, id: g.app_name, title: g.app_title, ...epicImages(g.metadata?.keyImages), gameId: null }));
    } catch {
      throw new Error(lastLine(list.stderr) || 'Epic did not return your games');
    }
    return { account: { loggedIn: true, user: account, error: null }, games };
  }

  // ── Installing, updating, adopting ───────────────────────────────────

  private job(store: StoreId, id: string, kind: StoreJob['kind']) {
    if (this.closing) throw new Error('The launcher is closing');
    const key = `${store}:${id}`;
    if (this.running.has(key)) throw new Error('This game is already being installed or updated.');
    const previous = this.jobs.get(key);
    const game = this.deps.games.list().find((g) => g.store === store && g.storeId === id);
    const owned = this.owned.find((o) => o.store === store && o.id === id);
    const continuing = previous && previous.kind === kind && ['queued', 'paused', 'failed'].includes(previous.state);
    const j: StoreJob = continuing ? { ...previous, state: 'active', detail: null, speedBps: 0 } : {
      store, id, kind, state: 'active', title: owned?.title ?? game?.title ?? id,
      gameId: game?.id ?? null, basePath: join(this.deps.gamesDir(), store === 'gog' ? 'GOG' : 'Epic'),
      progress: null, detail: null, speedBps: 0, receivedBytes: 0, totalBytes: null,
      workers: Math.max(1, Math.min(16, this.deps.downloadConnections?.() ?? 8)), createdAt: new Date().toISOString(),
    };
    const abort = new AbortController();
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    this.running.set(key, { abort, settled, finish });
    this.jobs.set(key, j);
    this.saveJobs(); this.publish();
    let last = 0;
    return {
      signal: abort.signal, basePath: j.basePath, workers: String(j.workers),
      line: (l: string) => {
        if (j.state !== 'active' || this.closing) return;
        if (!/https?:|token|secret|authorization|password/i.test(l) && /Progress:|Downloaded:|Download\s*[-:]|verif|repair|Nothing to do|All files|broken files|error|failed|finished|complete/i.test(l)) console.log(`[stores:${store}:${id}] ${l.slice(0, 500)}`);
        const p = parseProgress(l);
        if (p !== null) j.progress = p;
        Object.assign(j, parseStoreTelemetry(l));
        const now = Date.now();
        if (now - last > 400) { last = now; this.saveJobs(); this.publishJobs(); }
      },
      fail: (e: unknown) => {
        console.error(`[stores] ${store} ${kind} ${id} failed: ${(e as Error).message}`);
        if (j.state === 'active') { j.state = 'failed'; j.detail = (e as Error).message; }
      },
      done: () => {
        if (j.state === 'active') { j.state = 'completed'; j.progress = 1; }
        j.speedBps = 0;
        this.running.delete(key);
        if (kind === 'import') this.jobs.delete(key);
        this.saveJobs(); this.publish(); finish();
      },
    };
  }

  cancel(store: StoreId, id: string) {
    const key = `${store}:${id}`, j = this.jobs.get(key);
    if (!j) return;
    j.state = 'cancelled'; j.speedBps = 0;
    this.saveJobs(); this.publish();
    this.running.get(key)?.abort.abort();
  }

  private ownedGame(store: StoreId, id: string): OwnedGame {
    const o = this.owned.find((x) => x.store === store && x.id === id);
    if (!o) throw new Error('This game is not in your account.');
    return o;
  }

  async install(store: StoreId, id: string): Promise<number> {
    const o = this.ownedGame(store, id);
    const j = this.job(store, id, 'install');
    const base = j.basePath;
    mkdirSync(base, { recursive: true });
    try {
      if (store === 'gog') {
        const r = await this.gogdl(['download', id, '--platform', 'windows', '--path', base, '--support', join(this.dir, 'gog-support', id), '--skip-dlcs', '--lang', 'en-US', '--max-workers', j.workers], { onLine: j.line, signal: j.signal });
        if (r.code !== 0) throw new Error(lastLine(r.stderr) || 'The GOG download failed');
        const info = findGogInfo(base, id);
        if (!info) throw new Error('The game was downloaded, but its start file was not found.');
        const gameId = await this.register(o, dirname(info), true);
        this.markGogVerified(id, dirname(info), this.deps.games.get(gameId)?.storeBuild ?? null);
        return gameId;
      }
      const r = await this.legendary(['-y', 'install', id, '--base-path', base, '--skip-sdl', '--platform', 'Windows', '--max-workers', j.workers], { onLine: j.line, signal: j.signal });
      if (r.code !== 0) throw new Error(lastLine(r.stderr) || 'The Epic download failed');
      return await this.registerEpic(o, true, undefined, undefined, j.signal);
    } catch (e) {
      j.fail(e);
      throw e;
    } finally {
      j.done();
    }
  }

  /** Adopts a copy already on disk (like Heroic's import), so it can be updated from the store. */
  private adopting = new Map<string, { folder: string; result: Promise<number> }>();

  adopt(store: StoreId, id: string, folder: string): Promise<number> {
    const key = `${store}:${id}`, pending = this.adopting.get(key);
    if (pending) return sameInstall(pending.folder, folder) ? pending.result : Promise.reject(new Error('This game is being linked to another folder.'));
    const result = this.adoptFolder(store, id, folder).finally(() => this.adopting.delete(key));
    this.adopting.set(key, { folder, result });
    return result;
  }

  private async adoptFolder(store: StoreId, id: string, folder: string): Promise<number> {
    const o = this.ownedGame(store, id);
    const j = this.job(store, id, 'import');
    try {
      if (store === 'gog') {
        // The folder may be the game's own, one below it, or where its .exe sits (often a subfolder).
        let info: string | null = null;
        for (let d = folder, i = 0; i < 4 && !info; i++, d = dirname(d)) { info = findGogInfo(d, id, 0); if (d === dirname(d)) break; }
        info ??= findGogInfo(folder, id, 2);
        if (!info) throw new Error(`This folder does not hold ${o.title} from GOG (no goggame-${id}.info).`);
        return await this.register(o, dirname(info), false);
      }
      const installed = await this.epicInstall(id, j.signal);
      if (installed && sameInstall(installed.install_path, folder)) return await this.registerEpic(o, false, folder, undefined, j.signal);
      const r = await this.legendary(['-y', 'import', id, folder, '--platform', 'Windows', '--skip-dlcs'], { signal: j.signal });
      if (r.code !== 0) throw new Error(lastLine(r.stderr) || `This folder does not hold ${o.title} from Epic.`);
      return await this.registerEpic(o, false, folder, undefined, j.signal);
    } catch (e) {
      j.fail(e);
      throw e;
    } finally {
      j.done();
    }
  }

  /** A Library game for an installed GOG folder (or the existing Library game for that folder, linked). */
  private async register(o: OwnedGame, installDir: string, managed: boolean): Promise<number> {
    const info = readGogInfo(installDir, o.id);
    const task = gogPrimaryTask(info);
    if (!task) throw new Error('GOG did not say how to start this game.');
    const executable = installedExecutable(installDir, task.path);
    return this.upsert(o, { installDir, executable, args: task.args, build: info.buildId, managed });
  }

  private async epicInstall(id: string, signal?: AbortSignal) {
    const result = await this.legendary(['list-installed', '--json'], { signal });
    if (result.code !== 0) throw new Error('Epic could not read its installed-game records.');
    const list = JSON.parse(result.stdout || '[]') as Array<{ app_name: string; install_path: string; executable: string; version?: string; needs_verification?: boolean }>;
    return list.find((item) => item.app_name === id);
  }

  private async registerEpic(o: OwnedGame, managed: boolean, expectedPath?: string, expectedBuild?: string, signal?: AbortSignal): Promise<number> {
    const it = await this.epicInstall(o.id, signal);
    signal?.throwIfAborted();
    if (!it) throw new Error('Epic did not register the install.');
    if (expectedPath && !sameInstall(it.install_path, expectedPath)) throw new Error('Epic updated a different folder than the Library game.');
    if (expectedBuild && (it.version !== expectedBuild || it.needs_verification)) throw new Error('Epic did not finish updating and verifying the requested build.');
    return this.upsert(o, { installDir: it.install_path, executable: installedExecutable(it.install_path, it.executable), args: '', build: it.version ?? null, managed });
  }

  private gogManifest(id: string) { return join(this.dir, 'gogdl', 'heroic_gogdl', 'manifests', id); }
  private gogVerifiedFile() { return join(this.dir, 'gog-verified.json'); }
  private markGogVerified(id: string, path: string, build: string | null) {
    if (!build) return;
    const known = readJsonFile(this.gogVerifiedFile()) ?? {};
    known[id] = { path, build };
    atomicJson(this.gogVerifiedFile(), known);
  }

  private upsert(o: OwnedGame, p: { installDir: string; executable: string; args: string; build: string | null; managed: boolean }): number {
    const existing = this.deps.games.list().find((g) => (g.store === o.store && g.storeId === o.id) || (!g.store && ((g.installDir && sameInstall(g.installDir, p.installDir)) || (g.executable && sameInstall(g.executable, p.executable)))));
    const fields = { store: o.store, storeId: o.id, storeBuild: p.build, executable: p.executable, installDir: p.installDir, status: 'installed' as const };
    if (existing) {
      if (!existing.store && existing.update && ['downloading', 'preparing', 'waiting'].includes(existing.update.state)) throw new Error('Finish or cancel the current Library update before linking this game.');
      this.deps.games.update(existing.id, { ...fields, kind: 'windows', runner: existing.runner === 'native' ? 'proton' : existing.runner, ...(!existing.store ? { update: null } : {}), ...(existing.namedByUser ? {} : { title: o.title }) });
      if (!existing.images.cover && !existing.art) this.deps.games.update(existing.id, { images: { cover: o.cover, hero: o.hero } });
      if (!existing.prefixDir) this.deps.prepareGame(existing.id);
      this.updates.delete(existing.id);
      const job = this.jobs.get(`${o.store}:${o.id}`);
      if (job) job.gameId = existing.id;
      this.deps.changed();
      return existing.id;
    }
    const g = this.deps.games.create({ catalogId: null, downloadId: null, title: o.title, kind: 'windows', installDir: p.installDir, executable: p.executable, args: p.args, runner: 'proton', prefixDir: null, managed: p.managed, artworkFile: null, sourceHost: null, status: 'installed', candidates: [] });
    this.deps.games.update(g.id, { ...fields, images: { cover: o.cover, hero: o.hero } });
    const job = this.jobs.get(`${o.store}:${o.id}`);
    if (job) job.gameId = g.id;
    this.deps.prepareGame(g.id);
    this.deps.changed();
    return g.id;
  }

  /** Which installed store games have a newer build in the store. */
  async checkUpdates(): Promise<number> {
    const installed = this.deps.games.list().filter((g) => g.store && g.storeId);
    const gog = installed.filter((g) => g.store === 'gog' && this.accounts.gog.loggedIn);
    for (const g of gog) {
      const r = await this.gogdl(['info', g.storeId!, '--platform', 'windows', '--lang', 'en-US']).catch(() => null);
      try {
        const latest = (JSON.parse(r?.stdout ?? '') as { buildId?: string }).buildId;
        if (r?.code === 0 && latest && latest !== g.storeBuild) this.updates.add(g.id); else this.updates.delete(g.id);
      } catch { /* leave as it was */ }
    }
    const epic = installed.filter((g) => g.store === 'epic');
    if (epic.length && this.accounts.epic.loggedIn) {
      const r = await this.legendary(['list', '--json']).catch(() => null);
      try {
        const latest = new Map((JSON.parse(r?.stdout ?? '') as Array<{ app_name: string; asset_infos?: { Windows?: { build_version?: string } } }>).map((x) => [x.app_name, x.asset_infos?.Windows?.build_version]));
        for (const g of epic) {
          const v = latest.get(g.storeId!);
          if (r?.code === 0 && v && v !== g.storeBuild) this.updates.add(g.id); else this.updates.delete(g.id);
        }
      } catch { /* leave as it was */ }
    }
    this.deps.changed();
    return this.updates.size;
  }

  async update(gameId: number): Promise<void> {
    const g = this.deps.games.get(gameId);
    if (!g?.store || !g.storeId || !g.installDir) throw new Error('This game is not from GOG or Epic.');
    if (this.deps.isRunning?.(gameId)) throw new Error('Stop the game before updating it.');
    const o = this.owned.find((x) => x.store === g.store && x.id === g.storeId) ?? { store: g.store, id: g.storeId, title: g.title, cover: null, hero: null, gameId };
    const j = this.job(g.store, g.storeId, 'update');
    try {
      console.log(`[stores] ${g.store} update ${g.storeId}: ${g.installDir}`);
      if (g.store === 'gog') {
        const local = readGogInfo(g.installDir, g.storeId);
        const result = await this.gogdl(['info', g.storeId, '--platform', 'windows', '--lang', 'en-US'], { signal: j.signal });
        if (result.code !== 0) throw new Error(lastLine(result.stderr) || 'GOG could not check the target build.');
        const target = JSON.parse(result.stdout) as GogBuildInfo;
        if (!target.buildId) throw new Error('GOG did not report a target build.');
        target.buildId = String(target.buildId);
        const known = readJsonFile(this.gogVerifiedFile())?.[g.storeId];
        const cached = readJsonFile(this.gogManifest(g.storeId));
        const verified = local.buildId && known?.build === local.buildId && typeof known.path === 'string' && sameInstall(known.path, g.installDir) && String(cached?.buildId) === local.buildId;
        const command = verified ? 'update' : 'repair';
        if (!verified) {
          await seedGogRepairManifest({ file: this.gogManifest(g.storeId), legacyFile: this.deps.legacyGogConfigDir ? join(this.deps.legacyGogConfigDir, 'manifests', g.storeId) : undefined, id: g.storeId, target, http: this.http, signal: j.signal });
        }
        // Unlike download, update/repair takes the actual game folder, not its parent.
        const args = [command, g.storeId, '--build', target.buildId, '--platform', 'windows', '--path', g.installDir, '--support', join(this.dir, 'gog-support', g.storeId), '--skip-dlcs', '--lang', 'en-US', '--max-workers', j.workers];
        const updated = await this.gogdl(args, { onLine: j.line, signal: j.signal });
        if (updated.code !== 0) throw new Error(lastLine(updated.stderr) || 'The GOG update failed');
        j.signal.throwIfAborted();
        const actual = readGogInfo(g.installDir, g.storeId);
        if (actual.buildId !== target.buildId) throw new Error(`GOG exited without installing build ${target.buildId} in the Library folder (found ${actual.buildId ?? 'unknown'}).`);
        await this.register(o, g.installDir, g.managed);
        this.markGogVerified(g.storeId, g.installDir, actual.buildId);
        console.log(`[stores] gog ${g.storeId}: verified build ${actual.buildId} in ${g.installDir}`);
      } else {
        const list = await this.legendary(['list', '--json'], { signal: j.signal });
        if (list.code !== 0) throw new Error('Epic could not check the target build.');
        const target = (JSON.parse(list.stdout) as Array<{ app_name: string; asset_infos?: { Windows?: { build_version?: string } } }>).find((item) => item.app_name === g.storeId)?.asset_infos?.Windows?.build_version;
        if (!target) throw new Error('Epic did not report a target build.');
        const installed = await this.epicInstall(g.storeId, j.signal);
        if (!installed || !sameInstall(installed.install_path, g.installDir)) {
          const imported = await this.legendary(['-y', 'import', g.storeId, g.installDir, '--platform', 'Windows', '--skip-dlcs'], { signal: j.signal });
          if (imported.code !== 0) throw new Error('Epic could not link the Library folder before updating.');
          const linked = await this.epicInstall(g.storeId, j.signal);
          if (!linked || !sameInstall(linked.install_path, g.installDir)) throw new Error('Epic registered a different install folder.');
        }
        // Imported copies need verification AND the latest build. Plain repair
        // can succeed while leaving the old build installed.
        const r = await this.legendary(['-y', 'install', g.storeId, '--update-only', '--repair-and-update', '--skip-sdl', '--skip-dlcs', '--base-path', dirname(g.installDir), '--game-folder', g.installDir.split('/').pop()!, '--max-workers', j.workers], { onLine: j.line, signal: j.signal });
        if (r.code !== 0) throw new Error(lastLine(r.stderr) || 'The Epic update failed');
        await this.registerEpic(o, g.managed, g.installDir, target, j.signal);
        console.log(`[stores] epic ${g.storeId}: verified build ${target} in ${g.installDir}`);
      }
      this.updates.delete(gameId);
      this.deps.changed();
    } catch (e) {
      j.fail(e);
      throw e;
    } finally {
      j.done();
    }
  }

  /** Arguments an Epic game needs at each start (its login tokens); GOG games need none. */
  async launchArgs(g: GameRecord): Promise<string[] | null> {
    if (g.store !== 'epic' || !g.storeId) return null;
    const r = await this.legendary(['launch', g.storeId, '--json', '--skip-version-check']);
    try {
      return epicLaunchArgs(JSON.parse(r.stdout));
    } catch {
      // Offline: many games still start, some ask to log in.
      const off = await this.legendary(['launch', g.storeId, '--json', '--offline']).catch(() => null);
      try { return epicLaunchArgs(JSON.parse(off?.stdout ?? '')); } catch { return []; }
    }
  }

  /** A store game left the Library: legendary forgets it (the files are handled by the Library). */
  forget(g: GameRecord) {
    this.updates.delete(g.id);
    if (g.store === 'epic' && g.storeId) void this.legendary(['-y', 'uninstall', g.storeId, '--keep-files']).catch(() => undefined);
    this.publish();
  }
}
