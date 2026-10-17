// Fast page reads for indexing: plain HTTP through the fetcher worker, sending
// the cookies and user agent the user's Firefox session would send, so sites
// see the same visitor. Pages that need JavaScript or a website check fall
// back to Firefox in Discovery.
import type { WorkerHost } from './worker-host';
import type { BrowserClient } from './browser-client';
import type { FetchPageResult } from '../workers/fetcher';
import { parseSiteDate } from '@shared/site-date';
import { hostOf, siteKey } from '@shared/urls';

const AUTH_TTL_MS = 60_000;
/** Cookie lookups go through the Firefox worker; never let a busy browser stall indexing. */
const AUTH_WAIT_MS = 1500;
const authKey = (url: string) => {
  const u = new URL(url);
  return u.origin + u.pathname;
};

export class PageFetcher {
  private auth = new Map<string, { cookie: string; userAgent: string; at: number }>();
  /** Running totals shown in the Store status line. */
  readonly stats = { http: 0, fallbacks: 0, ms: 0 };

  private next = 0;
  private pending = new Map<string, Promise<{ cookie: string; userAgent: string; at: number }>>();

  /** Several parser processes: HTML parsing is CPU-bound and would serialise parallel reads. */
  constructor(private workers: WorkerHost[], private browser: BrowserClient, private profileDir?: string) {}

  private async session(url: string) {
    const key = authKey(url);
    const cached = this.auth.get(key);
    if (cached && Date.now() - cached.at < AUTH_TTL_MS) return cached;
    let lookup = this.pending.get(key);
    if (!lookup) {
      lookup = (async () => {
        try {
          // Ask for this host/path: root-only queries lose protected game-page
          // cookies, and sibling subdomains must not share an auth header.
          const r = await this.browser.cookieHeader('discovery', url);
          const entry = { cookie: r.cookie, userAgent: r.userAgent, at: Date.now() };
          this.auth.set(key, entry);
          return entry;
        } catch {
          // Firefox not started yet: anonymous reads still work for most sites.
          return { cookie: '', userAgent: '', at: Date.now() };
        } finally {
          this.pending.delete(key);
        }
      })();
      this.pending.set(key, lookup);
    }
    const timeout = new Promise<{ cookie: string; userAgent: string; at: number }>((resolve) => setTimeout(() => resolve(cached ?? { cookie: '', userAgent: '', at: 0 }), AUTH_WAIT_MS).unref());
    return Promise.race([lookup, timeout]);
  }

  async fetch(url: string, signal: AbortSignal, referer?: string): Promise<FetchPageResult> {
    const auth = await this.session(url);
    const worker = this.workers[this.next++ % this.workers.length];
    const r = await worker.call<FetchPageResult>('fetchPage', { url, cookie: auth.cookie, userAgent: auth.userAgent, referer }, signal);
    this.stats.http++;
    this.stats.ms += r.ms;
    return r;
  }

  /** Date ordering uses HTTP and a read-only cookie jar. A dedicated rendering tab handles
   * JavaScript and HTTP challenges; it never uses an AI or the AI's page. */
  async fetchBackground(url: string, signal: AbortSignal, detail = false): Promise<FetchPageResult> {
    const worker = this.workers[this.next++ % this.workers.length];
    const cached = this.auth.get(authKey(url));
    const cookie = this.profileDir ? await worker.call<string>('storedCookies', {profileDir:this.profileDir,url},signal).catch(()=> '') : cached?.cookie ?? '';
    if (signal.aborted) throw Object.assign(new Error('Cancelled'), {code:'cancelled'});
    const r = await worker.call<FetchPageResult>('fetchPage',{url,cookie,userAgent:cached?.userAgent},signal);
    if (signal.aborted) throw Object.assign(new Error('Cancelled'), {code:'cancelled'});
    if (r.ok && !r.extract.gates.captcha && !r.extract.gates.blocked && !r.extract.gates.login &&
      (!detail || parseSiteDate(r.extract.published,r.extract.observedAt))) return r;
    const started = Date.now();
    const extract = await this.browser.readDatePage(url,signal,detail);
    return {ok:true,status:200,url:extract.url,extract,ms:Date.now()-started};
  }

  async fetchText(url: string, signal: AbortSignal): Promise<{ status: number; url: string; text: string | null }> {
    const auth = await this.session(url);
    const worker = this.workers[this.next++ % this.workers.length];
    return worker.call('fetchText', { url, cookie: auth.cookie, userAgent: auth.userAgent }, signal);
  }

  /** HTTP validators (ETag, Last-Modified, size) of a download file. */
  async headFile(url: string, signal: AbortSignal, referer?: string): Promise<{ status: number; etag: string | null; lastModified: string | null; bytes: number | null }> {
    const auth = await this.session(url);
    const worker = this.workers[this.next++ % this.workers.length];
    return worker.call('headFile', { url, cookie: auth.cookie, userAgent: auth.userAgent, referer }, signal);
  }

  /** A completed website check changes the session cookies. */
  forget(url?: string) {
    if (url) { const site = siteKey(hostOf(url)); for (const key of this.auth.keys()) if (siteKey(hostOf(key)) === site) this.auth.delete(key); }
    else this.auth.clear();
  }
}
