import {afterEach,describe,expect,it,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {extractPage,type PageExtract} from '@shared/page-extract';
import {LocalGameAgent} from '../src/main/game-agent';
import {StoreSession} from '../src/main/store-session';
const closed:Array<()=>void>=[];
afterEach(()=>{closed.splice(0).forEach(f=>f());vi.useRealTimers();});
function page(html:string){const dom=new JSDOM(html,{url:'https://unknown.test/selected',runScripts:'outside-only'});closed.push(()=>dom.window.close());return dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;}
function setup(answer:unknown){const session=new StoreSession(),token=session.enter();closed.push(()=>session.leave());const chatJson=vi.fn(async()=>answer),snapshot=vi.fn(async()=>({png:'image'}));const ai={chatJson,setStatus:vi.fn()},browser={snapshot};return {agent:new LocalGameAgent(ai as never,browser as never,session),session,token,chatJson,snapshot};}
describe('local model owns page decisions',()=>{
 it('accepts an unfamiliar browse route only when selected by the model',async()=>{
  const ex=page('<a href="/new-shelf">Explore more worlds</a><a href="/orbit">Orbit</a>');
  const s=setup({games:[{link:ex.links[1].i,title:'Orbit'}],routes:[ex.links[0].i,999],gameTitle:null,step:{kind:'done',index:null},reason:'Observed games and next shelf'});
  const r=await s.agent.listing(ex,s.token);
  expect(r.cards.map(c=>c.title)).toEqual(['Orbit']);expect(r.routes).toEqual(['https://unknown.test/new-shelf']);expect(s.chatJson).toHaveBeenCalledOnce();expect(s.snapshot).toHaveBeenCalledOnce();
 });
 it('can reject a review even when a Download link exists',async()=>{
  const ex=page('<h1>Orbit review</h1><a href="/press-kit.zip">Download</a>');
  const s=setup({isGamePage:false,title:'Orbit review',description:'',platforms:[],categories:[],tags:[],downloadControls:[0],step:{kind:'done',index:null},reason:'Review and press kit only'});
  expect((await s.agent.game(ex,s.token,'Orbit')).candidates).toEqual([]);expect(s.chatJson).toHaveBeenCalledOnce();
 });
 it('accepts a model-observed download route that matches no known host or Download label',async()=>{
  const ex=page('<h1>Orbit</h1><a href="https://brand-new-storage.test/object/xyz">Receive playable package</a>');
  const s=setup({isGamePage:true,title:'Orbit',description:'A game',platforms:['windows'],categories:['Puzzle'],tags:[],downloadControls:[ex.controls[0].i],step:{kind:'done',index:null},reason:'Game archive gateway'});
  expect((await s.agent.game(ex,s.token,'Orbit')).candidates[0].url).toBe('https://brand-new-storage.test/object/xyz');
 });
 it('does not fall back to a hardcoded download click when the model fails',async()=>{
  const ex=page('<a href="/orbit.zip">Download</a>');const s=setup(null);s.chatJson.mockRejectedValueOnce(new Error('Model unavailable'));
  await expect(s.agent.transfer(ex,s.token,'Orbit',[],[])).rejects.toThrow('Model unavailable');
 });
 it('refuses AI work after leaving Store before taking screenshots',async()=>{
  const s=setup({});s.session.leave();await expect(s.agent.listing(page('<h1>Games</h1>'),s.token)).rejects.toThrow('stale');expect(s.chatJson).not.toHaveBeenCalled();expect(s.snapshot).not.toHaveBeenCalled();
 });
 it('requires the model to approve preparation and Library registration',async()=>{
  const s=setup({action:'reject',reason:'Not a game package'});await expect(s.agent.prepare(s.token,'Orbit',{name:'notes.txt',type:'unsupported',bytes:10})).rejects.toThrow('declined');
  s.chatJson.mockResolvedValueOnce({index:99,addToLibrary:true,reason:'invented'});
  await expect(s.agent.executable(s.token,'Orbit',[{path:'/game/Orbit.exe',relPath:'Orbit.exe',kind:'exe',size:1024,score:0,installerLike:false}])).rejects.toThrow('could not select');
 });
 it('never substitutes an installer when the model chooses it',async()=>{
  const s=setup({index:0,addToLibrary:true,reason:'installer'});
  await expect(s.agent.executable(s.token,'Orbit',[{path:'/game/setup.exe',relPath:'setup.exe',kind:'exe',size:1024,score:99,installerLike:true}])).rejects.toThrow('could not select');
 });
 it('reports real input focus and values without exposing password fields',()=>{
  const ex=page('<input name="answer" value="7"><input type="password" value="private">');
  expect(ex.inputState?.fields).toHaveLength(1);expect(ex.inputState?.fields[0]).toMatchObject({label:'answer',value:'7',focused:false});
  expect(JSON.stringify(ex.inputState)).not.toContain('private');
 });
 it('never answers a website check; returns as soon as it clears by itself',async()=>{
  vi.useFakeTimers();const ex=page('<form id="challenge-form"><input name="answer" value="7"></form>');ex.gates.captcha=true;
  const session=new StoreSession(),token=session.enter();closed.push(()=>session.leave());
  const browser={snapshot:vi.fn(),type:vi.fn(),pointer:vi.fn(),clickElement:vi.fn(),extract:vi.fn(async()=>({...ex,gates:{...ex.gates,captcha:false}}))};
  const ai={setStatus:vi.fn(),chatJson:vi.fn(),chatTools:vi.fn()};
  const pending=new LocalGameAgent(ai as never,browser as never,session).verify(ex,'discovery',token);
  await vi.advanceTimersByTimeAsync(2000);expect((await pending).gates.captcha).toBe(false);
  for(const f of [ai.chatJson,ai.chatTools,browser.type,browser.pointer,browser.clickElement,browser.snapshot])expect(f).not.toHaveBeenCalled();
  vi.useRealTimers();
 });
});

it('asks the local model for the playable mirror variant and rejects invented file choices', async () => {
 const s=setup({index:1});const routes=[{url:'https://host.test/setup.exe',label:'Installer',fileName:'setup.exe',platform:'windows',sizeText:null},{url:'https://other.test/Orbit.part1.rar',label:'Portable part 1',fileName:'Orbit.part1.rar',platform:'windows',sizeText:null}] as const;
 expect(await s.agent.mirrorVariant(s.token,'Orbit',[...routes])).toBe(1);
 expect(((s.chatJson.mock.calls as unknown as Array<[unknown,{user:string}]>)[0][1]).user).toContain('every other part will be queued separately');
 s.chatJson.mockResolvedValueOnce({index:99});await expect(s.agent.mirrorVariant(s.token,'Orbit',[...routes])).rejects.toThrow(/could not select/);
});
