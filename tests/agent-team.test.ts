import {faraSystemPrompt} from '@shared/fara-chat';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {BrowserAgent} from '../src/main/browser-agent';
import {LocalGameAgent} from '../src/main/game-agent';
import {ComputerAgent} from '../src/main/computer-agent';
import {AiService} from '../src/main/ai';
import {StoreSession} from '../src/main/store-session';
import {DEFAULT_AGENTS} from '@shared/models';
import {faraMessages,parseFaraCall} from '@shared/fara-chat';
import type {PageExtract} from '@shared/page-extract';
const clean:Array<()=>void>=[];afterEach(()=>clean.splice(0).forEach(f=>f()));
const ex={url:'https://games.test/orbit',title:'Orbit',controls:[],links:[],gates:{login:false},inputState:{fields:[]}} as unknown as PageExtract;
function native(name:string,args:unknown,id='call_1'){return {message:{role:'assistant',content:'',tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},modelId:DEFAULT_AGENTS.browsing};}
function setup(args:unknown){
 const session=new StoreSession(),token=session.enter();clean.push(()=>session.leave());
 const ai={setStatus:vi.fn(),chatTools:vi.fn(async(..._args:unknown[])=>native('computer_use',args))};
 const browser={snapshot:vi.fn(async()=>({png:'image',w:1440,h:900,url:ex.url})),inspectPoint:vi.fn(async()=>({text:'Get playable package',password:false,untrustedRegion:false,download:false,index:null})),pointer:vi.fn(async()=>{}),scroll:vi.fn(async()=>{}),navigate:vi.fn(async()=>{}),type:vi.fn(async()=>{})};
 return {session,token,ai,browser,agent:new BrowserAgent(ai as never,browser as never,session)};
}
describe('specialist agent tools',()=>{
 it('opens a sole unambiguous Download button on the saved game page without visual scrolling',async()=>{
  const s=setup({}),page={...ex,controls:[{i:1,text:'Download',href:null,tag:'button'}]} as PageExtract,agent=new LocalGameAgent(s.ai as never,s.browser as never,s.session);
  expect(await agent.transfer(page,s.token,'Orbit',[],[],'',page.url,{pageUrl:page.url,url:'',alternatives:[],blockedControls:[],gamePageUrl:page.url})).toMatchObject({kind:'click',index:1});expect(s.ai.chatTools).not.toHaveBeenCalled();expect(s.browser.snapshot).not.toHaveBeenCalled();
 });
 it('immediately selects the sole direct popup option without another model call',async()=>{
  const s=setup({}),page={...ex,controls:[{i:1,text:'Download',href:null,tag:'button',inDialog:true},{i:2,text:'Download .torrent File',href:null,tag:'button',inDialog:true},{i:3,text:'Download',href:null,tag:'button'}]} as PageExtract;
  const agent=new LocalGameAgent(s.ai as never,s.browser as never,s.session);
  expect(await agent.transfer(page,s.token,'Orbit',[],[])).toMatchObject({kind:'click',index:1});expect(s.ai.chatTools).not.toHaveBeenCalled();expect(s.browser.snapshot).not.toHaveBeenCalled();
 });
 it('rejects a screenshot click on the torrent option before it reaches the browser',async()=>{
  const s=setup({action:'left_click',coordinate:[200,300]});s.browser.inspectPoint.mockResolvedValueOnce({text:'Download Torrent',password:false,untrustedRegion:false,download:true,index:null});
  const step=await s.agent.next(ex,'interactive',s.token,'Download Orbit');await expect(s.agent.execute(step,ex,s.token,true)).rejects.toThrow('direct download');expect(s.browser.pointer).not.toHaveBeenCalled();
 });
 it('rejects an observed torrent button even when it is labelled only Download',async()=>{
  const s=setup({action:'click_element',element:1}),page={...ex,controls:[{i:1,text:'Download',href:'https://files.test/get?format=torrent',tag:'a',inViewport:true,rect:{x:0,y:0,w:100,h:30}}]} as PageExtract;
  const agent=new BrowserAgent(s.ai as never,s.browser as never,s.session,'computer');s.ai.chatTools.mockResolvedValue(native('click_element',{index:1}));
  const step=await agent.next(page,'interactive',s.token,'Download Orbit');await expect(agent.execute(step,page,s.token,true)).rejects.toThrow('direct download');
 });
 it('preserves the published Fara JSON tool protocol and native tool results',()=>{
  const tools=[{type:'function',function:{name:'computer_use',parameters:{}}}];
  const messages=faraMessages([{role:'system',content:'Browser agent'},{role:'assistant',content:'',reasoning_content:'Wait for the page',tool_calls:[{function:{name:'computer_use',arguments:'{"action":"wait","time":1}'}}]},{role:'tool',content:'Page loaded'}],tools);
  expect(messages[0].content).toContain('<tools>');
  expect(messages[1].content).toContain('<think>\nWait for the page\n</think>');
  expect(parseFaraCall(messages[1].content,['computer_use'])).toEqual({name:'computer_use',arguments:'{"action":"wait","time":1}'});
  expect(messages[2]).toEqual({role:'user',content:'<tool_response>\nPage loaded\n</tool_response>'});
 });
 it('rejects ambiguous, invented and malformed Fara tool calls',()=>{
  const call='<tool_call>{"name":"computer_use","arguments":{"action":"wait","time":1}}</tool_call>';
  for(const content of [call+call,'No tool call','<tool_call>{"name":"shell","arguments":{}}</tool_call>','<tool_call>{"name":"computer_use","arguments":[]}</tool_call>'])expect(()=>parseFaraCall(content,['computer_use'])).toThrow();
 });
 it('follows Microsoft\'s Fara harness: verbatim prompt, screenshot-first turns, scaled coordinates',async()=>{
  const s=setup({action:'left_click',coordinate:[250,500]});
  const step=await s.agent.next(ex,'interactive',s.token,'Download Orbit');await s.agent.execute(step,ex,s.token,true);
  expect(s.browser.pointer).toHaveBeenCalledWith('interactive',360,450,'left',s.token.signal);
  const first=s.ai.chatTools.mock.calls[0][2] as unknown as Array<{role:string;content:any}>;
  expect(first[0].content).toBe(faraSystemPrompt());
  expect(first[1].content[0].type).toBe('image_url');expect(first[1].content[1].text).toContain('Download Orbit');
  s.ai.chatTools.mockResolvedValueOnce(native('computer_use',{action:'wait',time:1},'call_2'));
  await s.agent.next(ex,'interactive',s.token,'Download Orbit');
  const messages=s.ai.chatTools.mock.calls[1][2] as unknown as Array<{role:string;content:any}>;
  expect(messages.some(m=>m.role==='tool')).toBe(false);
  const last=messages.filter(m=>m.role==='user').at(-1)!;expect(last.content[0].type).toBe('image_url');
  expect(last.content[1].text).toMatch(/^Current URL: .*\nHere is the next screenshot\. Think about what to do next\.$/s);
  await expect(s.agent.execute(step,ex,s.token,true)).rejects.toThrow('already completed');
 });
 it('refreshes a stale DOM observation before asking the model to navigate a newly opened host',async()=>{
  const s=setup({action:'visit_url',url:ex.url});
  s.browser.snapshot.mockResolvedValueOnce({png:'image',w:1440,h:900,url:'https://host.test/file'});
  await expect(s.agent.next(ex,'interactive',s.token,'Download Orbit')).rejects.toMatchObject({name:'BrowserObservationChangedError'});
  expect(s.ai.chatTools).not.toHaveBeenCalled();expect(s.browser.pointer).not.toHaveBeenCalled();
 });
 it('keeps separate browser tasks independent when verification moves to a different page',async()=>{
  const s=setup({action:'wait',time:0});
  const first=await s.agent.next(ex,'discovery',s.token,'Verify page A');await s.agent.execute(first,ex,s.token,false);
  await s.agent.next({...ex,url:'https://games.test/second'},'discovery',s.token,'Verify page B');
  const messages=s.ai.chatTools.mock.calls[1][2] as unknown as Array<{role:string;tool_call_id?:string}>;
  expect(messages.some(m=>m.role==='tool')).toBe(false);
  expect(JSON.stringify(messages)).not.toContain('Verify page A');
 });
 it('blocks a visually chosen advertisement without substituting a different click',async()=>{
  const s=setup({action:'left_click',coordinate:[200,300]});s.browser.inspectPoint.mockResolvedValueOnce({text:'Install browser extension',password:false,untrustedRegion:true,download:false,index:null});
  const step=await s.agent.next(ex,'interactive',s.token,'Download Orbit');
  await expect(s.agent.execute(step,ex,s.token,true)).rejects.toThrow('rejected');expect(s.browser.pointer).not.toHaveBeenCalled();
  s.ai.chatTools.mockResolvedValueOnce(native('computer_use',{action:'left_click',coordinate:[750,300]},'call_2'));
  const retry=await s.agent.next(ex,'interactive',s.token,'Download Orbit');
  expect(JSON.stringify(s.ai.chatTools.mock.calls[1][2])).toContain('Nothing was clicked');
  await s.agent.execute(retry,ex,s.token,true);
  expect(s.browser.pointer).toHaveBeenCalledExactlyOnceWith('interactive',1080,270,'left',s.token.signal);
 });
 it('retries invalid native JSON without executing or repeating a browser action',async()=>{
  const s=setup({action:'left_click',coordinate:[250,500]});
  s.ai.chatTools.mockRejectedValueOnce(Object.assign(Error('Malformed JSON'),{code:'agent-response'}));
  const step=await s.agent.next(ex,'interactive',s.token,'Download Orbit');
  expect(s.ai.chatTools).toHaveBeenCalledTimes(2);expect(s.browser.pointer).not.toHaveBeenCalled();
  expect(JSON.stringify(s.ai.chatTools.mock.calls[1][2])).toContain('no action was executed');
  await s.agent.execute(step,ex,s.token,true);expect(s.browser.pointer).toHaveBeenCalledOnce();
 });
 it('bounds invalid-response retries and never retries cancellation or missing models',async()=>{
  const s=setup({});s.ai.chatTools.mockRejectedValue(Object.assign(Error('Malformed JSON'),{code:'agent-response'}));
  await expect(s.agent.next(ex,'interactive',s.token,'Download Orbit')).rejects.toThrow('Malformed');expect(s.ai.chatTools).toHaveBeenCalledTimes(3);
  s.ai.chatTools.mockClear().mockRejectedValue(Error('Missing model'));
  await expect(s.agent.next(ex,'interactive',s.token,'Other task')).rejects.toThrow('Missing model');expect(s.ai.chatTools).toHaveBeenCalledOnce();
 });
 it('never navigates to an invented model URL',async()=>{
  const s=setup({action:'visit_url',url:'https://unobserved.test'});const step=await s.agent.next(ex,'interactive',s.token,'Download Orbit');
  await expect(s.agent.execute(step,ex,s.token,true)).rejects.toThrow('only opens links observed');expect(s.browser.navigate).not.toHaveBeenCalled();
 });
 it('rejects coordinates outside the model coordinate space',async()=>{
  const s=setup({action:'left_click',coordinate:[1500,500]});await expect(s.agent.next(ex,'interactive',s.token,'Download Orbit')).rejects.toThrow();expect(s.browser.pointer).not.toHaveBeenCalled();
 });
 it('presses trained key combinations but never window-closing shortcuts',async()=>{
  const s=setup({action:'key',keys:['Control','a']});
  await s.agent.execute(await s.agent.next(ex,'interactive',s.token,'Download Orbit'),ex,s.token,true);
  expect(s.browser.type).toHaveBeenCalledWith('interactive',{keys:['Control','a']},s.token.signal);
  s.ai.chatTools.mockResolvedValueOnce(native('computer_use',{action:'key',keys:['Control','w']},'call_2'));
  await expect(s.agent.execute(await s.agent.next(ex,'interactive',s.token,'Download Orbit'),ex,s.token,true)).rejects.toMatchObject({name:'BrowserActionRejectedError'});
  expect(s.browser.type).toHaveBeenCalledOnce();
 });
 it('rejects a decision after the Store session changes',async()=>{
  const s=setup({action:'left_click',coordinate:[500,500]});const step=await s.agent.next(ex,'interactive',s.token,'Download Orbit');s.session.leave();
  await expect(s.agent.execute(step,ex,s.token,true)).rejects.toThrow();expect(s.browser.pointer).not.toHaveBeenCalled();
 });
 it('hands a rejected browser target to Holo without executing the planner click',async()=>{
  const s=setup({action:'left_click',coordinate:[200,300]});
  const ai={...s.ai,specialists:true};
  const agent=new LocalGameAgent(ai as never,s.browser as never,s.session);
  s.browser.inspectPoint.mockResolvedValueOnce({text:'Install browser extension',password:false,untrustedRegion:true,download:false,index:null});
  Object.assign(s.browser,{extract:vi.fn(async()=>ex)});
  const planned=await agent.transfer(ex,s.token,'Orbit',[],[]);
  s.ai.chatTools.mockResolvedValueOnce(native('click',{element:'Playable package',x:750,y:300},'holo_call'));
  await agent.actBrowser(planned.computer!,ex,s.token,true);
  expect(s.ai.chatTools.mock.calls.map(c=>c[1])).toEqual(['browsing','computer']);
  expect(s.browser.pointer).toHaveBeenCalledExactlyOnceWith('interactive',1080,270,'left',s.token.signal);
  expect(agent.navigationStats.computerHandoffs).toBe(1);
  expect(JSON.stringify(s.ai.chatTools.mock.calls[1][2])).toContain('Nothing was clicked');
 });
 it('executes only Holo-selected current page control IDs and blocks file transfers during discovery',async()=>{
  const s=setup({});s.ai.chatTools.mockResolvedValue(native('click_element',{index:5}));
  const clickElement=vi.fn(async()=>{});Object.assign(s.browser,{clickElement});
  const page={...ex,controls:[{i:5,text:'Playable package',href:'https://storage.test/orbit.zip',inContent:true}]} as unknown as PageExtract;
  const agent=new BrowserAgent(s.ai as never,s.browser as never,s.session,'computer');
  const blocked=await agent.next(page,'discovery',s.token,'Inspect the game');
  await expect(agent.execute(blocked,page,s.token,false)).rejects.toThrow('cannot start');
  expect(clickElement).not.toHaveBeenCalled();
  const allowed=await agent.next(page,'interactive',s.token,'Download Orbit');
  await agent.execute(allowed,page,s.token,true);
  expect(clickElement).toHaveBeenCalledExactlyOnceWith('interactive',5,s.token.signal);
  s.ai.chatTools.mockResolvedValueOnce(native('click_element',{index:99}));
  const invented=await agent.next(page,'interactive',s.token,'Download Orbit');
  await expect(agent.execute(invented,page,s.token,true)).rejects.toThrow('unobserved');
  expect(clickElement).toHaveBeenCalledTimes(1);
 });
 it('never interacts with a human check: waits for it to clear by itself, then leaves it to the user',async()=>{
  vi.useFakeTimers();
  try {
   const s=setup({action:'left_click',coordinate:[250,500]});
   const gated={...ex,gates:{...ex.gates,captcha:true}} as PageExtract;
   Object.assign(s.browser,{extract:vi.fn().mockResolvedValue(gated)});
   const agent=new LocalGameAgent({...s.ai,specialists:true} as never,s.browser as never,s.session);
   const pending=agent.verify(gated,'interactive',s.token);await vi.advanceTimersByTimeAsync(20_000);
   expect((await pending).gates.captcha).toBe(true);
   expect(s.ai.chatTools).not.toHaveBeenCalled();expect(s.browser.pointer).not.toHaveBeenCalled();expect(s.browser.type).not.toHaveBeenCalled();
  } finally {vi.useRealTimers();}
 });
 it('routes preparation to Holo with a native tool and never accepts an installer index',async()=>{
  const session=new StoreSession(),token=session.enter();clean.push(()=>session.leave());
  const chatTools=vi.fn().mockResolvedValueOnce(native('prepare_game',{reason:'Portable archive'})).mockResolvedValueOnce(native('register_game',{index:1,reason:'Selected launcher'}));
  const agent=new ComputerAgent({chatTools} as never,session);
  await agent.prepare(token,'Orbit',{name:'orbit.zip',type:'zip',bytes:100});
  const candidates=[{path:'/game/start.sh',relPath:'start.sh',kind:'script',size:100,score:0,installerLike:false},{path:'/game/setup.exe',relPath:'setup.exe',kind:'exe',size:100,score:99,installerLike:true}] as const;
  await expect(agent.executable(token,'Orbit',[...candidates])).rejects.toThrow('unobserved or installer');
  expect(chatTools.mock.calls.every(c=>c[1]==='computer')).toBe(true);
  expect(JSON.stringify(chatTools.mock.calls[1][2])).toContain('Extraction completed');
 });
 it('accepts extra fields in tool calls and retries a malformed one instead of failing the install',async()=>{
  const session=new StoreSession(),token=session.enter();clean.push(()=>session.leave());
  const bad={message:{role:'assistant',content:'',tool_calls:[{id:'x',type:'function',function:{name:'register_game',arguments:'{"index": "zero"'}}]},modelId:'fara-1.5-9b'};
  const chatTools=vi.fn()
    // The reply that failed for a real user: the model echoed the observed package type.
    .mockResolvedValueOnce(native('prepare_game',{reason:'RAR archive',type:'archive'}))
    .mockResolvedValueOnce(bad)
    .mockResolvedValueOnce(native('register_game',{index:'0',reason:'Main game',confidence:'high'}));
  const agent=new ComputerAgent({chatTools} as never,session);
  await agent.prepare(token,'X4: Foundations',{name:'X4.rar',type:'archive',bytes:39_730_858_968});
  const chosen=await agent.executable(token,'X4: Foundations',[{path:'/g/X4.exe',relPath:'X4.exe',kind:'exe',size:9,score:1,installerLike:false}]);
  expect(chosen.relPath).toBe('X4.exe');
  expect(chatTools).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(chatTools.mock.calls[2][2])).toContain('could not be used');
 });
 it('asks again when the model answers the unpack step with a browser action',async()=>{
  const session=new StoreSession(),token=session.enter();clean.push(()=>session.leave());
  const chatTools=vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error('Fara returned an invalid tool response; no browser action was taken. Fara returned an unsupported native tool call.'),{code:'agent-response'}))
    .mockResolvedValueOnce(native('prepare_game',{reason:'Split 7z archive'}));
  const agent=new ComputerAgent({chatTools} as never,session);
  await agent.prepare(token,'Nebula Drift',{name:'nebula-drift.7z.001',type:'archive',bytes:122880});
  expect(chatTools).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(chatTools.mock.calls[1][2])).toContain('Call prepare_game now');
 });
 it('keeps browser ownership when inference emits idle before a tool executes',()=>{
  const session=new StoreSession();session.enter();const worker=new EventEmitter();
  const ai=new AiService(worker as never,session,{} as never);
  ai.setStatus({phase:'navigating',context:'interactive',detail:'Clicking Download'});
  worker.emit('event:status',{phase:'idle',detail:null,modelLoaded:true,accel:'cpu'});
  expect(ai.getStatus()).toMatchObject({phase:'navigating',context:'interactive',detail:'Clicking Download',modelLoaded:true});
  ai.setStatus({phase:'paused',context:'interactive',detail:'Complete verification'});
  worker.emit('event:status',{phase:'idle',detail:null,modelLoaded:false,accel:null});
  expect(ai.getStatus()).toMatchObject({phase:'paused',detail:'Complete verification'});
  session.leave();expect(ai.getStatus()).toMatchObject({phase:'idle',context:null});
 });
 it('routes JSON analysis and native browser calls to their assigned local models',async()=>{
  const session=new StoreSession(),token=session.enter();clean.push(()=>session.leave());
  const worker=Object.assign(new EventEmitter(),{call:vi.fn().mockResolvedValueOnce({content:'{"games":[]}'}).mockResolvedValueOnce(native('computer_use',{action:'wait',time:1}))});
  const ai=new AiService(worker as never,session,{get:()=>null,set:()=>{}} as never,()=>DEFAULT_AGENTS);
  await ai.chatJson(token,{system:'Read games',user:'Observed page',schema:{},agent:'analysis'});
  await ai.chatTools(token,'browsing',[],[{type:'function',function:{name:'computer_use',description:'Browser control',parameters:{}}}]);
  expect(worker.call.mock.calls[0][1].modelId).toBe(DEFAULT_AGENTS.analysis);expect(worker.call.mock.calls[1][1].modelId).toBe(DEFAULT_AGENTS.browsing);
  session.leave();await expect(ai.chatTools(token,'computer',[],[])).rejects.toThrow();expect(worker.call).toHaveBeenCalledTimes(2);
 });
});

it('rejects a different mirror during a host-specific sample and lets the model retry', async () => {
 const s=setup({action:'left_click',coordinate:[200,300]});
 const controls=[{i:1,text:'Download mirror A',href:'https://a.test/game.zip',inContent:true},{i:2,text:'Download mirror B',href:'https://b.test/game.zip',inContent:true}];
 const observed={...ex,controls} as PageExtract;
 s.browser.inspectPoint.mockResolvedValueOnce({text:'Download mirror B',password:false,untrustedRegion:false,download:true,index:2} as never);
 const route={pageUrl:ex.url,url:controls[0].href,alternatives:controls.map(c=>c.href),blockedControls:[2]};
 const step=await s.agent.next(observed,'interactive',s.token,'Test mirror A');
 await expect(s.agent.execute(step,observed,s.token,true,route)).rejects.toThrow(/tested separately/);expect(s.browser.pointer).not.toHaveBeenCalled();
 s.browser.inspectPoint.mockResolvedValueOnce({text:'Download mirror A',password:false,untrustedRegion:false,download:true,index:1} as never);
 const retry=await s.agent.next(observed,'interactive',s.token,'Test mirror A');
 await s.agent.execute(retry,observed,s.token,true,route);expect(s.browser.pointer).toHaveBeenCalledOnce();
});

describe('saved page before any game search',()=>{
 const scope={pageUrl:ex.url,url:'',alternatives:[],blockedControls:[],gamePageUrl:ex.url};
 it.each([
  {action:'visit_url',url:'https://games.test/'},
  {action:'visit_url',url:'https://games.test/?s=Orbit'},
  {action:'visit_url',url:'https://games.test/search'},
  {action:'web_search',query:'Orbit download'},
  {action:'key',keys:['Control','l']},
 ])('rejects an unnecessary $action detour while a saved game page exists',async(action)=>{
  const s=setup(action),step=await s.agent.next(ex,'interactive',s.token,'Download indexed Orbit');
  await expect(s.agent.execute(step,ex,s.token,true,scope)).rejects.toThrow(/saved|indexed/);
  expect(s.browser.navigate).not.toHaveBeenCalled();expect(s.browser.type).not.toHaveBeenCalled();
  s.ai.chatTools.mockResolvedValueOnce(native('computer_use',{action:'wait',time:0},'retry'));
  await s.agent.execute(await s.agent.next(ex,'interactive',s.token,'Download indexed Orbit'),ex,s.token,true,scope);
 });
 it('blocks a homepage link found by screenshot even when extraction omitted its control ID',async()=>{
  const s=setup({action:'left_click',coordinate:[250,500]});
  s.browser.inspectPoint.mockResolvedValueOnce({text:'Home',index:null,href:'https://games.test/',password:false,untrustedRegion:false,download:false} as never);
  await expect(s.agent.execute(await s.agent.next(ex,'interactive',s.token,'Download'),ex,s.token,true,scope)).rejects.toThrow(/indexed/);
  expect(s.browser.pointer).not.toHaveBeenCalled();
 });
 it('prevents typing into an unnecessary game search field',async()=>{
  const s=setup({action:'type',text:'Orbit'}),observed={...ex,inputState:{fields:[{id:1,label:'Search games',type:'search',value:'',focused:true}]}} as PageExtract;
  await expect(s.agent.execute(await s.agent.next(observed,'interactive',s.token,'Download'),observed,s.token,true,scope)).rejects.toThrow(/Searching again/);
  expect(s.browser.type).not.toHaveBeenCalled();
 });
 it('allows returning directly from a host to the saved indexed page',async()=>{
  const s=setup({action:'visit_url',url:ex.url}),host={...ex,url:'https://host.test/file/token',links:[]} as PageExtract;
  s.browser.snapshot.mockResolvedValue({png:'image',w:1440,h:900,url:host.url});
  await s.agent.execute(await s.agent.next(host,'interactive',s.token,'Download'),host,s.token,true,scope);
  expect(s.browser.navigate).toHaveBeenCalledWith('interactive',ex.url,s.token.signal);
 });
 it('tells the native agent the stored game URL instead of asking it to find the game',async()=>{
  const s=setup({action:'wait',time:0}),agent=new LocalGameAgent({...s.ai,specialists:true} as never,s.browser as never,s.session);
  await agent.transfer(ex,s.token,'Orbit',[],[],'',ex.url);
  expect(JSON.stringify(s.ai.chatTools.mock.calls[0][2])).toContain('already indexed at '+ex.url);
  expect(JSON.stringify(s.ai.chatTools.mock.calls[0][2])).toContain('only if the saved page is unavailable');
 });
});

it('keeps an observed file-host download query usable while blocking game searches',async()=>{
 const s=setup({action:'visit_url',url:'https://host.test/?file=token'});
 const page={...ex,url:'https://host.test/file/token',cards:[],links:[{i:0,href:'https://host.test/?file=token',text:'Download file',download:false,inContent:true,rect:{x:0,y:0,w:1,h:1},img:null}]} as PageExtract;
 s.browser.snapshot.mockResolvedValue({png:'image',w:1440,h:900,url:page.url});
 const scope={pageUrl:page.url,url:page.url,alternatives:[],blockedControls:[],gamePageUrl:ex.url};
 await s.agent.execute(await s.agent.next(page,'interactive',s.token,'Download'),page,s.token,true,scope);
 expect(s.browser.navigate).toHaveBeenCalledWith('interactive','https://host.test/?file=token',s.token.signal);
});

it('gives Fara measured centers for visible buttons instead of requiring an approximate visual click', async () => {
 const s=setup({action:'left_click',coordinate:[880,345]});
 const page={...ex,viewport:{w:1198,h:914,scrollY:0,docH:914},controls:[{i:4,text:'Download',tag:'button',inViewport:true,inContent:true,rect:{x:1003,y:302,w:102,h:26}}]} as PageExtract;
 s.browser.snapshot.mockResolvedValue({png:'image',w:1198,h:914,url:page.url});
 const step=await s.agent.next(page,'interactive',s.token,'Download Orbit');
 const messages=s.ai.chatTools.mock.calls[0][2] as any[];
 expect(messages[1].content[0].type).toBe('image_url');
 expect(messages[1].content[1].text).toContain('"label":"Download","coordinate":[880,345]');
 await s.agent.execute(step,page,s.token,true);
 expect(s.browser.pointer).toHaveBeenCalledWith('interactive',1054,315,'left',s.token.signal);
});

it('re-observes a resized download viewport before sending stale button coordinates to Fara', async () => {
 const s=setup({action:'left_click',coordinate:[880,345]});
 const page={...ex,viewport:{w:1198,h:914,scrollY:0,docH:914}} as PageExtract;
 await expect(s.agent.next(page,'interactive',s.token,'Download Orbit')).rejects.toMatchObject({name:'BrowserObservationChangedError'});
 expect(s.ai.chatTools).not.toHaveBeenCalled();expect(s.browser.pointer).not.toHaveBeenCalled();
});
