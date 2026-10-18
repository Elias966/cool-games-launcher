import {describe,it,expect} from 'vitest';
import {DownloadFlowMemory} from '../src/main/download-flow';
import type {PageExtract,ExtractControl} from '@shared/page-extract';
const control=(i:number,text='Download',href:string|null=null):ExtractControl=>({i,text,href,tag:'button',inViewport:false,inContent:true,rect:{x:10,y:1000,w:100,h:30}});
const page=(url='https://host.test/file/one',controls=[control(1)]):PageExtract=>({url,title:'File',site:null,meta:{},jsonLd:[],cards:[],cardConfidence:0,nextPage:null,game:null,controls,links:[],fileLinks:[],gates:{login:false,captcha:false,payment:false,ageGate:false,blocked:false},adultSignals:[],text:'Download package',media:[],viewport:{w:1280,h:800,scrollY:0,docH:2000}});
function cache(){const values=new Map<string,unknown>();return {values,get:<T>(k:string)=>(values.get(k) as T)??null,set:(k:string,v:unknown)=>{values.set(k,v)}};}
describe('verified download flow learning',()=>{
 it('learns unfamiliar button labels after successful AI navigation, without a hardcoded host layout',()=>{
  const c=cache(),m=new DownloadFlowMemory(c),ex=page('https://new-host.test/one',[control(1,'Receive playable package')]);
  m.record(ex,ex.controls[0]);m.verified();
  expect(new DownloadFlowMemory(c).suggest(page('https://new-host.test/two',[control(52,'Receive playable package')]))?.i).toBe(52);
 });
 it('persists successful semantic steps across restarts and new game URLs/IDs',()=>{
  const c=cache(),m=new DownloadFlowMemory(c),first=page();m.record(first,first.controls[0]);
  expect(new DownloadFlowMemory(c).suggest(page())).toBeNull();m.verified();
  const next=page('https://host.test/file/two',[control(49)]),restarted=new DownloadFlowMemory(c);
  expect(restarted.suggest(next)?.i).toBe(49);expect(restarted.suggest(next)).toBeNull();
  expect(JSON.stringify([...c.values])).not.toContain('/file/one');
 });
 it('does not reuse ambiguous, changed, gated or unrelated page layouts',()=>{
  const c=cache(),m=new DownloadFlowMemory(c),ex=page();m.record(ex,ex.controls[0]);m.verified();
  expect(m.suggest(page(ex.url,[control(2),control(3)]))).toBeNull();
  expect(m.suggest(page(ex.url,[control(2,'Download premium')]))).toBeNull();
  expect(m.suggest({...ex,gates:{...ex.gates,captcha:true}})).toBeNull();
  expect(m.suggest(page('https://other.test/file'))).toBeNull();
 });
 it('invalidates a replay that did not change the page and falls back to AI',()=>{
  const c=cache(),m=new DownloadFlowMemory(c),ex=page();m.record(ex,ex.controls[0]);m.verified();
  const candidate=m.suggest(ex)!;m.record(ex,candidate,true);m.observe(ex);
  expect(new DownloadFlowMemory(c).suggest(ex)).toBeNull();
 });
 it('learns only progressing steps on a verified route; discards failed routes',()=>{
  const c=cache(),m=new DownloadFlowMemory(c),ex=page();m.record(ex,ex.controls[0]);m.observe({...ex,text:'Generating link'});
  m.reset();m.verified();expect(c.values.size).toBe(0);
  m.record(ex,ex.controls[0]);m.observe({...ex,text:'Generating link'});m.verified();expect(c.values.size).toBe(1);
 });
 it('preserves individual mirror constraints and multipart selection',()=>{
  const c=cache(),m=new DownloadFlowMemory(c),ex=page('https://games.test/game',[control(5,'Mirror one','https://host.test/one'),control(6,'Mirror two','https://other.test/two')]);
  m.record(ex,ex.controls[0]);m.verified();
  expect(m.suggest(ex,{pageUrl:ex.url,url:ex.controls[1].href!,alternatives:[ex.controls[0].href!],blockedControls:[5]})).toBeNull();
  expect(m.suggest(page(ex.url,[control(5,'Download part 2')]))).toBeNull();
 });
 it('never replays the previous host download anchor while another host tab is being tested',()=>{
  const c=cache(),m=new DownloadFlowMemory(c),ex=page('https://hub.test/game',[control(1,'Vikingfile 1'),control(2,'Datavaults 1'),control(3,'Download','https://vikingfile.com/f/one')]);
  m.record(ex,ex.controls[2]);m.verified();
  expect(m.suggest(ex,{pageUrl:ex.url,url:ex.url+'#cgl-control-2',alternatives:[ex.url+'#cgl-control-1'],blockedControls:[1]})).toBeNull();
 });
});
