import {afterEach,describe,expect,it,vi} from 'vitest';
import {requestPage} from '../src/workers/fetcher';
afterEach(()=>vi.unstubAllGlobals());
describe('page transport redirects',()=>{
 it('reports the actual destination and strips credentials when a website redirects to another origin',async()=>{
  const sent:Array<{url:string;cookie:string|null;auth:string|null}>=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
   const h=new Headers(init.headers);sent.push({url,cookie:h.get('cookie'),auth:h.get('authorization')});
   return sent.length===1?new Response('',{status:302,headers:{location:'/next'}}):sent.length===2?new Response('',{status:302,headers:{location:'https://other.test/final'}}):new Response('<h1>Final</h1>');
  }));
  const r=await requestPage('https://games.test/start',{headers:{Cookie:'session=private',Authorization:'Bearer private'}});
  expect(r.url).toBe('https://other.test/final');
  expect(sent.map(s=>s.cookie)).toEqual(['session=private','session=private',null]);
  expect(sent.at(-1)?.auth).toBeNull();expect(await r.res.text()).toContain('Final');
 });
 it('refuses a redirect into a local file and bounds redirect loops',async()=>{
  const send=vi.fn(async()=>new Response('',{status:302,headers:{location:'file:///etc/passwd'}}));vi.stubGlobal('fetch',send);
  await expect(requestPage('https://games.test/')).rejects.toThrow('Only HTTP(S)');expect(send).toHaveBeenCalledTimes(1);
  send.mockImplementation(async()=>new Response('',{status:302,headers:{location:'/loop'}}));
  await expect(requestPage('https://games.test/')).rejects.toThrow('Too many page redirects');
  expect(send).toHaveBeenCalledTimes(12);
 });
});
