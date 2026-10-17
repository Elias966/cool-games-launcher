import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
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
