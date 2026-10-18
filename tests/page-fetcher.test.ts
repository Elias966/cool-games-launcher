import {describe,it,expect,vi,afterEach} from 'vitest';
import {PageFetcher} from '../src/main/page-fetcher';
import {extractHtml} from '../src/workers/fetcher';
afterEach(()=>vi.useRealTimers());
const html='<main><h1>Orbit</h1><button>Download</button></main>';
const response=(url:string)=>({ok:true as const,status:200,url,ms:1,extract:extractHtml(html,url)});
const signal=()=>new AbortController().signal;
describe('fast authenticated indexing reads',()=>{
 it('reuses the path-filtered jar for background dates when no saved profile is available',async()=>{
  const call=vi.fn(async(_method:string,p:any)=>response(p.url)),reader=new PageFetcher([{call} as any],{sessionCookies:async()=>({userAgent:'Firefox',cookies:[{name:'session',value:'yes',host:'games.test',path:'/game',secure:true}]})} as any);
  await reader.fetch('https://games.test/game/one',signal());await reader.fetchBackground('https://games.test/game/two',signal());expect(call.mock.calls.at(-1)![1].cookie).toBe('session=yes');
 });
 it('retrieves one cookie jar for parallel pages while preserving path, host and secure matching',async()=>{
  const sessionCookies=vi.fn(async()=>({userAgent:'Firefox/156',cookies:[{name:'path',value:'yes',host:'games.test',path:'/game/one',secure:true},{name:'root',value:'yes',host:'.games.test',path:'/',secure:false},{name:'other',value:'no',host:'other.test',path:'/',secure:false}]}));
  const call=vi.fn(async(_method:string,p:any)=>response(p.url)),reader=new PageFetcher([{call} as any],{sessionCookies} as any);
  await Promise.all(['one','two','three','four','five','six'].map(n=>reader.fetch('https://games.test/game/'+n,signal())));
  expect(sessionCookies).toHaveBeenCalledOnce();expect(call.mock.calls[0][1].cookie).toBe('path=yes; root=yes');expect(call.mock.calls.slice(1).every(c=>c[1].cookie==='root=yes')).toBe(true);
  await reader.fetch('http://games.test/game/one',signal());expect(call.mock.calls.at(-1)![1].cookie).toBe('root=yes');expect(sessionCookies).toHaveBeenCalledTimes(2);
 });
 it('does not enqueue a fresh browser cookie query for every page when Firefox is busy',async()=>{
  vi.useFakeTimers();const sessionCookies=vi.fn(()=>new Promise(()=>{})),call=vi.fn(async(_m:string,p:any)=>response(p.url)),reader=new PageFetcher([{call} as any],{sessionCookies} as any);
  const batch=Promise.all(Array.from({length:6},(_,i)=>reader.fetch('https://games.test/game/'+i,signal())));await vi.advanceTimersByTimeAsync(1501);await batch;
  expect(sessionCookies).toHaveBeenCalledOnce();expect(call).toHaveBeenCalledTimes(6);
 });
 it('batches blocked HTTP reads through Firefox and reuses that fast transport for subsequent pages',async()=>{
  const call=vi.fn(async(method:string,p:any)=>method==='fetchPage'?{ok:false,status:403,url:p.url,reason:'http',ms:1,detail:'HTTP 403'}:response(p.url));
  const fetchPages=vi.fn(async(urls:string[])=>urls.map(url=>({url,status:200,html,ms:20}))),sessionCookies=vi.fn(async()=>({cookies:[],userAgent:'Firefox'}));
  const reader=new PageFetcher([{call} as any],{sessionCookies,fetchPages} as any);
  const result=await Promise.all(Array.from({length:6},(_,i)=>reader.fetch('https://games.test/game/'+i,signal())));
  expect(result.every(r=>r.ok)).toBe(true);expect(fetchPages).toHaveBeenCalledOnce();expect(fetchPages.mock.calls[0][0]).toHaveLength(6);
  await reader.fetch('https://games.test/game/next',signal());expect(call.mock.calls.filter(c=>c[0]==='fetchPage')).toHaveLength(6);
 });
 it('preserves the gate when Firefox also receives a challenge rather than marking it verified',async()=>{
  const gated={ok:true as const,status:403,url:'https://games.test/game',ms:1,extract:extractHtml('<div class="g-recaptcha"></div>','https://games.test/game')};
  const call=vi.fn(async()=>gated),reader=new PageFetcher([{call} as any],{cookieHeader:async()=>({cookie:'',userAgent:''}),fetchPages:async()=>[{url:gated.url,status:403,html:'CAPTCHA',ms:1}]} as any);
  const r=await reader.fetch(gated.url,signal());expect(r.ok&&r.extract.gates.captcha).toBe(true);
 });
 it('does not accept cross-site redirects from the authenticated batch reader',async()=>{
  const call=vi.fn(async(_m:string,p:any)=>({ok:false,status:403,url:p.url,reason:'http',ms:1,detail:'blocked'}));
  const reader=new PageFetcher([{call} as any],{cookieHeader:async()=>({cookie:'',userAgent:''}),fetchPages:async()=>[{url:'https://other.test/game',status:200,html,ms:1}]} as any);
  expect((await reader.fetch('https://games.test/game',signal())).ok).toBe(false);expect(call).toHaveBeenCalledOnce();
 });
});


describe('website network failures during verification', () => {
  it('uses Firefox batches after transport errors and avoids repeating the failing transport for every game', async () => {
    const call = vi.fn(async (method: string, p: any) => method === 'fetchPage'
      ? { ok: false, status: 0, url: p.url, ms: 3000, reason: 'network', detail: 'net::ERR_HTTP2_PROTOCOL_ERROR' }
      : response(p.url));
    const fetchPages = vi.fn(async (urls: string[]) => urls.map(url => ({ url, status: 200, html, ms: 20 })));
    const reader = new PageFetcher([{ call } as any], { sessionCookies: async () => ({ cookies: [], userAgent: 'Firefox' }), fetchPages } as any);
    expect((await Promise.all(Array.from({ length: 6 }, (_, i) => reader.fetch('https://games.test/game/' + i, signal())))).every(r => r.ok)).toBe(true);
    expect(fetchPages).toHaveBeenCalledTimes(1);
    await reader.fetch('https://games.test/game/next', signal());
    expect(call.mock.calls.filter(c => c[0] === 'fetchPage')).toHaveLength(6);
  });

  it('keeps a transport error when the Firefox reader cannot verify the page', async () => {
    const error = { ok: false, status: 0, url: 'https://games.test/game', ms: 1, reason: 'network', detail: 'offline' };
    const reader = new PageFetcher([{ call: async () => error } as any], { sessionCookies: async () => ({ cookies: [], userAgent: 'Firefox' }), fetchPages: async () => [{ url: error.url, status: 200, html: '<title>Just a moment</title>', ms: 1 }] } as any);
    expect(await reader.fetch(error.url, signal())).toEqual(error);
  });
});
