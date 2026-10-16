// GOG and Epic accounts, like Heroic: the person logs in once in a window of
// the store's own site; the launcher then lists the games they own, installs
// and updates them with the store's tools (gogdl for GOG, legendary for Epic,
// both bundled), and can adopt a copy already on disk. Installed store games
// are ordinary Library games run through Proton; Epic games get their login
// tokens from legendary at every start.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OwnedGame, StoreAccount, StoreId, StoreJob, StoresState } from '@shared/types';
import type { GameRecord, GamesRepo } from './repos';

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
  const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
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
  child.on('close', (code) => resolve({ code, stdout, stderr }));
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
}

export class StoreService {
  private accounts: Record<StoreId, StoreAccount> = { gog: { loggedIn: false, user: null, error: null }, epic: { loggedIn: false, user: null, error: null } };
  private owned: OwnedGame[] = [];
  private jobs = new Map<string, StoreJob & { abort: AbortController }>();
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
  }

  private get dir() { return join(this.deps.dataDir, 'stores'); }
  private get gogAuth() { return join(this.dir, 'gog-auth.json'); }
  private get legendaryEnv() { return { LEGENDARY_CONFIG_PATH: join(this.dir, 'legendary') }; }

  private gogdl(args: string[], opts: Parameters<RunTool>[2] = {}) { return this.run(this.deps.tools.gogdl, ['--auth-config-path', this.gogAuth, ...args], opts); }
  private legendary(args: string[], opts: Parameters<RunTool>[2] = {}) { return this.run(this.deps.tools.legendary, args, { ...opts, env: { ...this.legendaryEnv, ...opts.env } }); }

  state(): StoresState {
    const installed = new Map(this.deps.games.list().filter((g) => g.store && g.storeId).map((g) => [`${g.store}:${g.storeId}`, g.id]));
    return {
      accounts: this.accounts,
      owned: this.owned.map((o) => ({ ...o, gameId: installed.get(`${o.store}:${o.id}`) ?? null })),
      jobs: [...this.jobs.values()].map(({ abort: _a, ...j }) => j),
      refreshing: this.refreshing,
    };
  }

  private publish() { this.deps.publish(this.state()); }

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
    const res = await this.http(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
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
        if (result.games) this.owned = [...this.owned.filter((o) => o.store !== store), ...result.games];
        else if (!result.account.loggedIn) this.owned = this.owned.filter((o) => o.store !== store);
      }
      this.save();
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
    const key = `${store}:${id}`;
    if (this.jobs.has(key)) throw new Error('This game is already being installed or updated.');
    const j: StoreJob & { abort: AbortController } = { store, id, kind, progress: null, detail: null, abort: new AbortController() };
    this.jobs.set(key, j);
    this.publish();
    let last = 0;
    return {
      signal: j.abort.signal,
      line: (l: string) => {
        const p = parseProgress(l);
        if (p === null) return;
        j.progress = p;
        const now = Date.now();
        if (now - last > 400) { last = now; this.publish(); }
      },
      done: () => { this.jobs.delete(key); this.publish(); },
    };
  }

  cancel(store: StoreId, id: string) {
    this.jobs.get(`${store}:${id}`)?.abort.abort();
  }

  private ownedGame(store: StoreId, id: string): OwnedGame {
    const o = this.owned.find((x) => x.store === store && x.id === id);
    if (!o) throw new Error('This game is not in your account.');
    return o;
  }

  async install(store: StoreId, id: string): Promise<number> {
    const o = this.ownedGame(store, id);
    const base = join(this.deps.gamesDir(), store === 'gog' ? 'GOG' : 'Epic');
    mkdirSync(base, { recursive: true });
    const j = this.job(store, id, 'install');
    try {
      if (store === 'gog') {
        const r = await this.gogdl(['download', id, '--platform', 'windows', '--path', base, '--support', join(this.dir, 'gog-support', id), '--skip-dlcs', '--lang', 'en-US'], { onLine: j.line, signal: j.signal });
        if (r.code !== 0) throw new Error(lastLine(r.stderr) || 'The GOG download failed');
        const info = findGogInfo(base, id);
        if (!info) throw new Error('The game was downloaded, but its start file was not found.');
        return await this.register(o, dirname(info), true);
      }
      const r = await this.legendary(['-y', 'install', id, '--base-path', base, '--skip-sdl', '--platform', 'Windows'], { onLine: j.line, signal: j.signal });
      if (r.code !== 0) throw new Error(lastLine(r.stderr) || 'The Epic download failed');
      return await this.registerEpic(o, true);
    } finally {
      j.done();
    }
  }

  /** Adopts a copy already on disk (like Heroic's import), so it can be updated from the store. */
  async adopt(store: StoreId, id: string, folder: string): Promise<number> {
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
      const r = await this.legendary(['-y', 'import', id, folder, '--platform', 'Windows'], { signal: j.signal });
      if (r.code !== 0) throw new Error(lastLine(r.stderr) || `This folder does not hold ${o.title} from Epic.`);
      return await this.registerEpic(o, false);
    } finally {
      j.done();
    }
  }

  /** A Library game for an installed GOG folder (or the existing Library game for that folder, linked). */
  private async register(o: OwnedGame, installDir: string, managed: boolean): Promise<number> {
    const info = JSON.parse(readFileSync(join(installDir, `goggame-${o.id}.info`), 'utf8')) as { playTasks?: GogTask[] };
    const task = gogPrimaryTask(info);
    if (!task) throw new Error('GOG did not say how to start this game.');
    const imported = await this.gogdl(['import', installDir]);
    let build: string | null = null;
    try { build = (JSON.parse(imported.stdout) as { buildId?: string }).buildId ?? null; } catch { /* unknown build */ }
    return this.upsert(o, { installDir, executable: join(installDir, task.path), args: task.args, build, managed });
  }

  private async registerEpic(o: OwnedGame, managed: boolean): Promise<number> {
    const r = await this.legendary(['list-installed', '--json']);
    const list = JSON.parse(r.stdout || '[]') as Array<{ app_name: string; install_path: string; executable: string; version?: string }>;
    const it = list.find((x) => x.app_name === o.id);
    if (!it) throw new Error('Epic did not register the install.');
    return this.upsert(o, { installDir: it.install_path, executable: join(it.install_path, it.executable.replace(/\\/g, '/')), args: '', build: it.version ?? null, managed });
  }

  private upsert(o: OwnedGame, p: { installDir: string; executable: string; args: string; build: string | null; managed: boolean }): number {
    const existing = this.deps.games.list().find((g) => (g.store === o.store && g.storeId === o.id) || (!g.store && g.installDir === p.installDir));
    const fields = { store: o.store, storeId: o.id, storeBuild: p.build, executable: p.executable, installDir: p.installDir, status: 'installed' as const };
    if (existing) {
      this.deps.games.update(existing.id, { ...fields, ...(existing.namedByUser ? {} : { title: o.title }) });
      if (!existing.images.cover && !existing.art) this.deps.games.update(existing.id, { images: { cover: o.cover, hero: o.hero } });
      this.updates.delete(existing.id);
      this.deps.changed();
      return existing.id;
    }
    const g = this.deps.games.create({ catalogId: null, downloadId: null, title: o.title, kind: 'windows', installDir: p.installDir, executable: p.executable, args: p.args, runner: 'proton', prefixDir: null, managed: p.managed, artworkFile: null, sourceHost: null, status: 'installed', candidates: [] });
    this.deps.games.update(g.id, { ...fields, images: { cover: o.cover, hero: o.hero } });
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
        if (latest && g.storeBuild && latest !== g.storeBuild) this.updates.add(g.id); else this.updates.delete(g.id);
      } catch { /* leave as it was */ }
    }
    const epic = installed.filter((g) => g.store === 'epic');
    if (epic.length && this.accounts.epic.loggedIn) {
      const r = await this.legendary(['list', '--json']).catch(() => null);
      try {
        const latest = new Map((JSON.parse(r?.stdout ?? '') as Array<{ app_name: string; asset_infos?: { Windows?: { build_version?: string } } }>).map((x) => [x.app_name, x.asset_infos?.Windows?.build_version]));
        for (const g of epic) {
          const v = latest.get(g.storeId!);
          if (v && g.storeBuild && v !== g.storeBuild) this.updates.add(g.id); else this.updates.delete(g.id);
        }
      } catch { /* leave as it was */ }
    }
    this.deps.changed();
    return this.updates.size;
  }

  async update(gameId: number): Promise<void> {
    const g = this.deps.games.get(gameId);
    if (!g?.store || !g.storeId || !g.installDir) throw new Error('This game is not from GOG or Epic.');
    const o = this.owned.find((x) => x.store === g.store && x.id === g.storeId) ?? { store: g.store, id: g.storeId, title: g.title, cover: null, hero: null, gameId };
    const j = this.job(g.store, g.storeId, 'update');
    try {
      if (g.store === 'gog') {
        // gogdl updates in place: same id, the folder that holds the game.
        const r = await this.gogdl(['update', g.storeId, '--platform', 'windows', '--path', dirname(g.installDir), '--support', join(this.dir, 'gog-support', g.storeId), '--skip-dlcs', '--lang', 'en-US'], { onLine: j.line, signal: j.signal });
        if (r.code !== 0) throw new Error(lastLine(r.stderr) || 'The GOG update failed');
        await this.register(o, g.installDir, g.managed);
      } else {
        const r = await this.legendary(['-y', 'install', g.storeId, '--update-only', '--skip-sdl'], { onLine: j.line, signal: j.signal });
        if (r.code !== 0) throw new Error(lastLine(r.stderr) || 'The Epic update failed');
        await this.registerEpic(o, g.managed);
      }
      this.updates.delete(gameId);
      this.deps.changed();
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
