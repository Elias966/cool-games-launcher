// Real HTTP streams, resumable transfer engine, multipart scheduling and extraction.
import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';
vi.mock('electron',()=>({app:{isPackaged:false,getAppPath:()=>process.cwd()},shell:{}}));
import { openDb } from '../src/main/db';
import { CatalogRepo, DownloadsRepo, SourcesRepo } from '../src/main/repos';
import { DownloadManager } from '../src/main/downloads';
import { Resolver } from '../src/main/resolver';
import { StoreSession } from '../src/main/store-session';
import { extractPage, type PageExtract } from '../src/shared/page-extract';
import { benchmarkMirror } from '../src/workers/mirror-probe';
import { probeUrl, runTransfer } from '../src/workers/transfer';
import { prepareGame } from '../src/workers/prepare-game';
const SEVEN=resolve('vendor/7zip/7zzs');
describe.skipIf(!existsSync(SEVEN))('multipart mirror transfer and extraction',()=>{
 it('downloads all real split volumes from their fastest hosts and extracts the complete game',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cgl-real-mirrors-'));let server:Server|undefined;
  const db=openDb(join(dir,'db'));const session=new StoreSession();session.enter();
  const work=new Map<number,{abort:AbortController;done:Promise<unknown>}>();let manager:DownloadManager|undefined;let dom:JSDOM|undefined;
  try {
   mkdirSync(join(dir,'input/Orbit/data'),{recursive:true});writeFileSync(join(dir,'input/Orbit/orbit.sh'),'#!/bin/sh\necho orbit\n',{mode:0o755});
   const data=randomBytes(90000);writeFileSync(join(dir,'input/Orbit/data/level.pak'),data);
   execFileSync(SEVEN,['a','-v40k','-mx0',join(dir,'orbit.7z'),'Orbit'],{cwd:join(dir,'input'),stdio:'ignore'});
   const volumes=readdirSync(dir).filter(n=>/^orbit\.7z\.\d+$/.test(n)).sort();expect(volumes.length).toBeGreaterThanOrEqual(3);
   const payloads=new Map(volumes.map(n=>[n,readFileSync(join(dir,n))]));
   server=createServer((req,res)=>{
    const [,host,name]=decodeURIComponent(req.url!).split('/');const payload=payloads.get(name);
    if(!payload){res.writeHead(404);res.end();return;}
    const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),payload.length-1):payload.length-1;
    const bytes=payload.subarray(start,end+1);
    res.writeHead(range?206:200,{'content-type':'application/octet-stream','content-disposition':`attachment; filename="${name}"`,'content-length':bytes.length,etag:'"'+name+'"',...(range?{'content-range':`bytes ${start}-${end}/${payload.length}`}:{})});
    const fast=host===(name.endsWith('002')?'b':'a');
    if(fast){res.end(bytes);return;}
    let offset=0;const timer=setInterval(()=>{if(offset>=bytes.length){clearInterval(timer);res.end();return;}res.write(bytes.subarray(offset,offset+8192));offset+=8192;},35);res.on('close',()=>clearInterval(timer));
   });
   await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
   const candidates=volumes.flatMap(fileName=>['a','b'].map(host=>({url:`${origin}/${host}/${fileName}`,label:'Download '+fileName,fileName,platform:'linux' as const,sizeText:null})));
   const pageUrl='https://games.test/orbit';dom=new JSDOM(candidates.map(c=>`<a href="${c.url}">${c.label}</a>`).join(''),{url:pageUrl,runScripts:'outside-only'});
   const page=dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;
   const catalog=new CatalogRepo(db),repo=new DownloadsRepo(db),source=new SourcesRepo(db).add('https://games.test/');
   const entry=catalog.upsertListing(source.id,{pageUrl,title:'Orbit',titleKey:'orbit'});catalog.setRating(entry.id,'safe',0,[],'fixture');catalog.setDetail(entry.id,{candidates});
   const worker=Object.assign(new EventEmitter(),{call:vi.fn(async(method:string,p:any,signal?:AbortSignal)=>{
    if(method==='benchmarkMirror')return benchmarkMirror(p.url,p.headers,signal!);
    if(method==='probe')return probeUrl(p.url,p.headers,signal!);
    if(method==='stop'){const running=work.get(p.id);running?.abort.abort();await running?.done;return {};}
    if(method==='start'){
     const abort=new AbortController();const done=runTransfer(p.spec,abort.signal,meta=>worker.emit('event:meta',{id:p.id,meta}),progress=>worker.emit('event:progress',{id:p.id,...progress})).then(result=>worker.emit('event:done',{id:p.id,result})).catch(e=>worker.emit('event:error',{id:p.id,code:e.code??'io',message:e.message,retryable:false}));
     work.set(p.id,{abort,done});return {};
    }
    throw Error(method);
   })});
   const settings={get:()=>({downloadsDir:join(dir,'downloads'),maxConcurrentDownloads:2,downloadConnections:4})};
   const policy=Object.assign(new EventEmitter(),{policy:()=>({showNsfw:false,revision:1})});
   manager=new DownloadManager(worker as never,repo,catalog,settings as never,policy as never,{} as never);
   const browser={navigate:async()=>{},returnToPage:async(_ctx:string,url:string,scrollY:number)=>({url,scrollY,reused:true}),extract:async()=>page,takeDownloads:async()=>[],cookieHeader:async()=>({cookie:'',userAgent:'fixture'})};
   const resolver=new Resolver({session,browser,downloads:manager,downloadsRepo:repo,catalog,downloadWorker:worker,policy,ai:{setStatus:()=>{}},agent:{mirrorVariant:async()=>0,transfer:async()=>({kind:'download',index:0})},openDrawer:()=>{}} as never);
   const first=repo.create({catalogId:entry.id,title:'Orbit',sourceHost:'games.test',state:'resolving'});resolver.enqueue(first.id);
   await vi.waitFor(()=>{const parts=repo.group(first.id);expect(parts).toHaveLength(volumes.length);expect(parts.every(p=>p.state==='completed')).toBe(true);},{timeout:12000});
   const parts=repo.group(first.id).sort((a,b)=>a.partIndex!-b.partIndex!);
   for(const part of parts){const expectedHost=part.partIndex===2?'b':'a';expect(part.url).toContain(`/${expectedHost}/`);expect(part.partTotal).toBe(volumes.length);expect(readFileSync(part.finalPath!).equals(payloads.get(part.fileName!)!)).toBe(true);}
   const result=await prepareGame({downloadId:first.id,filePath:parts[0].finalPath!,parts:parts.map(p=>p.finalPath!),gameDir:join(dir,'installed'),title:'Orbit'},new AbortController().signal,()=>{});
   expect(readFileSync(join(result.installDir,'Orbit/data/level.pak')).equals(data)).toBe(true);expect(existsSync(join(result.installDir,'Orbit/orbit.sh'))).toBe(true);
  } finally {session.leave();await manager?.shutdown();await Promise.all([...work.values()].map(w=>w.done));dom?.window.close();server?.closeAllConnections();server?.close();db.close();rmSync(dir,{recursive:true,force:true});}
 },20000);
});
