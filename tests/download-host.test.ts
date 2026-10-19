import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractPage, type PageExtract } from '../src/shared/page-extract';
import { unavailableHostReason, DownloadHostProgress } from '../src/shared/download-host';
const doms:JSDOM[]=[];
afterEach(()=>doms.splice(0).forEach(dom=>dom.window.close()));
function page(html:string,url='https://host.test/file/token') {
 const dom=new JSDOM(html,{url,runScripts:'outside-only'});doms.push(dom);
 return dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;
}
describe('unavailable download host evidence',()=>{
 it.each(['File not found','This file has been deleted','The file you requested is no longer available','The requested file is not available','The file you are trying to download has been removed','This transfer has expired','404 - Page not found','410 Gone','Not Found','Link expired','File not found: orbit.zip'])('recognises a prominent %s response',notice=>{
  expect(unavailableHostReason(page(`<main><h1>${notice}</h1><a href="/">Go home</a></main>`),'https://host.test/file/token')).toMatch(/unavailable/);
 });
 it('recognises a short error without a heading',()=>{
  expect(unavailableHostReason(page('<main>This file was removed from our servers.</main>'),'https://host.test/file/token')).toMatch(/removed/);
 });
 it.each(['/','/pricing','/support/help','/about'])('recognises a silent redirect to %s',path=>{
  expect(unavailableHostReason(page('<h1>Host your files</h1>',`https://host.test${path}`),'https://host.test/file/token')).toMatch(/homepage|unrelated/);
 });
 it.each([
  '<main><h1>Orbit.zip</h1><p>Your download starts in 15 seconds.</p></main><footer>File not found? Contact support</footer>',
  '<main><h1>Orbit.zip</h1><a href="/real.zip">Download file</a><section class="faq"><h2>File not found</h2></section></main>',
  '<main><h1>Orbit.zip</h1><div hidden role="alert">This file has been deleted</div><button>Free download</button></main>',
  '<main><h1>File Not Found.zip</h1><a href="/real.zip">Download file</a></main>',
  '<main><h1>404.zip</h1><a href="/real.zip">Download file</a></main>',
  '<main><h1>Orbit.zip</h1><h2>File not found?</h2><button>Free download</button></main>',
  '<main><h1>Orbit.zip</h1><p>If the file has been deleted, contact its uploader.</p><button>Free download</button></main>',
 ])('keeps a valid file/countdown/FAQ page available',html=>{
  expect(unavailableHostReason(page(html),'https://host.test/file/token')).toBeNull();
 });
 it('keeps a root download page with a real control or countdown available',()=>{
  for(const html of ['<button>Download file</button>','<p>Your download starts in 15 seconds.</p>'])expect(unavailableHostReason(page(html,'https://host.test/'),'https://host.test/file/token')).toBeNull();
 });
 it('keeps root URLs containing file tokens and legitimate CDN routes available',()=>{
  for(const url of ['https://host.test/?id=token','https://host.test/#file-token','https://cdn.test/files/orbit.zip'])expect(unavailableHostReason(page('<h1>Orbit.zip</h1>',url),'https://host.test/file/token')).toBeNull();
 });
});


it('recognises a server-busy file badge even when Download is visible', () => {
 const ex=page('<main><h1>Bloodborne-SteamRIP.com.rar</h1><span>31.0 GB</span> <span>server busy</span> <button>Download</button></main>');
 expect(unavailableHostReason(ex,ex.url)).toMatch(/temporarily busy/);
 expect(unavailableHostReason(page('<main><h1>Server Busy Simulator.zip</h1><button>Download</button></main>'),ex.url)).toBeNull();
});

it('stops three ineffective clicks despite a visible Download control, but keeps countdowns and real progress', () => {
 const ex=page('<main><h1>Orbit.rar</h1><button>Download</button></main>'), progress=new DownloadHostProgress();
 expect(progress.observe(ex,false)).toBeNull();
 expect(progress.observe(ex,true)).toBeNull();expect(progress.observe(ex,true)).toBeNull();
 expect(progress.observe(ex,true)).toMatch(/three clicks/);
 const countdown=page('<main><h1>Orbit.rar</h1><p>Your download starts in 15 seconds.</p><button>Download</button></main>');
 for(let i=0;i<5;i++)expect(progress.observe(countdown,true)).toBeNull();
 expect(progress.observe({...ex,text:ex.text+' A new download option appeared'},true)).toBeNull();
 expect(progress.observe(ex,false)).toBeNull();
});
