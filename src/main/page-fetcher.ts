// Fast page reads for indexing: plain HTTP through the fetcher worker, sending
// the cookies and user agent the user's Firefox session would send, so sites
// see the same visitor. Pages that need JavaScript or a website check fall
// back to Firefox in Discovery.
import type { WorkerHost } from './worker-host';
import type { BrowserClient, BrowserCookie } from './browser-client';
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

type Auth = { cookie:string; userAgent:string; at:number; cookies?:BrowserCookie[] };
const cookieFor=(cookies:BrowserCookie[],url:string)=>{const u=new URL(url);return cookies.filter(c=>(c.host===u.hostname||c.host.startsWith('.')&&(u.hostname===c.host.slice(1)||u.hostname.endsWith(c.host)))&&(!c.secure||u.protocol==='https:')&&(u.pathname===c.path||u.pathname.startsWith(c.path.endsWith('/')?c.path:c.path+'/'))&&!/[\r\n;]/.test(c.name+c.value)).sort((a,b)=>b.path.length-a.path.length).map(c=>c.name+'='+c.value).join('; ')};
type PendingPage={url:string;signal:AbortSignal;resolve:(r:FetchPageResult|null)=>void;reject:(e:Error)=>void};
export class PageFetcher {
  private auth = new Map<string, Auth>();
  private generation=0;
  private browserHttpUntil=new Map<string,number>();
  private pageBatches=new Map<string,PendingPage[]>();
  private browserReaders=new Set<string>();
  /** Running totals shown in the Store status line. */
  readonly stats = { http: 0, fallbacks: 0, ms: 0 };

  private next = 0;
  private pending = new Map<string, Promise<Auth>>();

  /** Several parser processes: HTML parsing is CPU-bound and would serialise parallel reads. */
  constructor(private workers: WorkerHost[], private browser: BrowserClient, private profileDir?: string|(()=>string|undefined)) {}

  private async session(url: string) {
    const jar=typeof this.browser.sessionCookies==='function';
    const key = jar?new URL(url).origin:authKey(url);
    const cached = this.auth.get(key);
    if (cached && Date.now() - cached.at < AUTH_TTL_MS) return {...cached,cookie:cached.cookies?cookieFor(cached.cookies,url):cached.cookie};
    let lookup = this.pending.get(key);
    if (!lookup) {
      const generation=this.generation;
      lookup = (async () => {
        try {
          // Ask for this host/path: root-only queries lose protected game-page
          // cookies, and sibling subdomains must not share an auth header.
          const r = jar?await this.browser.sessionCookies(url):await this.browser.cookieHeader('discovery', url);
          const entry:Auth = {cookie:'cookie' in r?r.cookie:'',cookies:'cookies' in r?r.cookies:undefined,userAgent:r.userAgent,at:Date.now()};
          if(generation===this.generation)this.auth.set(key, entry);
          return entry;
        } catch {
          // Firefox not started yet: anonymous reads still work for most sites.
          return { cookie: '', userAgent: '', at: Date.now() };
        } finally {
          if(this.pending.get(key)===lookup)this.pending.delete(key);
        }
      })();
      this.pending.set(key, lookup);
    }
    let timer:ReturnType<typeof setTimeout>;
    const timeout = new Promise<Auth>((resolve) => {timer=setTimeout(() => resolve(cached ?? { cookie: '', userAgent: '', at: 0 }), AUTH_WAIT_MS);timer.unref();});
    try{const r=await Promise.race([lookup,timeout]);return {...r,cookie:r.cookies?cookieFor(r.cookies,url):r.cookie};}finally{clearTimeout(timer!);}
  }

  async fetch(url: string, signal: AbortSignal, referer?: string): Promise<FetchPageResult> {
    const origin=new URL(url).origin;
    if((this.browserHttpUntil.get(origin)??0)>Date.now()){const read=await this.fetchInBrowser(url,signal);if(read)return read;}
    const auth = await this.session(url);
    const worker = this.workers[this.next++ % this.workers.length];
    const r = await worker.call<FetchPageResult>('fetchPage', { url, cookie: auth.cookie, userAgent: auth.userAgent, referer }, signal);
    this.stats.http++;
    this.stats.ms += r.ms;
    // Some hosts reject Chromium's TLS/HTTP connection without returning an
    // HTTP status. Firefox can still read them; batch those reads just like
    // 403s instead of forcing a full rendered navigation for every game.
    if(r.status===403||!r.ok&&r.reason==='network'||r.ok&&(r.extract.gates.captcha||r.extract.gates.blocked)){
      const read=await this.fetchInBrowser(url,signal);
      if(read){this.browserHttpUntil.set(origin,Date.now()+5*60_000);return read;}
    }
    return r;
  }

  /** Read several pages in Firefox's authenticated network session without
   * navigating or running an AI for each game. Parsing stays in parallel workers. */
  private fetchInBrowser(url:string,signal:AbortSignal):Promise<FetchPageResult|null>{
    if(typeof this.browser.fetchPages!=='function')return Promise.resolve(null);
    if(signal.aborted)return Promise.reject(Object.assign(Error('Cancelled'),{code:'cancelled'}));
    const origin=new URL(url).origin;
    return new Promise((resolve,reject)=>{
      let queue=this.pageBatches.get(origin);
      if(!queue){queue=[];this.pageBatches.set(origin,queue);setTimeout(()=>void this.flushPages(origin),10);}
      queue.push({url,signal,resolve,reject});
    });
  }
  private async flushPages(origin:string){
    if(this.browserReaders.has(origin))return;
    this.browserReaders.add(origin);
    const queue=this.pageBatches.get(origin)??[];this.pageBatches.delete(origin);
    const cancelled=()=>Object.assign(Error('Cancelled'),{code:'cancelled'});
    const active=queue.filter(r=>{if(r.signal.aborted){r.reject(cancelled());return false;}return true;});
    for(let start=0;start<active.length;start+=6){
      const batch=active.slice(start,start+6),controller=new AbortController();
      const abort=()=>{if(batch.every(r=>r.signal.aborted))controller.abort();};
      for(const r of batch)r.signal.addEventListener('abort',abort,{once:true});abort();
      try{
        const results=await this.browser.fetchPages(batch.map(r=>r.url),controller.signal);
        await Promise.all(batch.map(async(r,i)=>{
          if(r.signal.aborted){r.reject(cancelled());return;}
          try{const page=results[i];if(!page?.html||page.status!==200||new URL(page.url).origin!==origin){r.resolve(null);return;}
            const worker=this.workers[this.next++%this.workers.length];
            const parsed=await worker.call<FetchPageResult>('parseHtml',page,r.signal);
            r.resolve(parsed.ok&&!parsed.extract.gates.captcha&&!parsed.extract.gates.blocked&&!parsed.extract.gates.login?parsed:null);
          }catch{r.signal.aborted?r.reject(cancelled()):r.resolve(null);}
        }));
      }catch{for(const r of batch)r.signal.aborted?r.reject(cancelled()):r.resolve(null);}
      finally{for(const r of batch)r.signal.removeEventListener('abort',abort);}
    }
    this.browserReaders.delete(origin);
    if(this.pageBatches.has(origin))setTimeout(()=>void this.flushPages(origin),0);
  }

  /** Date ordering uses HTTP and a read-only cookie jar. A dedicated rendering tab handles
   * JavaScript and HTTP challenges; it never uses an AI or the AI's page. */
  async fetchBackground(url: string, signal: AbortSignal, detail = false): Promise<FetchPageResult> {
    const worker = this.workers[this.next++ % this.workers.length];
    const cached = this.auth.get(typeof this.browser.sessionCookies==='function'?new URL(url).origin:authKey(url));
    const profileDir=typeof this.profileDir==='function'?this.profileDir():this.profileDir;
    const cookie = profileDir ? await worker.call<string>('storedCookies', {profileDir,url},signal).catch(()=> '') : cached?.cookies?cookieFor(cached.cookies,url):cached?.cookie ?? '';
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
    this.generation++;this.browserHttpUntil.clear();this.pending.clear();
    if (url) { const site = siteKey(hostOf(url)); for (const key of this.auth.keys()) if (siteKey(hostOf(key)) === site) this.auth.delete(key); }
    else this.auth.clear();
  }
}
