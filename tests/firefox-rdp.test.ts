import {describe,it,expect} from 'vitest';
import {createServer,type Socket} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FirefoxRdp} from '../src/workers/firefox-rdp';
import {connectionPreferences} from '../src/workers/installed-firefox';

async function peer(fail=false){
  const dir=mkdtempSync(join(tmpdir(),'cgl-rdp-')),path=join(dir,'bridge.sock');const sockets:Socket[]=[];const requests:any[]=[];
  const server=createServer(socket=>{sockets.push(socket);let buffer=Buffer.alloc(0);const send=(p:unknown)=>{const b=Buffer.from(JSON.stringify(p));const wire=Buffer.concat([Buffer.from(b.length+':'),b]);socket.write(wire.subarray(0,3));socket.write(wire.subarray(3))};
    send({from:'root',applicationType:'browser'});
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const colon=buffer.indexOf(58);if(colon<0)return;const n=Number(buffer.subarray(0,colon));if(buffer.length<colon+1+n)return;const p=JSON.parse(buffer.subarray(colon+1,colon+1+n).toString());buffer=buffer.subarray(colon+1+n);requests.push(p);
      if(p.type==='getProcess')send({from:p.to,processDescriptor:{actor:'descriptor'}});
      else if(p.type==='getTarget')send({from:p.to,process:{consoleActor:'console'}});
      else if(p.type==='evaluateJSAsync'){
        send({from:'console',type:'frameUpdate',frames:[]});
        // The result may arrive in the same chunk before its waiter is set up.
        send({from:'console',resultID:'eval1'});send({from:'console',type:'evaluationResult',resultID:'eval1',hasException:fail,exceptionMessage:fail?'Fixture rejected bootstrap':undefined,result:'connected ✓'});
      }
    }});
  });await new Promise<void>(r=>server.listen(path,r));
  return {path,requests,close:async()=>{sockets.forEach(s=>s.destroy());await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})}};
}
describe('Private launcher Firefox connection',()=>{
  it('uses Firefox parent-process developer messages and handles fragmented Unicode results',async()=>{
    const p=await peer();let c:FirefoxRdp|undefined;try{c=await FirefoxRdp.connect(p.path);expect(await c.bootstrap('fixture')).toBe('connected ✓');expect(p.requests.map(r=>r.type)).toEqual(['getProcess','getTarget','evaluateJSAsync']);expect(p.requests[0].id).toBe(0)}finally{c?.close();await p.close()}
  });
  it('reports failed browser bootstraps instead of pretending the bridge connected',async()=>{
    const p=await peer(true);let c:FirefoxRdp|undefined;try{c=await FirefoxRdp.connect(p.path);await expect(c.bootstrap('fixture')).rejects.toThrow('Fixture rejected bootstrap')}finally{c?.close();await p.close()}
  });
  it('adds only local connection preferences, preserving existing browser preferences on repeated setup',()=>{
    const original='// user preferences\nuser_pref("privacy.trackingprotection.enabled", true);\nuser_pref("browser.startup.page", 3);\n';
    const prepared=connectionPreferences(original);expect(prepared).toContain(original.trim());expect(connectionPreferences(prepared)).toBe(prepared);expect(prepared.match(/devtools.debugger.remote-enabled/g)).toHaveLength(1);expect(prepared).toContain('"devtools.debugger.force-local", true');expect(prepared).not.toMatch(/useragent|webdriver|marionette|sandbox/);
  });
});
