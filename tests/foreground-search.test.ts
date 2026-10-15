import { latestCatalogDownload } from '@shared/download-state';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {StoreSession} from '../src/main/store-session';
import {ForegroundWork} from '../src/main/foreground';
import {StoreSearch} from '../src/main/store-search';
import {Discovery} from '../src/main/discovery';
import {Resolver} from '../src/main/resolver';
import {LocalGameAgent} from '../src/main/game-agent';
import {openDb} from '../src/main/db';
import {SourcesRepo,CatalogRepo,DownloadsRepo,SettingsRepo,ConsentRepo,defaultSettings} from '../src/main/repos';
import {PolicyService} from '../src/main/policy-service';
import {HostRateLimiter} from '../src/main/rate-limit';
import {CLASSIFIER_VERSION} from '../src/main/ai';
import {extractPage,type PageExtract} from '@shared/page-extract';
import {fixtureAgent} from './helpers/fixture-agent';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();vi.useRealTimers();});
const page=(html:string,url='https://games.test/')=>{const dom=new JSDOM(html,{url,runScripts:'outside-only'});const ex=dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;dom.window.close();return ex;};
const game=()=>page('<script type="application/ld+json">'+JSON.stringify({'@type':'VideoGame',name:'Hidden Orbit',image:'/cover.png',operatingSystem:'Linux'})+'</script><main><a href="https://external.test/orbit.zip">Playable package</a></main>','https://games.test/hidden');
const until=async(fn:()=>unknown)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('Condition timed out');};
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'cgl-search-')),db=openDb(join(dir,'db')),session=new StoreSession();
 const settings=new SettingsRepo(db,defaultSettings({games:dir,downloads:dir})),sources=new SourcesRepo(db),catalog=new CatalogRepo(db),downloadsRepo=new DownloadsRepo(db),policy=new PolicyService(settings,new ConsentRepo(db));
 const source=sources.add('https://games.test/');sources.update(source.id,{rateLimitMs:0});
 cleanup.push(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const classification={classifyEntry:vi.fn(async(id:number)=>{catalog.setRating(id,'safe',0,[],CLASSIFIER_VERSION);catalog.setArtwork(id,'cover.png');})};
 return {session,settings,sources,catalog,downloadsRepo,policy,source,classification};
}

describe('foreground task ownership',()=>{
 it('settles a cancelled queued request even while discovery is still draining',async()=>{
  const session=new StoreSession();session.enter();let drain!:()=>void;
  const pending=new Promise<void>(r=>{drain=r;});
  const work=new ForegroundWork(session,{setPaused:async p=>{if(p)await pending;}}),run=vi.fn(async()=>42),controller=new AbortController();
  const request=work.run(20,run,controller.signal);controller.abort();
  await expect(request).rejects.toThrow('stale');expect(run).not.toHaveBeenCalled();drain();session.leave();
 });
 it('rejects queued tasks after a failed drain and can run a later request',async()=>{
  const session=new StoreSession();session.enter();let fail=true;
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
   const work=new ForegroundWork(session,{setPaused:async p=>{if(p&&fail)throw Error('Drain failed');}});
   await expect(work.run(20,async()=>42)).rejects.toThrow('Drain failed');
   fail=false;expect(await work.run(20,async()=>43)).toBe(43);
  } finally {session.leave();log.mockRestore();}
 });
 it('keeps background paused across a fast transfer-to-preparation handoff and resumes long transfers',async()=>{
  vi.useFakeTimers();const session=new StoreSession();session.enter();const background={setPaused:vi.fn(async()=>{})};const work=new ForegroundWork(session,background);
  try {
   await work.run(20,async()=>work.transferHandoff());
   expect(background.setPaused.mock.calls.some((c:any)=>c[0]===false)).toBe(false);
   await vi.advanceTimersByTimeAsync(1000);
   let done!:()=>void;const preparation=work.run(20,()=>new Promise<void>(r=>{done=r;}));
   await vi.advanceTimersByTimeAsync(1000);
   expect(background.setPaused.mock.calls.some((c:any)=>c[0]===false)).toBe(false);
   done();await preparation;expect(background.setPaused).toHaveBeenLastCalledWith(false);
   background.setPaused.mockClear();work.transferHandoff();await vi.advanceTimersByTimeAsync(1500);
   expect(background.setPaused).toHaveBeenLastCalledWith(false);
  } finally {session.leave();vi.useRealTimers();}
 });
 it('clears the handoff delay on leaving Store',()=>{
  vi.useFakeTimers();const session=new StoreSession();session.enter();const background={setPaused:vi.fn(async()=>{})};const work=new ForegroundWork(session,background);
  work.transferHandoff();session.leave();expect(background.setPaused).toHaveBeenLastCalledWith(false);expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
 });
 it('shows the live retry instead of pinning a stale failed download in game details and cards',()=>{
  const items=[{id:1,catalogId:7,state:'failed'},{id:2,catalogId:7,state:'resolving'},{id:3,catalogId:7,state:'cancelled'},{id:4,catalogId:8,state:'active'}] as const;
  expect(latestCatalogDownload(items,7)).toBe(items[1]);expect(latestCatalogDownload(items,99)).toBeNull();
 });
 it('drains active discovery, runs queued downloads before search, and resumes only after focus is released',async()=>{
  const session=new StoreSession();session.enter();const calls:string[]=[];let drain!:()=>void;
  const paused=new Promise<void>(r=>{drain=r;});const background={setPaused:vi.fn(async(p:boolean)=>{calls.push(p?'pause':'resume');if(p)await paused;})};
  const work=new ForegroundWork(session,background);work.hold('search-input',true);
  const search=work.run(10,async()=>{calls.push('search');return 1;});
  const download=work.run(20,async()=>{calls.push('download');return 2;});
  expect(calls).not.toContain('download');drain();expect(await download).toBe(2);expect(await search).toBe(1);
  await until(()=>calls.includes('search'));expect(calls.indexOf('download')).toBeLessThan(calls.indexOf('search'));expect(calls).not.toContain('resume');
  work.hold('search-input',false);expect(calls.at(-1)).toBe('resume');session.leave();
 });
 it('cancels queued stale requests when leaving Store',async()=>{
  const session=new StoreSession();session.enter();let drain!:()=>void;const pending=new Promise<void>(r=>{drain=r;});
  const work=new ForegroundWork(session,{setPaused:async(p)=>{if(p)await pending;}}),run=vi.fn(async()=>42);
  const request=work.run(10,run);const rejection=expect(request).rejects.toThrow('stale');session.leave();drain();await rejection;expect(run).not.toHaveBeenCalled();
 });
 it('a selected download cancels in-flight listing inference before navigating and preserves the crawl cursor',async()=>{
  const s=setup(),calls:string[]=[];let current='https://games.test/';
  const browser={navigate:vi.fn(async(context:string,url:string)=>{calls.push(context+':navigate');current=url;}),extract:vi.fn(async()=>current.endsWith('/hidden')?game():page('<main><a href="/other">Other game</a></main>')),stopLoading:vi.fn(async()=>{}),takeDownloads:vi.fn(async()=>[]),cookieHeader:vi.fn(async()=>({cookie:'',userAgent:'fixture'}))};
  const agent=fixtureAgent();agent.learnListing=vi.fn(async(_ex,token)=>{calls.push('listing');return await new Promise<never>((_,reject)=>token.signal.addEventListener('abort',()=>{calls.push('listing:aborted');reject(Object.assign(Error('Cancelled'),{code:'cancelled'}));},{once:true}));});
  const discovery=new Discovery({...s,ai:{setStatus:vi.fn()},browser,agent,limiter:new HostRateLimiter()} as never),foreground=new ForegroundWork(s.session,discovery);
  const entry=discovery.storeCard(s.source.id,{href:game().url,title:'Hidden Orbit',img:null,text:'',platforms:[],author:null,price:null,tags:[]},game())!;
  s.catalog.setRating(entry.id,'safe',0,[],CLASSIFIER_VERSION);
  const downloads={broadcastList:vi.fn(),handoff:vi.fn((id:number)=>{calls.push('handoff');s.downloadsRepo.update(id,{state:'active'});}),failResolution:vi.fn()};
  const transfer=vi.fn(async()=>({kind:'download',index:0}));
  const resolver=new Resolver({...s,foreground,ai:{setStatus:vi.fn()},browser,downloads,catalog:s.catalog,downloadWorker:{call:async()=>({isFile:true,fileName:'orbit.zip',totalBytes:100})},agent:{...agent,transfer},openDrawer:vi.fn()} as never);
  cleanup.push(async()=>{s.session.leave();await discovery.setPaused(true);});
  s.session.enter();await until(()=>calls.includes('listing'));const record=s.downloadsRepo.create({catalogId:entry.id,title:'Hidden Orbit',sourceHost:'games.test',state:'resolving'});resolver.enqueue(record.id);foreground.hold('search-input',true);
  await until(()=>downloads.handoff.mock.calls.length===1);
  expect(calls.indexOf('listing:aborted')).toBeLessThan(calls.indexOf('interactive:navigate'));expect(transfer).toHaveBeenCalledOnce();
  expect(downloads.failResolution).not.toHaveBeenCalled();expect(s.sources.cursor(s.source.id)?.pending).toContain(s.source.url);expect(s.session.active).toBe(true);
 });
 it('resumes a selected download after a rapid Store leave/re-entry while the old request drains',async()=>{
  const s=setup(),foreground=new ForegroundWork(s.session,{setPaused:async()=>{}});
  const entry=s.catalog.upsertListing(s.source.id,{pageUrl:game().url,title:'Hidden Orbit',titleKey:'hidden orbit'});
  s.catalog.setRating(entry.id,'safe',0,[],CLASSIFIER_VERSION);
  const d=s.downloadsRepo.create({catalogId:entry.id,title:'Hidden Orbit',sourceHost:'games.test',state:'resolving'});
  const downloads={broadcastList:vi.fn(),failResolution:vi.fn((id:number,code:'interrupted',detail:string,state:'needs-resolution')=>s.downloadsRepo.update(id,{state,errorCode:code,errorDetail:detail}))};
  const resolver=new Resolver({...s,foreground,ai:{setStatus:vi.fn()},browser:{},downloads,catalog:s.catalog,downloadWorker:{},agent:fixtureAgent(),openDrawer:vi.fn()} as never);
  let attempts=0;
  const resolve=vi.spyOn(resolver as any,'resolve').mockImplementation(async(...args:unknown[])=>{
   const token=args[1] as {signal:AbortSignal};attempts++;
   if(attempts===1)await new Promise<never>((_,reject)=>token.signal.addEventListener('abort',()=>setTimeout(()=>reject(Object.assign(Error('Cancelled'),{code:'cancelled'})),10),{once:true}));
   else s.downloadsRepo.update(d.id,{state:'active',errorCode:null});
  });
  s.session.enter();await until(()=>resolve.mock.calls.length===1);s.session.leave();s.session.enter();
  await until(()=>s.downloadsRepo.get(d.id)?.state==='active');expect(resolve).toHaveBeenCalledTimes(2);s.session.leave();
 });

});

describe('native browser transfer completion',()=>{
 function nativeSetup(){
  const s=setup();const token=s.session.enter();cleanup.push(()=>s.session.leave());
  const entry=s.catalog.upsertListing(s.source.id,{pageUrl:game().url,title:'Hidden Orbit',titleKey:'hidden orbit'});
  s.catalog.setRating(entry.id,'safe',0,[],CLASSIFIER_VERSION);
  const d=s.downloadsRepo.create({catalogId:entry.id,title:'Hidden Orbit',sourceHost:'games.test',state:'resolving'});
  const browser={navigate:vi.fn(async()=>{}),extract:vi.fn(async()=>game()),takeDownloads:vi.fn(async()=>[] as any[])};
  const downloads={broadcastList:vi.fn(),adoptBrowserDownload:vi.fn((id:number)=>s.downloadsRepo.update(id,{state:'active'}))};
  const agent={...fixtureAgent(),transfer:vi.fn(async()=>({kind:'computer',computer:{action:{action:'terminate',answer:'Transfer requested'}}})),actBrowser:vi.fn(async()=>'done')};
  const resolver=new Resolver({...s,browser,downloads,agent,ai:{setStatus:vi.fn()},downloadWorker:{},openDrawer:vi.fn()} as never);
  return {...s,token,d,browser,downloads,agent,resolver};
 }
 it('resumes an exhausted checkpoint and observes a delayed transfer after the final agent decision',async()=>{
  const s=nativeSetup();s.downloadsRepo.update(s.d.id,{resolution:{pageUrl:game().url,steps:24,history:['previous attempt']}});
  const started=Date.now();s.browser.takeDownloads.mockImplementation(async()=>Date.now()-started>=2200?[{target:'/isolated/orbit.zip',succeeded:false,stopped:false}]:[]);
  await (s.resolver as any).resolve(s.d.id,s.token);
  expect(s.downloads.adoptBrowserDownload).toHaveBeenCalledOnce();
  expect(s.agent.transfer).toHaveBeenCalledOnce();expect(s.downloadsRepo.get(s.d.id)?.state).toBe('active');
 },10000);
 it('does not add a transfer delay to a native wait or scroll action',async()=>{
  const s=nativeSetup();s.agent.transfer.mockResolvedValueOnce({kind:'computer',computer:{action:{action:'wait'}}} as any).mockResolvedValueOnce({kind:'stop',label:'Finished observation'} as any);
  s.agent.actBrowser.mockResolvedValue('continue');
  const started=Date.now();await expect((s.resolver as any).resolve(s.d.id,s.token)).rejects.toThrow('Finished observation');
  expect(Date.now()-started).toBeLessThan(1000);
 });
});

describe('AI Store search',()=>{
 async function searchSetup(){
  const s=setup();s.session.enter();let current='https://games.test/',value='old query';
  const home=()=>page('<form><input type="search" placeholder="Find a world" value="old query"><button>Go</button></form>');
  const results=()=>page('<main><a href="/article">Hidden Orbit review</a><a href="/hidden"><img src="/cover.png">Hidden Orbit</a></main>','https://games.test/results?q=Hidden+Orbit');
  const browser={navigate:vi.fn(async(_context:string,url:string)=>{current=url;}),extract:vi.fn(async()=>current.includes('/results')?results():current.endsWith('/hidden')?game():current.endsWith('/article')?page('<h1>Hidden Orbit review</h1>','https://games.test/article'):home()),snapshot:vi.fn(async()=>({png:'fixture'})),clickElement:vi.fn(async()=>{}),type:vi.fn(async(_context:string,input:{key?:string;text?:string})=>{if(input.key==='SelectAll')value='';if(input.text)value+=input.text;if(input.key==='Enter')current='https://games.test/results?q='+encodeURIComponent(value);}),stopLoading:vi.fn(async()=>{})};
  const chatJson=vi.fn(async(_token,req)=>{
   if(req.user[1].text.includes('Goal: Find the playable game'))return current.includes('/results')?{games:results().links.map(l=>({link:l.i,title:l.text})),action:'done',index:null,reason:'Found matches'}:{games:[],action:'submit',index:home().inputState!.fields[0].id,reason:'Use site search'};
   const valid=current.endsWith('/hidden');return {isGamePage:valid,title:'Hidden Orbit',description:'Space puzzle',platforms:['linux'],categories:['Puzzle'],tags:['space'],downloadControls:valid?[game().controls[0].i]:[],step:{kind:'done',index:null},reason:valid?'Playable package':'Review without a download'};
  });
  const ai={chatJson,setStatus:vi.fn()},agent=new LocalGameAgent(ai as never,browser as never,s.session);
  const discovery=new Discovery({...s,ai,browser,agent,limiter:new HostRateLimiter()} as never),foreground=new ForegroundWork(s.session,discovery);
  foreground.hold('search-input',true);cleanup.push(async()=>{s.session.leave();await discovery.setPaused(true);});
  const service=new StoreSearch({...s,foreground,browser,agent,discovery,ai,limiter:new HostRateLimiter(),showBrowser:vi.fn()} as never);
  return {...s,service,browser,agent,chatJson};
 }
 it('uses a model-selected form, rejects an article, saves a verified game with external download route and opens it',async()=>{
  const s=await searchSetup(),cursor={pending:['https://games.test/next'],visited:[s.source.url],pagesDone:1,startedAt:new Date().toISOString()};s.sources.saveCursor(s.source.id,cursor);
  const result=await s.service.search('Hidden Orbit');expect(result.id).not.toBeNull();expect(s.catalog.get(result.id!,s.policy.policy())?.title).toBe('Hidden Orbit');
  expect(s.catalog.query(s.policy.policy(),{}).total).toBe(1);expect(s.catalog.raw(result.id!)?.candidates[0].url).toBe('https://external.test/orbit.zip');
  expect(s.browser.type.mock.calls.map(c=>c[1])).toEqual([{key:'SelectAll'},{text:'Hidden Orbit'},{key:'Enter'}]);expect(s.sources.cursor(s.source.id)).toEqual(cursor);
  // One model decision (use the site search); the exact-title result and its
  // page structure need no further model calls.
  expect(s.chatJson).toHaveBeenCalledTimes(1);
  s.browser.navigate.mockClear();expect((await s.service.search('Hidden Orbit')).id).toBe(result.id);expect(s.browser.navigate).not.toHaveBeenCalled();
 });
 it('discards cancelled search decisions before any browser action or catalog writes',async()=>{
  const s=await searchSetup();let finish!:(x:any)=>void;s.chatJson.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
  const pending=s.service.search('Hidden Orbit');await until(()=>!!finish);s.service.cancel();finish({games:[],action:'submit',index:80,reason:'late'});
  expect((await pending).cancelled).toBe(true);expect(s.browser.type).not.toHaveBeenCalled();expect(s.catalog.count(s.source.id)).toBe(0);
 });
 it('does not search disabled websites',async()=>{const s=await searchSetup();s.sources.update(s.source.id,{enabled:false});const result=await s.service.search('Hidden Orbit');expect(result.id).toBeNull();expect(s.browser.navigate).not.toHaveBeenCalled();});
 it('rejects a model-selected unrelated game rather than opening it for the requested title',async()=>{
  const s=await searchSetup();let attempts=0;
  const original=s.agent.search.bind(s.agent);
  s.agent.search=vi.fn(async(ex,token,query,history)=>{
   attempts++;
   if(attempts===1)return {cards:[{href:game().url,title:'Hidden Orbit',img:null,text:'',platforms:[],author:null,price:null,tags:[]}],action:'done' as const,index:null};
   expect(history.join(' ')).toContain('Rejected result');
   return {cards:[],action:'done' as const,index:null};
  });
  const result=await s.service.search('A Different Game');expect(result.id).toBeNull();expect(attempts).toBe(2);s.agent.search=original;
 });
 it('retains ownership of a search verification page until cancellation or retry',async()=>{
  const s=await searchSetup();s.browser.extract.mockImplementation(async()=>{const ex=page('<h1>Please sign in</h1>');ex.gates.login=true;return ex;});
  const result=await s.service.search('Hidden Orbit');expect(result.message).toContain('verification');expect(s.agent.search).toBeTypeOf('function');expect(s.chatJson).not.toHaveBeenCalled();
  // Releasing input focus does not resume discovery over the verification page.
  const navigate=s.browser.navigate.mock.calls.length;
  // Search's verification hold remains; cancelling releases it explicitly.
  await new Promise(r=>setTimeout(r,10));expect(s.browser.navigate).toHaveBeenCalledTimes(navigate);
 });
 it('does not treat punctuation-only search as a match for every saved title',async()=>{
  const s=await searchSetup();expect((await s.service.search('!!!')).id).toBeNull();expect(s.chatJson).not.toHaveBeenCalled();
 });

});
