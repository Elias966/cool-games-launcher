// Resumable HTTP(S) transfer engine used by the downloads worker. Kept free of
// Electron APIs so it can be tested directly.
import { createWriteStream, existsSync, statSync, renameSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { once } from 'node:events';

export type TransferErrorCode = 'network' | 'link-expired' | 'disk-full' | 'http' | 'not-a-file' | 'size-mismatch' | 'io' | 'cancelled';

export class TransferError extends Error {
  constructor(
    readonly code: TransferErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'TransferError';
  }
}

/**
 * One bandwidth cap shared by every transfer in this process (0 = no limit).
 * Each chunk is paid for after it arrives; while the account is in debt the
 * reader pauses, and TCP flow control slows the sender down.
 */
export class Bandwidth {
  private rate = 0;
  private tokens = 0;
  private last = Date.now();

  setLimit(bytesPerSecond: number) {
    this.rate = Math.max(0, Math.floor(bytesPerSecond));
    this.tokens = 0;
    this.last = Date.now();
  }

  get limit() {
    return this.rate;
  }

  async take(bytes: number, signal?: AbortSignal): Promise<void> {
    if (!this.rate) return;
    const now = Date.now();
    // At most a quarter second of saved-up allowance, so the cap holds over short spans too.
    this.tokens = Math.min(this.rate / 4, this.tokens + ((now - this.last) * this.rate) / 1000);
    this.last = now;
    this.tokens -= bytes;
    if (this.tokens >= 0) return;
    const wait = Math.min(5000, (-this.tokens / this.rate) * 1000);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, wait);
      function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

export const bandwidth = new Bandwidth();

export interface TransferSpec {
  url: string;
  headers: Record<string, string>;
  partPath: string;
  finalDir: string;
  fileNameHint: string | null;
  /** Validators from an earlier attempt, used with If-Range so a changed file restarts cleanly. */
  etag: string | null;
  lastModified: string | null;
  expectedTotal: number | null;
  /** Maximum simultaneous HTTP ranges for this file. */
  connections?: number;
}

export interface TransferProgress {
  receivedBytes: number;
  totalBytes: number | null;
  speedBps: number;
  etaSeconds: number | null;
  connections?: number;
}

export interface TransferMeta {
  etag: string | null;
  lastModified: string | null;
  totalBytes: number | null;
  resumable: boolean;
  fileName: string | null;
  finalUrl: string;
  connections?: number;
}

export interface TransferResult extends TransferMeta {
  path: string;
  receivedBytes: number;
}

const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)/i;

export function isFileResponse(type: string | null, fileName: string | null, url: string): boolean {
  if (HTML_TYPES.test(type ?? '') || /^(?:application\/(?:json|.*\+json|xml|.*\+xml|javascript)|text\/(?:css|javascript))/i.test(type ?? '')) return false;
  if (fileName && /\.(?:html?|json|xml|css|js)$/i.test(fileName)) return false;
  const file = /\.(?:zip|7z|rar|tar(?:\.(?:gz|xz|bz2|zst))?|tgz|txz|appimage|x86_64|sh|run|exe|msi|deb|rpm|apk|dmg|love|jar|bin|(?:zip|7z|rar|tar)\.\d{3}|r\d{2})$/i;
  let path = '';
  try { path = decodeURIComponent(new URL(url).pathname); } catch { /* malformed response URL */ }
  if (/^text\//i.test(type ?? '')) return file.test(fileName ?? path);
  return /^application\//i.test(type ?? '') || file.test(fileName ?? path);
}

export function parseContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const star = value.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = value.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
  if (plain) return (plain[2] ?? plain[1]).trim();
  return null;
}

/** Makes a server-supplied file name safe to use inside our downloads folder. */
export function sanitizeFileName(name: string | null | undefined, fallback = 'download'): string {
  let n = basename((name ?? '').replace(/\\/g, '/'));
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (n.length > 180) {
    const ext = extname(n).slice(0, 20);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n || fallback;
}

export function uniquePath(dir: string, name: string): string {
  let candidate = join(dir, name);
  if (!existsSync(candidate)) return candidate;
  const ext = name.match(/(\.tar\.(gz|xz|bz2|zst)|\.[^.]+)$/)?.[0] ?? '';
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    candidate = join(dir, `${stem} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new TransferError('io', 'Could not choose a file name');
}

function classifyFsError(err: NodeJS.ErrnoException): TransferError {
  if (err.code === 'ENOSPC' || err.code === 'EDQUOT') return new TransferError('disk-full', 'The disk is full. Free some space, then resume.');
  return new TransferError('io', `Could not write the file: ${err.message}`);
}

/**
 * Downloads `spec.url` into `spec.partPath`, resuming from the bytes already
 * there when the server supports ranges and the file has not changed.
 */
async function runSingleTransfer(
  spec: TransferSpec,
  signal: AbortSignal,
  onMeta: (meta: TransferMeta) => void,
  onProgress: (p: TransferProgress) => void,
  initialResponse?: Response,
): Promise<TransferResult> {
  mkdirSync(dirname(spec.partPath), { recursive: true });
  let offset = !initialResponse && existsSync(spec.partPath) ? statSync(spec.partPath).size : 0;
  const headers: Record<string, string> = { ...spec.headers, 'Accept-Encoding': 'identity' };
  if (offset > 0) {
    headers.Range = `bytes=${offset}-`;
    const validator = spec.etag && !spec.etag.startsWith('W/') ? spec.etag : spec.lastModified;
    if (validator) headers['If-Range'] = validator;
  }

  let res: Response;
  try {
    res = initialResponse ?? await fetch(spec.url, { headers, redirect: 'follow', signal });
  } catch (e) {
    if (signal.aborted) throw new TransferError('cancelled', 'Cancelled');
    throw new TransferError('network', `Network error: ${(e as Error).message}`, true);
  }

  if (res.status === 416 && offset > 0) {
    // Range beyond the end: either already complete or the file shrank.
    const total = Number(res.headers.get('content-range')?.split('/')[1] ?? NaN);
    if (Number.isFinite(total) && total === offset) {
      return finish(spec, offset, {
        etag: spec.etag,
        lastModified: spec.lastModified,
        totalBytes: total,
        resumable: true,
        fileName: spec.fileNameHint,
        finalUrl: res.url || spec.url,
      });
    }
    rmSync(spec.partPath, { force: true });
    throw new TransferError('network', 'The file changed on the server; restarting.', true);
  }
  if ([401, 403, 404, 410].includes(res.status)) {
    res.body?.cancel().catch(() => undefined);
    throw new TransferError('link-expired', `The download link no longer works (HTTP ${res.status}). Resolve it again from the Store.`);
  }
  if (res.status === 429 || res.status >= 500) {
    res.body?.cancel().catch(() => undefined);
    throw new TransferError('http', `The server is busy (HTTP ${res.status}).`, true);
  }
  if (res.status !== 200 && res.status !== 206) {
    res.body?.cancel().catch(() => undefined);
    throw new TransferError('http', `Unexpected HTTP ${res.status}.`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  const disposition = parseContentDisposition(res.headers.get('content-disposition'));
  if (!isFileResponse(contentType, disposition, res.url || spec.url)) {
    res.body?.cancel().catch(() => undefined);
    throw new TransferError('link-expired', 'The link returned a web page instead of a file. It may have expired or need a login — resolve it again from the Store.');
  }

  let append = false;
  if (res.status === 206) {
    const range = res.headers.get('content-range') ?? '';
    const m = range.match(/bytes (\d+)-(\d+)\/(\d+|\*)/);
    if (!m || Number(m[1]) !== offset) {
      res.body?.cancel().catch(() => undefined);
      rmSync(spec.partPath, { force: true });
      throw new TransferError('network', 'The server sent an unexpected range; restarting.', true);
    }
    append = true;
  } else {
    offset = 0; // full response: server ignored the range or the file changed
  }

  const length = Number(res.headers.get('content-length') ?? NaN);
  const rangeTotal = Number(res.headers.get('content-range')?.split('/')[1] ?? NaN);
  const totalBytes = Number.isFinite(rangeTotal) ? rangeTotal : Number.isFinite(length) ? length + offset : null;
  const meta: TransferMeta = {
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    totalBytes,
    resumable: res.status === 206 || /bytes/i.test(res.headers.get('accept-ranges') ?? ''),
    fileName: disposition ?? spec.fileNameHint,
    finalUrl: res.url || spec.url,
    connections: 1,
  };
  onMeta(meta);
  if (!res.body) throw new TransferError('network', 'Empty response', true);

  const out = createWriteStream(spec.partPath, { flags: append ? 'a' : 'w' });
  let received = offset;
  let windowBytes = 0;
  let windowStart = Date.now();
  let speed = 0;
  let lastEmit = 0;
  let writeError: NodeJS.ErrnoException | null = null;
  out.on('error', (e) => {
    writeError = e as NodeJS.ErrnoException;
  });

  try {
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    for await (const chunk of body) {
      if (writeError) throw classifyFsError(writeError);
      const buf = chunk as Buffer;
      received += buf.length;
      windowBytes += buf.length;
      if (!out.write(buf)) await once(out, 'drain');
      await bandwidth.take(buf.length, signal);
      const now = Date.now();
      if (now - windowStart >= 500) {
        const inst = (windowBytes * 1000) / (now - windowStart);
        speed = speed ? speed * 0.7 + inst * 0.3 : inst;
        windowBytes = 0;
        windowStart = now;
      }
      if (now - lastEmit >= 250) {
        lastEmit = now;
        onProgress({
          connections: 1,
          receivedBytes: received,
          totalBytes,
          speedBps: speed,
          etaSeconds: totalBytes && speed > 0 ? (totalBytes - received) / speed : null,
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    if (writeError) throw classifyFsError(writeError);
  } catch (e) {
    out.destroy();
    if (e instanceof TransferError) throw e;
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOSPC' || err.code === 'EDQUOT' || err.code === 'EIO') throw classifyFsError(err);
    if (signal.aborted) throw new TransferError('cancelled', 'Cancelled');
    throw new TransferError('network', `Connection interrupted: ${err.message}`, true);
  }

  if (totalBytes !== null && received !== totalBytes) {
    throw new TransferError(received < totalBytes ? 'network' : 'size-mismatch', `Received ${received} of ${totalBytes} bytes.`, received < totalBytes);
  }
  onProgress({ connections: 1, receivedBytes: received, totalBytes: totalBytes ?? received, speedBps: 0, etaSeconds: 0 });
  return finish(spec, received, meta);
}

function finish(spec: TransferSpec, received: number, meta: TransferMeta): TransferResult {
  mkdirSync(spec.finalDir, { recursive: true });
  const name = sanitizeFileName(meta.fileName ?? spec.fileNameHint);
  const target = uniquePath(spec.finalDir, name);
  try {
    renameSync(spec.partPath, target);
  } catch (e) {
    throw classifyFsError(e as NodeJS.ErrnoException);
  }
  return { ...meta, path: target, receivedBytes: received, totalBytes: meta.totalBytes ?? received };
}

export interface ProbeResult {
  ok: boolean;
  status: number;
  isFile: boolean;
  contentType: string | null;
  fileName: string | null;
  totalBytes: number | null;
  resumable: boolean;
  finalUrl: string;
}

/** Checks whether a URL serves a file (not an HTML page) without downloading it. */
export async function probeUrl(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<ProbeResult> {
  const res = await fetch(url, { headers: { ...headers, Range: 'bytes=0-0', 'Accept-Encoding': 'identity' }, redirect: 'follow', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
  res.body?.cancel().catch(() => undefined);
  const contentType = res.headers.get('content-type');
  const fileName = parseContentDisposition(res.headers.get('content-disposition'));
  const rangeTotal = Number(res.headers.get('content-range')?.split('/')[1] ?? NaN);
  const length = Number(res.headers.get('content-length') ?? NaN);
  return {
    ok: res.status === 200 || res.status === 206,
    status: res.status,
    isFile: (res.status === 200 || res.status === 206) && isFileResponse(contentType, fileName, res.url || url),
    contentType,
    fileName,
    totalBytes: Number.isFinite(rangeTotal) ? rangeTotal : res.status === 200 && Number.isFinite(length) ? length : null,
    resumable: res.status === 206,
    finalUrl: res.url || url,
  };
}

interface Segment { start: number; end: number; received: number }
interface Checkpoint {
  version: 1;
  total: number;
  validator: string;
  segments: Segment[];
}

const checkpointPath = (part: string) => `${part}.segments.json`;

function readCheckpoint(part: string): Checkpoint | null {
  try {
    const c = JSON.parse(readFileSync(checkpointPath(part), 'utf8')) as Checkpoint;
    if (c.version !== 1 || !Number.isSafeInteger(c.total) || c.total <= 0 || typeof c.validator !== 'string' ||
        !Array.isArray(c.segments) || c.segments.length < 1 || c.segments.length > 16) return null;
    let next = 0;
    const size = statSync(part).size;
    for (const s of c.segments) {
      if (![s.start, s.end, s.received].every(Number.isSafeInteger) || s.start !== next || s.end < s.start ||
          s.received < 0 || s.received > s.end - s.start + 1 || (s.received > 0 && s.start + s.received > size)) return null;
      next = s.end + 1;
    }
    return next === c.total ? c : null;
  } catch { return null; }
}

/** Sparse file size includes unwritten holes. Only checkpointed ranges count. */
export function partialBytes(part: string | null): number {
  if (!part) return 0;
  if (existsSync(checkpointPath(part))) return readCheckpoint(part)?.segments.reduce((n, s) => n + s.received, 0) ?? 0;
  try { return statSync(part).size; } catch { return 0; }
}

export function removePartial(part: string) {
  rmSync(part, { force: true });
  rmSync(checkpointPath(part), { force: true });
  rmSync(`${checkpointPath(part)}.tmp`, { force: true });
}

function saveCheckpoint(part: string, checkpoint: Checkpoint) {
  try {
    writeFileSync(`${checkpointPath(part)}.tmp`, JSON.stringify(checkpoint), { mode: 0o600 });
    renameSync(`${checkpointPath(part)}.tmp`, checkpointPath(part));
  } catch (e) { throw classifyFsError(e as NodeJS.ErrnoException); }
}

class ParallelUnsupported extends Error {}

/** Parallel ranges share one file; atomic checkpoints record only completed writes. */
export async function runTransfer(
  spec: TransferSpec,
  signal: AbortSignal,
  onMeta: (meta: TransferMeta) => void,
  onProgress: (progress: TransferProgress) => void,
): Promise<TransferResult> {
  const limit = Math.max(1, Math.min(16, Math.floor(spec.connections ?? 1) || 1));
  const hasCheckpoint = existsSync(checkpointPath(spec.partPath));
  if (limit === 1 && !hasCheckpoint) return runSingleTransfer(spec, signal, onMeta, onProgress);
  mkdirSync(dirname(spec.partPath), { recursive: true });
  // Prove bounded ranges work before splitting. Reuse a full response when a
  // server ignores Range, including hosts whose links work only once.
  let probe: Response;
  try {
    probe = await fetch(spec.url, { headers: { ...spec.headers, Range: 'bytes=0-0', 'Accept-Encoding': 'identity' }, redirect: 'follow', signal });
  } catch (e) {
    if (signal.aborted) throw new TransferError('cancelled', 'Cancelled');
    throw new TransferError('network', `Network error: ${(e as Error).message}`, true);
  }
  const range = probe.headers.get('content-range')?.match(/^bytes 0-0\/(\d+)$/);
  const total = range ? Number(range[1]) : 0;
  const etag = probe.headers.get('etag');
  const lastModified = probe.headers.get('last-modified');
  const validator = etag && !etag.startsWith('W/') ? etag : lastModified;
  const disposition = parseContentDisposition(probe.headers.get('content-disposition'));
  const supported = probe.status === 206 && Number.isSafeInteger(total) && total >= 2 * 1024 * 1024 && validator &&
    (!probe.headers.get('content-encoding') || probe.headers.get('content-encoding') === 'identity') &&
    isFileResponse(probe.headers.get('content-type'), disposition, probe.url || spec.url);
  if (!supported) {
    // A legacy contiguous prefix can still resume normally. Sparse parts cannot.
    if (hasCheckpoint) removePartial(spec.partPath);
    if (probe.status === 200) return runSingleTransfer(spec, signal, onMeta, onProgress, probe);
    await probe.body?.cancel().catch(() => undefined);
    return runSingleTransfer(spec, signal, onMeta, onProgress);
  }
  await probe.body?.cancel().catch(() => undefined);
  let checkpoint = readCheckpoint(spec.partPath);
  if (!checkpoint || checkpoint.total !== total || checkpoint.validator !== validator) {
    // Preserve old single-stream progress only with a matching validator/size.
    const oldValidator = spec.etag && !spec.etag.startsWith('W/') ? spec.etag : spec.lastModified;
    const prefix = !hasCheckpoint && oldValidator === validator && (!spec.expectedTotal || spec.expectedTotal === total) ? partialBytes(spec.partPath) : 0;
    if (hasCheckpoint || !prefix || prefix > total) removePartial(spec.partPath);
    const count = Math.min(limit, Math.floor(total / (1024 * 1024)));
    const chunkSize = Math.ceil(total / count);
    const segments: Segment[] = [];
    for (let start = 0; start < total; start += chunkSize) {
      const end = Math.min(total - 1, start + chunkSize - 1);
      segments.push({ start, end, received: Math.max(0, Math.min(end - start + 1, prefix <= total ? prefix - start : 0)) });
    }
    checkpoint = { version: 1, total, validator: validator!, segments };
  }
  const c = checkpoint;
  const pending = c.segments.filter((s) => s.received < s.end - s.start + 1);
  const connections = Math.min(limit, pending.length);
  const meta: TransferMeta = { etag, lastModified, totalBytes: total, resumable: true, fileName: disposition ?? spec.fileNameHint, finalUrl: probe.url || spec.url, connections };
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const file = await open(spec.partPath, existsSync(spec.partPath) ? 'r+' : 'w').catch((e) => { throw classifyFsError(e); });
  let received = c.segments.reduce((n, s) => n + s.received, 0);
  let lastTime = Date.now(), lastBytes = received, lastSave = 0, speed = 0;
  let firstError: unknown;
  let next = 0;
  const progress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastSave < 250) return;
    const elapsed = now - lastTime;
    if (elapsed >= 500) {
      const instant = (received - lastBytes) * 1000 / elapsed;
      speed = speed ? speed * 0.7 + instant * 0.3 : instant;
      lastBytes = received; lastTime = now;
    }
    saveCheckpoint(spec.partPath, c);
    lastSave = now;
    onProgress({ receivedBytes: received, totalBytes: total, speedBps: speed, etaSeconds: speed > 0 ? (total - received) / speed : null, connections });
  };
  try {
    saveCheckpoint(spec.partPath, c);
    onMeta(meta);
    progress(true);
    const downloadSegment = async (s: Segment) => {
      const start = s.start + s.received;
      const response = await fetch(spec.url, {
        headers: { ...spec.headers, Range: `bytes=${start}-${s.end}`, 'If-Range': c.validator, 'Accept-Encoding': 'identity' },
        redirect: 'follow', signal: combined,
      });
      const expectedRange = `bytes ${start}-${s.end}/${total}`;
      const responseEtag = response.headers.get('etag');
      const responseModified = response.headers.get('last-modified');
      if (response.status !== 206 || response.headers.get('content-range') !== expectedRange ||
          (responseEtag && etag && responseEtag !== etag) || (!etag && responseModified && responseModified !== lastModified) ||
          (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') ||
          !isFileResponse(response.headers.get('content-type'), parseContentDisposition(response.headers.get('content-disposition')), response.url || spec.url)) {
        await response.body?.cancel().catch(() => undefined);
        throw new ParallelUnsupported('The host rejected parallel ranges or the file changed.');
      }
      if (!response.body) throw new TransferError('network', 'Empty range response', true);
      const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
      for await (const chunk of body) {
        combined.throwIfAborted();
        const buf = chunk as Buffer;
        if (s.start + s.received + buf.length > s.end + 1) throw new ParallelUnsupported('The host sent too many bytes for a range.');
        let written = 0;
        while (written < buf.length) {
          const result = await file.write(buf, written, buf.length - written, s.start + s.received + written)
            .catch((e) => { throw classifyFsError(e); });
          if (!result.bytesWritten) throw new TransferError('io', 'Could not write the download.');
          written += result.bytesWritten;
        }
        s.received += written;
        received += written;
        progress();
        await bandwidth.take(written, combined);
      }
      if (s.received !== s.end - s.start + 1) throw new TransferError('network', 'Range connection ended early.', true);
    };
    const tasks = Array.from({ length: connections }, async () => {
      try {
        while (next < pending.length) {
          combined.throwIfAborted();
          await downloadSegment(pending[next++]);
        }
      } catch (e) {
        if (!firstError) firstError = e;
        controller.abort();
        throw e;
      }
    });
    await Promise.allSettled(tasks); // Never reopen/delete while a sibling writes.
    progress(true);
    if (signal.aborted) throw new TransferError('cancelled', 'Cancelled');
    if (firstError) throw firstError;
    await file.truncate(total);
  } catch (e) {
    if (signal.aborted) throw new TransferError('cancelled', 'Cancelled');
    if (e instanceof ParallelUnsupported) {
      // Handled after closing all writers below.
      firstError = e;
    } else if (e instanceof TransferError) throw e;
    else throw new TransferError('network', `Connection interrupted: ${(e as Error).message}`, true);
  } finally {
    await file.close();
  }
  if (firstError instanceof ParallelUnsupported) {
    removePartial(spec.partPath);
    return runSingleTransfer({ ...spec, etag: null, lastModified: null }, signal, onMeta, onProgress);
  }
  if (signal.aborted) throw new TransferError('cancelled', 'Cancelled');
  const result = finish(spec, total, meta);
  rmSync(checkpointPath(spec.partPath), { force: true });
  onProgress({ receivedBytes: total, totalBytes: total, speedBps: 0, etaSeconds: 0, connections });
  return result;
}
