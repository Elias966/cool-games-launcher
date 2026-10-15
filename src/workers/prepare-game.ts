// Download authorizes copying/extraction and library registration; starting
// any game or installer remains a separate Play action.
import { copyFileSync, chmodSync, mkdirSync, rmSync, existsSync, mkdtempSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_LIMITS, extractArchive, ExtractError, freeBytes, isVolumeSet } from './extract';
import { packageType, type PackageType } from './package-type';
import { scanExecutables, pickExecutable, detectKind, type ExecCandidate } from './exec-scan';

export interface InstallParams { downloadId: number; filePath: string; /** Every file of a game split into parts, in order. */ parts?: string[]; gameDir: string; title: string; agentManaged?: boolean; preferredPlatform?: 'linux' | 'windows' }
export interface InstallResult {
  type: PackageType; installDir: string; kind: 'linux' | 'windows'; executable: string | null;
  candidates: ExecCandidate[]; status: 'installed' | 'needs-executable' | 'installer-pending';
}

export async function prepareGame(p: InstallParams, signal: AbortSignal, progress: (detail: string, fraction: number | null) => void): Promise<InstallResult> {
  const type = packageType(p.filePath);
  if (type === 'unsupported') throw new ExtractError('Supported game packages: ZIP, RAR, 7z and tar archives, Linux programs, AppImages and Windows executables.', 'unsupported');
  mkdirSync(dirname(p.gameDir), { recursive: true });
  const staging = mkdtempSync(`${p.gameDir}.extracting-`);
  let installed = false;
  try {
    let result: Omit<InstallResult, 'installDir'>;
    if (type === 'archive') {
      progress('Extracting the game folder…', 0);
      const parts = p.parts?.length ? p.parts : [p.filePath];
      const sourceBytes = parts.reduce((n, f) => n + (existsSync(f) ? statSync(f).size : 0), 0);
      // Volumes of one archive (part1.rar, .7z.001 …) open from the first; separately packed parts unpack one by one into the same folder.
      const queue = parts.length > 1 && !(await isVolumeSet(parts[0])) ? parts : [parts[0]];
      for (let i = 0; i < queue.length; i++) {
        const label = queue.length > 1 ? `part ${i + 1} of ${queue.length}: ` : '';
        await extractArchive(queue[i], staging, signal, (x) => progress(`Extracting ${label}${x.entries} files`, x.totalBytes ? (i + x.bytes / x.totalBytes) / queue.length : null), { ...DEFAULT_LIMITS, sourceBytes: queue.length === 1 ? sourceBytes : undefined });
      }
      progress('Finding the game executable…', null);
      const candidates = scanExecutables(staging, p.title, 100000, 12);
      const native = candidates.filter((c) => !c.installerLike && ['elf', 'appimage', 'script'].includes(c.kind));
      const windows = candidates.filter((c) => c.kind === 'exe' || c.kind === 'msi');
      const kind = p.preferredPlatform === 'windows' && windows.length ? 'windows' : native.length ? 'linux' : 'windows';
      const pool = kind === 'linux' ? native : windows;
      const choice = p.agentManaged ? null : pickExecutable(pool);
      if (choice && kind === 'linux') chmodSync(choice.path, 0o755);
      const onlyInstallers = kind === 'windows' && pool.length > 0 && pool.every((c) => c.installerLike || c.kind === 'msi');
      result = { type, kind, executable: choice?.path ?? null, candidates: [...pool.slice(0, 24), ...candidates.filter((c) => !pool.includes(c) && !c.installerLike).slice(0, 6)], status: onlyInstallers ? 'installer-pending' : choice ? 'installed' : 'needs-executable' };
    } else {
      if (statSync(p.filePath).size > freeBytes(staging) - 128 * 1024 ** 2) throw new ExtractError('Not enough free disk space', 'disk-full');
      const target = join(staging, basename(p.filePath));
      progress('Preparing the game…', null); copyFileSync(p.filePath, target);
      const native = type === 'appimage' || type === 'linux-binary';
      if (native) chmodSync(target, 0o755);
      const installer = type === 'windows-installer';
      result = { type, kind: native ? 'linux' : 'windows', executable: installer ? null : target, candidates: [{ path: target, relPath: basename(target), kind: target.endsWith('.msi') ? 'msi' : native ? type === 'appimage' ? 'appimage' : detectKind(target, statSync(target).mode) ?? 'elf' : 'exe', size: statSync(target).size, score: 0, installerLike: installer }], status: installer ? 'installer-pending' : 'installed' };
    }
    signal.throwIfAborted();
    // Preserve a folder from an older failed attempt instead of overwriting it.
    let destination = p.gameDir;
    for (let n = 2; existsSync(destination); n++) destination = `${p.gameDir}-${n}`;
    renameSync(staging, destination); installed = true;
    const moved = (path: string) => destination + path.slice(staging.length);
    return { ...result, installDir: destination, executable: result.executable ? moved(result.executable) : null, candidates: result.candidates.map((c) => ({ ...c, path: moved(c.path) })) };
  } finally {
    if (!installed) rmSync(staging, { recursive: true, force: true });
  }
}
