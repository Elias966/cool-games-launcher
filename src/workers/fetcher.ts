// Page fetcher utility process: reads website pages over plain HTTP, with the
// Firefox session's cookies and user agent, and runs the same DOM extraction
// the browser uses (without a layout engine). Indexing reads many listing and
// game pages in parallel through it; Firefox remains the fallback for pages
// that need JavaScript or a human website check.
import { JSDOM, VirtualConsole } from 'jsdom';
import { gunzipSync } from 'node:zlib';
import { serve } from './rpc';
import { extractPage, type PageExtract } from '@shared/page-extract';

process.title = 'cgl-fetcher';

const MAX_BYTES = 8 * 1024 * 1024;
const quiet = new VirtualConsole();

export interface FetchPageParams {
  url: string;
  cookie?: string;
  userAgent?: string;
  referer?: string;
  timeoutMs?: number;
}

export type FetchPageResult =
  | { ok: true; status: number; url: string; ms: number; extract: PageExtract }
  | { ok: false; status: number; url: string; ms: number; reason: 'http' | 'not-html' | 'too-large' | 'network'; detail: string };

async function readCapped(res: Response, signal: AbortSignal): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Runs extractPage against static HTML. Synchronous, so the globals it reads cannot interleave. */
export function extractHtml(html: string, url: string): PageExtract {
  const dom = new JSDOM(html, { url, virtualConsole: quiet });
  try {
    const w = dom.window as unknown as Window & typeof globalThis;
    // Script and style text would otherwise leak into textContent-based labels.
    w.document.querySelectorAll('script:not([type="application/ld+json"]), style, noscript, template').forEach((e) => e.remove());
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, window: g.window, location: g.location };
    Object.assign(g, { document: w.document, window: w, location: w.location });
    try {
      return extractPage({ fast: true, mark: false, maxLinks: 600 });
    } finally {
      Object.assign(g, saved);
    }
  } finally {
    dom.window.close();
  }
}

async function fetchPage(p: FetchPageParams, signal: AbortSignal): Promise<FetchPageResult> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(p.timeoutMs ?? 20_000);
  const headers: Record<string, string> = {
    'User-Agent': p.userAgent || 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
    Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.7',
  };
  if (p.cookie) headers.Cookie = p.cookie;
  if (p.referer) headers.Referer = p.referer;
  let res: Response;
  try {
    res = await fetch(p.url, { headers, redirect: 'follow', signal: AbortSignal.any([signal, timeout]) });
  } catch (e) {
    if (signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
    return { ok: false, status: 0, url: p.url, ms: Date.now() - started, reason: 'network', detail: (e as Error).message };
  }
  const base = { status: res.status, url: res.url || p.url };
  const type = res.headers.get('content-type') ?? '';
  if (!/html|xml/i.test(type)) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, ...base, ms: Date.now() - started, reason: 'not-html', detail: type };
  }
  const html = await readCapped(res, signal);
  if (html === null) return { ok: false, ...base, ms: Date.now() - started, reason: 'too-large', detail: `>${MAX_BYTES} bytes` };
  // Challenge and error pages still go through extraction so their gates are
  // reported; the caller decides whether Firefox or the user takes over.
  const extract = extractHtml(html, base.url);
  if (res.status >= 400 && !extract.gates.captcha && !extract.gates.blocked) {
    return { ok: false, ...base, ms: Date.now() - started, reason: 'http', detail: `HTTP ${res.status}` };
  }
  return { ok: true, ...base, ms: Date.now() - started, extract };
}

/** Plain-text reads for robots.txt and (optionally gzipped) XML sitemaps. */
async function fetchText(p: FetchPageParams, signal: AbortSignal): Promise<{ status: number; url: string; text: string | null }> {
  const headers: Record<string, string> = { 'User-Agent': p.userAgent || 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', Accept: 'application/xml,text/xml,text/plain;q=0.9,*/*;q=0.5' };
  if (p.cookie) headers.Cookie = p.cookie;
  let res: Response;
  try {
    res = await fetch(p.url, { headers, redirect: 'follow', signal: AbortSignal.any([signal, AbortSignal.timeout(p.timeoutMs ?? 20_000)]) });
  } catch (e) {
    if (signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
    return { status: 0, url: p.url, text: null };
  }
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); return { status: res.status, url: res.url || p.url, text: null }; }
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 30 * 1024 * 1024) { await reader.cancel(); return { status: res.status, url: res.url, text: null }; }
    chunks.push(value);
  }
  let buf = Buffer.concat(chunks);
  if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = gunzipSync(buf, { maxOutputLength: 64 * 1024 * 1024 }); } catch { return { status: res.status, url: res.url, text: null }; } }
  return { status: res.status, url: res.url || p.url, text: buf.toString('utf8') };
}

/** HTTP validators of a download file (HEAD, falling back to a 1-byte range GET). */
async function headFile(p: FetchPageParams, signal: AbortSignal): Promise<{ status: number; etag: string | null; lastModified: string | null; bytes: number | null }> {
  const headers: Record<string, string> = { 'User-Agent': p.userAgent || 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', Accept: '*/*' };
  if (p.cookie) headers.Cookie = p.cookie;
  if (p.referer) headers.Referer = p.referer;
  const read = (res: Response, bytes: number | null) => ({ status: res.status, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), bytes });
  const timeout = () => AbortSignal.any([signal, AbortSignal.timeout(p.timeoutMs ?? 15_000)]);
  try {
    const res = await fetch(p.url, { method: 'HEAD', headers, redirect: 'follow', signal: timeout() });
    const len = Number(res.headers.get('content-length'));
    if (res.ok && !/html/i.test(res.headers.get('content-type') ?? '')) return read(res, Number.isFinite(len) && len > 0 ? len : null);
    if (res.status !== 405 && res.status !== 501 && res.status !== 403) return read(res, null);
    const g = await fetch(p.url, { headers: { ...headers, Range: 'bytes=0-0' }, redirect: 'follow', signal: timeout() });
    await g.body?.cancel().catch(() => undefined);
    const total = Number(/\/(\d+)$/.exec(g.headers.get('content-range') ?? '')?.[1]);
    if (/html/i.test(g.headers.get('content-type') ?? '')) return read(g, null);
    return read(g, Number.isFinite(total) && total > 0 ? total : null);
  } catch {
    if (signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
    return { status: 0, etag: null, lastModified: null, bytes: null };
  }
}

if ((process as unknown as { parentPort?: unknown }).parentPort) {
  serve({
    fetchPage: (p: FetchPageParams, signal: AbortSignal) => fetchPage(p, signal),
    fetchText: (p: FetchPageParams, signal: AbortSignal) => fetchText(p, signal),
    headFile: (p: FetchPageParams, signal: AbortSignal) => headFile(p, signal),
  });
}
