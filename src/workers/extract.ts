// Safe archive extraction. Rejects absolute paths, parent-directory escapes,
// links that point outside the destination, device files and zip bombs.
// Extraction never executes anything.
import { openSync, readSync, closeSync, createWriteStream, mkdirSync, symlinkSync, linkSync, chmodSync, existsSync, lstatSync, statfsSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep, isAbsolute, posix } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export class ExtractError extends Error {
  constructor(
    message: string,
    readonly code: 'unsafe' | 'disk-full' | 'unsupported' | 'corrupt' | 'cancelled' | 'too-large' = 'corrupt',
  ) {
    super(message);
    this.name = 'ExtractError';
  }
}

export interface ExtractLimits {
  /** Verified compatibility bundles can contain links through internal aliases. */
  deferInternalLinks?: boolean;
  maxEntries: number;
  maxTotalBytes: number;
  /** Ratio of uncompressed to compressed size above which, beyond 1 GB, the archive is refused. */
  maxRatio: number;
  /** Size of all volumes of a split archive (the ratio check otherwise sees only the first). */
  sourceBytes?: number;
}

/** Is this the first file of a multi-volume archive (RAR volumes, split .001 files)? */
export async function isVolumeSet(file: string): Promise<boolean> {
  if (/\.0*1$/.test(file)) return true;
  const kind = detectArchiveKind(file);
  if (kind !== 'rar' && kind !== '7z') return false;
  const { sevenZipVolumes } = await import('./sevenzip');
  return (await sevenZipVolumes(file)) > 1;
}

export const DEFAULT_LIMITS: ExtractLimits = {
  maxEntries: 250_000,
  maxTotalBytes: 200 * 1024 ** 3,
  maxRatio: 250,
};

export type ArchiveKind = 'rar' | '7z' | 'zip' | 'tar' | 'tar.gz' | 'tar.xz' | 'tar.bz2' | 'tar.zst';

export function archiveKind(fileName: string): ArchiveKind | null {
  const n = fileName.toLowerCase();
  if (n.endsWith('.rar')) return 'rar';
  if (n.endsWith('.7z')) return '7z';
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
  if (n.endsWith('.tar.xz') || n.endsWith('.txz')) return 'tar.xz';
  if (n.endsWith('.tar.bz2') || n.endsWith('.tbz2') || n.endsWith('.tbz')) return 'tar.bz2';
  if (n.endsWith('.tar.zst') || n.endsWith('.tzst')) return 'tar.zst';
  if (n.endsWith('.tar')) return 'tar';
  return null;
}

/** Hosts sometimes omit the filename or extension; inspect archive signatures. */
export function detectArchiveKind(file: string): ArchiveKind | null {
  if (existsSync(file)) {
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r'); const head = Buffer.alloc(512); const size = readSync(fd, head, 0, head.length, 0);
      const b = head.subarray(0, size); const hex = b.subarray(0, 8).toString('hex');
      if (/^504b(?:0304|0506|0708)/.test(hex)) return 'zip';
      if (hex.startsWith('526172211a07')) return 'rar';
      if (hex.startsWith('377abcaf271c')) return '7z';
      if (hex.startsWith('1f8b')) return 'tar.gz';
      if (hex.startsWith('fd377a585a00')) return 'tar.xz';
      if (hex.startsWith('425a68')) return 'tar.bz2';
      if (hex.startsWith('28b52ffd')) return 'tar.zst';
      if (b.subarray(257, 262).toString() === 'ustar') return 'tar';
    } catch { /* Extraction reports unreadable or corrupt files. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return archiveKind(file);
}

/** Resolves an archive member name inside `root`, or returns null when it would escape. */
export function safeJoin(root: string, member: string): string | null {
  if (!member || member.includes('\0')) return null;
  const unixish = member.replace(/\\/g, '/');
  if (unixish.startsWith('/') || /^[a-zA-Z]:\//.test(unixish)) return null;
  const norm = posix.normalize(unixish);
  if (norm === '..' || norm.startsWith('../') || norm.split('/').includes('..')) return null;
  const full = resolve(root, norm);
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
  return full;
}

/** Checks that a symlink created at `linkPath` pointing to `target` stays within `root`. */
export function safeLinkTarget(root: string, linkPath: string, target: string): boolean {
  if (!target || target.includes('\0') || isAbsolute(target)) return false;
  const resolved = resolve(dirname(linkPath), target);
  const rootResolved = resolve(root);
  return resolved === rootResolved || resolved.startsWith(rootResolved + sep);
}

/** Ensures no existing path component between root and `full` is a symlink (prevents write-through-link attacks). */
function assertNoLinkedParents(root: string, full: string) {
  const rootResolved = resolve(root);
  let cur = dirname(full);
  while (cur.length > rootResolved.length) {
    if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) throw new ExtractError(`Archive writes through a link: ${cur}`, 'unsafe');
    cur = dirname(cur);
  }
}

export function freeBytes(dir: string): number {
  let d = dir;
  while (!existsSync(d)) d = dirname(d);
  const s = statfsSync(d);
  return Number(s.bavail) * Number(s.bsize);
}

export interface ExtractProgress {
  entries: number;
  bytes: number;
  totalBytes: number | null;
}

export async function extractArchive(
  archivePath: string,
  dest: string,
  signal: AbortSignal,
  onProgress: (p: ExtractProgress) => void,
  limits: ExtractLimits = DEFAULT_LIMITS,
): Promise<void> {
  const kind = detectArchiveKind(archivePath);
  if (!kind) throw new ExtractError('Unsupported archive format', 'unsupported');
  mkdirSync(dest, { recursive: true });
  const root = realpathSync(dest);
  // Split archives (game.zip.001 …) are joined by 7-Zip whatever their inner format.
  if (kind === 'rar' || kind === '7z' || /\.\d{3}$/.test(archivePath)) {
    const { extractSevenZip } = await import('./sevenzip');
    return extractSevenZip(archivePath, root, signal, onProgress, limits);
  }
  if (kind === 'zip') return extractZip(archivePath, root, signal, onProgress, limits);
  return extractTar(archivePath, kind, root, signal, onProgress, limits);
}

async function extractZip(file: string, root: string, signal: AbortSignal, onProgress: (p: ExtractProgress) => void, limits: ExtractLimits) {
  const yauzl = await import('yauzl');
  const zip = await new Promise<import('yauzl').ZipFile>((res, rej) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true, decodeStrings: true }, (err, z) => (err ? rej(new ExtractError(`Not a valid ZIP file: ${err.message}`)) : res(z!))),
  );
  // Pre-scan sizes from the central directory before writing anything.
  const entries: import('yauzl').Entry[] = [];
  await new Promise<void>((res, rej) => {
    zip.on('entry', (e: import('yauzl').Entry) => {
      entries.push(e);
      if (entries.length > limits.maxEntries) {
        zip.close();
        rej(new ExtractError('Archive has too many files', 'too-large'));
        return;
      }
      zip.readEntry();
    });
    zip.on('end', () => res());
    zip.on('error', (e) => {
      // yauzl validates member names itself; report its path errors as unsafe, not corrupt.
      const unsafe = /relative path|absolute path|invalid characters/i.test(e.message);
      rej(new ExtractError(`${unsafe ? 'Unsafe path in archive' : 'Corrupt ZIP'}: ${e.message}`, unsafe ? 'unsafe' : 'corrupt'));
    });
    zip.readEntry();
  });
  const total = entries.reduce((s, e) => s + e.uncompressedSize, 0);
  const compressed = entries.reduce((s, e) => s + e.compressedSize, 0);
  if (total > limits.maxTotalBytes) throw new ExtractError('Archive is too large to extract', 'too-large');
  if (total > 1024 ** 3 && compressed > 0 && total / compressed > limits.maxRatio) throw new ExtractError('Archive expands suspiciously (possible zip bomb)', 'unsafe');
  if (total > freeBytes(root) - 256 * 1024 ** 2) throw new ExtractError('Not enough free disk space to extract this archive', 'disk-full');

  const z2 = await new Promise<import('yauzl').ZipFile>((res, rej) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, z) => (err ? rej(err) : res(z!))),
  );
  let done = 0;
  let bytes = 0;
  try {
    for (const entry of entries) {
      if (signal.aborted) throw new ExtractError('Cancelled', 'cancelled');
      const full = safeJoin(root, entry.fileName);
      if (!full) throw new ExtractError(`Unsafe path in archive: ${entry.fileName}`, 'unsafe');
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const type = mode & 0o170000;
      if (entry.fileName.endsWith('/') || type === 0o040000) {
        mkdirSync(full, { recursive: true });
      } else if (type === 0o120000) {
        const target = (await readStream(await openEntry(z2, entry))).toString('utf8');
        if (!safeLinkTarget(root, full, target)) throw new ExtractError(`Link escapes the game folder: ${entry.fileName}`, 'unsafe');
        assertNoLinkedParents(root, full);
        mkdirSync(dirname(full), { recursive: true });
        if (!existsSync(full)) symlinkSync(target, full);
      } else if (type === 0 || type === 0o100000) {
        assertNoLinkedParents(root, full);
        mkdirSync(dirname(full), { recursive: true });
        if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw new ExtractError(`Archive overwrites a link: ${entry.fileName}`, 'unsafe');
        const stream = await openEntry(z2, entry);
        await pipeline(stream, createWriteStream(full, { mode: 0o644 }), { signal }).catch((e) => {
          if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw new ExtractError('The disk filled up during extraction', 'disk-full');
          throw e;
        });
        chmodSync(full, mode & 0o111 ? 0o755 : 0o644);
        bytes += entry.uncompressedSize;
      }
      // Other types (devices, FIFOs) are skipped.
      done++;
      if (done % 50 === 0) onProgress({ entries: done, bytes, totalBytes: total });
    }
  } finally {
    z2.close();
  }
  onProgress({ entries: done, bytes, totalBytes: total });
}

function openEntry(zip: import('yauzl').ZipFile, entry: import('yauzl').Entry): Promise<Readable> {
  return new Promise((res, rej) => zip.openReadStream(entry, (err, s) => (err ? rej(new ExtractError(`Corrupt entry ${entry.fileName}: ${err.message}`)) : res(s!))));
}

async function readStream(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) {
    chunks.push(c as Buffer);
    if (chunks.reduce((n, b) => n + b.length, 0) > 4096) throw new ExtractError('Link target too long', 'unsafe');
  }
  return Buffer.concat(chunks);
}

async function extractTar(
  file: string,
  kind: ArchiveKind,
  root: string,
  signal: AbortSignal,
  onProgress: (p: ExtractProgress) => void,
  limits: ExtractLimits,
) {
  const tar = await import('tar');
  const { statSync, createReadStream } = await import('node:fs');
  const compressedSize = statSync(file).size;
  let entries = 0;
  let bytes = 0;
  let failure: ExtractError | null = null;
  const free = freeBytes(root);
  const links: Array<{ path: string; target: string; symbolic: boolean }> = [];

  const unpack = new tar.Unpack({
    cwd: root,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noMtime: false,
    unlink: false,
    processUmask: 0o022,
    filter: (path: string, entry: any) => {
      if (failure) return false;
      entries++;
      if (entries > limits.maxEntries) {
        failure = new ExtractError('Archive has too many files', 'too-large');
        return false;
      }
      const full = safeJoin(root, path);
      if (!full) {
        failure = new ExtractError(`Unsafe path in archive: ${path}`, 'unsafe');
        return false;
      }
      const type: string = entry.type;
      if (type === 'SymbolicLink') {
        if (!safeLinkTarget(root, full, entry.linkpath)) {
          failure = new ExtractError(`Link escapes the game folder: ${path}`, 'unsafe');
          return false;
        }
      } else if (type === 'Link') {
        if (!safeJoin(root, entry.linkpath)) {
          failure = new ExtractError(`Hard link escapes the game folder: ${path}`, 'unsafe');
          return false;
        }
      } else if (type !== 'File' && type !== 'OldFile' && type !== 'ContiguousFile' && type !== 'Directory') {
        return false; // devices, FIFOs and other special entries are skipped
      }
      // Extract regular files first. Recent tar versions reject even valid
      // link chains; create them ourselves only after validating the full graph.
      if (limits.deferInternalLinks && (type === 'SymbolicLink' || type === 'Link')) {
        links.push({ path: posix.normalize(path), target: entry.linkpath, symbolic: type === 'SymbolicLink' });
        return false;
      }
      bytes += entry.size ?? 0;
      if (bytes > limits.maxTotalBytes || bytes > free - 256 * 1024 ** 2) {
        failure = new ExtractError(bytes > limits.maxTotalBytes ? 'Archive is too large to extract' : 'Not enough free disk space to extract this archive', bytes > limits.maxTotalBytes ? 'too-large' : 'disk-full');
        return false;
      }
      if (bytes > 1024 ** 3 && bytes / compressedSize > limits.maxRatio) {
        failure = new ExtractError('Archive expands suspiciously (possible tar bomb)', 'unsafe');
        return false;
      }
      if (entries % 50 === 0) onProgress({ entries, bytes, totalBytes: null });
      return true;
    },
  } as any);

  const sources: Readable[] = [];
  let child: import('node:child_process').ChildProcess | null = null;
  if (kind === 'tar.xz' || kind === 'tar.bz2') {
    child = spawn(kind === 'tar.xz' ? 'xz' : 'bzip2', ['-dc', '--', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', (e) => {
      failure = new ExtractError(`Cannot decompress ${kind}: ${e.message}`, 'unsupported');
    });
    sources.push(child.stdout!);
  } else {
    sources.push(createReadStream(file));
  }
  const abort = () => {
    failure = new ExtractError('Cancelled', 'cancelled');
    child?.kill();
    sources[0].destroy();
    unpack.abort?.(new Error('cancelled'));
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await pipeline(sources[0], unpack as unknown as NodeJS.WritableStream);
  } catch (e) {
    if (failure) throw failure;
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOSPC') throw new ExtractError('The disk filled up during extraction', 'disk-full');
    throw new ExtractError(`Corrupt archive: ${err.message}`);
  } finally {
    signal.removeEventListener('abort', abort);
  }
  if (failure) throw failure;
  if (child && child.exitCode && child.exitCode !== 0) throw new ExtractError('Decompression failed');
  if (limits.deferInternalLinks) createInternalLinks(root, links, signal);
  onProgress({ entries, bytes, totalBytes: bytes });
}

function createInternalLinks(root: string, links: Array<{ path: string; target: string; symbolic: boolean }>, signal: AbortSignal) {
  const aliases = new Map(links.filter((l) => l.symbolic).map((l) => [l.path, l.target]));
  const canonical = (path: string) => {
    const pending = path.split('/'); const done: string[] = []; let hops = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!done.length) throw new ExtractError('Link chain escapes the compatibility folder', 'unsafe');
        done.pop(); continue;
      }
      const key = [...done, part].join('/');
      const target = aliases.get(key);
      if (target !== undefined) {
        if (++hops > 40 || isAbsolute(target)) throw new ExtractError('Invalid compatibility link chain', 'unsafe');
        pending.unshift(...target.split('/'));
      } else done.push(part);
    }
    return resolve(root, ...done);
  };
  // Validate every chain before creating any link, including dangling targets.
  for (const l of links) canonical(l.symbolic ? `${posix.dirname(l.path)}/${l.target}` : l.target);
  let hard = links.filter((l) => !l.symbolic);
  while (hard.length) {
    const remaining: typeof hard = [];
    for (const l of hard) {
      if (signal.aborted) throw new ExtractError('Cancelled', 'cancelled');
      const target = canonical(l.target);
      if (!existsSync(target)) { remaining.push(l); continue; }
      const full = safeJoin(root, l.path)!;
      assertNoLinkedParents(root, full);
      if (!lstatSync(target).isFile() || existsSync(full)) throw new ExtractError('Invalid compatibility hard link', 'unsafe');
      mkdirSync(dirname(full), { recursive: true });
      linkSync(target, full);
    }
    if (remaining.length === hard.length) throw new ExtractError('Missing compatibility hard link target', 'corrupt');
    hard = remaining;
  }
  // Deepest members first prevents writes through a newly created parent link.
  for (const l of links.filter((l) => l.symbolic).sort((a, b) => b.path.split('/').length - a.path.split('/').length)) {
    if (signal.aborted) throw new ExtractError('Cancelled', 'cancelled');
    const full = safeJoin(root, l.path)!;
    assertNoLinkedParents(root, full);
    mkdirSync(dirname(full), { recursive: true });
    let occupied = false;
    try { lstatSync(full); occupied = true; } catch { /* new link */ }
    if (occupied) throw new ExtractError('Compatibility link overlaps an extracted file', 'unsafe');
    symlinkSync(l.target, full);
  }
}

