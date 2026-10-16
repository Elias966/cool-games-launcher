import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/main/db';
import { CatalogRepo, ConsentRepo, SettingsRepo, SourcesRepo, defaultSettings } from '../src/main/repos';
import { PolicyService } from '../src/main/policy-service';
import { StoreSession, type SessionToken } from '../src/main/store-session';
import { Discovery } from '../src/main/discovery';
import { HostRateLimiter } from '../src/main/rate-limit';
import { CLASSIFIER_VERSION } from '../src/main/ai';
import { extractPage, type PageExtract } from '@shared/page-extract';
import type { Source } from '@shared/types';
import { fixtureAgent } from './helpers/fixture-agent';

const cleanup: Array<() => void> = [];
afterEach(async () => { await vi.advanceTimersByTimeAsync(1000); cleanup.splice(0).reverse().forEach(f => f()); vi.useRealTimers(); });
function page(html: string, url: string): PageExtract {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const result = dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;
  dom.window.close(); return result;
}
function listing(n: number) {
  return page('<main>'+[1,2,3].map(i=>`<article><h2><a href="/game-${n}-${i}">Orbit ${n}-${i}</a></h2><img src="/cover.png"></article>`).join('')+(n===1?'<a class="next page-numbers" href="/page/2">Next</a>':'')+'</main>', n===1?'https://games.test/':'https://games.test/page/2');
}
function game(url: string) {
  return page('<script type="application/ld+json">'+JSON.stringify({'@type':'VideoGame',name:'Orbit '+url.split('/game-')[1],description:'A space puzzle game',genre:'Puzzle',keywords:'space',operatingSystem:'Linux',image:'/cover.png'})+'</script><main><a href="https://files.test/orbit.zip">Download game</a></main>',url);
}
function file() { vi.useFakeTimers(); const dir=mkdtempSync(join(tmpdir(),'cgl-persist-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'launcher.db'); }
function setup(path: string, deps: object = {}) {
  const db=openDb(path),session=new StoreSession(),settings=new SettingsRepo(db,defaultSettings({games:tmpdir(),downloads:tmpdir()}));
  const sources=new SourcesRepo(db),catalog=new CatalogRepo(db),policy=new PolicyService(settings,new ConsentRepo(db));
  let current='about:blank';
  const browser={navigate:vi.fn(async (_:string,url:string)=>{current=url;}),extract:vi.fn(async()=>current==='https://games.test/'?listing(1):current.endsWith('/page/2')?listing(2):game(current)),scroll:vi.fn(async()=>{}),stopLoading:vi.fn(async()=>{})};
  const agent=fixtureAgent(),classification={classifyEntry:vi.fn(async(id:number)=>{catalog.setRating(id,'safe',0,[],CLASSIFIER_VERSION);catalog.setArtwork(id,'verified.png');})};
  const discovery=new Discovery({sources,catalog,settings,session,policy,browser,agent,classification,ai:{setStatus:vi.fn()} as never,limiter:new HostRateLimiter(),...deps} as never);
  session.removeAllListeners('enter');
  cleanup.push(()=>{session.leave();try{db.close();}catch{}});
  const run=(token=session.token()!)=>(discovery as unknown as {crawlSource(s:Source,t:SessionToken):Promise<void>}).crawlSource(sources.list()[0],token);
  const pick=()=>(discovery as unknown as {pickSource():Source|null}).pickSource();
  return {db,session,sources,catalog,policy,browser,agent,classification,discovery,run,pick};
}
function source(s:ReturnType<typeof setup>) { const row=s.sources.add('https://games.test/');s.sources.update(row.id,{rateLimitMs:0,maxPages:1});return row; }
async function close(s:ReturnType<typeof setup>) { s.session.leave();await vi.advanceTimersByTimeAsync(1000);s.db.close(); }

describe('durable incremental Store indexing',()=>{
  it('keeps verified games, search, facets and links during rescan; only checks new games',async()=>{
    const path=file(),s=setup(path),src=source(s);s.session.enter();await s.run();await s.run();
    const before=s.catalog.query(s.policy.policy(),{}).entries.map(e=>s.catalog.raw(e.id));
    expect(before).toHaveLength(6);s.browser.navigate.mockClear();
    const read=s.browser.extract.getMockImplementation()!;
    s.browser.extract.mockImplementation(async()=>{const ex=await read();if(ex.url==='https://games.test/')ex.cards.push({...ex.cards[0],href:'https://games.test/game-3-1',title:'Orbit 3-1'});return ex;});
    s.discovery.recrawl(src.id);
    expect(s.catalog.query(s.policy.policy(),{search:'Orbit 1-1'}).total).toBe(1);
    expect(s.catalog.facets(s.policy.policy())).toMatchObject({categories:[{name:'puzzle'}],tags:[{name:'space'}]});
    expect(before.map(e=>s.catalog.raw(e!.id))).toEqual(before);
    await s.run();await s.run();
    // Only the new game's page is read; verified games are never re-parsed.
    expect(s.browser.navigate.mock.calls.map(([,url])=>url).filter(url=>url.includes('/game-'))).toEqual(['https://games.test/game-3-1']);
    expect(before.map(e=>s.catalog.raw(e!.id))).toEqual(before);
    await close(s);const reopened=setup(path);
    expect(reopened.catalog.query(reopened.policy.policy(),{search:'Orbit',tags:['space']}).total).toBe(7);
    expect(reopened.pick()).toBeNull();
  });

  it('re-checks an indexed site incrementally: new games are found, and it stops after two pages with nothing new',async()=>{
    const path=file(),s=setup(path),src=source(s);s.sources.update(src.id,{maxPages:50});s.session.enter();
    // An endless newest-first listing: page N links to page N+1.
    const pageN=(n:number,extra='')=>page('<main>'+extra+[1,2,3].map(i=>`<article><h2><a href="/game-${n}-${i}">Orbit ${n}-${i}</a></h2><img src="/cover.png"></article>`).join('')+`<a class="next page-numbers" href="/page/${n+1}">Next</a></main>`,n===1?'https://games.test/':`https://games.test/page/${n}`);
    let current='';let fresh='';
    s.browser.navigate.mockImplementation(async(_:string,url:string)=>{current=url;});
    s.browser.extract.mockImplementation(async()=>{const m=/\/page\/(\d+)/.exec(current);return current==='https://games.test/'?pageN(1,fresh):m?pageN(+m[1]):game(current);});
    // Pages 1–5 were indexed by an earlier full crawl.
    for(let n=1;n<=5;n++)for(let i=1;i<=3;i++)s.catalog.upsertListing(src.id,{pageUrl:`https://games.test/game-${n}-${i}`,title:`Orbit ${n}-${i}`,titleKey:`orbit ${n} ${i}`});
    s.sources.markCrawled(src.id);s.sources.saveRecipe(src.id,{version:1,game:[{host:'^games\\.test$',path:'^/game-[^/]+/?$'}],more:[],listingMode:'http',detailMode:'http',learnedAt:'',origin:'ai',fullCrawlAt:new Date().toISOString(),routesVersion:3});
    fresh='<article><h2><a href="/game-new-1">Brand New</a></h2><img src="/cover.png"></article>';
    s.discovery.recrawl(src.id);await s.run();
    const listings=s.browser.navigate.mock.calls.map(([,u])=>u).filter(u=>!u.includes('/game-'));
    expect(listings).toEqual(['https://games.test/','https://games.test/page/2','https://games.test/page/3']);
    expect(s.catalog.query(s.policy.policy(),{search:'Orbit new-1'}).total).toBe(1);
    expect(s.sources.cursor(src.id)).toBeNull();
  });

  it('a site learned with older instructions re-learns its listing routes once and walks the whole site', async () => {
    const path=file(),s=setup(path),src=source(s);s.sources.update(src.id,{maxPages:10});s.session.enter();
    // Homepage without pagination; the catalog sits behind a category page.
    const home=page('<main>'+[1,2,3].map(i=>`<article><h2><a href="/game-1-${i}">Orbit 1-${i}</a></h2><img src="/cover.png"></article>`).join('')+'<a href="/category/all/">All games</a></main>','https://games.test/');
    const cat=page('<main>'+[1,2,3].map(i=>`<article><h2><a href="/game-9-${i}">Orbit 9-${i}</a></h2><img src="/cover.png"></article>`).join('')+'</main>','https://games.test/category/all/');
    let current='';
    s.browser.navigate.mockImplementation(async(_:string,url:string)=>{current=url;});
    s.browser.extract.mockImplementation(async()=>current==='https://games.test/'?home:current.includes('/category/all')?cat:game(current));
    for(let i=1;i<=3;i++)s.catalog.upsertListing(src.id,{pageUrl:`https://games.test/game-1-${i}`,title:`Orbit 1-${i}`,titleKey:`orbit 1 ${i}`});
    s.sources.markCrawled(src.id);
    // Old recipe: no routes, no routesVersion, a recorded "full" crawl.
    s.sources.saveRecipe(src.id,{version:1,game:[{host:'^games\\.test$',path:'^/game-[^/]+/?$'}],more:[],listingMode:'http',detailMode:'http',learnedAt:'',origin:'ai',fullCrawlAt:new Date().toISOString()});
    expect(s.pick()?.id).toBe(src.id);
    await s.run();
    expect(s.agent.learnListing).toHaveBeenCalledTimes(1);
    expect(s.browser.navigate.mock.calls.map(([,u])=>u)).toContain('https://games.test/category/all');
    expect(s.catalog.query(s.policy.policy(),{search:'Orbit 9'}).total).toBe(3);
    expect(s.sources.recipe(src.id)?.routesVersion).toBe(3);
    expect(s.pick()).toBeNull();
  });

  it('coalesces Rescan clicks during a running scan instead of scheduling a duplicate scan',async()=>{
    const path=file(),s=setup(path),src=source(s),read=vi.mocked(s.agent.learnListing).getMockImplementation()!;
    vi.mocked(s.agent.learnListing).mockImplementationOnce(async(ex,token)=>{s.discovery.recrawl(src.id);return read(ex,token);});
    s.session.enter();await s.run();await s.run();
    expect(s.pick()).toBeNull();
    expect(s.browser.navigate.mock.calls.filter(([,url])=>url==='https://games.test/')).toHaveLength(1);
  });

  it('resumes the next listing after reopening SQLite, without parsing completed listings or games',async()=>{
    const path=file(),s=setup(path),src=source(s);s.session.enter();await s.run();
    const old=s.catalog.query(s.policy.policy(),{}).entries;
    expect(s.sources.cursor(src.id)?.pending).toEqual(['https://games.test/page/2']);
    s.discovery.recrawl(src.id);expect(s.sources.cursor(src.id)?.pending).toEqual(['https://games.test/page/2']);
    await close(s);const next=setup(path);next.session.enter();await next.run();
    expect(next.browser.navigate.mock.calls[0][1]).toBe('https://games.test/page/2');
    expect(next.browser.navigate.mock.calls.some(([,url])=>old.some(e=>e.pageUrl===url))).toBe(false);
    expect(next.catalog.query(next.policy.policy(),{}).total).toBe(6);
    expect(next.sources.cursor(src.id)).toBeNull();
  });

  it('an interrupted game check resumes with unfinished games only, never the finished listing',async()=>{
    const path=file(),s=setup(path),src=source(s);const token=s.session.enter();
    const navigate=s.browser.navigate.getMockImplementation()!;
    s.browser.navigate.mockImplementation(async(ctx,url)=>{if(url.endsWith('/game-1-2')){s.session.leave();s.session.assertLive(token);}return navigate(ctx,url);});
    await expect(s.run(token)).rejects.toThrow();
    const done=s.catalog.query(s.policy.policy(),{}).entries.map(e=>s.catalog.raw(e.id)!).filter(e=>e.detailFetchedAt).map(e=>e.pageUrl);
    expect(s.sources.cursor(src.id)?.visited).toEqual(['https://games.test/']);
    await close(s);const next=setup(path);next.session.enter();await next.run();
    const visited=next.browser.navigate.mock.calls.map(([,url])=>url);
    expect(visited).toContain('https://games.test/game-1-2');
    expect(visited.some(url=>url==='https://games.test/'||done.includes(url))).toBe(false);
    expect(next.catalog.query(next.policy.policy(),{}).total).toBe(6);
  });

  it('commits a listing page\'s games and routes before reading any game page',async()=>{
    const path=file(),s=setup(path),src=source(s);const token=s.session.enter();
    const navigate=s.browser.navigate.getMockImplementation()!;
    s.browser.navigate.mockImplementation(async(ctx,url)=>{if(url.includes('/game-')){s.session.leave();s.session.assertLive(token);}return navigate(ctx,url);});
    await expect(s.run(token)).rejects.toThrow();
    expect(s.catalog.count(src.id)).toBe(3);
    expect(s.sources.cursor(src.id)).toMatchObject({pending:['https://games.test/page/2'],visited:['https://games.test/'],pagesDone:1});
    await close(s);const next=setup(path);
    expect(next.catalog.count(src.id)).toBe(3);
    expect(next.sources.cursor(src.id)?.pending).toEqual(['https://games.test/page/2']);
  });

  it('retries a transient failure at its saved page, with durable backoff and bounded automatic retries',async()=>{
    const path=file(),s=setup(path),src=source(s);s.session.enter();await s.run();
    s.browser.extract.mockRejectedValue(new Error('Transient site failure'));
    await s.run();expect(s.sources.get(src.id)?.status).toBe('error');
    expect(s.sources.get(src.id)?.lastCrawlAt).toBeNull();
    expect(s.sources.cursor(src.id)).toMatchObject({pending:['https://games.test/page/2'],visited:['https://games.test/'],failures:1});
    expect(s.pick()).toBeNull();await close(s);
    const next=setup(path);next.session.enter();expect(next.pick()).toBeNull();await vi.advanceTimersByTimeAsync(30_000);expect(next.pick()?.id).toBe(src.id);
    next.browser.extract.mockRejectedValue(new Error('Still unavailable'));
    await next.run();await next.run();await vi.advanceTimersByTimeAsync(300_000);expect(next.pick()).toBeNull();
    expect(next.catalog.query(next.policy.policy(),{search:'Orbit'}).total).toBe(3);
    next.discovery.recrawl(src.id);expect(next.pick()?.id).toBe(src.id);
    next.browser.extract.mockImplementation(async()=>next.browser.navigate.mock.calls.at(-1)![1].endsWith('/page/2')?listing(2):game(next.browser.navigate.mock.calls.at(-1)![1]));
    await next.run();expect(next.catalog.query(next.policy.policy(),{}).total).toBe(6);
    expect(next.browser.navigate.mock.calls.some(([,url])=>url==='https://games.test/')).toBe(false);
  });

  it('continues interrupted classification from stored download evidence, without another model detail parse',async()=>{
    const path=file(),s=setup(path),src=source(s);const token=s.session.enter();
    const classify=s.classification.classifyEntry.getMockImplementation()!;
    // Interrupt the post-detail check (listing cover checks run before details).
    s.classification.classifyEntry.mockImplementation(async(id:number)=>{if(s.catalog.raw(id)?.detailFetchedAt){s.session.leave();s.session.assertLive(token);}return classify(id);});
    await expect(s.run(token)).rejects.toThrow();
    const saved=[...Array(10).keys()].map(i=>s.catalog.raw(i+1)).find(e=>e?.detailFetchedAt&&e.rating==='unknown')!;
    expect(saved.candidates).toHaveLength(1);
    await close(s);const next=setup(path);next.session.enter();await next.run();
    expect(next.browser.navigate.mock.calls.some(([,url])=>url===saved.pageUrl)).toBe(false);
    expect(next.catalog.raw(saved.id)?.candidates).toEqual(saved.candidates);
    expect(next.catalog.get(saved.id,next.policy.policy())?.rating).toBe('safe');
  });

  it('repairs old rescan-hidden routes on upgrade without exposing unchecked entries or losing the queue',async()=>{
    const path=file(),s=setup(path),src=source(s);s.session.enter();await s.run();
    const before=s.catalog.query(s.policy.policy(),{}).entries;
    s.db.exec("UPDATE catalog SET download_status='pending',detail_fetched_at=NULL; ALTER TABLE sources DROP COLUMN recipe_json; ALTER TABLE catalog DROP COLUMN version_json; ALTER TABLE catalog DROP COLUMN listing_title; ALTER TABLE games DROP COLUMN installed_version_json; ALTER TABLE games DROP COLUMN update_json; ALTER TABLE games DROP COLUMN previous_json; ALTER TABLE games DROP COLUMN update_checked_at; ALTER TABLE downloads DROP COLUMN update_game_id; ALTER TABLE catalog DROP COLUMN popularity_json; ALTER TABLE catalog DROP COLUMN published_at; ALTER TABLE catalog DROP COLUMN rank_popular; ALTER TABLE catalog DROP COLUMN rank_trending; ALTER TABLE catalog DROP COLUMN pop_score; ALTER TABLE catalog DROP COLUMN trend_score; ALTER TABLE catalog DROP COLUMN description_source; ALTER TABLE downloads DROP COLUMN group_id; ALTER TABLE downloads DROP COLUMN part_index; ALTER TABLE downloads DROP COLUMN part_total; ALTER TABLE games DROP COLUMN archive_kept; ALTER TABLE games DROP COLUMN launch_json; ALTER TABLE catalog DROP COLUMN steam_json; DROP TABLE wishlist; ALTER TABLE games DROP COLUMN redist_json; DROP TABLE play_sessions; ALTER TABLE catalog DROP COLUMN cover_score; UPDATE schema_version SET version=5");
    // Written by the old schema, which has no listing_title column yet.
    const unknown=(s.db.prepare("INSERT INTO catalog (source_id,page_url,title,title_key) VALUES (?,'https://games.test/unverified','Unverified','unverified') RETURNING id").get(src.id) as {id:number}).id;
    await close(s);const next=setup(path);
    expect(next.catalog.query(next.policy.policy(),{}).entries.map(e=>e.id).sort()).toEqual(before.map(e=>e.id).sort());
    expect(next.catalog.get(unknown,next.policy.policy())).toBeNull();
    expect(next.sources.cursor(src.id)?.pending).toEqual(['https://games.test/page/2']);
  });

  it('rolls back a partial listing commit together with its checkpoint',()=>{
    const path=file(),s=setup(path),src=source(s);
    expect(()=>s.sources.checkpoint(src.id,{pending:['https://games.test/page/2'],visited:[],pagesDone:1,startedAt:'now'},()=>{
      s.catalog.upsertListing(src.id,{pageUrl:'https://games.test/partial',title:'Partial',titleKey:'partial'});throw Error('Interrupted transaction');
    })).toThrow('Interrupted transaction');
    expect(s.catalog.count(src.id)).toBe(0);expect(s.sources.cursor(src.id)).toBeNull();
  });
});

describe('script-rendered game pages read in Firefox',()=>{
  // A single-page app: the HTTP copy and the first read after navigating are an
  // empty shell; the game renders a moment later.
  const shell=(url:string)=>page('<title>Game Jolt - Share your creations</title><main></main>',url);
  const rendered=(url:string)=>{const slug=url.split('/games/')[1];return page('<script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:'Orbit '+slug,image:`/cover-${slug}.png`})+`</script><main><h1>Orbit ${slug}</h1><a href="https://files.test/${slug}.zip">Download game</a></main>`,url);};
  function spa(s:ReturnType<typeof setup>) {
    let current='about:blank',reads=0;
    s.browser.navigate.mockImplementation(async(_:string,url:string)=>{current=url;reads=0;});
    s.browser.extract.mockImplementation(async()=>reads++===0?shell(current):rendered(current));
  }
  async function checkAll(s:ReturnType<typeof setup>,src:Source) {
    s.session.enter();
    const ids=['a','b','c'].map(slug=>s.catalog.upsertListing(src.id,{pageUrl:`https://games.test/games/${slug}`,title:`Orbit ${slug}`,titleKey:`orbit ${slug}`})!.id);
    // Parallel verification workers share the one Firefox window.
    const all=Promise.all(ids.map(id=>s.discovery.fetchDetail(id,s.session.token()!)));
    await vi.advanceTimersByTimeAsync(30_000);await all;
    return ids.map(id=>s.catalog.raw(id)!);
  }
  const expectOwnPages=(rows:Array<NonNullable<ReturnType<CatalogRepo['raw']>>>)=>{
    expect(rows.map(r=>r.title)).toEqual(['Orbit a','Orbit b','Orbit c']);
    expect(rows.map(r=>r.thumbnailUrl)).toEqual(['a','b','c'].map(slug=>`https://games.test/cover-${slug}.png`));
    expect(rows.map(r=>r.candidates.map(c=>c.url))).toEqual(['a','b','c'].map(slug=>[`https://files.test/${slug}.zip`]));
    expect(rows.every(r=>r.downloadStatus==='available')).toBe(true);
  };

  it('waits for each page to render before another check navigates the window away',async()=>{
    const fetcher={stats:{http:0,fallbacks:0,ms:0},fetch:vi.fn(async(url:string)=>({ok:true,status:200,ms:1,extract:shell(url)}))};
    const s=setup(file(),{fetcher});spa(s);
    expectOwnPages(await checkAll(s,source(s)));
    expect(fetcher.fetch).toHaveBeenCalledTimes(3);
  });

  it('renders game pages when the site recipe reads them in Firefox',async()=>{
    const s=setup(file()),src=source(s);spa(s);
    s.sources.saveRecipe(src.id,{version:1,game:[{host:'^games\\.test$',path:'^/games/[^/]+$'}],more:[],listingMode:'browser',detailMode:'browser',learnedAt:'',origin:'ai',routesVersion:3});
    expect(s.sources.recipe(src.id)?.detailMode).toBe('browser');
    expectOwnPages(await checkAll(s,src));
  });
});
