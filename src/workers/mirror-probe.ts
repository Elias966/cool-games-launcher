// Small, sequential measurements run in the downloads utility process.
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { isFileResponse, parseContentDisposition } from './transfer';

export const MIRROR_SAMPLE_BYTES = 8 * 1024 * 1024;
export const MIRROR_SAMPLE_MS = 5000;
export const MIRROR_PREFIX_BYTES = 16 * 1024;
export class MirrorProbeError extends Error { readonly code = 'not-a-file'; }

export interface MirrorSample {
  fileName: string | null;
  totalBytes: number | null;
  speedBps: number;
  sampledBytes: number;
  elapsedMs: number;
  prefixHash: string;
  prefixBytes: number;
  resumable: boolean;
  measuredAt: number;
}

/** Do not forward a host's login cookies to a different redirect origin. */
async function request(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  let current = url, scoped = { ...headers };
  for (let hop = 0; hop < 10; hop++) {
    const response = await fetch(current, { headers: scoped, redirect: 'manual', signal, cache: 'no-store' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Error('The mirror returned an empty redirect.');
    const next = new URL(location, current);
    if (!/^https?:$/.test(next.protocol)) throw new Error('Unsupported mirror redirect.');
    if (next.origin !== new URL(current).origin) scoped = Object.fromEntries(Object.entries(scoped).filter(([k]) => !/^(cookie|authorization|proxy-authorization)$/i.test(k)));
    current = next.href;
  }
  throw new Error('The mirror redirected too many times.');
}

export async function benchmarkMirror(url: string, headers: Record<string, string>, signal: AbortSignal, limits = { bytes: MIRROR_SAMPLE_BYTES, ms: MIRROR_SAMPLE_MS }): Promise<MirrorSample> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.ms);
  const combined = AbortSignal.any([signal, controller.signal]);
  const start = performance.now();
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let received = 0, prefixBytes = 0;
  const hash = createHash('sha256');
  try {
    response = await request(url, { ...headers, Range: `bytes=0-${limits.bytes - 1}`, 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' }, combined);
    const fileName = parseContentDisposition(response.headers.get('content-disposition'));
    if (![200, 206].includes(response.status)) throw new Error(`The mirror did not serve a file (HTTP ${response.status}).`);
    if (!isFileResponse(response.headers.get('content-type'), fileName, response.url || url)) throw new MirrorProbeError(`The mirror did not serve a file (HTTP ${response.status}).`);
    const range = response.headers.get('content-range')?.match(/^bytes 0-(\d+)\/(\d+)$/);
    if (response.status === 206 && (!range || Number(range[1]) >= Number(range[2]))) throw new Error('The mirror returned an invalid byte range.');
    const length = Number(response.headers.get('content-length') ?? NaN);
    const total = range ? Number(range[2]) : Number.isSafeInteger(length) && length > 0 ? length : null;
    if (!response.body) throw new Error('The mirror returned no file data.');
    reader = response.body.getReader();
    try {
      while (received < limits.bytes) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = Math.min(value.byteLength, limits.bytes - received);
        const prefix = Math.min(bytes, MIRROR_PREFIX_BYTES - prefixBytes);
        if (prefix > 0) { hash.update(value.subarray(0, prefix)); prefixBytes += prefix; }
        received += bytes;
      }
    } catch (error) {
      if (signal.aborted || !controller.signal.aborted) throw error;
      // A timed sample is usable if enough actual file data arrived.
    }
    signal.throwIfAborted();
    if (prefixBytes < MIRROR_PREFIX_BYTES && !(total !== null && received >= total && received > 0)) throw new Error('The mirror was too slow to return a usable sample.');
    const elapsedMs = Math.max(1, performance.now() - start);
    return { fileName, totalBytes: total, speedBps: received * 1000 / elapsedMs, sampledBytes: received, elapsedMs, prefixHash: hash.digest('hex'), prefixBytes, resumable: response.status === 206, measuredAt: Date.now() };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    if (!reader) await response?.body?.cancel().catch(() => undefined);
  }
}

/** Compare a replayed GET sample with the original Firefox transfer first. */
export async function browserFilePrefix(target: string, partFilePath?: string | null): Promise<{ hash: string; bytes: number } | null> {
  for (const path of [partFilePath, target, `${target}.part`].filter((p): p is string=>!!p)) {
    let file;
    try {
      if ((await stat(path)).size < MIRROR_PREFIX_BYTES) continue;
      file = await open(path, 'r');
      const bytes = Buffer.alloc(MIRROR_PREFIX_BYTES);
      const result = await file.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead !== bytes.length) continue;
      return { hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    } catch { /* Firefox has not flushed this file yet. */ }
    finally { await file?.close(); }
  }
  return null;
}
