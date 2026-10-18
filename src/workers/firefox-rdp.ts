// Firefox's developer connection stays on a private Unix socket. This transport
// never enables Marionette, changes navigator.webdriver, or inspects user tabs.
import {createConnection,type Socket} from 'node:net';

export class FirefoxRdp {
  private socket:Socket;
  private buffer=Buffer.alloc(0);
  private waiting:Array<{matches:(packet:any)=>boolean;resolve:(packet:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>=[];
  private packets:any[]=[];
  private chain:Promise<unknown>=Promise.resolve();
  private constructor(path:string){
    this.socket=createConnection(path);
    this.socket.on('data',chunk=>{try{this.receive(chunk)}catch(error){this.fail(error as Error);this.socket.destroy()}});
    this.socket.on('error',error=>this.fail(error));
    this.socket.on('close',()=>this.fail(Error('Launcher Firefox connection closed')));
  }
  static async connect(path:string){const connection=new FirefoxRdp(path);try{await connection.packet(p=>p.from==='root'&&p.applicationType==='browser');return connection}catch(error){connection.close();throw error}}
  private receive(chunk:Buffer){
    this.buffer=Buffer.concat([this.buffer,chunk]);
    for(;;){const colon=this.buffer.indexOf(58);if(colon<0){if(this.buffer.length>12)throw Error('Invalid Firefox response');return}
      const header=this.buffer.subarray(0,colon).toString();if(!/^\d+$/.test(header))throw Error('Invalid Firefox response');const length=Number(header);
      if(length>32*1024*1024)throw Error('Firefox response too large');if(this.buffer.length<colon+1+length)return;
      const packet=JSON.parse(this.buffer.subarray(colon+1,colon+1+length).toString());this.buffer=this.buffer.subarray(colon+1+length);
      const index=this.waiting.findIndex(w=>w.matches(packet));if(index>=0){const [w]=this.waiting.splice(index,1);clearTimeout(w.timer);w.resolve(packet)}
      else if(packet.applicationType||packet.type==='evaluationResult')this.packets.push(packet);
    }
  }
  private fail(error:Error){for(const w of this.waiting){clearTimeout(w.timer);w.reject(error)}this.waiting=[];this.packets=[]}
  private packet(matches:(packet:any)=>boolean,timeout=15000):Promise<any>{
    const index=this.packets.findIndex(matches);if(index>=0)return Promise.resolve(this.packets.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{const w={matches,resolve,reject,timer:setTimeout(()=>{this.waiting=this.waiting.filter(x=>x!==w);reject(Error('Launcher Firefox connection timed out'))},timeout)};this.waiting.push(w)});
  }
  request(to:string,type:string,args:Record<string,unknown>={}):Promise<any>{
    const run=async()=>{const response=this.packet(p=>p.from===to&&!p.type);const body=Buffer.from(JSON.stringify({to,type,...args}));this.socket.write(Buffer.concat([Buffer.from(body.length+':'),body]));const result=await response;if(result.error)throw Error(result.message||result.error);return result};
    const next=this.chain.then(run,run);this.chain=next.catch(()=>undefined);return next;
  }
  async bootstrap(source:string,awaitPromise=false){
    const {processDescriptor}=await this.request('root','getProcess',{id:0});
    const {process}=await this.request(processDescriptor.actor,'getTarget');
    const response=await this.request(process.consoleActor,'evaluateJSAsync',{text:source,...(awaitPromise?{mapped:{await:true}}:{})});
    const result=await this.packet(p=>p.type==='evaluationResult'&&p.resultID===response.resultID);
    if(result.hasException||result.exception)throw Error(typeof result.exceptionMessage==='string'?result.exceptionMessage:'Firefox could not start the launcher connection');
    return result.result;
  }
  close(){this.fail(Error('Launcher Firefox connection closed'));this.socket.destroy()}
}
