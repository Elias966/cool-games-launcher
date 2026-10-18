import {describe,it,expect} from 'vitest';
import {LocalBrowserBridge} from '../src/workers/normal-firefox';
import {requests} from '../src/shared/ipc';
import {defaultSettings,SettingsRepo} from '../src/main/repos';
import {openDb} from '../src/main/db';
import {installedFirefoxProfile} from '../src/workers/installed-firefox';

describe('Browser mode settings',()=>{
  it('keeps existing profiles in AI mode and validates both explicit modes',()=>{
    expect(defaultSettings({games:'/tmp/games',downloads:'/tmp/downloads'}).browserMode).toBe('ai');
    for(const browserMode of ['ai','normal','installed'])expect(requests['settings:update'].parse({browserMode})).toEqual({browserMode});
    expect(()=>requests['settings:update'].parse({browserMode:'stealth'})).toThrow();
    expect(()=>requests['settings:update'].parse({browserMode:'personal'})).toThrow();
  });
  it('moves the retired personal-profile experiment to an isolated installed-browser profile',()=>{
    const db=openDb(':memory:');try{
      db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('browserMode',JSON.stringify('personal'));
      expect(new SettingsRepo(db,defaultSettings({games:'/tmp/games',downloads:'/tmp/downloads'})).get().browserMode).toBe('installed');
      expect(installedFirefoxProfile('/home/fixture',true)).toBe('/home/fixture/snap/firefox/common/cool-games-launcher-browser');
    }finally{db.close()}
  });
});
describe('Private normal-browser connection',()=>{
  it('rejects websites and unauthenticated local clients, then pairs commands with their results',async()=>{
    const bridge=new LocalBrowserBridge();const config=await bridge.listen('/tmp/isolated-profile');const base=`http://127.0.0.1:${config.port}`;
    const headers={Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'};
    try{
      expect((await fetch(base+'/poll')).status).toBe(403);
      expect((await fetch(base+'/poll',{headers:{...headers,Origin:'https://untrusted.test'}})).status).toBe(403);
      expect((await fetch(base+'/poll',{method:'OPTIONS'})).status).toBe(403);
      await fetch(base+'/ready',{method:'POST',headers,body:'{}'});await bridge.ready;
      const result=bridge.command({op:'url'});const command=await (await fetch(base+'/poll',{headers})).json();
      expect(command.command).toEqual({op:'url'});
      await fetch(base+'/result',{method:'POST',headers,body:JSON.stringify({id:command.id,value:'https://fixture.test/game'})});
      expect(await result).toBe('https://fixture.test/game');
    }finally{bridge.close();}
  });
  it('drops timed-out requests and rejects pending work when closed',async()=>{
    const bridge=new LocalBrowserBridge();await bridge.listen('/tmp/isolated-profile');
    try{await expect(bridge.command({op:'never'},10)).rejects.toThrow('timed out');
      const pending=bridge.command({op:'pending'});const rejected=expect(pending).rejects.toThrow('closed');bridge.close();await rejected;
    }finally{bridge.close();}
  });
});

describe('Long installed-Firefox profile paths', () => {
  it('binds and connects through short proc paths to the same private socket with a long Unicode profile path', async () => {
    const fs = await import('node:fs'), net = await import('node:net'), { spawn } = await import('node:child_process');
    const { tmpdir } = await import('node:os'), { join } = await import('node:path');
    const { privateFirefoxSocket } = await import('../src/workers/installed-firefox');
    const root = fs.mkdtempSync(join(tmpdir(), 'cgl-long-profile-'));
    const dir = join(root, 'ملف-شخصي-'.repeat(10), 'chrome/cgl-launcher');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const socket = privateFirefoxSocket(dir);
    const child = spawn(process.execPath, ['-e', `require('net').createServer(s=>s.end('connected')).listen(${JSON.stringify(socket.listenPath)},()=>process.stdout.write('ready'))`], { cwd: socket.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      expect(Buffer.byteLength(socket.file)).toBeGreaterThan(103);
      expect(Buffer.byteLength(socket.listenPath)).toBeLessThan(104);
      expect(Buffer.byteLength(socket.connectPath)).toBeLessThan(104);
      await new Promise<void>((r,j) => { child.stdout.once('data', () => r()); child.once('error',j); child.once('exit', code => j(Error('Listener exited: ' + code))); });
      expect(fs.lstatSync(socket.file).isSocket()).toBe(true);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      const value = await new Promise<string>((r,j) => { const c = net.createConnection(socket.connectPath); c.on('error',j); c.on('data', b => r(b.toString())); });
      expect(value).toBe('connected');
    } finally { socket.close(); socket.close(); child.kill(); await new Promise(r => child.once('exit',r)); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps the existing socket address for short profiles', async () => {
    const { privateFirefoxSocket } = await import('../src/workers/installed-firefox');
    const s = privateFirefoxSocket('/home/test/launcher');
    expect(s.listenPath).toBe('/home/test/launcher/control.sock');
    expect(s.connectPath).toBe(s.file); expect(s.cwd).toBeUndefined(); s.close();
  });
});
