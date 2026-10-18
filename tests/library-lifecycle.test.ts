import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, dialog: { showOpenDialog: vi.fn() }, shell: {} }));
vi.mock('../src/main/shortcuts', () => ({ removeShortcuts: vi.fn(), createShortcut: vi.fn() }));
import { openDb } from '../src/main/db';
import { GamesRepo, defaultSettings } from '../src/main/repos';
import { Library } from '../src/main/library';
const cleanup: Array<()=>void>=[];
afterEach(()=>{cleanup.splice(0).reverse().forEach(fn=>fn());vi.restoreAllMocks();});
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'cgl-life-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const db=openDb(join(dir,'db'));cleanup.push(()=>db.close());const games=new GamesRepo(db);
 const game=games.create({catalogId:null,downloadId:null,title:'Game',kind:'linux',installDir:join(dir,'game'),executable:join(dir,'game/run'),args:'',runner:'native',prefixDir:null,managed:true,artworkFile:null,sourceHost:null,status:'installed',candidates:[]});
 const worker=Object.assign(new EventEmitter(),{call:vi.fn(async()=>({}))});
 const settings={get:()=>({...defaultSettings({games:dir,downloads:dir}),saveBackups:false})};
 const policy=Object.assign(new EventEmitter(),{policy:()=>({showNsfw:false,revision:1})});
 const library=new Library(worker as never,games,{list:()=>[]} as never,Object.assign(new EventEmitter(),{broadcastList:()=>{}}) as never,{} as never,settings as never,policy as never,()=>null,{installed:()=>[]} as never,{agent:{} as never,session:new EventEmitter() as never});
 return {library,games,game,worker};
}
describe('Library operation races',()=>{
 it('accepts an original-source update whose browser checkpoint moved to a file host', async () => {
  const t=setup(),executable=join(t.game.installDir!,'..','new-game');writeFileSync(executable,'new program');
  const fp=(version:string)=>({version,scheme:'semantic',files:[],sizes:[],updated:null,at:new Date().toISOString()});
  t.games.update(t.game.id,{sourceHost:'original.test',installedVersion:fp('2.0') as any});
  (t.library as any).downloadsRepo={get:()=>({id:77,sourceHost:'original.test',resolution:{pageUrl:'https://file-host.test/download',buildVersion:fp('3.0')}})};
  vi.spyOn(t.library as any,'backupSaves').mockRejectedValue(new Error('Reached save backup'));
  await expect((t.library as any).applyPreparedUpdate(t.game.id,{executable,installDir:join(executable,'..'),downloadId:77})).rejects.toThrow('Reached save backup');
  expect(t.worker.call).not.toHaveBeenCalled();
 });
 it.each(['older', 'other-website'])('rejects a resumed %s update before touching saves or game files', async scenario => {
  const t=setup(),executable=join(t.game.installDir!,'..','new-game');writeFileSync(executable,'new program');
  const fingerprint=(version:string)=>({version,scheme:'semantic',files:[],sizes:[],updated:null,at:new Date().toISOString()});
  t.games.update(t.game.id,{sourceHost:'original.test',installedVersion:fingerprint('2.0') as any});
  (t.library as any).downloadsRepo={get:()=>({id:77,sourceHost:scenario==='other-website'?'elsewhere.test':'original.test',resolution:{pageUrl:scenario==='other-website'?'https://elsewhere.test/game':'https://original.test/game',buildVersion:fingerprint(scenario==='older'?'1.0':'3.0')}})};
  await expect((t.library as any).applyPreparedUpdate(t.game.id,{executable,installDir:join(executable,'..'),downloadId:77})).rejects.toThrow(/installed game is unchanged/);
  expect(t.worker.call).not.toHaveBeenCalled();expect(t.games.get(t.game.id)?.executable).toBe(t.game.executable);
 });
 it('prevents duplicate starts and uninstall while a launch is still preparing',async()=>{
  const t=setup();let finish!:()=>void;
  const start=vi.spyOn(t.library as unknown as {launchGame:(id:number)=>Promise<void>},'launchGame').mockImplementation(()=>new Promise<void>(r=>{finish=r;}));
  const pending=t.library.launch(t.game.id);expect(t.library.isRunning(t.game.id)).toBe(true);
  await expect(t.library.launch(t.game.id)).rejects.toThrow(/already/);
  await expect(t.library.uninstall(t.game.id,false)).rejects.toThrow(/Stop/);
  expect(start).toHaveBeenCalledOnce();finish();await pending;expect(t.library.isRunning(t.game.id)).toBe(false);
 });
 it('blocks starting during uninstall and blocks changing files during a store transfer',async()=>{
  const t=setup();let finish!:()=>void;t.worker.call.mockImplementation(()=>new Promise(r=>{finish=()=>r({});}));
  const removal=t.library.uninstall(t.game.id,false);expect(t.library.isChanging(t.game.id)).toBe(true);
  await expect(t.library.launch(t.game.id)).rejects.toThrow(/Wait/);finish();await removal;
  const other=setup();other.library.storeBusy=()=>true;
  await expect(other.library.launch(other.game.id)).rejects.toThrow(/store transfer/);
  await expect(other.library.uninstall(other.game.id,false)).rejects.toThrow(/store transfer/);
  expect(other.games.get(other.game.id)).not.toBeNull();
 });
 it('retains a game while its local update is preparing', async () => {
  const t=setup();t.games.update(t.game.id,{update:{state:'preparing',from:null,to:null,reason:'update',key:'k',detectedAt:new Date().toISOString()}});
  await expect(t.library.uninstall(t.game.id,false)).rejects.toThrow(/Library update/);
  expect(t.games.get(t.game.id)).not.toBeNull();expect(t.worker.call).not.toHaveBeenCalled();
 });
 it('validates the complete settings request before committing launch options',()=>{
  const t=setup();const previous=t.games.get(t.game.id)!.launch;
  expect(()=>t.library.configure(t.game.id,{runner:'proton',launch:{gamemode:!previous.gamemode}})).toThrow(/natively/);
  expect(t.games.get(t.game.id)!.launch).toEqual(previous);
 });
});

describe('Valve Proton runtime installer guard', () => {
 function windows(defaultPath='/steam/Proton 10.0', own: string|null=null, runner='proton') {
  const t=setup(); t.games.update(t.game.id,{kind:'windows',runner:runner as any,redistDone:null,launch:{...t.game.launch,protonPath:own}});
  const installed=[{path:'/steam/Proton 10.0',provider:'valve'},{path:'/managed/GE-Proton10-25',provider:'ge'}];
  (t.library as any).compat={installed:()=>installed,protonPath:()=>defaultPath};
  return t;
 }
 it('skips installers with Valve selected as the launcher default without marking them installed', async () => {
  const t=windows();
  await (t.library as any).installRuntimes(t.games.get(t.game.id),'proton',{protonPath:'/steam/Proton 10.0'});
  expect(t.worker.call).not.toHaveBeenCalled(); expect(t.games.get(t.game.id)?.redistDone).toBeNull();
  expect(t.library.list()[0].runtimeInstallerDisabled).toBe(true);
  expect(()=>t.library.resetRuntimes(t.game.id)).toThrow(/Valve Proton/);
 });
 it('applies the per-game Valve override even when the default is GE', async () => {
  const t=windows('/managed/GE-Proton10-25','/steam/Proton 10.0');
  expect(t.library.list()[0].runtimeInstallerDisabled).toBe(true);
  await (t.library as any).installRuntimes(t.games.get(t.game.id),'proton',{protonPath:'/steam/Proton 10.0'});
  expect(t.worker.call).not.toHaveBeenCalled();
 });
 it('allows runtimes with a GE override or Wine despite a Valve default', async () => {
  for (const t of [windows('/steam/Proton 10.0','/managed/GE-Proton10-25'),windows('/steam/Proton 10.0',null,'wine')]) {
   t.worker.call.mockResolvedValue([]);
   expect(t.library.list()[0].runtimeInstallerDisabled).toBe(false);
   await (t.library as any).installRuntimes(t.games.get(t.game.id),t.games.get(t.game.id)!.runner,{protonPath:'/managed/GE-Proton10-25'});
   expect(t.worker.call).toHaveBeenCalledWith('findRedists',expect.anything());
  }
 });
});
