// Install utility process: extracts archives, finds executables, launches and
// stops games, and removes app-managed files. Nothing runs automatically after
// a download — every launch or installer run is an explicit user request.
import { carryOver, snapshotBuild } from './carry-over';
import { backupSaves, pruneBackups, restoreSaves } from './save-backup';
import { applyExtras, type LaunchExtras } from './launch-wrap';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, realpathSync, openSync, closeSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { emit, serve } from './rpc';
import { prepareGame, type InstallParams } from './prepare-game';
import { extractArchive, DEFAULT_LIMITS } from './extract';
import { packageType } from './package-type';
import { scanExecutables, detectKind } from './exec-scan';

process.title = 'cgl-install';

function within(root: string, target: string): boolean {
  const r = realpathSync(root);
  const t = existsSync(target) ? realpathSync(target) : resolve(target);
  return t !== r && t.startsWith(r + sep);
}

// --- launching -----------------------------------------------------------

interface LaunchParams {
  gameId: number;
  executable: string;
  args: string[];
  runner: 'native' | 'wine' | 'proton';
  prefixDir: string | null;
  winePath: string;
  protonPath: string;
  umuPath: string;
  logPath: string;
  /** Allowed root for the executable (install dir or, for imports, the import folder). */
  allowedRoot: string;
  installer?: boolean;
  /** Per-game launch options with the helper tools found on the system. */
  extras?: LaunchExtras;
}


const running = new Map<number, { child: ChildProcess; startedAt: number; prefix: string | null; wine: string | null }>();

function buildCommand(p: LaunchParams): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Do not leak the AppImage's own library paths into games.
  for (const k of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'ELECTRON_RUN_AS_NODE', 'CHROME_DESKTOP', 'GDK_BACKEND']) delete env[k];
  if (p.runner === 'native') {
    const kind = detectKind(p.executable, statSync(p.executable).mode);
    if (kind === 'script') return { cmd: '/bin/sh', args: [p.executable, ...p.args], env };
    return { cmd: p.executable, args: p.args, env };
  }
  if (!p.prefixDir) throw new Error('A Wine prefix is required');
  mkdirSync(p.prefixDir, { recursive: true });
  env.WINEPREFIX = p.prefixDir;
  const isMsi = p.executable.toLowerCase().endsWith('.msi');
  if (p.runner === 'wine') {
    const wine = p.winePath || 'wine';
    env.WINEDEBUG = env.WINEDEBUG ?? '-all';
    return { cmd: wine, args: isMsi ? ['msiexec', '/i', p.executable, ...p.args] : [p.executable, ...p.args], env };
  }
  // Proton outside Steam via umu-launcher.
  if (!p.umuPath || !existsSync(p.umuPath)) throw new Error('umu-launcher was not found. Set its path in Settings → Compatibility.');
  if (!p.protonPath) throw new Error('Choose a Proton installation in Settings → Compatibility first.');
  env.GAMEID = env.GAMEID ?? 'umu-default';
  env.PROTONPATH = p.protonPath;
  env.STORE = 'none';
  return { cmd: p.umuPath, args: isMsi ? ['msiexec', '/i', p.executable, ...p.args] : [p.executable, ...p.args], env };
}

function launch(p: LaunchParams) {
  if (running.has(p.gameId)) throw new Error('This game is already running');
  if (!existsSync(p.executable)) throw new Error('The executable no longer exists. Pick it again in the game settings.');
  if (!within(p.allowedRoot, p.executable) && !(p.prefixDir && within(p.prefixDir, p.executable))) {
    throw new Error('The executable is outside the game folder');
  }
  // Installers run plainly; games get their launch options.
  const { cmd, args, env } = applyExtras(buildCommand(p), p.installer ? undefined : p.extras, p.runner !== 'native');
  mkdirSync(dirname(p.logPath), { recursive: true });
  const logFd = openSync(p.logPath, 'a');
  const child = spawn(cmd, args, {
    cwd: dirname(p.executable),
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  const startedAt = Date.now();
  running.set(p.gameId, { child, startedAt, prefix: p.prefixDir, wine: p.runner === 'wine' ? p.winePath || 'wine' : null });
  child.on('error', (e) => {
    running.delete(p.gameId);
    emit('game-exit', { gameId: p.gameId, code: null, error: e.message, seconds: 0, installer: !!p.installer });
  });
  child.on('exit', (code, sig) => {
    running.delete(p.gameId);
    emit('game-exit', { gameId: p.gameId, code, signal: sig, seconds: Math.round((Date.now() - startedAt) / 1000), installer: !!p.installer });
  });
  emit('game-started', { gameId: p.gameId, pid: child.pid, installer: !!p.installer });
  return { pid: child.pid };
}

function stop(p: { gameId: number }) {
  const r = running.get(p.gameId);
  if (!r || !r.child.pid) return { ok: false };
  try {
    process.kill(-r.child.pid, 'SIGTERM');
  } catch {
    r.child.kill('SIGTERM');
  }
  if (r.wine && r.prefix) {
    const server = join(dirname(r.wine === 'wine' ? '/usr/bin/wine' : r.wine), 'wineserver');
    spawn(existsSync(server) ? server : 'wineserver', ['-k'], { env: { ...process.env, WINEPREFIX: r.prefix }, stdio: 'ignore' }).on('error', () => undefined);
  }
  setTimeout(() => {
    if (running.has(p.gameId) && r.child.pid) {
      try {
        process.kill(-r.child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, 6000).unref();
  return { ok: true };
}

function removeManaged(p: { path: string; root: string }) {
  if (!existsSync(p.path)) return { removed: false };
  if (!within(p.root, p.path)) throw new Error('Refusing to delete files outside the app-managed folder');
  rmSync(p.path, { recursive: true, force: true });
  return { removed: true };
}

serve({
  async hashFile(p: { path: string }, signal: AbortSignal) {
    const hash = createHash('sha256');
    const stream = createReadStream(p.path, { signal });
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
  },
  async extractCompat(p: { path: string; dest: string }, signal: AbortSignal) {
    await extractArchive(p.path, p.dest, signal, () => undefined, { ...DEFAULT_LIMITS, deferInternalLinks: true });
  },
  install(p: InstallParams, signal: AbortSignal) {
    let last = 0;
    return prepareGame(p, signal, (detail, fraction) => {
      if (Date.now() - last < 250 && fraction !== null && fraction !== 0) return;
      last = Date.now();
      emit('install-progress', { downloadId: p.downloadId, detail, fraction });
    });
  },
  scan(p: { dir: string; title: string; windowsOnly?: boolean }) {
    const all = scanExecutables(p.dir, p.title, 40000, 8);
    const list = p.windowsOnly ? all.filter((c) => c.kind === 'exe') : all;
    return list.filter((c) => !/[\\/]windows[\\/](system32|syswow64|winsxs)[\\/]/i.test(c.path)).slice(0, 40);
  },
  launch,
  stop,
  removeManaged,
  snapshotBuild,
  carryOver,
  backupSaves,
  restoreSaves,
  pruneBackups(p: { dir: string; keep: number }) { pruneBackups(p.dir, p.keep); return { ok: true }; },
  packageType(p: { path: string }) {
    return packageType(p.path);
  },
  running() {
    return [...running.keys()];
  },
});
