import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { benchmarkMirror, browserFilePrefix, MIRROR_PREFIX_BYTES } from '../src/workers/mirror-probe';
const data=Buffer.alloc(2*1024*1024,0x67), controllers:AbortController[]=[];
let server:Server, other:Server, base:string, second:string, dir:string;
let redirectedHeaders:Record<string,unknown>={};
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'cgl-mirror-probe-'));
 other=createServer((req,res)=>{redirectedHeaders=req.headers;res.writeHead(206,{'content-type':'application/zip','content-disposition':'attachment; filename="game.zip"','content-range':`bytes 0-131071/${data.length}`,'content-length':131072});res.end(data.subarray(0,131072));});
 await new Promise<void>(r=>other.listen(0,'127.0.0.1',r));second=`http://127.0.0.1:${(other.address() as AddressInfo).port}`;
 server=createServer((req,res)=>{
  const name=req.url!.split('?')[0];
  if(name==='/html'){res.writeHead(200,{'content-type':'text/html'});res.end('<html>Login</html>');return;}
  if(name==='/broken'){res.writeHead(503);res.end();return;}
  if(name==='/redirect'){res.writeHead(302,{location:second+'/game.zip'});res.end();return;}
  if(name==='/stall'){res.writeHead(206,{'content-type':'application/zip','content-range':`bytes 0-131071/${data.length}`});res.flushHeaders();return;}
  const end=Math.min(Number(req.headers.range?.match(/-(\d+)$/)?.[1]??data.length-1),data.length-1);
  res.writeHead(name==='/no-range'?200:206,{'content-type':'application/zip','content-disposition':'attachment; filename="game.zip"','content-length':name==='/no-range'?data.length:end+1,...(name==='/no-range'?{}:{'content-range':`bytes 0-${end}/${data.length}`})});
  if(name==='/fast'){res.end(data.subarray(0,end+1));return;}
  let offset=0;const timer=setInterval(()=>{if(offset>end){clearInterval(timer);res.end();return;}const next=Math.min(offset+16384,end+1);res.write(data.subarray(offset,next));offset=next;},25);res.on('close',()=>clearInterval(timer));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(()=>{for(const c of controllers)c.abort();server.closeAllConnections();server.close();other.closeAllConnections();other.close();rmSync(dir,{recursive:true,force:true});});
function signal(){const c=new AbortController();controllers.push(c);return c;}
const limits={bytes:128*1024,ms:1000};
describe('real mirror throughput samples',()=>{
 it('measures file bytes, ranks a faster stream above a slower one, and stops at the byte cap',async()=>{
  const fast=await benchmarkMirror(base+'/fast',{},signal().signal,limits);
  const slow=await benchmarkMirror(base+'/slow',{},signal().signal,limits);
  expect(fast.speedBps).toBeGreaterThan(slow.speedBps*3);
  expect(fast).toMatchObject({sampledBytes:limits.bytes,prefixBytes:MIRROR_PREFIX_BYTES,totalBytes:data.length,resumable:true,fileName:'game.zip'});
  expect(fast.prefixHash).toBe(slow.prefixHash);
 });
 it('rejects HTML, broken hosts and stalls rather than assigning them a fake speed',async()=>{
  await expect(benchmarkMirror(base+'/html',{},signal().signal,limits)).rejects.toThrow(/did not serve a file/);
  await expect(benchmarkMirror(base+'/broken',{},signal().signal,limits)).rejects.toThrow(/503/);
  await expect(benchmarkMirror(base+'/stall',{},signal().signal,{...limits,ms:80})).rejects.toThrow(/slow/);
 });
 it('uses received bytes at the time limit and supports servers that ignore Range',async()=>{
  const timed=await benchmarkMirror(base+'/slow',{},signal().signal,{...limits,ms:110});
  expect(timed.sampledBytes).toBeGreaterThanOrEqual(MIRROR_PREFIX_BYTES);expect(timed.sampledBytes).toBeLessThan(limits.bytes);
  const single=await benchmarkMirror(base+'/no-range',{},signal().signal,limits);expect(single.resumable).toBe(false);expect(single.sampledBytes).toBe(limits.bytes);expect(single.totalBytes).toBe(data.length);
 });
 it('cancels an in-flight sample and strips credentials on a cross-origin redirect',async()=>{
  const c=signal();const pending=benchmarkMirror(base+'/slow',{},c.signal,limits);setTimeout(()=>c.abort(),40);await expect(pending).rejects.toThrow();
  await benchmarkMirror(base+'/redirect',{Cookie:'private-cookie',Authorization:'Bearer private-token'},signal().signal,limits);
  expect(redirectedHeaders.cookie).toBeUndefined();expect(redirectedHeaders.authorization).toBeUndefined();
 });
 it('compares a Firefox partial file with the same sampled prefix',async()=>{
  const target=join(dir,'game.zip');writeFileSync(target+'.part',data.subarray(0,32768));
  const original=await browserFilePrefix(target),sample=await benchmarkMirror(base+'/fast',{},signal().signal,limits);
  expect(original).toEqual({hash:sample.prefixHash,bytes:sample.prefixBytes});expect(await browserFilePrefix(join(dir,'missing'))).toBeNull();
  const randomized=join(dir,'game.random.zip.part');writeFileSync(randomized,data.subarray(0,32768));writeFileSync(target,Buffer.alloc(0));
  expect(await browserFilePrefix(target,randomized)).toEqual(original);
 });
});
