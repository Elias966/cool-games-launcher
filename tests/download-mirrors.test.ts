import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { downloadEvidence } from '../src/shared/download-evidence';
import { extractPage, type PageExtract } from '../src/shared/page-extract';
vi.mock('electron', () => ({ app: { isPackaged:false,getAppPath:()=>process.cwd() },shell:{} }));
import { openDb } from '../src/main/db';
import { CatalogRepo, DownloadsRepo, SourcesRepo, toDownloadItem } from '../src/main/repos';
import { StoreSession } from '../src/main/store-session';
import { Resolver } from '../src/main/resolver';
import { sameMirrorFile, mirrorRoutes, mirrorsForPart, type MeasuredMirror } from '../src/main/download-mirrors';
import type { DownloadCandidate } from '../src/shared/types';
const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
const sourceUrl='https://games.test/orbit';
function page(html:string,url=sourceUrl){const dom=new JSDOM(html,{url,runScripts:'outside-only'});cleanup.push(()=>dom.window.close());return dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;}
function candidate(host:string,name='orbit.zip'):DownloadCandidate{return {url:`https://${host}/${name}`,label:host,fileName:name,platform:'windows',sizeText:null};}
const sample=(speed:number,name='orbit.zip',hash='same')=>({fileName:name,totalBytes:1000000,speedBps:speed,sampledBytes:100000,elapsedMs:100,prefixHash:hash,prefixBytes:16384,resumable:true,measuredAt:Date.now()});
function setup(routes=[candidate('slow.test'),candidate('fast.test')]){
 const dir=mkdtempSync(join(tmpdir(),'cgl-mirrors-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const db=openDb(join(dir,'db'));cleanup.push(()=>db.close());const sources=new SourcesRepo(db),catalog=new CatalogRepo(db),downloadsRepo=new DownloadsRepo(db);
 const source=sources.add('https://games.test/');const entry=catalog.upsertListing(source.id,{pageUrl:sourceUrl,title:'Orbit',titleKey:'orbit'});
 catalog.setRating(entry.id,'safe',0,[],'fixture');catalog.setDetail(entry.id,{candidates:routes});
 const d=downloadsRepo.create({catalogId:entry.id,title:'Orbit',sourceHost:'games.test',state:'resolving'});
 let current=sourceUrl;
 const sourcePage=page(routes.map(c=>`<a href="${c.url}">Download ${c.label}</a>`).join(''));
 const browser={snapshot:vi.fn(async()=>({url:current})),navigate:vi.fn(async(_context:string,url:string)=>{current=url;}),extract:vi.fn(async()=>current===sourceUrl?sourcePage:page('<a href="https://cdn.test/orbit.zip">Download orbit.zip</a>',current)),takeDownloads:vi.fn(async(_cancel:boolean,_target?:string)=>[] as any[]),cookieHeader:vi.fn(async()=>({cookie:'session-cookie',userAgent:'fixture'}))};
 (browser as any).followLink=vi.fn(async(ctx:string,_source:string,url:string)=>{const before=await browser.extract();await browser.navigate(ctx,url);return {followed:true,url,scrollY:before.viewport.scrollY};});
 (browser as any).returnToPage=vi.fn(async(context:string,url:string,scrollY:number,signal?:AbortSignal)=>{if(current!==url)await browser.navigate(context,url);return {url,scrollY,reused:true};});
 const downloadWorker={call:vi.fn(async(method:string,args:any,_signal?:AbortSignal):Promise<any>=>method==='benchmarkMirror'?sample(args.url.includes('fast')?2000:200):method==='browserFilePrefix'?{hash:'same',bytes:16384}:{isFile:true,fileName:'orbit.zip',totalBytes:1000000})};
 const downloads={setPrompt:vi.fn((id:number,prompt:any,state:any)=>downloadsRepo.update(id,{userPrompt:prompt,state})),broadcastList:vi.fn(),handoff:vi.fn((id:number,url:string,_headers:Record<string,string>,fileName:string,totalBytes:number)=>downloadsRepo.update(id,{state:'active',resolution:null,errorDetail:null,fileName,totalBytes,url})),adoptBrowserDownload:vi.fn((id:number,_download:unknown)=>downloadsRepo.update(id,{state:'active'})),failResolution:vi.fn((id:number,_code:string,detail:string)=>downloadsRepo.update(id,{state:'failed',errorDetail:detail}))};
 const agent={verify:vi.fn(async(ex:PageExtract)=>ex),transfer:vi.fn(async(_ex:PageExtract,_token:unknown,_title:string)=>({kind:'download',index:0}))};
 const session=new StoreSession(),token=session.enter();cleanup.push(()=>session.leave());
 const deps={browserSampleMs:5,session,browser,downloadWorker,downloads,downloadsRepo,catalog,agent,ai:{setStatus:vi.fn()},policy:{policy:()=>({showNsfw:false,revision:1})},openDrawer:vi.fn()};
 const resolver=new Resolver(deps as never);
 const resolve=(service=resolver,t=token)=>(service as unknown as {resolve:(id:number,token:typeof t)=>Promise<void>}).resolve(d.id,t);
 return {dir,db,session,token,deps,resolver,resolve,d,downloadsRepo,catalog,browser,downloadWorker,downloads,agent,current:()=>current};
}
describe('fastest working mirror selection',()=>{
 it('samples every observed mirror and selects the fastest equivalent file, not a faster different part',async()=>{
  const t=setup([candidate('slow.test'),candidate('fast.test'),candidate('broken.test'),candidate('wrong-part.test','orbit.part2.rar')]);
  t.downloadWorker.call.mockImplementation(async(method,args)=>{if(method==='probe')return {isFile:true,fileName:'orbit.zip',totalBytes:1000000} as any;if(args.url.includes('broken'))throw Error('HTTP 503');if(args.url.includes('wrong-part'))return sample(50000,'orbit.part2.rar','different');return sample(args.url.includes('fast')?2000:200);});
  await t.resolve();expect(t.downloads.handoff).toHaveBeenCalledOnce();expect(t.downloads.handoff.mock.calls[0][1]).toBe('https://fast.test/orbit.zip');
  expect(t.downloadWorker.call.mock.calls.filter(c=>c[0]==='benchmarkMirror')).toHaveLength(4);
  expect(toDownloadItem(t.downloadsRepo.get(t.d.id)!)).toMatchObject({mirrorChoice:{host:'fast.test',speedBps:2000,tested:4,measured:2,unavailable:2},state:'active'});
 });
 it('benchmarks all four working hosts and can choose the last host', async () => {
  const t=setup(['one.test','two.test','three.test','four.test'].map(h=>candidate(h)));
  t.downloadWorker.call.mockImplementation(async(method,args)=>method==='probe'?{isFile:true,fileName:'orbit.zip',totalBytes:1000000}:sample(args.url.includes('four.test')?9000:100));
  await t.resolve();expect(t.downloadWorker.call.mock.calls.filter(c=>c[0]==='benchmarkMirror')).toHaveLength(4);
  expect(t.downloadsRepo.get(t.d.id)?.url).toBe('https://four.test/orbit.zip');
 });
 it('uses the next fastest measured mirror if the winning link expires',async()=>{
  const t=setup();const original=t.downloadWorker.call.getMockImplementation()!;
  t.downloadWorker.call.mockImplementation(async(method,args)=>method==='probe'&&args.url.includes('fast')?{isFile:false} as any:original(method,args));
  await t.resolve();expect(t.downloads.handoff.mock.calls[0][1]).toBe('https://slow.test/orbit.zip');
 });
 it('persists completed measurements when navigation is interrupted and continues with remaining routes',async()=>{
  const t=setup();let first=true;
  t.downloadWorker.call.mockImplementation(async(method,args)=>{if(method==='probe')return {isFile:true,fileName:'orbit.zip',totalBytes:1000000} as any;if(args.url.includes('fast')&&first){first=false;t.session.leave();throw Object.assign(Error('Cancelled'),{name:'AbortError'});}return sample(args.url.includes('fast')?2000:200);});
  await expect(t.resolve()).rejects.toThrow(/stale/);
  expect(t.downloadsRepo.get(t.d.id)?.resolution?.mirrors?.samples).toHaveLength(1);
  const session=new StoreSession(),token=session.enter();cleanup.push(()=>session.leave());const resumed=new Resolver({...t.deps,session} as never);
  await t.resolve(resumed,token);expect(t.downloads.handoff.mock.calls[0][1]).toBe('https://fast.test/orbit.zip');
  expect(t.downloadWorker.call.mock.calls.filter(c=>c[0]==='benchmarkMirror'&&c[1].url.includes('slow'))).toHaveLength(1);
 });
 it('navigates and uses the AI on unfamiliar host pages before benchmarking their observed file',async()=>{
  const t=setup([{...candidate('host-a.test','gateway'),fileName:null},{...candidate('host-b.test','gateway'),fileName:null}]);
  await t.resolve();expect(t.agent.transfer).toHaveBeenCalledTimes(2);
  expect(t.browser.navigate.mock.calls.map(c=>c[1])).toContain('https://host-a.test/gateway');
  expect(t.downloadWorker.call.mock.calls.filter(c=>c[0]==='benchmarkMirror')).toHaveLength(2);
 });
 it('retains a one-shot fallback while testing every other host before adoption',async()=>{
  const t=setup([{...candidate('browser.test','gateway'),fileName:null},candidate('fast.test')]);let started=false;
  const original={target:'/isolated/orbit.zip',url:'blob:https://browser.test/token',currentBytes:10,totalBytes:1000000,stopped:false,succeeded:false};
  t.browser.takeDownloads.mockImplementation(async()=>{if(t.current().includes('browser.test'))started=true;return started?[original]:[];});
  const call=t.downloadWorker.call.getMockImplementation()!;
  t.downloadWorker.call.mockImplementation(async(method,args,signal)=>{if(method==='browserFilePrefix')return null;if(method==='benchmarkMirror')throw Error('Other host unavailable');return call(method,args,signal);});
  await t.resolve();expect(t.downloads.adoptBrowserDownload).toHaveBeenCalledWith(t.d.id,original);
  expect(t.downloadWorker.call).toHaveBeenCalledWith('benchmarkMirror',expect.objectContaining({url:'https://fast.test/orbit.zip'}),expect.any(AbortSignal));
  expect(t.browser.takeDownloads.mock.calls.some(c=>c[0]===true)).toBe(false);expect(t.downloads.handoff).not.toHaveBeenCalled();
 });
 it('only cancels its own browser sample after a real range GET matches original file bytes',async()=>{
  const t=setup([{...candidate('browser.test','gateway'),fileName:null},candidate('fast.test')]);let removed=false;
  const original={target:'/isolated/orbit.zip',url:'https://slow.test/orbit.zip',currentBytes:20000,totalBytes:1000000,stopped:false,succeeded:false};
  const unrelated={target:'/another-game.zip',url:'blob:https://other.test/id',stopped:false,succeeded:false};
  t.browser.takeDownloads.mockImplementation(async(cancel,target)=>{if(cancel&&target===original.target)removed=true;return [unrelated,...(!removed&&t.current().includes('browser.test')?[original]:[])];});
  await t.resolve();expect(t.browser.takeDownloads).toHaveBeenCalledWith(true,original.target);
  expect(t.browser.takeDownloads.mock.calls.some(c=>c[0]===true&&c[1]!==original.target)).toBe(false);
  expect(t.downloads.handoff.mock.calls[0][1]).toBe('https://fast.test/orbit.zip');
 });
 it('rejects a size/name change after measurement and does not hand off a different build',async()=>{
  const t=setup();t.downloadWorker.call.mockImplementation(async(method,args)=>method==='probe'?{isFile:true,fileName:'orbit-v2.zip',totalBytes:2000000} as any:sample(args.url.includes('fast')?2000:200));
  await expect(t.resolve()).rejects.toThrow(/None of the tested/);expect(t.downloads.handoff).not.toHaveBeenCalled();
 });
});
describe('equivalent mirror grouping',()=>{
 it('keeps platform, part, prefix, size and filename differences out of a mirror group',()=>{
  const a:MeasuredMirror={...sample(100),route:'a',url:'a',referer:sourceUrl,nameHint:'orbit.zip',platform:'windows'};
  for(const change of [{platform:'linux'},{fileName:'orbit.part2.rar'},{prefixHash:'other'},{totalBytes:1000001}])expect(sameMirrorFile(a,{...a,...change} as MeasuredMirror)).toBe(false);
  expect(sameMirrorFile(a,{...a,fileName:'Orbit (2).zip'})).toBe(true);
  expect(mirrorRoutes([candidate('a'),candidate('a'),{...candidate('mac'),platform:'macos'}])).toHaveLength(1);
 });
});

describe('multipart mirror selection',()=>{
 it.each([['orbit.part1.rar','orbit.part2.rar'],['orbit.7z.001','orbit.7z.002'],['orbit.rar','orbit.r00'],['Orbit-Part1.zip','Orbit-Part2.zip']])('queues every required %s / %s part and independently chooses its fastest host',async(firstName,secondName)=>{
  const routes=[candidate('slow.test',firstName),candidate('fast.test',firstName),candidate('slow.test',secondName),candidate('fast.test',secondName)];
  const t=setup(routes);
  const extract=t.browser.extract.getMockImplementation()!;t.browser.extract.mockImplementation(async()=>{const ex=await extract();if(ex.url===sourceUrl)ex.viewport.scrollY=1840;return ex;});
  t.downloadWorker.call.mockImplementation(async(method,args)=>{
   const part=args.url.split('/').pop();
   if(method==='probe')return {isFile:true,fileName:part,totalBytes:1000000} as any;
   const speed=args.url.includes('fast')?(part===firstName?2000:100):500;
   return sample(speed,part,part);
  });
  t.resolver.enqueue(t.d.id);
  await vi.waitFor(()=>expect(t.downloads.handoff).toHaveBeenCalledTimes(2));
  const records=t.downloadsRepo.group(t.d.id);
  expect(records.map(d=>d.partIndex).sort()).toEqual([1,2]);
  expect(records.every(d=>d.partTotal===2&&d.state==='active')).toBe(true);
  expect(records.find(d=>d.partIndex===1)?.url).toBe(`https://fast.test/${firstName}`);
  expect(records.find(d=>d.partIndex===2)?.url).toBe(`https://slow.test/${secondName}`);
  expect(records.find(d=>d.partIndex===2)?.resolution?.partName).toBe(secondName);
  expect(records.find(d=>d.partIndex===2)?.resolution?.linkPage).toEqual({url:sourceUrl,scrollY:1840});
  expect((t.browser as any).returnToPage).toHaveBeenCalledWith('interactive',sourceUrl,1840,expect.any(AbortSignal));
  expect(t.downloadWorker.call.mock.calls.filter(c=>c[0]==='benchmarkMirror')).toHaveLength(4);
 });
 it('recognises split 7z, old RAR and labelled parts without treating siblings as mirrors',()=>{
  for(const names of [['orbit.7z.001','orbit.7z.002'],['orbit.rar','orbit.r00'],['Orbit-Part1.zip','Orbit-Part2.zip']]){
   const routes=names.flatMap(name=>[candidate('slow.test',name),candidate('fast.test',name)]);
   expect(mirrorsForPart(routes,names[0],1).map(c=>c.fileName)).toEqual([names[0],names[0]]);
   expect(mirrorsForPart(routes,names[1],2).map(c=>c.fileName)).toEqual([names[1],names[1]]);
  }
 });
});

it('retries a finished failed comparison instead of permanently skipping every host', async () => {
 const t=setup();const original=t.downloadWorker.call.getMockImplementation()!;
 t.downloadWorker.call.mockImplementation(async()=>{throw Error('offline');});
 await expect(t.resolve()).rejects.toThrow(/None of the tested/);expect(t.downloadsRepo.get(t.d.id)?.resolution?.mirrors?.finished).toBe(true);
 t.downloadWorker.call.mockImplementation(original);t.downloadsRepo.update(t.d.id,{state:'needs-resolution',errorCode:'interrupted'});
 await t.resolve();expect(t.downloads.handoff).toHaveBeenCalledOnce();
});

it('lets the AI follow HTML interstitials at file-looking URLs', async () => {
 const t=setup();const original=t.downloadWorker.call.getMockImplementation()!;
 t.downloadWorker.call.mockImplementation(async(method,args)=>{
  if(method==='benchmarkMirror'&&args.url==='https://slow.test/orbit.zip')throw Object.assign(Error('HTML landing page'),{code:'not-a-file'});
  return original(method,args);
 });
 await t.resolve();expect(t.browser.navigate.mock.calls.map(c=>c[1])).toContain('https://slow.test/orbit.zip');expect(t.agent.transfer).toHaveBeenCalledOnce();
 expect(t.downloads.handoff.mock.calls[0][1]).toBe('https://fast.test/orbit.zip');
});

it('leaves an interrupted mirror comparison in a recoverable state on full shutdown', async () => {
 const t=setup();let started=false;
 t.downloadWorker.call.mockImplementation(async(_method,_args,signal?:AbortSignal)=>{
  started=true;return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{name:'AbortError'})),{once:true})) as any;
 });
 t.resolver.enqueue(t.d.id);await vi.waitFor(()=>expect(started).toBe(true));
 t.resolver.shutdown();await Promise.resolve();await Promise.resolve();
 expect(['resolving','needs-resolution']).toContain(t.downloadsRepo.get(t.d.id)?.state);
 expect(t.downloadsRepo.get(t.d.id)?.resolution?.mirrors).toBeDefined();
 expect(t.downloads.handoff).not.toHaveBeenCalled();
});

describe('dead host recovery',()=>{
 const landing=(host:string,path='file/token')=>({...candidate(host,path),fileName:null});
 it.each(['File not found','The file you requested has been deleted','This file is no longer available'])('returns to the game page and skips a %s host before asking the AI to browse it',async(notice)=>{
  const dead=landing('dead.test'),live=landing('live.test');const t=setup([dead,live]);
  const extract=t.browser.extract.getMockImplementation()!;
  t.browser.extract.mockImplementation(async()=>t.current().includes('dead.test')?page(`<main><h1>${notice}</h1><a href="/pricing">Premium downloads</a></main>`,t.current()):extract());
  await t.resolve();
  expect(t.downloads.handoff).toHaveBeenCalledOnce();expect(t.agent.transfer).toHaveBeenCalledOnce();
  const nav=t.browser.navigate.mock.calls.map(c=>c[1]);
  expect(nav.slice(nav.indexOf(dead.url),nav.indexOf(live.url)+1)).toEqual([dead.url,sourceUrl,live.url]);
  expect(t.downloadsRepo.get(t.d.id)?.resolution?.mirrors?.failures).toContainEqual(expect.objectContaining({route:dead.url,reason:expect.stringMatching(/unavailable/)}));
 });
 it('skips a missing link that silently redirects to the host homepage',async()=>{
  const dead=landing('dead.test'),live=landing('live.test');const t=setup([dead,live]);
  const navigate=t.browser.navigate.getMockImplementation()!,extract=t.browser.extract.getMockImplementation()!;
  t.browser.navigate.mockImplementation(async(ctx,url)=>navigate(ctx,url===dead.url?'https://dead.test/':url));
  t.browser.extract.mockImplementation(async()=>t.current()==='https://dead.test/'?page('<h1>Share files online</h1><a href="/upload">Upload your files</a>',t.current()):extract());
  await t.resolve();expect(t.agent.transfer).toHaveBeenCalledOnce();
  expect(t.downloadsRepo.get(t.d.id)?.resolution?.mirrors?.failures[0].reason).toMatch(/homepage/);
 });
 it('stops an uninformative host after four fruitless browsing actions and tries the next route',async()=>{
  const t=setup([landing('dead.test'),landing('live.test')]);const extract=t.browser.extract.getMockImplementation()!;
  t.browser.extract.mockImplementation(async()=>t.current().includes('dead.test')?page('<h1>Welcome</h1><p>Share your files here.</p>',t.current()):extract());
  (t.browser as any).scroll=vi.fn(async()=>{});
  t.agent.transfer.mockImplementation(async()=>({kind:t.current().includes('dead.test')?'scroll':'download',index:0}));
  await t.resolve();expect((t.browser as any).scroll).toHaveBeenCalledTimes(4);expect(t.downloads.handoff).toHaveBeenCalledOnce();
 });
 it('returns from a single dead host and reports that no other route exists',async()=>{
  const dead=landing('dead.test');const t=setup([dead]);const extract=t.browser.extract.getMockImplementation()!;
  t.browser.extract.mockImplementation(async()=>t.current().includes('dead.test')?page('<h1>File not found</h1>',t.current()):extract());
  (t.browser as any).clickElement=vi.fn(async()=>t.browser.navigate('interactive',dead.url));
  t.agent.transfer.mockResolvedValue({kind:'click',index:0});
  await expect(t.resolve()).rejects.toThrow(/No other download link/);
  expect(t.current()).toBe(sourceUrl);expect(t.agent.transfer).toHaveBeenCalledOnce();expect(t.downloads.handoff).not.toHaveBeenCalled();
 });
 it('recovers an old checkpoint on a dead host and chooses an alternative without retrying the dead link',async()=>{
  const dead=landing('dead.test'),live=landing('live.test');const t=setup([dead,live]);const extract=t.browser.extract.getMockImplementation()!;
  t.downloadsRepo.update(t.d.id,{resolution:{pageUrl:dead.url,routeUrl:dead.url,steps:3,history:['previous host click']},state:'needs-resolution',errorCode:'interrupted'});
  t.browser.extract.mockImplementation(async()=>t.current().includes('dead.test')?page('<h1>This file has expired</h1>',t.current()):extract());
  await t.resolve();expect(t.downloads.handoff).toHaveBeenCalledOnce();
  expect(t.downloadsRepo.get(t.d.id)?.resolution?.mirrors?.tested).toContain(dead.url);
  expect(t.browser.navigate.mock.calls.filter(c=>c[1]===dead.url)).toHaveLength(1);
 });
 it('does not blacklist a host that still serves another multipart volume',async()=>{
  const routes=['orbit.part1.rar','orbit.part2.rar'].flatMap((name,i)=>[
   {...candidate('uploadhaven.com',`download/part${i+1}`),fileName:name},
   candidate('backup.test',name),
  ]);
  const t=setup(routes);const extract=t.browser.extract.getMockImplementation()!;
  t.browser.extract.mockImplementation(async()=>t.current().includes('uploadhaven.com')
   ?page(t.current().endsWith('part1')?'<h1>File has been deleted</h1>':'<a href="https://cdn.test/orbit.part2.rar">Download orbit.part2.rar</a>',t.current())
   :extract());
  t.downloadWorker.call.mockImplementation(async(method,args)=>{
   const name=args.url.includes('part2')?'orbit.part2.rar':'orbit.part1.rar';
   return method==='probe'?{isFile:true,fileName:name,totalBytes:1000000} as any:sample(args.url.includes('cdn.test')?2000:100,name,name);
  });
  t.resolver.enqueue(t.d.id);await vi.waitFor(()=>expect(t.downloads.handoff).toHaveBeenCalledTimes(2));
  const records=t.downloadsRepo.group(t.d.id);
  expect(records.every(r=>r.state==='active'&&r.partTotal===2)).toBe(true);
  expect(records.find(r=>r.partIndex===1)?.url).toBe('https://backup.test/orbit.part1.rar');
  expect(records.find(r=>r.partIndex===2)?.url).toBe('https://cdn.test/orbit.part2.rar');
 });
});

it('keeps a rejected dead route skipped when a later mirror is interrupted and resumed',async()=>{
 const dead={...candidate('dead.test','file/token'),fileName:null};const live=candidate('live.test');const t=setup([dead,live]);
 (t.agent as any).mirrorVariant=vi.fn(async(_token:unknown,_title:string,routes:DownloadCandidate[])=>routes.findIndex(r=>r.url===dead.url));
 const extract=t.browser.extract.getMockImplementation()!,call=t.downloadWorker.call.getMockImplementation()!;
 t.browser.extract.mockImplementation(async()=>t.current().includes('dead.test')?page('<h1>File not found</h1>',t.current()):extract());
 let interrupted=false;
 t.downloadWorker.call.mockImplementation(async(method,args)=>{
  if(method==='benchmarkMirror'&&args.url===live.url&&!interrupted){interrupted=true;t.session.leave();throw Object.assign(Error('Cancelled'),{name:'AbortError'});}
  return call(method,args);
 });
 await expect(t.resolve()).rejects.toThrow(/stale/);
 expect(t.downloadsRepo.get(t.d.id)?.resolution?.mirrors?.tested).toContain(dead.url);
 const session=new StoreSession(),token=session.enter();cleanup.push(()=>session.leave());
 const resumed=new Resolver({...t.deps,session} as never);await t.resolve(resumed,token);
 expect(t.downloads.handoff).toHaveBeenCalledOnce();expect(t.browser.navigate.mock.calls.filter(c=>c[1]===dead.url)).toHaveLength(1);
});

describe('return to the saved download-links viewport',()=>{
 it('returns to the actual game page at the links, rather than the older catalog URL or page top',async()=>{
  const dead={...candidate('dead.test','file/token'),fileName:null},live={...candidate('live.test','file/token'),fileName:null};
  const t=setup([dead,live]);const linksUrl='https://games.test/orbit/downloads#mirrors';
  const links=page(`<main><a href="${dead.url}">Download dead</a><a href="${live.url}">Download live</a></main>`,linksUrl);
  links.viewport.scrollY=2870;
  t.browser.extract.mockImplementation(async()=>t.current()===sourceUrl||t.current()===linksUrl?links:t.current().includes('dead.test')?page('<h1>File not found</h1>',t.current()):page('<a href="https://cdn.test/orbit.zip">Download orbit.zip</a>',t.current()));
  await t.resolve();
  expect((t.browser as any).returnToPage).toHaveBeenCalledWith('interactive',linksUrl,2870,t.token.signal);
  const nav=t.browser.navigate.mock.calls.map(c=>c[1]),failed=nav.indexOf(dead.url);
  expect(nav.slice(failed,nav.indexOf(live.url)+1)).toEqual([dead.url,linksUrl,live.url]);
  expect(t.downloadsRepo.get(t.d.id)?.resolution?.linkPage).toEqual({url:linksUrl,scrollY:2870});
  expect(t.downloadsRepo.get(t.d.id)?.resolution?.mirrors?.sourceScrollY).toBe(2870);
 });
 it('restores the persisted source viewport when a comparison resumes',async()=>{
  const dead={...candidate('dead.test','file/token'),fileName:null},live=candidate('live.test');const t=setup([dead,live]);
  const linksUrl='https://games.test/orbit/downloads#mirrors';const links=page(`<a href="${live.url}">Download live</a>`,linksUrl);links.viewport.scrollY=3210;
  t.downloadsRepo.update(t.d.id,{state:'needs-resolution',errorCode:'interrupted',resolution:{pageUrl:dead.url,steps:2,history:[],mirrors:{sourceUrl:linksUrl,sourceScrollY:3210,routes:[dead,live],tested:[dead.url],samples:[],failures:[{route:dead.url,reason:'File missing'}]}}});
  const extract=t.browser.extract.getMockImplementation()!;t.browser.extract.mockImplementation(async()=>t.current()===linksUrl?links:extract());
  await t.resolve();expect((t.browser as any).returnToPage).toHaveBeenCalledWith('interactive',linksUrl,3210,t.token.signal);
  expect(t.browser.navigate.mock.calls.some(c=>c[1]===sourceUrl||c[1]===dead.url)).toBe(false);
  expect(t.downloads.handoff).toHaveBeenCalledOnce();
 });
 it('restores script buttons at their saved position without reloading the game page twice',async()=>{
  const t=setup([]);const links=page('<main><button>Download first mirror</button><button>Download second mirror</button></main>');links.viewport.scrollY=1960;
  const original=t.browser.extract.getMockImplementation()!;
  t.browser.extract.mockImplementation(async()=>t.current()===sourceUrl?links:t.current().includes('dead.test')?page('<h1>File not found</h1>',t.current()):original());
  t.agent.transfer.mockImplementation(async(ex:PageExtract,_token:unknown,title:string)=>({kind:ex.url===sourceUrl?'click':'download',index:ex.url===sourceUrl&&title.includes('#cgl-control-1')?1:0}) as any);
  (t.browser as any).clickElement=vi.fn(async(_ctx:string,index:number)=>t.browser.navigate('interactive',index===0?'https://dead.test/file/token':'https://live.test/file/token'));
  await t.resolve();
  expect((t.browser as any).returnToPage.mock.calls.every((c:any[])=>c[1]===sourceUrl&&c[2]===1960)).toBe(true);
  expect(t.browser.navigate.mock.calls.filter(c=>c[1]===sourceUrl)).toHaveLength(2); // Initial visit and one recovery; the next trial reuses it.
  expect(t.downloads.handoff).toHaveBeenCalledOnce();
 });
});

it('remembers the source viewport for an unfamiliar script control too',async()=>{
 const t=setup([]),links=page('<main><button>Proceed</button></main>','https://games.test/orbit/builds');links.viewport.scrollY=2340;
 t.browser.extract.mockImplementation(async()=>t.current().includes('dead.test')?page('<h1>File not found</h1>',t.current()):links);
 (t.browser as any).clickElement=vi.fn(async()=>t.browser.navigate('interactive','https://dead.test/file/token'));
 t.agent.transfer.mockResolvedValue({kind:'click',index:0});
 await expect(t.resolve()).rejects.toThrow(/No other download link/);
 expect((t.browser as any).returnToPage).toHaveBeenCalledWith('interactive',links.url,2340,t.token.signal);
});

describe('use indexed game URLs before searching',()=>{
 it('opens an indexed game directly without requesting search recovery',async()=>{
  const t=setup();const recoverGamePage=vi.fn(async()=>null);const service=new Resolver({...t.deps,recoverGamePage} as never);
  await t.resolve(service);expect(t.browser.navigate.mock.calls[0][1]).toBe(sourceUrl);expect(recoverGamePage).not.toHaveBeenCalled();
  expect(t.catalog.raw(t.d.catalogId!)?.pageUrl).toBe(sourceUrl);
 });
 it('discards an old homepage bookmark and uses the catalog game URL on resume',async()=>{
  const t=setup();t.downloadsRepo.update(t.d.id,{state:'needs-resolution',errorCode:'interrupted',resolution:{pageUrl:'https://games.test/',routeUrl:'https://dead.test/token',linkPage:{url:'https://games.test/',scrollY:0},steps:3,history:[],mirrors:{sourceUrl:sourceUrl,sourceScrollY:2420,routes:[candidate('slow.test'),candidate('fast.test')],tested:[],samples:[],failures:[]}}});
  await t.resolve();expect((t.browser as any).returnToPage).toHaveBeenCalledWith('interactive',sourceUrl,2420,t.token.signal);
  expect(t.browser.navigate.mock.calls.some(c=>c[1]==='https://games.test/')).toBe(false);
 });
 it('does not replace the saved game bookmark when a host redirects to the site homepage',async()=>{
  const t=setup([{...candidate('dead.test','file/token'),fileName:null},{...candidate('live.test','file/token'),fileName:null}]);
  const navigate=t.browser.navigate.getMockImplementation()!,extract=t.browser.extract.getMockImplementation()!;
  t.browser.navigate.mockImplementation(async(ctx,url)=>navigate(ctx,url.includes('dead.test')?'https://games.test/':url));
  t.browser.extract.mockImplementation(async()=>t.current()==='https://games.test/'?page('<h1>Game site</h1><input type="search" placeholder="Search games">','https://games.test/'):extract());
  await t.resolve();expect(t.agent.transfer).toHaveBeenCalledOnce();expect(t.downloadsRepo.get(t.d.id)?.resolution?.linkPage?.url).toBe(sourceUrl);
 });
 it('tries cached host URLs before searching when the saved game page disappears',async()=>{
  const t=setup(),extract=t.browser.extract.getMockImplementation()!,recoverGamePage=vi.fn(async()=>null);
  t.browser.extract.mockImplementation(async()=>t.current()===sourceUrl?page('<h1>404 - Page not found</h1>'):extract());
  await t.resolve(new Resolver({...t.deps,recoverGamePage} as never));expect(t.downloads.handoff).toHaveBeenCalledOnce();expect(recoverGamePage).not.toHaveBeenCalled();
 });
 it('searches only after a missing page and every cached host fail, then saves the verified replacement URL',async()=>{
  const t=setup(),extract=t.browser.extract.getMockImplementation()!,call=t.downloadWorker.call.getMockImplementation()!;
  t.browser.extract.mockImplementation(async()=>t.current()===sourceUrl?page('<h1>404 - Page not found</h1>'):extract());
  t.downloadWorker.call.mockImplementation(async(method,args)=>{if(method==='benchmarkMirror'&&!args.url.includes('cdn.test'))throw Error('HTTP 404');return call(method,args);});
  const replacement='https://games.test/orbit-new',fresh={...candidate('cdn.test'),fileName:'orbit.zip'};
  const recoverGamePage=vi.fn(async()=>{
   expect(t.downloadWorker.call.mock.calls.filter(c=>c[0]==='benchmarkMirror')).toHaveLength(2);
   return {url:replacement,scrollY:1940,candidates:[fresh]};
  });
  await t.resolve(new Resolver({...t.deps,recoverGamePage} as never));
  expect(recoverGamePage).toHaveBeenCalledOnce();expect(t.downloads.handoff).toHaveBeenCalledOnce();
  expect(t.catalog.raw(t.d.catalogId!)?.pageUrl).toBe(replacement);expect(t.catalog.raw(t.d.catalogId!)?.candidates.map(c=>c.url)).toEqual([fresh.url]);
 });
 it('keeps an existing indexed page open when every host fails',async()=>{
  const t=setup();t.downloadWorker.call.mockRejectedValue(Error('HTTP 404'));const recoverGamePage=vi.fn(async()=>null);
  await expect(t.resolve(new Resolver({...t.deps,recoverGamePage} as never))).rejects.toThrow(/None of the tested/);
  expect(t.downloadWorker.call.mock.calls.filter(c=>c[0]==='benchmarkMirror')).toHaveLength(2);expect(recoverGamePage).not.toHaveBeenCalled();expect(t.current()).toBe(sourceUrl);
 });
 it('does not repeat a failed recovery search after an interrupted restart',async()=>{
  const t=setup([]),recoverGamePage=vi.fn(async()=>null);
  t.downloadsRepo.update(t.d.id,{resolution:{pageUrl:sourceUrl,steps:0,history:[],pageRecoveryAttempted:true},state:'needs-resolution',errorCode:'interrupted'});
  t.browser.extract.mockResolvedValue(page('<h1>404 - Page not found</h1>'));
  await expect(t.resolve(new Resolver({...t.deps,recoverGamePage} as never))).rejects.toThrow(/No verified replacement/);expect(recoverGamePage).not.toHaveBeenCalled();
 });
});

it('keeps the links position found by AI scrolling inside a script-mirror trial',async()=>{
 const t=setup([]),links=page('<button>Download first mirror</button><button>Download second mirror</button>');let scrollY=0;
 t.browser.extract.mockImplementation(async()=>t.current()===sourceUrl?{...links,viewport:{...links.viewport,scrollY}}:page('<h1>File not found</h1>',t.current()));
 const navigate=t.browser.navigate.getMockImplementation()!;
 t.browser.navigate.mockImplementation(async(ctx,url)=>{if(url===sourceUrl)scrollY=0;await navigate(ctx,url);});
 (t.browser as any).returnToPage=vi.fn(async(ctx:string,url:string,top:number)=>{if(t.current()!==url)await t.browser.navigate(ctx,url);scrollY=top;return {url,scrollY,reused:true};});
 t.agent.transfer.mockImplementation(async(_ex,_token,title)=>({kind:'computer',computer:{action:scrollY===0?{action:'scroll'}:{action:'click_element',element:title.includes('#cgl-control-1')?1:0}}}) as any);
 let scrolls=0;
 (t.agent as any).actBrowser=vi.fn(async(step:any)=>{if(step.action.action==='scroll'){scrollY=2780;scrolls++;}else await t.browser.navigate('interactive',step.action.element===0?'https://dead.test/file/token':'https://live.test/file/token');return 'continue';});
 let completed=false;t.browser.takeDownloads.mockImplementation(async()=>{if(t.current().includes('live.test'))completed=true;return completed?[{target:'/isolated/orbit.zip',url:'blob:https://live.test/token',currentBytes:1000000,totalBytes:1000000,succeeded:true,stopped:true}]:[];});
 await t.resolve();expect(scrolls).toBe(1);
 expect((t.browser as any).returnToPage.mock.calls.some((c:any[])=>c[2]===2780)).toBe(true);
 expect(t.downloads.adoptBrowserDownload).toHaveBeenCalledOnce();
 expect(t.downloadsRepo.get(t.d.id)?.resolution?.mirrors?.sourceScrollY).toBe(2780);
});

describe('verification during mirror comparisons',()=>{
 it('pauses on the exact host without rejecting it or searching, then resumes it after restart',async()=>{
  const first={...candidate('check.test','file/token'),fileName:null};
  const t=setup([first,candidate('fast.test')]);
  const original=t.browser.extract.getMockImplementation()!;
  let gated=true;
  t.browser.extract.mockImplementation(async()=>t.current()===first.url&&gated?page('<h1>Verify you are human</h1><div class="g-recaptcha"></div>',first.url):original());
  (t.browser as any).snapshot=vi.fn(async()=>({url:t.current()}));
  const recoverGamePage=vi.fn();
  const resolver=new Resolver({...t.deps,recoverGamePage} as never);
  await t.resolve(resolver);
  const paused=t.downloadsRepo.get(t.d.id)!;
  expect(paused.state).toBe('needs-user');
  expect(paused.resolution?.pageUrl).toBe(first.url);
  expect(paused.resolution?.mirrors?.paused).toEqual({route:first.url,pageUrl:first.url});
  expect(paused.resolution?.mirrors?.failures).toEqual([]);
  expect(paused.resolution?.mirrors?.tested).not.toContain(first.url);
  expect(t.deps.openDrawer).toHaveBeenLastCalledWith(expect.any(String),true,'captcha');
  expect(t.agent.verify).not.toHaveBeenCalled();
  expect(recoverGamePage).not.toHaveBeenCalled();
  // A fresh resolver reads only the durable checkpoint, with the verified tab intact.
  gated=false;t.downloadsRepo.update(t.d.id,{state:'resolving'});t.browser.navigate.mockClear();
  const restarted=new Resolver({...t.deps,recoverGamePage} as never);
  await t.resolve(restarted);
  expect(t.downloads.handoff).toHaveBeenCalledOnce();
  expect(t.browser.navigate.mock.calls.some(c=>c[1]===first.url||c[1]===sourceUrl)).toBe(false);
  expect(t.downloadsRepo.get(t.d.id)?.resolution?.mirrors?.paused).toBeUndefined();
 });
 it('does not mistake a different page for a completed human check',async()=>{
  vi.useFakeTimers();
  const t=setup();
  const checkpoint={pageUrl:'https://check.test/token',steps:1,history:[]};
  const resume=vi.spyOn(t.resolver,'continueAfterUser');
  try {
   (t.resolver as any).pause(t.d.id,{kind:'captcha',message:'Check'},checkpoint);
   t.browser.extract.mockResolvedValue(page('<h1>Home</h1>','https://games.test/'));
   await vi.advanceTimersByTimeAsync(2500);
   expect(resume).not.toHaveBeenCalled();expect(t.downloadsRepo.get(t.d.id)?.state).toBe('needs-user');
   t.browser.extract.mockResolvedValue(page('<h1>File ready</h1>',checkpoint.pageUrl));
   resume.mockImplementation(()=>{});
   await vi.advanceTimersByTimeAsync(2500);expect(resume).toHaveBeenCalledWith(t.d.id);
  } finally {t.session.leave();await vi.advanceTimersByTimeAsync(2500);vi.useRealTimers();}
 });
});

it('restores a saved resolution page when the restarted browser is blank',async()=>{
 const t=setup();t.downloadsRepo.update(t.d.id,{resolution:{pageUrl:sourceUrl,steps:5,history:[]}});
 t.browser.snapshot.mockResolvedValueOnce({url:'about:blank'});
 await t.resolve();expect(t.browser.navigate.mock.calls[0][1]).toBe(sourceUrl);
 expect(t.downloads.handoff).toHaveBeenCalledOnce();
});

it('follows observed host links from the game document so referrer restrictions do not reject them',async()=>{
 const routes=[{...candidate('check.test','file/token'),fileName:null},{...candidate('other.test','file/token'),fileName:null}];const t=setup(routes);
 await t.resolve();
 expect((t.browser as any).followLink).toHaveBeenCalledWith('interactive',sourceUrl,routes[0].url,expect.any(AbortSignal));
 expect((t.browser as any).followLink).toHaveBeenCalledWith('interactive',sourceUrl,routes[1].url,expect.any(AbortSignal));
 expect(t.downloads.handoff).toHaveBeenCalledOnce();
});

it.each([200,20000])('compares a browser-only host at %i B/s with all other mirrors',async(speed)=>{
 const first={...candidate('browser.test','gateway'),fileName:null,platform:'windows' as const};const t=setup([first,candidate('fast.test')]);let started=false,removed=false;
 const original={target:'/isolated/orbit.zip',partFilePath:'/isolated/orbit.random.zip.part',url:'blob:https://browser.test/token',speedBps:speed,currentBytes:20000,totalBytes:1000000,stopped:false,succeeded:false};
 t.browser.takeDownloads.mockImplementation(async(cancel,target)=>{if(t.current().includes('browser.test'))started=true;if(cancel&&target===original.target){expect(t.downloads.handoff).toHaveBeenCalledOnce();removed=true;}return started&&!removed?[original]:[];});
 await t.resolve();expect(t.downloadWorker.call).toHaveBeenCalledWith('benchmarkMirror',expect.objectContaining({url:'https://fast.test/orbit.zip'}),expect.any(AbortSignal));
 if(speed<2000){expect(t.downloads.handoff).toHaveBeenCalledOnce();expect(removed).toBe(true);expect(t.downloads.adoptBrowserDownload).not.toHaveBeenCalled();}
 else{expect(t.downloads.adoptBrowserDownload).toHaveBeenCalledWith(t.d.id,original);expect(t.downloads.handoff).not.toHaveBeenCalled();expect(removed).toBe(false);}
 expect(t.downloadsRepo.get(t.d.id)?.resolution?.mirrors?.selected?.tested).toBe(2);
});

it('does not attribute a retained first-host transfer to a second host after verification resumes',async()=>{
 const first={...candidate('browser.test','gateway'),fileName:null,platform:'windows' as const},second={...candidate('gate.test','gateway'),fileName:null,platform:'windows' as const};
 const t=setup([first,second]);let started=false,gated=true;
 const original={target:'/isolated/orbit.zip',url:'blob:https://browser.test/token',speedBps:500,currentBytes:20000,totalBytes:1000000,stopped:false,succeeded:false};
 t.browser.takeDownloads.mockImplementation(async()=>{if(t.current().includes('browser.test'))started=true;return started?[original]:[];});
 const extract=t.browser.extract.getMockImplementation()!;
 t.browser.extract.mockImplementation(async()=>t.current()===second.url&&gated?page('<title>Verify you are human</title>',second.url):extract());
 await t.resolve();expect(t.downloadsRepo.get(t.d.id)?.state).toBe('needs-user');expect(t.downloads.adoptBrowserDownload).not.toHaveBeenCalled();
 gated=false;t.downloadsRepo.update(t.d.id,{state:'resolving'});await t.resolve(new Resolver(t.deps as never));
 const samples=t.downloadsRepo.get(t.d.id)?.resolution?.mirrors?.samples;
 expect(samples?.map(s=>s.route)).toEqual([first.url,second.url]);
 expect(samples?.find(s=>s.route===second.url)?.url).toBe('https://cdn.test/orbit.zip');
 expect(t.downloads.adoptBrowserDownload).toHaveBeenCalledWith(t.d.id,original);
});

it('keeps third and fourth host links when the AI control observation was truncated', () => {
 const ex=page('<a href="https://megadb.net/aaaaaaaaaaaa">Mirror A</a><a href="https://bzzhr.to/bbbbbbbbbbbb">Mirror B</a><a href="https://gofile.io/d/cccccc">Mirror C</a><a href="https://1fichier.com/?dddddddddddd">Mirror D</a>');ex.controls=ex.controls.slice(0,2);
 expect(downloadEvidence(ex).map(c=>new URL(c.url).hostname)).toEqual(['megadb.net','bzzhr.to','gofile.io','1fichier.com']);
});
