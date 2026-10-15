import {afterEach,describe,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {ModelManager} from '../src/main/models';
import {openDb} from '../src/main/db';
import {DownloadsRepo,SettingsRepo,defaultSettings} from '../src/main/repos';
import type {ModelPin} from '@shared/models';
const cleanup:Array<()=>void>=[];afterEach(()=>cleanup.splice(0).forEach(f=>f()));
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'cgl-models-')),db=openDb(join(dir,'db'));
 cleanup.push(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const repo=new DownloadsRepo(db),settings=new SettingsRepo(db,defaultSettings({games:join(dir,'games'),downloads:join(dir,'downloads')}));mkdirSync(settings.get().downloadsDir);
 const bytes=Buffer.from('GGUF fixture model data'),hash=createHash('sha256').update(bytes).digest('hex');
 const pin:ModelPin={id:'owl-test',name:'Owl test',parameters:4,variant:'Instruct',quantization:'Q4_K_M',minRamGb:8,pageUrl:'https://models.test',conversionUrl:'https://models.test',revision:'pinned',files:['model','vision'].map(role=>({role:role as 'model'|'vision',url:`https://models.test/pinned/${role}.gguf`,sha256:hash,size:bytes.length}))};
 const transfers=new EventEmitter(),handoff=vi.fn((id:number,url:string,_headers:unknown,fileName:string,totalBytes:number)=>repo.update(id,{url,fileName,totalBytes,state:'queued'}));
 const downloads=Object.assign(transfers,{handoff,resume:vi.fn(),broadcastList:vi.fn()});
 const onSelected=vi.fn(async()=>{}),worker={call:vi.fn(async()=>hash)};
 const deps={root:join(dir,'models'),repo,downloads:downloads as never,settings,worker:worker as never,onSelected,catalog:[pin]};
 const manager=new ModelManager(deps);
 function complete(id:number,bad=false){const d=repo.get(id)!,path=join(settings.get().downloadsDir,d.fileName!);writeFileSync(path,bad?Buffer.from('not a model'):bytes);repo.update(id,{state:'completed',finalPath:path,receivedBytes:bad?11:bytes.length});transfers.emit('completed',id,path);}
 return {dir,db,repo,settings,manager,deps,bytes,hash,handoff,downloads,worker,onSelected,complete};
}
describe('on-demand local model management',()=>{
 it('requires verified specialist files and preserves compatible role assignments',async()=>{
  const s=setup();s.deps.catalog[0]={...s.deps.catalog[0],family:'holo'};
  await expect(s.manager.assign('analysis','owl-test')).rejects.toThrow('compatible');
  await expect(s.manager.assign('computer','owl-test')).rejects.toThrow('verified');
  await s.manager.download('owl-test');for(const d of s.repo.list())s.complete(d.id);
  await vi.waitFor(()=>expect(s.manager.ready('owl-test')).toBe(true));
  const before=s.settings.get().aiAgents;
  await s.manager.assign('computer','owl-test');
  expect(s.settings.get().aiAgents).toEqual({...before,computer:'owl-test'});
  expect(s.onSelected).toHaveBeenCalledOnce();
  expect(s.manager.list().agents.find(a=>a.role==='computer')?.installed).toBe(true);
 });
 it('a single Fara model may serve every role; legacy teams upgrade once it is verified',async()=>{
  const s=setup();s.deps.catalog[0]={...s.deps.catalog[0],id:'fara-1.5-9b',family:'fara'};
  s.settings.update({aiAgents:{browsing:'fara-1.5-4b',computer:'holo-3.1-4b',analysis:'qwen-3.5-4b'}});
  expect(s.manager.upgradeLegacyTeam()).toBe(false);
  await s.manager.download('fara-1.5-9b');for(const d of s.repo.list())s.complete(d.id);
  await vi.waitFor(()=>expect(s.manager.ready('fara-1.5-9b')).toBe(true));
  expect(s.manager.upgradeLegacyTeam()).toBe(true);
  expect(s.settings.get().aiAgents).toEqual({browsing:'fara-1.5-9b',computer:'fara-1.5-9b',analysis:'fara-1.5-9b'});
  s.settings.update({aiAgents:{browsing:'fara-1.5-9b',computer:'holo-3.1-4b',analysis:'fara-1.5-9b'}});
  expect(s.manager.upgradeLegacyTeam()).toBe(false);
 });
 it('accepts every real catalog ID, including version dots, without downloading',()=>{
  const s=setup(),manager=new ModelManager({...s.deps,catalog:undefined});
  const list=manager.list();expect(list.models).toHaveLength(10);expect(list.models.every(m=>!m.installed)).toBe(true);expect(manager.ready()).toBe(false);expect(s.handoff).not.toHaveBeenCalled();
 });
 it('does not download on startup, catalog viewing, or unavailable selection',async()=>{
  const s=setup();s.manager.list();s.manager.recover();expect(s.handoff).not.toHaveBeenCalled();
  await expect(s.manager.select('owl-test')).rejects.toThrow('Download');expect(s.handoff).not.toHaveBeenCalled();
  await expect(s.manager.download('../../foreign')).rejects.toThrow('Unknown');
 });
 it('queues exactly the pinned model and vision component only after Download',async()=>{
  const s=setup();await s.manager.download('owl-test');expect(s.handoff).toHaveBeenCalledTimes(2);
  expect(s.repo.list().map(d=>d.modelAsset?.role)).toEqual(['model','vision']);
  await s.manager.download('owl-test');expect(s.handoff).toHaveBeenCalledTimes(2);expect(s.manager.ready('owl-test')).toBe(false);
 });
 it('requires both verified files and explicitly switches the runtime',async()=>{
  const s=setup();await s.manager.download('owl-test');const ids=s.repo.list().map(d=>d.id);s.complete(ids[0]);
  await vi.waitFor(()=>expect(s.repo.get(ids[0])?.installState).toBe('installed'));expect(s.manager.ready('owl-test')).toBe(false);
  s.complete(ids[1]);await vi.waitFor(()=>expect(s.manager.ready('owl-test')).toBe(true));
  expect(s.settings.get().aiModelId).not.toBe('owl-test');await s.manager.select('owl-test');expect(s.onSelected).toHaveBeenCalledOnce();
  expect(s.settings.get().aiModelId).toBe('owl-test');expect(existsSync(s.manager.runtime().model)).toBe(true);
  expect(s.repo.get(ids[0])?.finalPath).toBe(s.manager.runtime().model);
 });
 it('rejects corrupt bytes and permits an explicit fresh download',async()=>{
  const s=setup();await s.manager.download('owl-test');const id=s.repo.list()[0].id;s.complete(id,true);
  await vi.waitFor(()=>expect(s.repo.get(id)?.installState).toBe('failed'));expect(s.manager.ready('owl-test')).toBe(false);
  await s.manager.download('owl-test');expect(s.handoff).toHaveBeenCalledTimes(3);expect(s.repo.get(id)?.state).toBe('queued');
 });
 it('rejects a matching-size file with the wrong SHA-256',async()=>{
  const s=setup();s.worker.call.mockResolvedValueOnce('0'.repeat(64));await s.manager.download('owl-test');s.complete(s.repo.list()[0].id);
  await vi.waitFor(()=>expect(s.repo.list()[0].installState).toBe('failed'));expect(s.manager.ready('owl-test')).toBe(false);
 });
 it('resumes paused downloads without creating another transfer',async()=>{
  const s=setup();await s.manager.download('owl-test');const id=s.repo.list()[0].id;s.repo.update(id,{state:'paused',receivedBytes:10});
  await s.manager.download('owl-test');expect(s.downloads.resume).toHaveBeenCalledWith(id);expect(s.handoff).toHaveBeenCalledTimes(2);
 });
 it('recovers downloaded components after restart without starting new downloads',async()=>{
  const s=setup();await s.manager.download('owl-test');
  for(const d of s.repo.list()){const path=join(s.settings.get().downloadsDir,d.fileName!);writeFileSync(path,s.bytes);s.repo.update(d.id,{state:'completed',finalPath:path});}
  const recovered=new ModelManager(s.deps);recovered.recover();await vi.waitFor(()=>expect(recovered.ready('owl-test')).toBe(true));expect(s.handoff).toHaveBeenCalledTimes(2);
 });
});
