import {createHash} from 'node:crypto';
import type {PageExtract, ExtractControl} from '@shared/page-extract';
import {downloadControls, isCatalogNavigation, excludedDownloadLabel,isTorrentDownload} from '@shared/download-evidence';
import type {BrowserRouteConstraint} from './browser-agent';

interface FlowCache {get<T>(key:string,maxAgeHours?:number):T|null;set(key:string,value:unknown):void}
interface Selector {label:string;tag:string;destination:string}
interface LearnedStep {version:1;selector:Selector}
const selector=(ex:PageExtract,c:ExtractControl):Selector=>({label:c.text.replace(/\s+/g,' ').trim().toLowerCase(),tag:c.tag,destination:!c.href?'script':new URL(c.href).origin===new URL(ex.url).origin?'same-site':new URL(c.href).origin});
const eligible=(ex:PageExtract)=>ex.controls.filter(c=>c.inContent!==false&&!excludedDownloadLabel(c.text)&&!isTorrentDownload(c.text,c.href)&&!isCatalogNavigation(ex,c)&&! /\b(?:buy|purchase|checkout|subscribe|sign ?(?:in|up)|log ?in|register|installer|captcha|verify|verification|search)\b/i.test(c.text));
const keyFor=(ex:PageExtract)=>'download-flow:v1:'+createHash('sha256').update(JSON.stringify([new URL(ex.url).origin,[...new Set(downloadControls(ex).map(c=>JSON.stringify(selector(ex,c))))].sort()])).digest('hex');
const stateFor=(ex:PageExtract)=>JSON.stringify([ex.url,ex.text,ex.controls.map(c=>[c.text,c.href])]);

/** Semantic controls learned only from routes that produced a game file.
 * Signed URLs, DOM IDs and screen coordinates are never replayed.
 */
export class DownloadFlowMemory {
  private cache:FlowCache;
  private draft=new Map<string,LearnedStep>();
  private attempted=new Set<string>();
  private pending?:{key:string;step:LearnedStep;state:string;replayed:boolean};
  constructor(cache?:FlowCache){const values=new Map<string,unknown>();this.cache=cache??{get:<T>(k:string)=>(values.get(k) as T)??null,set:(k,v)=>{values.set(k,v)}};}
  reset(){this.draft.clear();this.attempted.clear();this.pending=undefined;}
  observe(ex:PageExtract){
    if(!this.pending)return;
    if(this.pending.state!==stateFor(ex))this.draft.set(this.pending.key,this.pending.step);
    else if(this.pending.replayed)this.cache.set(this.pending.key,null);
    this.pending=undefined;
  }
  record(ex:PageExtract,c:ExtractControl,replayed=false){
    if(Object.values(ex.gates).some(Boolean)||!eligible(ex).some(x=>x.i===c.i))return;
    const step:LearnedStep={version:1,selector:selector(ex,c)};
    if(eligible(ex).filter(x=>JSON.stringify(selector(ex,x))===JSON.stringify(step.selector)).length!==1)return;
    this.pending={key:keyFor(ex),step,state:stateFor(ex),replayed};
  }
  suggest(ex:PageExtract,route?:BrowserRouteConstraint):ExtractControl|null{
    if(Object.values(ex.gates).some(Boolean))return null;
    const key=keyFor(ex),attempt=ex.url+'|'+key;
    if(this.attempted.has(attempt))return null;
    const learned=this.cache.get<LearnedStep>(key,24*30);
    if(learned?.version!==1)return null;
    const matches=eligible(ex).filter(c=>JSON.stringify(selector(ex,c))===JSON.stringify(learned.selector));
    if(matches.length!==1)return null;
    const c=matches[0];
    if(route&&ex.url.split('#')[0]===route.pageUrl.split('#')[0]&&(route.blockedControls.includes(c.i)||c.href&&c.href!==route.url&&route.alternatives.includes(c.href)))return null;
    // A host selector's current Download anchor may still belong to the
    // previous mirror. Replay only the requested selector on this page.
    const scriptRoute=route&&/#cgl-control-(\d+)$/.exec(route.url);
    if(scriptRoute&&ex.url.split('#')[0]===route!.pageUrl.split('#')[0]&&c.i!==Number(scriptRoute[1]))return null;
    this.attempted.add(attempt);return c;
  }
  verified(){
    if(this.pending)this.draft.set(this.pending.key,this.pending.step);
    for(const [key,step] of this.draft)this.cache.set(key,step);
    this.draft.clear();this.pending=undefined;
  }
}
