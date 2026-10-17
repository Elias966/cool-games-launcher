import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openDb} from '../src/main/db';
import {CatalogRepo,SourcesRepo} from '../src/main/repos';
import {SiteDates} from '../src/main/site-dates';
import {PageFetcher} from '../src/main/page-fetcher';
import {storedCookies,extractHtml} from '../src/workers/fetcher';
const policy = {showNsfw:true,hideWomenCovers:false,revision:1};
const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'cgl-dates-'));const db=openDb(join(dir,'db'));
 cleanup.push(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const catalog=new CatalogRepo(db),sources=new SourcesRepo(db),source=sources.add('https://games.test/');
 sources.update(source.id,{enabled:true});
 const add=(title:string)=>{const id=catalog.upsertListing(source.id,{pageUrl:`https://games.test/${title}`,title,titleKey:title}).id;catalog.markListed([id]);catalog.setRating(id,'safe',0,[],'test');return id};
 return{catalog,sources,source,add};
}
function response(url:string,html:string){return{ok:true as const,status:200,url,ms:1,extract:extractHtml(html,url)}}
describe('launcher date service',()=>{
 it('orders saved game pages over HTTP without an AI session or browser',async()=>{
  const{catalog,sources,add}=fixture();const older=add('Older'),newer=add('Newer');
  const fetchBackground=vi.fn(async(url:string)=>response(url,`<article><time class="published" datetime="${url.endsWith('Newer')?'2026-10-16':'2026-10-15'}"></time></article>`));
  const service=new SiteDates({catalog,sources,fetcher:{fetchBackground} as any,limiter:{wait:async()=>{}} as any,changed:vi.fn()});cleanup.push(()=>service.stop());
  service.setActive(true);await vi.waitFor(()=>expect(catalog.get(newer,policy)?.siteAddedAt).toBe('2026-10-16T00:00:00.000Z'));
  expect(catalog.get(older,policy)?.siteAddedAt).toBe('2026-10-15T00:00:00.000Z');expect(fetchBackground).toHaveBeenCalledTimes(2);
 });
 it('finds new listings using saved site patterns and reads their own page date',async()=>{
  const{catalog,sources,source}=fixture();
  sources.saveRecipe(source.id,{version:1,game:[{host:'^games\\.test$',path:'^/games/[^/]+/?$'}],more:[],listingMode:'http',detailMode:'http',learnedAt:new Date().toISOString(),origin:'structure'});
  const fetchBackground=vi.fn(async(url:string)=>response(url,url==='https://games.test/'?'<main><h2>Recently Added</h2><article><a href="/games/added"><h3>Added Game</h3></a><time datetime="2026-10-17"></time></article></main>':'<article><h1>Added Game</h1><time class="published" datetime="2026-10-14"></time></article>'));
  const classify=vi.fn(async(id:number)=>{catalog.setRating(id,'safe',0,[],'test')});
  const service=new SiteDates({catalog,sources,fetcher:{fetchBackground} as any,limiter:{wait:async()=>{}} as any,changed:vi.fn(),classify});cleanup.push(()=>service.stop());
  service.setActive(true);
  await vi.waitFor(()=>expect(catalog.query(policy,{sort:'new'}).entries[0]?.siteAddedAt).toBe('2026-10-14T00:00:00.000Z'));
  expect(catalog.query(policy,{sort:'new'}).entries[0]?.pageUrl).toBe('https://games.test/games/added');
  expect(fetchBackground.mock.calls.map(c=>c[0])).toEqual(['https://games.test/','https://games.test/games/added']);expect(classify).toHaveBeenCalledTimes(1);
 });
 it('preserves saved titles when repeated listing markup is weaker',async()=>{
  const{catalog,sources,source,add}=fixture();const id=add('Existing');
  sources.saveRecipe(source.id,{version:1,game:[{host:'^games\\.test$',path:'^/Existing$'}],more:[],listingMode:'http',detailMode:'http',learnedAt:new Date().toISOString(),origin:'structure'});
  const fetchBackground=vi.fn(async(url:string)=>response(url,url==='https://games.test/'?'<main><a href="/Existing">Wrong heading</a></main>':'<article><time class="published" datetime="2026-10-16"></time></article>'));
  const service=new SiteDates({catalog,sources,fetcher:{fetchBackground} as any,limiter:{wait:async()=>{}} as any,changed:vi.fn()});cleanup.push(()=>service.stop());service.setActive(true);
  await vi.waitFor(()=>expect(catalog.get(id,policy)?.siteAddedAt).toBeTruthy());expect(catalog.raw(id)?.title).toBe('Existing');
 });
 it('leaves CAPTCHA and redirected homepages undated and does not loop or invoke an agent',async()=>{
  const{catalog,sources,add}=fixture();const gate=add('Gated'),redirect=add('Redirect');
  const fetchBackground=vi.fn(async(url:string)=>url.endsWith('Gated')?response(url,'<h1>Verify you are human</h1><div class="cf-turnstile"></div>'):response('https://games.test/','<time datetime="2026-10-16"></time>'));
  const service=new SiteDates({catalog,sources,fetcher:{fetchBackground} as any,limiter:{wait:async()=>{}} as any,changed:vi.fn()});cleanup.push(()=>service.stop());
  service.setActive(true);await vi.waitFor(()=>expect(fetchBackground).toHaveBeenCalledTimes(2));service.prioritize([gate,redirect]);
  await new Promise(r=>setTimeout(r,30));expect(fetchBackground).toHaveBeenCalledTimes(2);expect(catalog.get(gate,policy)?.siteAddedAt).toBeNull();expect(catalog.get(redirect,policy)?.siteAddedAt).toBeNull();
 });
 it('aborts date reads when the user leaves New',async()=>{
  const{catalog,sources,add}=fixture();const id=add('Pending');let signal:AbortSignal|undefined;
  const fetchBackground=vi.fn((_url:string,s:AbortSignal)=>{signal=s;return new Promise((_resolve,reject)=>s.addEventListener('abort',()=>reject(Error('cancelled'))))});
  const service=new SiteDates({catalog,sources,fetcher:{fetchBackground} as any,limiter:{wait:async()=>{}} as any,changed:vi.fn()});cleanup.push(()=>service.stop());
  service.setActive(true);await vi.waitFor(()=>expect(signal).toBeDefined());service.setActive(false);expect(signal!.aborted).toBe(true);expect(catalog.get(id,policy)?.siteAddedAt).toBeNull();
 });
 it('rechecks the live gated page before refreshing listings after human control',async()=>{
  const{catalog,sources,add}=fixture();const id=add('Gated');let solved=false;
  const fetchBackground=vi.fn(async(url:string)=>response(url,solved?'<article><time class="published" datetime="2026-10-16"></time></article>':'<h1>Verify you are human</h1><div class="cf-turnstile"></div>'));
  const verify=vi.fn(),service=new SiteDates({catalog,sources,fetcher:{fetchBackground} as any,limiter:{wait:async()=>{}} as any,changed:vi.fn(),verify});cleanup.push(()=>service.stop());
  service.setActive(true);await vi.waitFor(()=>expect(verify).toHaveBeenCalledTimes(1));solved=true;service.setActive(true);
  await vi.waitFor(()=>expect(catalog.get(id,policy)?.siteAddedAt).toBe('2026-10-16T00:00:00.000Z'));
  expect(fetchBackground.mock.calls.map(c=>c[0])).toEqual(['https://games.test/Gated','https://games.test/Gated']);
 });
 it('uses a deterministic rendering tab for HTTP challenges and script dates',async()=>{
  const gated=response('https://games.test/game','<h1>Verify you are human</h1><div class="cf-turnstile"></div>');
  const call=vi.fn(async()=>gated),cookieHeader=vi.fn(),readDatePage=vi.fn(async(url:string)=>extractHtml('<article><time class="published" datetime="2026-10-16"></time></article>',url));
  const fetcher=new PageFetcher([{call} as any],{cookieHeader,readDatePage} as any);
  const r=await fetcher.fetchBackground('https://games.test/game',new AbortController().signal,true);
  expect(r.ok&&r.extract.published).toBe('2026-10-16');expect(readDatePage).toHaveBeenCalledTimes(1);expect(cookieHeader).not.toHaveBeenCalled();
 });
 it('background fetch never asks Firefox to start or retrieve cookies',async()=>{
  const call=vi.fn(async(method:string)=>method==='storedCookies'?'saved=value':response('https://games.test/game','<h1>Game</h1>'));
  const cookieHeader=vi.fn(()=>{throw Error('Firefox must stay untouched')});
  const fetcher=new PageFetcher([{call} as any],{cookieHeader} as any,'/profile');
  await fetcher.fetchBackground('https://games.test/game',new AbortController().signal);
  expect(cookieHeader).not.toHaveBeenCalled();expect(call.mock.calls.map(c=>c[0])).toEqual(['storedCookies','fetchPage']);
 });
});
describe('saved Firefox cookies',()=>{
 it('restricts cookies by host, path, expiry, partition and HTTPS without modifying the profile',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cgl-cookies-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const db=new DatabaseSync(join(dir,'cookies.sqlite'));db.exec('CREATE TABLE moz_cookies(name TEXT,value TEXT,host TEXT,path TEXT,isSecure INTEGER,expiry INTEGER,originAttributes TEXT)');
  const insert=db.prepare('INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?)'),future=Date.now()/1000+3600;
  for(const row of [['domain','yes','.games.test','/',0,future,''],['host','yes','games.test','/',0,future,''],['path','yes','.games.test','/game',0,future,''],['secure','yes','.games.test','/',1,future,''],['expired','no','.games.test','/',0,1,''],['partition','no','.games.test','/',0,future,'^partitionKey=x'],['other','no','.evil.test','/',0,future,'']])insert.run(...row);
  db.close();
  expect(storedCookies({profileDir:dir,url:'https://games.test/game/one'})).toBe('path=yes; domain=yes; host=yes; secure=yes');
  expect(storedCookies({profileDir:dir,url:'http://sub.games.test/game-other'})).toBe('domain=yes');
  expect(storedCookies({profileDir:dir,url:'https://evilgames.test/game'})).toBe('');
 });
});
