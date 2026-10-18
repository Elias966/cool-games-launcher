// Ordinary Firefox launch with an authenticated, worker-owned local bridge.
// Website documents cannot issue bridge requests or execute privileged code.
import {createServer, type ServerResponse} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {writeFileSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {FirefoxRdp} from './firefox-rdp';
import type {WebDriver} from 'selenium-webdriver';

type Command = Record<string,unknown>;
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export class LocalBrowserBridge {
  private token=randomBytes(32).toString('hex');
  private server=createServer((req,res)=>void this.handle(req,res));
  private poll:ServerResponse|null=null;
  private queued:Array<{id:number;command:Command}>=[];
  private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private sequence=0;
  private readyResolve!:()=>void;private readyReject!:(error:Error)=>void;
  readonly ready=new Promise<void>((r,j)=>{this.readyResolve=r;this.readyReject=j});
  constructor(){this.ready.catch(()=>undefined);}
  async listen(profile:string) {
    await new Promise<void>((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve);});
    return {port:(this.server.address() as import('node:net').AddressInfo).port,token:this.token,profile};
  }
  private flush(){if(this.poll&&this.queued.length){const res=this.poll;this.poll=null;res.end(JSON.stringify(this.queued.shift()));}}
  private async handle(req:import('node:http').IncomingMessage,res:ServerResponse) {
    const provided=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+this.token);
    if(req.headers.origin||provided.length!==expected.length||!timingSafeEqual(provided,expected)){res.writeHead(403);res.end();return;}
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    if(req.method==='GET'&&req.url==='/poll'){
      if(this.poll){res.writeHead(409);res.end();return;}
      this.poll=res;const timer=setTimeout(()=>{if(this.poll===res){this.poll=null;res.end('null')}},25000);
      res.once('close',()=>{clearTimeout(timer);if(this.poll===res)this.poll=null});this.flush();return;
    }
    if(req.method!=='POST'||!['/ready','/result'].includes(req.url??'')){res.writeHead(404);res.end();return;}
    try{
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024)throw Error('Browser response too large');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());
      if(req.url==='/ready')body.error?this.readyReject(Error(body.error)):this.readyResolve();
      else {const pending=this.pending.get(body.id);if(pending){clearTimeout(pending.timer);this.pending.delete(body.id);body.error?pending.reject(Error(body.error)):pending.resolve(body.value);}}
      res.end('{}');
    }catch{res.writeHead(400);res.end();}
  }
  command(command:Command,timeout=35000):Promise<any>{
    return new Promise((resolve,reject)=>{const id=++this.sequence;const timer=setTimeout(()=>{this.pending.delete(id);this.queued=this.queued.filter(x=>x.id!==id);reject(Error('Normal Firefox command timed out'))},timeout);this.pending.set(id,{resolve,reject,timer});this.queued.push({id,command});this.flush();});
  }
  close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Firefox control connection closed'));}this.pending.clear();this.queued=[];if(this.poll){this.poll.end('null');this.poll=null;}this.server.closeAllConnections();this.server.close();}
}

class NormalElement {
  constructor(readonly owner:NormalFirefox,readonly id:string){}
  getAttribute(name:string){return this.owner.executeScript<string|null>('return arguments[0].getAttribute(arguments[1])',this,name);}
  getText(){return this.owner.executeScript<string>('return arguments[0].innerText || arguments[0].textContent || ""',this);}
  async click(){const r=await this.owner.executeScript<{x:number;y:number}>('const r=arguments[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}',this);await this.owner.actions().move(r).press(0).release(0).perform();}
}

export class NormalFirefox {
  private attached=false;private ownsProcess=false;private rdp:FirefoxRdp|null=null;
  private context='content'; private timeouts={pageLoad:30000,script:15000};private child:ChildProcess|null=null;
  private bridge=new LocalBrowserBridge();private configFile='';private handle='';
  private encode(value:any):any{if(value instanceof NormalElement)return {__cglElement:value.id};if(Array.isArray(value))return value.map(v=>this.encode(v));return value;}
  private decode(value:any):any{if(value&&typeof value.__cglElement==='string')return new NormalElement(this,value.__cglElement);if(Array.isArray(value))return value.map(v=>this.decode(v));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.decode(v)]));return value;}
  private call(command:Command,timeout?:number){if(process.env.CGL_DEBUG)process.stderr.write('[normal] '+command.op+'\n');return this.bridge.command(command,timeout);}
  static async start(config:{firefoxPath:string;profileDir:string;width:number;height:number;headless?:boolean}) {
    if(!existsSync(join(dirname(config.firefoxPath),'cgl-browser.cfg')))throw Error('Normal browser integration is missing. Rebuild the bundled Firefox files.');
    const d=new NormalFirefox();const auth=await d.bridge.listen(config.profileDir);d.configFile=join(config.profileDir,'cgl-control.json');writeFileSync(d.configFile,JSON.stringify(auth),{mode:0o600});
    d.child=spawn(config.firefoxPath,['-profile',config.profileDir,'-no-remote',`--width=${config.width}`,`--height=${config.height}`,...(config.headless?['-headless']:[])],{env:{...process.env,CGL_BROWSER_CONTROL:d.configFile},stdio:['ignore','pipe','pipe']});
    let errorText='';const capture=(b:Buffer)=>{const s=String(b);if(s.includes('[cgl-normal]'))errorText=s.slice(0,500);if(process.env.CGL_DEBUG)process.stderr.write(s)};d.child.stderr?.on('data',capture);d.child.stdout?.on('data',capture);
    const exited=new Promise<never>((_,reject)=>{d.child!.once('error',e=>reject(e));d.child!.once('exit',()=>reject(Error(errorText||'Normal Firefox closed')))});
    exited.catch(()=>undefined);const deadline=setTimeout(()=>d.bridge.close(),20000);
    try{await Promise.race([d.bridge.ready,exited,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error(errorText||'Normal Firefox did not connect')),20000).unref())]);d.handle=await d.call({op:'selected'});d.child.once('exit',()=>d.bridge.close());return d;}
    catch(error){d.child.kill('SIGTERM');d.bridge.close();rmSync(d.configFile,{force:true});throw error;}
    finally{clearTimeout(deadline);}
  }
  static async attach(config:{socketPath:string;profileDir:string;bridgeDir:string;hideStartupWindows?:boolean;ownsProcess?:boolean}) {
    const d=new NormalFirefox();d.attached=true;d.ownsProcess=!!config.ownsProcess;
    const auth=await d.bridge.listen(config.profileDir);
    let rdp:FirefoxRdp|undefined;
    try {
      rdp=await FirefoxRdp.connect(config.socketPath);
      const options={config:{...auth,hideStartupWindows:!!config.hideStartupWindows,width:1440,height:1000},resourceDir:join(config.bridgeDir,'cgl-browser')};
      const source=readFileSync(join(config.bridgeDir,'cgl-browser.cfg'),'utf8');
      const bootstrap=`(()=>{const w=Services.wm.getMostRecentWindow('navigator:browser');const box=Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(),{sandboxPrototype:w,wantXrays:false});Object.assign(box,{Services,ChromeUtils,Ci,Cu,__CGL_PERSONAL:${JSON.stringify(options)}});Cu.evalInSandbox(${JSON.stringify(source)},box);return true})()`;
      await rdp.bootstrap(bootstrap);
      await Promise.race([d.bridge.ready,delay(20000).then(()=>{throw Error('Installed Firefox did not connect')})]);
      d.handle=await d.call({op:'selected'});d.rdp=rdp;return d;
    }catch(error){rdp?.close();d.bridge.close();throw error}
  }
  get personal(){return this.attached;}
  paint(){return this.call({op:'frame'});}
  hasDialog():Promise<boolean>{return this.call({op:'dialog'});}
  selectedWindowHandle():Promise<string>{return this.call({op:'selected'});}
  selectedUrl():Promise<string>{return this.call({op:'selectedUrl'});}
  nativeVisibility(visible:boolean){return this.call({op:'visibility',visible});}
  setContext(context:string){this.context=context;return Promise.resolve();}
  async executeScript<T=any>(source:string,...args:any[]):Promise<T>{return this.decode(await this.call({op:'script',context:this.context,source,args:args.map(v=>this.encode(v)),timeout:this.timeouts.script}));}
  async executeAsyncScript<T=any>(source:string,...args:any[]):Promise<T>{return this.decode(await this.call({op:'script',async:true,context:this.context,source,args:args.map(v=>this.encode(v)),timeout:this.timeouts.script}));}
  async getWindowHandle(){return this.handle;}
  getAllWindowHandles():Promise<string[]>{return this.call({op:'handles'});}
  getCurrentUrl():Promise<string>{return this.call({op:'url'});}
  getTitle():Promise<string>{return this.call({op:'title'});}
  async readSelected<T>(source:string):Promise<T>{return this.call({op:'selectedScript',source});}
  switchTo(){return {window:async(handle:string)=>{await this.call({op:'switch',handle});this.handle=handle;},newWindow:async(_type:string)=>{this.handle=await this.call({op:'newTab'});}};}
  manage(){return {setTimeouts:async(t:Partial<typeof this.timeouts>)=>{Object.assign(this.timeouts,t)},window:()=>({maximize:()=>this.call({op:'maximize'})})};}
  async get(url:string){
    const previous=await this.call({op:'state'});const previousUrl=previous.url;await this.call({op:'load',url});
    await this.wait(async()=>{try{const state=await this.call({op:'state'});const page=await this.executeScript<{url:string;ready:boolean}>('return {url:location.href,ready:document.readyState!=="loading"}');
      return page.ready&&new URL(page.url).protocol===new URL(url).protocol&&(page.url!==previousUrl||state.document!==previous.document);
    }catch{return false}},this.timeouts.pageLoad,'Page load timed out',80);
  }
  private async history(action:'back'|'forward'|'reload'){
    const previous=await this.call({op:'state'});if(!await this.call({op:'history',action}))return;
    await this.wait(async()=>{try{const state=await this.call({op:'state'});const page=await this.executeScript<{url:string;ready:boolean}>('return {url:location.href,ready:document.readyState!=="loading"}');return page.ready&&(state.document!==previous.document||page.url!==previous.url);}catch{return false}},this.timeouts.pageLoad,'History navigation timed out',80);
  }
  navigate(){return {back:()=>this.history('back'),forward:()=>this.history('forward'),refresh:()=>this.history('reload')};}
  close(){return this.call({op:'close'});}
  takeScreenshot():Promise<string>{return this.call({op:'screenshot'});}
  sleep(ms:number){return delay(ms);}
  async wait(fn:()=>unknown|Promise<unknown>,ms:number,message='Browser wait timed out',gap=50){const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await delay(gap)}throw Error(message);}
  async findElements(by:{value:string}){return this.executeScript<NormalElement[]>('return [...document.querySelectorAll(arguments[0])]',by.value);}
  actions(_options?:unknown){
    const items:Command[]=[];const add=(item:Command)=>{items.push(item);return actions};
    const actions={move:(p:{x:number;y:number;origin?:unknown})=>add({kind:'move',x:p.x,y:p.y}),press:(button=0)=>add({kind:'press',button}),release:(button=0)=>add({kind:'release',button}),scroll:(x:number,y:number,dx:number,dy:number)=>add({kind:'scroll',x,y,dx,dy}),keyDown:(key:string)=>add({kind:'down',key}),keyUp:(key:string)=>add({kind:'up',key}),sendKeys:(text:string)=>add({kind:'text',text}),perform:async()=>{try{await this.call({op:'actions',actions:items})}finally{items.length=0}}};return actions;
  }
  async quit(){if(this.attached){try{await this.call({op:'quit'},2000).catch(()=>undefined);await delay(150);if(this.ownsProcess)await this.rdp?.bootstrap('Services.startup.quit(Ci.nsIAppStartup.eForceQuit)').catch(()=>undefined)}finally{this.rdp?.close();this.rdp=null;this.bridge.close()}return;}const child=this.child;this.child=null;try{if(child?.exitCode===null){await this.call({op:'quit'},2000).catch(()=>undefined);await Promise.race([new Promise(r=>child.once('exit',r)),delay(4000)]);if(child.exitCode===null)child.kill('SIGTERM');}}finally{this.bridge.close();if(this.configFile)rmSync(this.configFile,{force:true});}}
  terminate(){if(this.attached){void this.call({op:'quit'},1000).catch(()=>undefined).finally(()=>{this.rdp?.close();this.rdp=null;this.bridge.close()});return;}this.child?.kill('SIGTERM');this.child=null;this.bridge.close();if(this.configFile)rmSync(this.configFile,{force:true});}
  asDriver(){return this as unknown as WebDriver;}
}
