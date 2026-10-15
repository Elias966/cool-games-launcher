import type { ForegroundWork } from './foreground';
import type { SessionToken } from './store-session';
import type { LocalGameAgent } from './game-agent';
import type { StoreSession } from './store-session';
import type { InstallResult } from '../workers/prepare-game';
import { isCancelled } from '@shared/worker-protocol';
// Library: prepares downloaded game folders automatically, launches
// native and Windows games, runs user-driven installers, imports and
// uninstalls.
import { dialog, shell, type BrowserWindow } from 'electron';
import { existsSync, readdirSync, readFileSync, statSync, chmodSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { WorkerHost } from './worker-host';
import type { CatalogRepo, DownloadRecord, DownloadsRepo, GamesRepo, GameRecord, PreviousBuild, SettingsRepo } from './repos';
import type { ExecCandidate } from '../workers/exec-scan';
import { findVersion, versionLabel, fingerprintKey, type InstalledVersion } from '@shared/game-version';
import { installedFile } from './updates';
import { createShortcut, removeShortcuts } from './shortcuts';
import type { CompatManager } from './compat';
import type { DownloadManager } from './downloads';
import type { PolicyService } from './policy-service';
import { publish, toast } from './bus';
import { paths, vendor } from './paths';
import type { Game, GameUpdateInfo, LaunchOptions, Runner, SaveBackup } from '@shared/types';

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'game'
  );
}

/** Where a build's pristine file list is kept (see workers/carry-over). */
function manifestFor(dir: string) {
  return join(paths.manifests, `${createHash('sha1').update(resolve(dir)).digest('hex')}.json`);
}

const UPDATE_BUSY = new Set(['downloading', 'preparing', 'waiting']);
type PreparedBuild = NonNullable<GameUpdateInfo['prepared']>;

/**
 * The new build's counterpart of the executable the player already uses: same
 * file name (or the same name without its version digits), in the deepest
 * matching folder. Null when it is ambiguous; the AI chooses then.
 */
export function matchExecutable(oldRel: string, candidates: Array<Pick<ExecCandidate, 'relPath' | 'kind' | 'installerLike'>>): number | null {
  const usable = candidates.map((c, i) => ({ c, i })).filter(({ c }) => !c.installerLike && c.kind !== 'msi');
  const parts = (p: string) => p.split(/[\\/]/);
  const name = (p: string) => parts(p).pop()!.toLowerCase();
  const loose = (p: string) => name(p).replace(/[\d._-]+/g, '');
  for (const same of [(p: string) => name(p) === name(oldRel), (p: string) => loose(p) === loose(oldRel) && loose(p).length >= 3]) {
    const hits = usable.filter(({ c }) => same(c.relPath));
    if (!hits.length) continue;
    const depth = (p: string) => { const a = parts(oldRel).reverse(), b = parts(p).reverse(); let n = 0; while (n < a.length && n < b.length && a[n].toLowerCase() === b[n].toLowerCase()) n++; return n; };
    hits.sort((x, y) => depth(y.c.relPath) - depth(x.c.relPath));
    if (hits.length > 1 && depth(hits[0].c.relPath) === depth(hits[1].c.relPath)) return null;
    return hits[0].i;
  }
  return null;
}

/** "Orbit Run v1.0" becomes "Orbit Run v1.1"; titles without the version (or renamed by the user) stay. */
function retitle(title: string, from: string | null | undefined, to: string | null | undefined): string | undefined {
  if (!from || !to || from === to || /^build /.test(from) !== /^build /.test(to) || findVersion({ titles: [title] }) !== from) return undefined;
  const bare = (v: string) => v.replace(/^build /, '');
  const i = title.lastIndexOf(bare(from));
  return i < 0 ? undefined : title.slice(0, i) + bare(to) + title.slice(i + bare(from).length);
}

function inside(root: string, p: string) {
  const r = resolve(root);
  const t = resolve(p);
  return t.startsWith(r + sep);
}

export function detectProton(): string[] {
  const roots = [
    join(homedir(), '.steam/root/compatibilitytools.d'),
    join(homedir(), '.steam/steam/compatibilitytools.d'),
    join(homedir(), '.local/share/Steam/compatibilitytools.d'),
    join(homedir(), '.steam/steam/steamapps/common'),
    join(homedir(), '.steam/root/steamapps/common'),
    join(homedir(), '.var/app/com.valvesoftware.Steam/data/Steam/steamapps/common'),
    '/usr/share/steam/steamapps/common',
    join(homedir(), '.local/share/Steam/steamapps/common'),
    join(homedir(), '.var/app/com.valvesoftware.Steam/data/Steam/compatibilitytools.d'),
    join(homedir(), '.local/share/umu/compatibilitytools'),
    '/usr/share/steam/compatibilitytools.d',
  ];
  const found = new Set<string>();
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const name of readdirSync(r)) {
      const dir = join(r, name);
      if (existsSync(join(dir, 'proton')) && /proton/i.test(name)) found.add(dir);
    }
  }
  return [...found].sort().reverse();
}

/** Optional launch helpers on the system (Gamescope, MangoHud, GameMode). */
export function detectTools(): { gamescope: string | null; mangohud: string | null; gamemode: string | null } {
  const find = (name: string) => {
    try { return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() || null; } catch { return null; }
  };
  return { gamescope: find('gamescope'), mangohud: find('mangohud'), gamemode: find('gamemoderun') };
}

export function detectWine(): string | null {
  try {
    return execFileSync('sh', ['-c', 'command -v wine'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export class Library {
  private pendingLaunch = new Set<number>();
  private runningIds = new Set<number>();
  private installing = new Set<number>();
  private preparationQueue: number[] = [];
  private preparing = false;
  private startDownload: ((catalogId: number, title: string, sourceHost: string | null) => DownloadRecord) | null = null;
  private work = new AbortController();
  private recovery: Parameters<Library['setRecovery']>[0] | null = null;

  constructor(
    private worker: WorkerHost,
    private games: GamesRepo,
    private downloadsRepo: DownloadsRepo,
    private downloads: DownloadManager,
    private catalog: CatalogRepo,
    private settings: SettingsRepo,
    private policy: PolicyService,
    private window: () => BrowserWindow | null,
    private compat: CompatManager,
    private agentContext: { agent: Pick<LocalGameAgent, 'prepare' | 'executable'> & Partial<Pick<LocalGameAgent, 'registered'>>; session: StoreSession; foreground?: ForegroundWork },
  ) {
    agentContext.session.on('enter', () => void this.pumpPreparation());
    downloads.on('completed', (id: number) => this.enqueuePreparation(id));
    worker.on('event:game-started', (e: { gameId: number; installer?: boolean }) => {
      if (!e.installer && this.runningIds.size === 0) this.playingListener?.(true);
      this.runningIds.add(e.gameId);
      this.broadcast();
    });
    worker.on('event:game-exit', (e: { gameId: number; code: number | null; seconds: number; installer: boolean; error?: string }) => {
      this.runningIds.delete(e.gameId);
      if (this.runningIds.size === 0) this.playingListener?.(false);
      if (e.installer) void this.afterInstaller(e.gameId);
      else { this.games.recordPlay(e.gameId, e.seconds); void this.afterPlay(e.gameId, e.seconds, e.code, !!e.error); }
      if (e.error) toast('error', `Could not start: ${e.error}`);
      else if (!e.installer && e.code && e.code !== 0 && e.seconds < 5) toast('warning', 'The game exited immediately. Check its runner and executable in the game settings.');
      this.broadcast();
    });
    worker.on('event:install-progress', (e: { downloadId: number; detail: string; fraction?: number | null }) => {
      this.downloadsRepo.update(e.downloadId, { installDetail: typeof e.fraction === 'number' ? `Unpacking ${Math.round(e.fraction * 100)}% · ${e.detail}` : e.detail });
      this.downloads.broadcastList();
    });
    worker.on('exit', () => {
      if (this.runningIds.size) this.playingListener?.(false);
      this.runningIds.clear();
      this.broadcast();
    });
    policy.on('changed', () => this.broadcast());
  }

  /** Resume library preparation after an application restart. */
  recover() {
    // An update prepared while its game was running installs now.
    for (const g of this.games.list()) {
      if (g.update?.state === 'waiting' && g.update.prepared) void this.applyUpdate(g.id, g.update.prepared).catch((e: unknown) => this.failUpdate(g.id, e));
    }
    for (const d of this.downloadsRepo.list()) {
      // 0.2.5 rejected AI replies with extra fields ("Unrecognized key"); those games are prepared again.
      if (d.state === 'completed' && d.installState === 'failed' && d.catalogId !== null && /unrecognized_keys|Unrecognized key/.test(d.installDetail ?? '')) {
        this.downloadsRepo.update(d.id, { installState: 'none', installDetail: 'Preparing again…' });
        d.installState = 'none';
      }
      if (d.state === 'completed' && d.installState !== 'failed') this.enqueuePreparation(d.id);
    }
  }

  /** How Library updates start their download (the resolver lives with the Store). */
  setDownloadStarter(fn: (catalogId: number, title: string, sourceHost: string | null) => DownloadRecord) {
    this.startDownload = fn;
  }

  /**
   * A split game is prepared from its first part once every part has arrived;
   * until then each finished part says what it is waiting for.
   */
  partsReady(groupId: number): { ready: boolean; lead: DownloadRecord | null; files: string[]; waiting: string | null } {
    const parts = this.downloadsRepo.group(groupId);
    const lead = parts.find((p) => p.id === groupId) ?? null;
    const total = lead?.partTotal ?? null;
    const done = parts.filter((p) => p.state === 'completed' && p.finalPath);
    const indexes = new Set(done.map((p) => p.partIndex));
    const ready = total !== null && Array.from({ length: total }, (_, i) => i + 1).every((k) => indexes.has(k));
    return {
      ready,
      lead,
      files: done.sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0)).map((p) => p.finalPath!),
      waiting: ready ? null : `${done.length} of ${total ?? '?'} parts downloaded — waiting for the rest`,
    };
  }

  /** Called when the parts of a split game are all known (or a part finished). */
  partsSettled(groupId: number) {
    const lead = this.downloadsRepo.get(groupId);
    if (lead?.state === 'completed') this.enqueuePreparation(groupId);
  }

  private enqueuePreparation(id: number) {
    let d = this.downloadsRepo.get(id);
    if (!d || d.catalogId === null || d.state !== 'completed') return;
    if (d.groupId) {
      const set = this.partsReady(d.groupId);
      const installed = set.lead?.gameId ? this.games.get(set.lead.gameId) : null;
      if (installed) {
        for (const p of this.downloadsRepo.group(d.groupId)) this.downloadsRepo.update(p.id, { gameId: installed.id, installState: 'installed', installDetail: p.id === d.groupId ? 'Ready to play' : `Part of ${installed.title}` });
        this.downloads.broadcastList();
        return;
      }
      if (!set.ready || !set.lead) {
        for (const p of this.downloadsRepo.group(d.groupId)) if (p.state === 'completed') this.downloadsRepo.update(p.id, { installState: 'none', installDetail: set.waiting });
        this.downloads.broadcastList();
        return;
      }
      // Only the first part is prepared; the others are its files.
      for (const p of this.downloadsRepo.group(d.groupId)) if (p.id !== d.groupId) this.downloadsRepo.update(p.id, { installState: 'installing', installDetail: `Part of ${p.title}` });
      id = d.groupId;
      d = set.lead;
    }
    const existing = d.gameId ? this.games.get(d.gameId) : this.games.list().find((g) => g.downloadId === id);
    if (existing) {
      this.downloadsRepo.update(id, { gameId: existing.id, installState: 'installed', installDetail: existing.status === 'installed' ? 'Ready to play' : 'Choose the game executable in Library' });
      this.downloads.broadcastList(); return;
    }
    if (this.preparationQueue.includes(id) || this.installing.has(id)) return;
    this.downloadsRepo.update(id, { installState: 'installing', installDetail: 'Waiting to prepare the game folder…' });
    this.downloads.broadcastList();
    this.preparationQueue.push(id);
    void this.pumpPreparation();
  }

  private async pumpPreparation() {
    if (this.preparing) return;
    this.preparing = true;
    try {
      while (this.preparationQueue.length && this.agentContext.session.active) {
        const id = this.preparationQueue.shift()!;
        if (!this.downloadsRepo.get(id)) continue;
        await this.installFromDownload(id).catch((e) => toast('error', `Could not prepare the game: ${(e as Error).message}`));
      }
    } finally { this.preparing = false; }
  }

  list(): Game[] {
    const pol = this.policy.policy();
    return this.games.list().map((g) => this.toGame(g, pol.showNsfw));
  }

  private toGame(g: GameRecord, showNsfw: boolean): Game {
    const artworkAllowed = g.artworkFile && (g.catalogRating !== 'adult' || showNsfw) && g.catalogRating !== 'unknown';
    return {
      id: g.id,
      catalogId: g.catalogId,
      title: g.title,
      kind: g.kind,
      installDir: g.installDir,
      executable: g.executable,
      args: g.args,
      runner: g.runner,
      prefixDir: g.prefixDir,
      managed: g.managed,
      favorite: g.favorite,
      artwork: artworkAllowed ? `cgl-media://artwork/${encodeURIComponent(g.artworkFile!)}` : null,
      sourceHost: g.sourceHost,
      addedAt: g.addedAt,
      lastPlayedAt: g.lastPlayedAt,
      playtimeSeconds: g.playtimeSeconds,
      status: g.status,
      running: this.runningIds.has(g.id),
      executableCandidates: g.candidates,
      version: versionLabel(g.installedVersion),
      update: this.updateView(g),
      previousVersion: g.previous ? versionLabel(g.previous.version) ?? 'previous version' : null,
      canRollback: !!g.previous?.installDir && existsSync(g.previous.installDir),
      archive: g.archiveKept || this.settings.get().afterInstall !== 'ask' ? null : this.archiveOf(g),
      launch: g.launch,
      art: g.catalogRating === 'safe' ? g.art : null,
    };
  }

  /** The downloaded files behind an installed game that are still on disk. */
  private archiveFiles(gameId: number): Array<{ id: number; path: string; bytes: number }> {
    const out: Array<{ id: number; path: string; bytes: number }> = [];
    for (const d of this.downloadsRepo.list()) {
      if (d.gameId !== gameId || !d.finalPath || d.state !== 'completed') continue;
      try { out.push({ id: d.id, path: d.finalPath, bytes: statSync(d.finalPath).size }); } catch { /* already gone */ }
    }
    return out;
  }

  private archiveOf(g: GameRecord): Game['archive'] {
    if (g.status !== 'installed' || !g.managed) return null;
    const files = this.archiveFiles(g.id);
    return files.length ? { bytes: files.reduce((n, f) => n + f.bytes, 0), files: files.length } : null;
  }

  /** Deletes the downloaded archive (every part) of an installed game; the game folder is untouched. */
  deleteArchive(id: number): { freed: number } {
    const g = this.games.get(id);
    if (!g || g.status !== 'installed') throw new Error('Only the downloads of installed games can be removed');
    let freed = 0;
    for (const f of this.archiveFiles(id)) {
      try { rmSync(f.path, { force: true }); freed += f.bytes; } catch (e) { console.warn('[library] could not delete', f.path, (e as Error).message); continue; }
      this.downloadsRepo.update(f.id, { finalPath: null, installDetail: 'Installed · downloaded files deleted' });
    }
    this.downloads.broadcastList();
    this.broadcast();
    return { freed };
  }

  keepArchive(id: number) {
    this.games.update(id, { archiveKept: true });
    this.broadcast();
  }

  /** After a successful install: delete the archive when Settings says so. */
  private afterInstalled(gameId: number) {
    if (this.settings.get().afterInstall !== 'delete') return;
    const { freed } = this.deleteArchive(gameId);
    if (freed) toast('info', `Deleted the downloaded files (${(freed / 1024 ** 3).toFixed(freed > 1024 ** 3 ? 1 : 2)} GB freed).`);
  }

  /**
   * A download that turns out damaged when unpacking is deleted and fetched
   * again once (every part of a split game). A second damaged copy means the
   * file on the website itself is probably broken.
   */
  private redownloadDamaged(d: DownloadRecord): boolean {
    if (!this.recovery || d.catalogId === null) return false;
    const key = `redownload:${d.catalogId}`;
    if (this.recovery.cache.get(key, 24)) return false;
    this.recovery.cache.set(key, { at: new Date().toISOString() });
    const parts = d.groupId ? this.downloadsRepo.group(d.groupId) : [d];
    for (const p of parts) {
      for (const f of [p.finalPath, p.partPath]) if (f) rmSync(f, { force: true });
      this.downloadsRepo.update(p.id, {
        state: 'resolving', url: null, finalPath: null, partPath: null, receivedBytes: 0, totalBytes: null, preparation: null,
        installState: 'none', installDetail: 'The download was damaged — fetching a fresh copy', errorCode: null, errorDetail: null,
        resolution: p.groupId && p.id !== p.groupId && p.resolution ? { ...p.resolution, steps: 0, history: [] } : null,
      });
    }
    toast('warning', `The download of ${d.title} was damaged. Downloading a fresh copy…`);
    this.recovery.redownload(parts.map((p) => p.id));
    this.downloads.broadcastList();
    return true;
  }

  setRecovery(recovery: { redownload: (ids: number[]) => void; cache: { get: (key: string, hours: number) => unknown; set: (key: string, value: unknown) => void } }) {
    this.recovery = recovery;
  }

  /** The stored update state, with the live state of its download folded in. */
  private updateView(g: GameRecord): GameUpdateInfo | null {
    if (!g.update) return null;
    const { prepared: _prepared, ...u } = g.update;
    if (u.state !== 'downloading') return u;
    const d = u.downloadId ? this.downloadsRepo.get(u.downloadId) : null;
    if (!d || d.state === 'cancelled' || d.state === 'failed') return { ...u, state: 'failed', detail: d?.errorDetail ?? 'The update download stopped. Try again.' };
    if (d.state === 'needs-user') return { ...u, detail: d.userPrompt?.message ?? 'The download needs you in the browser.' };
    if (d.state === 'needs-resolution' || (d.state === 'resolving' && !this.agentContext.session.active)) return { ...u, detail: 'Finding the download…' };
    if (d.state === 'resolving') return { ...u, detail: 'Finding the download…' };
    if (d.state === 'completed') return { ...u, state: 'preparing', detail: 'Unpacking the new version…' };
    return { ...u, detail: d.totalBytes ? `Downloading ${Math.round((d.receivedBytes / d.totalBytes) * 100)}%` : 'Downloading…' };
  }

  private listener: ((games: Game[]) => void) | null = null;
  private playingListener: ((playing: boolean) => void) | null = null;
  /** Told when the first game starts and when the last one closes. */
  onPlaying(fn: (playing: boolean) => void) {
    this.playingListener = fn;
  }
  /** Also told about Library changes (the tray's recent games). */
  onChanged(fn: (games: Game[]) => void) {
    this.listener = fn;
    fn(this.list());
  }

  broadcast() {
    const games = this.list();
    publish('library:changed', games);
    this.listener?.(games);
  }

  /** An applications-menu entry or desktop icon that starts the game through the launcher. */
  shortcut(id: number, where: 'menu' | 'desktop', fallbackIcon: string): { path: string } {
    const g = this.games.get(id);
    if (!g) throw new Error('Game not found');
    const artwork = g.artworkFile ? join(paths.artwork, g.artworkFile) : null;
    return { path: createShortcut({ id, title: g.title, where, artwork, iconDir: join(paths.data, 'icons'), fallbackIcon }) };
  }

  private defaultRunner(kind: 'linux' | 'windows'): Runner {
    if (kind === 'linux') return 'native';
    return 'proton';
  }

  async installFromDownload(downloadId: number) {
    return this.prepareDownload(downloadId);
  }

  /**
   * Runs one AI decision in the foreground queue (it outranks indexing). Only
   * the decisions wait there: unpacking a large game must not hold up other
   * downloads' AI work, nor be cancelled when the user switches tabs.
   */
  private ai<T>(fn: (token: SessionToken) => Promise<T>): Promise<T> {
    const fg = this.agentContext.foreground;
    if (fg) return fg.run(20, fn);
    const token = this.agentContext.session.token();
    return token ? fn(token) : Promise.reject(Object.assign(new Error('AI paused'), { code: 'cancelled' }));
  }

  /** Every part's file of a split game, in order (undefined for a single file). */
  private partFiles(d: DownloadRecord): string[] | undefined {
    return d.groupId ? this.partsReady(d.groupId).files : undefined;
  }

  /** Stops unpacking at shutdown; everything else survives in the database. */
  shutdown() {
    this.work.abort();
  }

  private pausePreparation(downloadId: number, detail = 'Preparation paused — it continues automatically') {
    this.downloadsRepo.update(downloadId, { installState: 'none', installDetail: detail });
    if (!this.preparationQueue.includes(downloadId)) this.preparationQueue.push(downloadId);
    this.downloads.broadcastList();
  }

  private async prepareDownload(downloadId: number) {
    const d = this.downloadsRepo.get(downloadId);
    if (!d || d.state !== 'completed' || !d.finalPath) throw new Error('The download is not complete');
    if (!existsSync(d.finalPath)) throw new Error('The downloaded file is missing');
    if (this.installing.has(downloadId)) return;
    if (d.gameId && this.games.get(d.gameId)) throw new Error('Already installed');
    const updating = d.updateGameId ? this.games.get(d.updateGameId) : null;
    if (updating) return this.prepareUpdate(d, updating);
    if (!this.agentContext.session.active) { this.pausePreparation(downloadId); return; }
    this.installing.add(downloadId);
    const s = this.settings.get();
    const gameDir = join(s.libraryDir, `${slug(d.title)}-${downloadId}`);
    this.downloadsRepo.update(downloadId, { installState: 'installing', installDetail: 'Preparing…' });
    this.downloads.broadcastList();
    try {
      const entry = d.catalogId ? this.catalog.raw(d.catalogId) : null;
      const preferredPlatform = entry?.platforms.length === 1 && ['linux', 'windows'].includes(entry.platforms[0]) ? entry.platforms[0] : undefined;
      let r = d.preparation;
      if (!r || !existsSync(r.installDir)) {
        const type = await this.worker.call<string>('packageType', { path: d.finalPath }, this.work.signal);
        await this.ai((token) => this.agentContext.agent.prepare(token, d.title, { name: basename(d.finalPath!), type, bytes: statSync(d.finalPath!).size }));
        this.downloadsRepo.update(downloadId, { installDetail: 'Unpacking…' });
        this.downloads.broadcastList();
        r = await this.worker.call<InstallResult>('install', { downloadId, filePath: d.finalPath, parts: this.partFiles(d), gameDir, title: d.title, preferredPlatform, agentManaged: true }, this.work.signal);
        // Pristine file list before anything runs: later saves can be told apart on update.
        await this.worker.call('snapshotBuild', { root: r.installDir, out: manifestFor(r.installDir) }, this.work.signal).catch(() => undefined);
        // Kept, so a pause before the next AI decision never unpacks the game again.
        this.downloadsRepo.update(downloadId, { preparation: r });
      }
      const candidates = r.candidates;
      const selected = await this.ai(async (token) => {
        const choice = await this.agentContext.agent.executable(token, d.title, candidates);
        this.agentContext.session.assertLive(token, 'AI Library registration');
        this.agentContext.agent.registered?.(token, d.title, choice.path);
        return choice;
      });
      if (!r.candidates.some(c => c.path === selected.path) || !inside(r.installDir, selected.path) || selected.installerLike || selected.kind === 'msi') throw new Error('The AI selected an invalid game executable');
      r = { ...r, executable: selected.path, kind: selected.kind === 'exe' ? 'windows' : 'linux', status: 'installed' };
      if (r.kind === 'linux') chmodSync(selected.path, 0o755);
      const game = this.games.create({
        catalogId: d.catalogId,
        downloadId,
        title: entry?.title ?? d.title,
        kind: r.kind,
        installDir: r.installDir,
        executable: r.executable,
        args: '',
        runner: this.defaultRunner(r.kind),
        prefixDir: null,
        managed: true,
        artworkFile: entry?.artworkFile ?? null,
        sourceHost: d.sourceHost,
        status: r.status,
        candidates: r.candidates.map((c) => c.path),
        installedVersion: entry?.version ? { ...entry.version, file: installedFile(d) } : null,
      });
      if (r.kind === 'windows') {
        this.games.update(game.id, { prefixDir: join(paths.prefixes, `game-${game.id}`) });
        void this.compat.ensureProton().catch(() => undefined);
      }
      this.downloadsRepo.update(downloadId, {
        installState: 'installed',
        installDetail: r.status === 'installed' ? 'Ready to play' : r.status === 'installer-pending' ? 'Run the installer from the Library' : 'Choose which file starts the game',
        gameId: game.id,
      });
      if (d.groupId) for (const p of this.downloadsRepo.group(d.groupId)) if (p.id !== downloadId) this.downloadsRepo.update(p.id, { installState: 'installed', installDetail: `Part of ${game.title}`, gameId: game.id });
      toast('success', r.status === 'installed' ? `${game.title} is ready in your Library.` : `${game.title} needs one more step in the Library.`);
      if (r.status === 'installed') this.afterInstalled(game.id);
    } catch (e) {
      const paused = isCancelled(e);
      const interrupted = paused || (e as { code?: string }).code === 'worker-exit';
      if (!interrupted && (e as { code?: string }).code === 'corrupt' && this.redownloadDamaged(d)) return;
      if (paused) this.pausePreparation(downloadId);
      else this.downloadsRepo.update(downloadId, { installState: interrupted ? 'none' : 'failed', installDetail: interrupted ? 'Preparation interrupted; retrying…' : (e as { code?: string }).code === 'corrupt' ? `The downloaded file is damaged again — the file on the website is probably broken. (${(e as Error).message.slice(0, 200)})` : (e as Error).message.slice(0, 300) });
      if (!paused && interrupted && !this.work.signal.aborted) setTimeout(() => this.enqueuePreparation(downloadId), 2000).unref();
      else if (!interrupted) toast('error', `Could not prepare ${d.title}: ${(e as Error).message}`);
    } finally {
      this.installing.delete(downloadId);
      this.downloads.broadcastList();
      this.broadcast();
    }
  }

  // ── Updates ──────────────────────────────────────────────────────────────
  // A newer build downloads like any game, unpacks into its own folder while
  // the installed one stays playable, receives the player's saves, and then
  // replaces it. The replaced build is kept for rollback until the new one has
  // been played.

  /** Downloads the newer build of an installed game. */
  startUpdate(id: number) {
    const g = this.games.get(id);
    if (!g?.catalogId || !g.managed || !g.installDir) throw new Error('Only games the launcher installed from a website can be updated');
    const current = this.updateView(g);
    if (current && UPDATE_BUSY.has(current.state)) return;
    const entry = this.catalog.raw(g.catalogId);
    if (!entry || entry.downloadStatus !== 'available') throw new Error('The game page no longer offers a download');
    if (!this.startDownload) throw new Error('Downloads are not ready yet');
    // Named after the page's current title, so the new folder carries the new version.
    const d = this.startDownload(g.catalogId, entry.title || g.title, g.sourceHost);
    this.downloadsRepo.update(d.id, { updateGameId: id });
    const now = new Date().toISOString();
    const base: GameUpdateInfo = g.update ?? { state: 'available', from: versionLabel(g.installedVersion), to: versionLabel(entry.version), reason: 'update requested', detectedAt: now, key: entry.version ? fingerprintKey(entry.version) : now };
    this.games.update(id, { update: { ...base, to: versionLabel(entry.version) ?? base.to, state: 'downloading', downloadId: d.id, detail: null, prepared: null } });
    this.downloads.broadcastList();
    this.broadcast();
  }

  private setUpdate(id: number, patch: Partial<GameUpdateInfo>) {
    const cur = this.games.get(id)?.update;
    if (!cur) return;
    this.games.update(id, { update: { ...cur, ...patch } });
    this.broadcast();
  }

  private failUpdate(id: number, e: unknown) {
    const message = (e as Error).message?.slice(0, 300) ?? String(e);
    this.setUpdate(id, { state: 'failed', detail: message, prepared: null });
    toast('error', `Could not update ${this.games.get(id)?.title ?? 'the game'}: ${message}`);
  }

  private async prepareUpdate(d: DownloadRecord, old: GameRecord) {
    if (this.installing.has(d.id)) return;
    this.installing.add(d.id);
    // Unpacking and matching the executable need no AI; only an ambiguous
    // executable asks the AI.
    const signal = this.work.signal;
    this.downloadsRepo.update(d.id, { installState: 'installing', installDetail: `Preparing the update for ${old.title}…` });
    this.downloads.broadcastList();
    this.setUpdate(old.id, { state: 'preparing', detail: 'Unpacking the new version…' });
    try {
      let r = d.preparation;
      if (!r || !existsSync(r.installDir)) {
        const gameDir = join(this.settings.get().libraryDir, `${slug(d.title)}-${d.id}`);
        r = await this.worker.call<InstallResult>('install', { downloadId: d.id, filePath: d.finalPath!, parts: this.partFiles(d), gameDir, title: d.title, preferredPlatform: old.kind, agentManaged: true }, signal);
        await this.worker.call('snapshotBuild', { root: r.installDir, out: manifestFor(r.installDir) }, signal).catch(() => undefined);
        this.downloadsRepo.update(d.id, { preparation: r });
      }
      const oldRel = old.installDir && old.executable ? relative(old.installDir, old.executable) : basename(old.executable ?? '');
      const matched = matchExecutable(oldRel, r.candidates);
      let selected = matched !== null ? r.candidates[matched] : null;
      if (!selected) {
        const candidates = r.candidates;
        selected = await this.ai(async (token) => {
          const choice = await this.agentContext.agent.executable(token, d.title, candidates);
          this.agentContext.session.assertLive(token, 'AI update executable');
          return choice;
        });
      }
      if (!r.candidates.some((c) => c.path === selected!.path) || !inside(r.installDir, selected.path) || selected.installerLike || selected.kind === 'msi') {
        throw new Error('The new version ships only an installer; install it from the Store page instead');
      }
      const kind = selected.kind === 'exe' ? 'windows' : 'linux';
      if (kind === 'linux') chmodSync(selected.path, 0o755);
      const prepared: PreparedBuild = { installDir: r.installDir, executable: selected.path, kind, candidates: r.candidates.map((c) => c.path), downloadId: d.id };
      if (this.runningIds.has(old.id)) {
        this.setUpdate(old.id, { state: 'waiting', prepared, detail: 'Installs when you close the game' });
        this.downloadsRepo.update(d.id, { installState: 'installing', installDetail: 'Update ready — installs when the game closes' });
        toast('info', `The update for ${old.title} is ready and installs when you close the game.`);
        return;
      }
      await this.applyUpdate(old.id, prepared);
    } catch (e) {
      const paused = isCancelled(e);
      if (paused || (e as { code?: string }).code === 'worker-exit') {
        this.downloadsRepo.update(d.id, { installState: 'none', installDetail: 'Update preparation paused; it continues automatically' });
        this.setUpdate(old.id, { state: 'preparing', detail: 'Paused — continues automatically' });
        if (!this.preparationQueue.includes(d.id)) this.preparationQueue.push(d.id);
        if (!paused && !this.work.signal.aborted) setTimeout(() => this.enqueuePreparation(d.id), 2000).unref();
      } else {
        this.downloadsRepo.update(d.id, { installState: 'failed', installDetail: (e as Error).message.slice(0, 300) });
        this.failUpdate(old.id, e);
      }
    } finally {
      this.installing.delete(d.id);
      this.downloads.broadcastList();
      this.broadcast();
    }
  }

  /** Carries saves into the prepared build and makes it the installed one. */
  private async applyUpdate(id: number, prepared: PreparedBuild) {
    const g = this.games.get(id);
    if (!g) return;
    if (this.runningIds.has(id)) { this.setUpdate(id, { state: 'waiting', prepared }); return; }
    if (!existsSync(prepared.executable)) throw new Error('The prepared update is missing; download it again');
    this.setUpdate(id, { state: 'preparing', detail: 'Moving your saves to the new version…' });
    if (this.settings.get().saveBackups) await this.backupSaves(id, 'before updating');
    let carried = 0;
    if (g.installDir && g.executable && existsSync(g.installDir)) {
      const r = await this.worker.call<{ copied: string[]; skipped: string[] }>('carryOver', {
        fromRoot: g.installDir, fromExe: g.executable, toRoot: prepared.installDir, toExe: prepared.executable,
        manifest: manifestFor(g.installDir), since: Date.parse(g.addedAt),
      });
      carried = r.copied.length;
      if (carried) console.log(`[updates] ${g.title}: carried ${carried} file(s) into the new version`, r.copied.slice(0, 20));
    }
    // Only one previous build is kept.
    if (g.previous?.installDir && g.previous.installDir !== g.installDir) await this.removeBuild(g.previous.installDir);
    const d = this.downloadsRepo.get(prepared.downloadId);
    const entry = g.catalogId ? this.catalog.raw(g.catalogId) : null;
    const now = new Date().toISOString();
    const previous: PreviousBuild = { installDir: g.installDir, executable: g.executable, kind: g.kind, runner: g.runner, candidates: g.candidates, version: g.installedVersion, replacedAt: now };
    const installedVersion: InstalledVersion = { ...(entry?.version ?? { version: null, updated: null, files: [], sizes: [], at: now }), file: installedFile(d) };
    const runner = prepared.kind === g.kind ? g.runner : this.defaultRunner(prepared.kind);
    const prefixDir = g.prefixDir ?? (prepared.kind === 'windows' ? join(paths.prefixes, `game-${g.id}`) : null);
    const to = versionLabel(installedVersion) ?? g.update?.to ?? null;
    const title = retitle(g.title, g.installedVersion?.version, installedVersion.version);
    this.games.update(id, {
      title,
      installDir: prepared.installDir, executable: prepared.executable, kind: prepared.kind, runner, prefixDir,
      candidates: prepared.candidates, status: 'installed', downloadId: prepared.downloadId, previous, installedVersion,
      update: { ...(g.update ?? { from: versionLabel(g.installedVersion), reason: 'updated', detectedAt: now, key: entry?.version ? fingerprintKey(entry.version) : now }), state: 'updated', to, carried, detail: null, prepared: null },
      updateCheckedAt: now,
    });
    this.downloadsRepo.update(prepared.downloadId, { installState: 'installed', installDetail: `Updated ${g.title}${to ? ` to ${to}` : ''}`, gameId: id });
    if (prepared.kind === 'windows') void this.compat.ensureProton().catch(() => undefined);
    toast('success', `${g.title} updated${to ? ` to ${to}` : ''}.${carried ? ` ${carried} save/settings file${carried === 1 ? '' : 's'} carried over.` : ''} The previous version is kept until you have played the new one.`);
    this.afterInstalled(id);
    this.downloads.broadcastList();
    this.broadcast();
  }

  // ── Save backups ─────────────────────────────────────────────────────────

  private backupDir(id: number) {
    return join(paths.saveBackups, `game-${id}`);
  }

  /** Copies the game's saves (prefix user folders, files it wrote in its folder); null when there is nothing to save. */
  async backupSaves(id: number, reason: string): Promise<SaveBackup | null> {
    const g = this.games.get(id);
    if (!g) return null;
    const at = new Date().toISOString();
    const stamp = at.replace(/[:.]/g, '-');
    const out = join(this.backupDir(id), stamp);
    try {
      const r = await this.worker.call<{ files: number; bytes: number }>('backupSaves', {
        out,
        gameRoot: g.managed ? g.installDir : null,
        manifest: g.installDir ? manifestFor(g.installDir) : null,
        since: Date.parse(g.addedAt),
        prefix: g.prefixDir,
        meta: { reason, at, title: g.title, version: versionLabel(g.installedVersion) },
      });
      if (!r.files) return null;
      await this.worker.call('pruneBackups', { dir: this.backupDir(id), keep: this.settings.get().saveBackupsKeep });
      return { stamp, at, reason, files: r.files, bytes: r.bytes, version: versionLabel(g.installedVersion) };
    } catch (e) {
      console.warn('[saves] backup failed', g.title, (e as Error).message);
      return null;
    }
  }

  listSaves(id: number): SaveBackup[] {
    const dir = this.backupDir(id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).sort().reverse().flatMap((stamp) => {
      try {
        const m = JSON.parse(readFileSync(join(dir, stamp, 'backup.json'), 'utf8')) as { reason: string; at: string; files: number; bytes: number; version?: string | null };
        return [{ stamp, at: m.at, reason: m.reason, files: m.files, bytes: m.bytes, version: m.version ?? null }];
      } catch { return []; }
    });
  }

  /** Puts a backup back; the current saves are backed up first, so a restore can itself be undone. */
  async restoreSaves(id: number, stamp: string): Promise<{ files: number }> {
    const g = this.games.get(id);
    if (!g) throw new Error('Game not found');
    if (this.runningIds.has(id)) throw new Error('Close the game before restoring saves');
    const from = join(this.backupDir(id), stamp);
    if (!existsSync(join(from, 'backup.json'))) throw new Error('That backup no longer exists');
    await this.backupSaves(id, 'before restoring an older backup');
    const r = await this.worker.call<{ files: number }>('restoreSaves', { from, gameRoot: g.managed ? g.installDir : null, prefix: g.prefixDir });
    toast('success', `Restored ${r.files} save file${r.files === 1 ? '' : 's'} for ${g.title}.`);
    return r;
  }

  async openSaves(id: number) {
    const dir = this.backupDir(id);
    if (existsSync(dir)) await shell.openPath(dir);
  }

  /** After a play session: back up saves, install a waiting update, or retire the previous build once the new one works. */
  private async afterPlay(id: number, seconds: number, code: number | null, failed: boolean) {
    const g = this.games.get(id);
    if (!g) return;
    if (!failed && seconds >= 60 && this.settings.get().saveBackups) await this.backupSaves(id, 'after playing');
    if (g.update?.state === 'waiting' && g.update.prepared) {
      await this.applyUpdate(id, g.update.prepared).catch((e) => this.failUpdate(id, e));
      return;
    }
    if (!g.previous) return;
    if (failed || (code && code !== 0 && seconds < 20)) {
      toast('warning', `${g.title} closed right after starting. If the update broke it, use “Roll back” in the Library.`);
      return;
    }
    if (seconds < 60) return;
    if (g.previous.installDir && g.previous.installDir !== g.installDir) await this.removeBuild(g.previous.installDir);
    this.games.update(id, { previous: null, update: g.update?.state === 'updated' ? null : g.update });
    this.broadcast();
  }

  /** Back to the build an update replaced; the player's newer saves come along. */
  async rollback(id: number) {
    const g = this.games.get(id);
    const p = g?.previous;
    if (!g || !p?.installDir || !p.executable || !existsSync(p.executable)) throw new Error('The previous version is no longer available');
    if (this.runningIds.has(id)) throw new Error('Close the game before rolling back');
    if (this.settings.get().saveBackups) await this.backupSaves(id, 'before rolling back');
    if (g.installDir && g.executable && existsSync(g.installDir)) {
      await this.worker.call('carryOver', { fromRoot: g.installDir, fromExe: g.executable, toRoot: p.installDir, toExe: p.executable, manifest: manifestFor(g.installDir), since: null });
    }
    const current = g.installDir;
    const now = new Date().toISOString();
    const entry = g.catalogId ? this.catalog.raw(g.catalogId) : null;
    // The build rolled back from is not offered again; a later one is.
    const key = g.update?.key ?? (entry?.version ? fingerprintKey(entry.version) : now);
    this.games.update(id, {
      title: retitle(g.title, g.installedVersion?.version, p.version?.version),
      installDir: p.installDir, executable: p.executable, kind: p.kind, runner: p.runner, candidates: p.candidates,
      installedVersion: p.version, previous: null, status: 'installed',
      update: { state: 'ignored', from: versionLabel(p.version), to: versionLabel(g.installedVersion), reason: 'rolled back', detectedAt: now, key },
    });
    if (current && current !== p.installDir) await this.removeBuild(current);
    toast('success', `${g.title} is back on ${versionLabel(p.version) ?? 'the previous version'}.`);
    this.broadcast();
  }

  /** Not interested in this build; a later one is offered again. */
  ignoreUpdate(id: number) {
    const g = this.games.get(id);
    const current = g ? this.updateView(g) : null;
    if (!current || UPDATE_BUSY.has(current.state)) return;
    this.setUpdate(id, { state: 'ignored', detail: null });
  }

  private async removeBuild(dir: string) {
    try {
      await this.worker.call('removeManaged', { path: dir, root: this.settings.get().libraryDir });
      rmSync(manifestFor(dir), { force: true });
    } catch (e) {
      console.warn('[updates] could not remove old build', dir, (e as Error).message);
    }
  }

  private tools = detectTools();

  private async runnerEnv(runner: Runner, launch?: LaunchOptions) {
    const s = this.settings.get();
    // A game's own Proton build, when it is still installed; otherwise the default.
    const own = runner === 'proton' && launch?.protonPath && this.compat.installed().some((p) => p.path === launch.protonPath) ? launch.protonPath : null;
    return {
      winePath: s.winePath || detectWine() || 'wine',
      protonPath: runner === 'proton' ? own ?? await this.compat.ensureProton() : '',
      umuPath: s.umuPath || vendor().umu,
    };
  }

  /** Wrappers and environment from the game's launch options, for the install worker. */
  private extras(launch: LaunchOptions) {
    return { ...launch, tools: this.tools };
  }

  private allowedRoot(g: GameRecord) {
    return g.installDir ?? dirname(g.executable ?? '/nonexistent');
  }

  async launch(id: number) {
    const g = this.games.get(id);
    if (!g) throw new Error('Game not found');
    if (!g.executable) throw new Error('Choose the executable first');
    const runner = g.kind === 'linux' ? 'native' : g.runner === 'native' ? 'proton' : g.runner;
    let env: Awaited<ReturnType<Library['runnerEnv']>>;
    try {
      env = await this.runnerEnv(runner, g.launch);
    } catch (e) {
      // Like Heroic: Play while Proton is still being set up is remembered,
      // and the game starts by itself the moment Proton is verified.
      if ((e as { code?: string }).code !== 'proton-provisioning') throw e;
      if (!this.pendingLaunch.has(id)) {
        this.pendingLaunch.add(id);
        this.compat.whenReady(() => { this.pendingLaunch.delete(id); void this.launch(id).catch((err) => toast('error', `Could not start ${g.title}: ${(err as Error).message}`)); });
      }
      toast('info', `Setting up Proton for ${g.title} — it will start automatically when ready (progress in Downloads).`);
      return;
    }
    if (runner === 'proton') this.compat.notifyRuntime();
    await this.worker.call('launch', {
      gameId: id,
      executable: g.executable,
      args: splitArgs(g.args),
      runner,
      prefixDir: g.prefixDir ?? (g.kind === 'windows' ? join(paths.prefixes, `game-${g.id}`) : null),
      ...env,
      logPath: join(paths.logs, `game-${id}.log`),
      allowedRoot: this.allowedRoot(g),
      extras: this.extras(g.launch),
      // The Steam id lets umu apply this game's known fixes (protonfixes).
      umuId: g.art?.appid ? `umu-${g.art.appid}` : null,
    });
  }

  async stop(id: number) {
    await this.worker.call('stop', { gameId: id });
  }

  async runInstaller(id: number) {
    const g = this.games.get(id);
    if (!g || g.status !== 'installer-pending') throw new Error('No installer is waiting for this game');
    const installer = g.candidates[0];
    if (!installer || !existsSync(installer)) throw new Error('The installer file is missing');
    const prefixDir = g.prefixDir ?? join(paths.prefixes, `game-${g.id}`);
    this.games.update(id, { prefixDir, status: 'installing' });
    this.broadcast();
    try {
      const runner = g.runner === 'native' ? 'proton' : g.runner;
      const env = await this.runnerEnv(runner);
      if (runner === 'proton') this.compat.notifyRuntime();
      await this.worker.call('launch', {
        gameId: id,
        executable: installer,
        args: [],
        runner: g.runner === 'native' ? 'proton' : g.runner,
        prefixDir,
        ...env,
        logPath: join(paths.logs, `game-${id}-installer.log`),
        allowedRoot: this.allowedRoot(g),
        installer: true,
      });
    } catch (e) {
      this.games.update(id, { status: 'installer-pending' });
      this.broadcast();
      throw e;
    }
  }

  private async afterInstaller(id: number) {
    const g = this.games.get(id);
    if (!g?.prefixDir) return;
    const driveC = join(g.prefixDir, 'drive_c');
    const cands = await this.worker
      .call<Array<{ path: string; installerLike: boolean }>>('scan', { dir: driveC, title: g.title, windowsOnly: true })
      .catch(() => []);
    const usable = cands.filter((c) => !c.installerLike && !/[\\/](windows|programdata)[\\/]/i.test(c.path));
    this.games.update(id, {
      status: usable.length ? 'needs-executable' : 'installer-pending',
      candidates: usable.map((c) => c.path).slice(0, 30),
    });
    if (usable.length === 1) {
      this.games.update(id, { executable: usable[0].path, status: 'installed' });
      toast('success', `${g.title} is installed.`);
    } else if (usable.length) {
      toast('info', `Installer finished. Choose which program starts ${g.title}.`);
    } else {
      toast('warning', 'The installer finished but no game program was found. Run it again or pick the file manually.');
    }
    this.broadcast();
  }

  configure(id: number, patch: { title?: string; executable?: string; args?: string; runner?: Runner; launch?: Partial<LaunchOptions> }): Game {
    const g = this.games.get(id);
    if (!g) throw new Error('Game not found');
    if (patch.launch) {
      const launch = { ...g.launch, ...patch.launch };
      if (launch.protonPath && !this.compat.installed().some((p) => p.path === launch.protonPath)) throw new Error('That Proton version is not installed');
      this.games.update(id, { launch });
    }
    if (patch.executable !== undefined) {
      const ok =
        inside(this.allowedRoot(g), patch.executable) || (g.prefixDir ? inside(g.prefixDir, patch.executable) : false) || g.candidates.includes(patch.executable);
      if (!ok || !existsSync(patch.executable)) throw new Error('Pick a file inside the game folder');
    }
    // Choosing a different build may switch platforms (e.g. the Windows .exe of a multi-platform archive).
    let kind = g.kind;
    let runner = patch.runner ?? g.runner;
    let prefixDir = g.prefixDir;
    if (patch.executable !== undefined) {
      kind = /\.(exe|msi|bat)$/i.test(patch.executable) ? 'windows' : 'linux';
      if (kind === 'linux') runner = 'native';
      else if (runner === 'native') runner = this.defaultRunner('windows');
      if (kind === 'windows' && !prefixDir) prefixDir = join(paths.prefixes, `game-${g.id}`);
    }
    if (runner === 'native' && kind === 'windows') throw new Error('Windows games need Wine or Proton');
    if (runner !== 'native' && kind === 'linux') throw new Error('Linux games run natively');
    this.games.update(id, {
      title: patch.title,
      executable: patch.executable,
      args: patch.args,
      runner,
      kind,
      prefixDir,
      status: patch.executable ? 'installed' : undefined,
    });
    this.broadcast();
    return this.list().find((x) => x.id === id)!;
  }

  setFavorite(id: number, favorite: boolean) {
    this.games.update(id, { favorite });
    this.broadcast();
  }

  async uninstall(id: number, removePrefix: boolean) {
    const g = this.games.get(id);
    if (!g) return;
    if (this.runningIds.has(id)) throw new Error('Stop the game before uninstalling it');
    // Kept after uninstalling: reinstalling and restoring brings the progress back.
    if (this.settings.get().saveBackups) await this.backupSaves(id, 'before uninstalling');
    const s = this.settings.get();
    if (g.managed && g.installDir) {
      await this.worker.call('removeManaged', { path: g.installDir, root: s.libraryDir });
      rmSync(manifestFor(g.installDir), { force: true });
    }
    if (g.previous?.installDir) await this.removeBuild(g.previous.installDir);
    if (removePrefix && g.prefixDir && existsSync(g.prefixDir)) {
      await this.worker.call('removeManaged', { path: g.prefixDir, root: paths.prefixes });
    }
    if (g.downloadId) this.downloadsRepo.update(g.downloadId, { installState: 'none', installDetail: null, gameId: null });
    removeShortcuts(id);
    this.games.remove(id);
    this.downloads.broadcastList();
    this.broadcast();
  }

  async importGame(): Promise<Game | null> {
    const win = this.window();
    const res = await dialog.showOpenDialog(win!, {
      title: 'Import a game — choose the file that starts it',
      properties: ['openFile'],
      filters: [
        { name: 'Games', extensions: ['exe', 'AppImage', 'appimage', 'x86_64', 'sh', '*'] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const exe = res.filePaths[0];
    const kind = await this.worker.call<string>('packageType', { path: exe });
    if (kind === 'unsupported' || kind === 'archive') throw new Error('Choose an executable (Linux program, AppImage, script or Windows .exe)');
    const isWin = kind === 'windows-exe' || kind === 'windows-installer';
    const title = basename(exe).replace(/\.(exe|appimage|x86_64|sh)$/i, '').replace(/[-_.]+/g, ' ').trim() || 'Imported game';
    const game = this.games.create({
      catalogId: null,
      downloadId: null,
      title,
      kind: isWin ? 'windows' : 'linux',
      installDir: dirname(exe),
      executable: exe,
      args: '',
      runner: this.defaultRunner(isWin ? 'windows' : 'linux'),
      prefixDir: null,
      managed: false,
      artworkFile: null,
      sourceHost: null,
      status: 'installed',
      candidates: [],
    });
    if (isWin) this.games.update(game.id, { prefixDir: join(paths.prefixes, `game-${game.id}`) });
    this.broadcast();
    return this.list().find((x) => x.id === game.id) ?? null;
  }

  async pickExecutable(id: number): Promise<Game | null> {
    const g = this.games.get(id);
    if (!g) return null;
    const res = await dialog.showOpenDialog(this.window()!, {
      title: 'Choose the file that starts the game',
      defaultPath: g.installDir ?? g.prefixDir ?? undefined,
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return this.configure(id, { executable: res.filePaths[0] });
  }

  reveal(id: number) {
    const g = this.games.get(id);
    const target = g?.executable ?? g?.installDir;
    if (target && existsSync(target)) shell.showItemInFolder(target);
  }

  isRunning(id: number) {
    return this.runningIds.has(id);
  }
}

/** Splits a command-line argument string, honouring simple quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
