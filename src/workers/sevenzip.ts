// Decode RAR/7z to stdout. The decoder never gets a destination directory;
// Node validates and writes each member inside the private staging folder.
import { execFile, spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { existsSync, mkdirSync, lstatSync, symlinkSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { ExtractError, freeBytes, safeJoin, safeLinkTarget, type ExtractLimits, type ExtractProgress } from './extract';

interface Member { name: string; size: number; directory: boolean; link: boolean; target: string | null; mode: number }

export function parseSevenZipList(text: string, root: string, limits: ExtractLimits): Member[] {
  const members: Member[] = []; const names = new Set<string>();
  for (const block of text.replace(/^[\r\n]+|[\r\n]+$/g, '').split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const fields: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const match = /^([^=\r\n]+) = (.*)$/.exec(line);
      if (!match || Object.hasOwn(fields, match[1])) throw new ExtractError('Ambiguous archive member metadata', 'unsafe');
      fields[match[1]] = match[2];
    }
    const name = fields.Path; const full = name && safeJoin(root, name);
    if (!full || full === resolve(root) || names.has(full)) throw new ExtractError('Unsafe or duplicate path in archive', 'unsafe');
    names.add(full);
    const directory = fields.Folder ? fields.Folder === '+' : /^D|(?:^|\s)d[rwx-]{9}/.test(fields.Attributes ?? '');
    const size = Number(fields.Size);
    if ((fields.Folder !== undefined && !['+', '-'].includes(fields.Folder)) || !/^\d+$/.test(fields.Size ?? '') || !Number.isSafeInteger(size) || size < 0) throw new ExtractError('Invalid archive member size');
    if (fields.Encrypted === '+') throw new ExtractError('This archive requires a password. Use an unencrypted build.', 'unsupported');
    if (fields['Split Before'] === '+' || fields['Split After'] === '+') throw new ExtractError('This is a multipart archive. All volumes are required.', 'unsupported');
    if (fields['Alternate Stream'] === '+' || fields['Hard Link'] || fields['Copy Link']) throw new ExtractError('Unsupported archive link or alternate stream', 'unsafe');
    const attrs = fields.Attributes ?? '';
    const link = !!fields['Symbolic Link'] || /(?:^|\s)l[rwx-]{9}/.test(attrs);
    if (/(?:^|\s)[bcp][rwx-]{9}/.test(attrs)) throw new ExtractError('Archive contains a special device', 'unsafe');
    members.push({ name, size, directory, link, target: fields['Symbolic Link'] || null, mode: /x/.test(attrs) ? 0o755 : 0o644 });
    if (members.length > limits.maxEntries) throw new ExtractError('Archive has too many files', 'too-large');
  }
  if (!members.length) throw new ExtractError('The archive contains no files');
  return members;
}

function decoder(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [resources && join(resources, 'vendor/7zip/7zzs'), resolve(__dirname, '../../vendor/7zip/7zzs')];
  const path = candidates.find((p) => p && existsSync(p));
  if (!path) throw new ExtractError('The bundled RAR decoder is missing. Reinstall the launcher.', 'unsupported');
  return path;
}

function noLinkedParents(root: string, full: string) {
  let path = dirname(full);
  while (path.length >= root.length) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ExtractError('Archive writes through a symbolic link', 'unsafe');
    if (path === root) break;
    path = dirname(path);
  }
}

/** Number of volumes 7-Zip finds for this archive (1 for a single file). */
export async function sevenZipVolumes(file: string): Promise<number> {
  const tool = decoder();
  const text = await new Promise<string>((resolve) => {
    execFile(tool, ['l', '-slt', '-p-', '--', file], { maxBuffer: 64 * 1024 * 1024 }, (_error, stdout) => resolve(stdout ?? ''));
  });
  const head = text.split(/\n----------\n/)[0] ?? text;
  const volumes = Number(/^Volumes = (\d+)/m.exec(head)?.[1] ?? 0);
  if (volumes > 1) return volumes;
  return /^Multivolume = \+/m.test(head) || /^Type = Split/m.test(head) ? 2 : 1;
}

export async function extractSevenZip(file: string, root: string, signal: AbortSignal, onProgress: (p: ExtractProgress) => void, limits: ExtractLimits) {
  const tool = decoder();
  const text = await new Promise<string>((resolve, reject) => {
    execFile(tool, ['l', '-slt', '-ba', '-sccUTF-8', '-p-', '--', file], { signal, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new ExtractError(signal.aborted ? 'Cancelled' : /password|encrypted/i.test(stderr) ? 'This archive requires a password.' : `Could not read the archive: ${stderr.slice(-800)}`, signal.aborted ? 'cancelled' : 'corrupt'));
      else resolve(stdout);
    });
  });
  const members = parseSevenZipList(text, root, limits);
  const total = members.reduce((n, e) => n + e.size, 0);
  if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) throw new ExtractError('Archive is too large to extract', 'too-large');
  const { statSync } = await import('node:fs');
  if (total > 1024 ** 3 && total / Math.max(1, limits.sourceBytes ?? statSync(file).size) > limits.maxRatio) throw new ExtractError('Archive expands suspiciously', 'unsafe');
  if (total > freeBytes(root) - 256 * 1024 ** 2) throw new ExtractError('Not enough free disk space to extract this archive', 'disk-full');
  const pendingLinks: Array<{ path: string; target: string }> = [];
  const files = members.filter((e) => !e.directory);
  for (const e of members.filter((e) => e.directory)) {
    const full = safeJoin(root, e.name)!; noLinkedParents(root, full); mkdirSync(full, { recursive: true });
  }
  let index = 0, offset = 0, bytes = 0, entries = 0;
  let output: Awaited<ReturnType<typeof open>> | null = null;
  let linkBytes: Buffer[] = [];
  const finishMember = async () => {
    const e = files[index];
    if (output) { await output.close(); output = null; }
    if (e.link) {
      const target = e.target ?? Buffer.concat(linkBytes).toString('utf8');
      const path = safeJoin(root, e.name)!;
      if (!safeLinkTarget(root, path, target)) throw new ExtractError('Archive link escapes the game folder', 'unsafe');
      pendingLinks.push({ path, target });
    }
    index++; offset = 0; entries++; linkBytes = [];
    onProgress({ entries, bytes, totalBytes: total });
  };
  const beginMember = async () => {
    const e = files[index]; if (!e) return;
    const full = safeJoin(root, e.name)!; noLinkedParents(root, full); mkdirSync(dirname(full), { recursive: true });
    if (e.link) {
      if (e.size > 4096) throw new ExtractError('Invalid symbolic link length', 'unsafe');
    } else output = await open(full, 'wx', e.mode);
  };
  const child = spawn(tool, ['x', '-so', '-y', '-bd', '-bb0', '-p-', '--', file], { stdio: ['ignore', 'pipe', 'pipe'], signal });
  // Attach a consumer immediately: a fast decoder may exit before the first
  // file opens, and Node drains otherwise-unconsumed child stdio on exit.
  const stream = child.stdout.pipe(new PassThrough());
  child.stdout.on('error', (e) => stream.destroy(e));
  let stderr = '';
  child.stderr.on('data', (buf: Buffer) => { stderr = (stderr + buf.toString()).slice(-4096); });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new ExtractError(`Archive decoding failed: ${stderr.slice(-800)}`)));
  });
  void done.catch(() => undefined);
  try {
    await beginMember();
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const buf = chunk as Buffer; let at = 0;
      while (at < buf.length) {
        while (files[index] && offset === files[index].size) { await finishMember(); await beginMember(); }
        const e = files[index];
        if (!e) throw new ExtractError('Archive produced unexpected extra bytes', 'unsafe');
        const length = Math.min(buf.length - at, e.size - offset);
        const data = buf.subarray(at, at + length);
        if (e.link) linkBytes.push(Buffer.from(data));
        else {
          let written = 0;
          while (written < data.length) {
            const r = await output!.write(data, written, data.length - written);
            if (!r.bytesWritten) throw new ExtractError('Could not write the extracted file');
            written += r.bytesWritten;
          }
        }
        offset += length; at += length; bytes += length;
      }
    }
    await done;
    while (files[index] && offset === files[index].size) { await finishMember(); await beginMember(); }
    if (index !== files.length || bytes !== total) throw new ExtractError(`The archive ended early (${bytes}/${total} bytes, ${index}/${files.length} files)`);
    // Links are created only after data writes finish, so no member writes through them.
    for (const link of pendingLinks) { noLinkedParents(root, link.path); symlinkSync(link.target, link.path); }
  } catch (e) {
    child.kill('SIGKILL');
    if (signal.aborted) throw new ExtractError('Cancelled', 'cancelled');
    if ((e as NodeJS.ErrnoException).code === 'ENOSPC' || (e as NodeJS.ErrnoException).code === 'EDQUOT') throw new ExtractError('The disk filled up during extraction', 'disk-full');
    throw e;
  } finally {
    stream.destroy();
    if (output) await output.close().catch(() => undefined);
    if (child.exitCode === null) child.kill('SIGKILL');
    await done.catch(() => undefined);
  }
}
