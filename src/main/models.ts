// Model downloads are explicit, pinned queue entries; inference never fetches weights.
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,copyFileSync,unlinkSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {MODEL_CATALOG,AGENT_ROLES,familyFits,DEFAULT_AGENTS,LEGACY_AGENTS,RECOMMENDED_MODEL_ID,type AgentRole,type ModelPin,type ModelList} from '@shared/models';
import type {DownloadsRepo,SettingsRepo} from './repos';
import type {DownloadManager} from './downloads';
import type {WorkerHost} from './worker-host';
import {publish,toast} from './bus';

export class ModelManager {
 private verifying=new Set<number>();
 constructor(private deps:{root:string;repo:DownloadsRepo;downloads:DownloadManager;settings:SettingsRepo;worker:WorkerHost;onSelected:()=>Promise<void>;catalog?:ModelPin[]}){
  deps.downloads.on('completed',(id:number)=>{if(deps.repo.get(id)?.modelAsset)void this.verify(id);});
 }
 private catalog(){return this.deps.catalog??MODEL_CATALOG;}
 private pin(id:string){const pin=this.catalog().find(p=>p.id===id);if(!pin||!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id))throw Error('Unknown local model');return pin;}
 private dir(id:string){return join(this.deps.root,this.pin(id).id);}
 private file(id:string,role:string){return join(this.dir(id),role+'.gguf');}
 private verified(id:string,role:string){
  try{
   const pin=this.pin(id).files.find(f=>f.role===role)!;
   const receipt=JSON.parse(readFileSync(join(this.dir(id),role+'.verified.json'),'utf8'));
   return receipt.sha256===pin.sha256&&receipt.size===pin.size&&statSync(this.file(id,role)).size===pin.size;
  }catch{return false;}
 }
 ready(id=this.deps.settings.get().aiModelId){return this.pin(id).files.every(f=>this.verified(id,f.role));}
 runtime(id=this.deps.settings.get().aiModelId){this.pin(id);return {model:this.file(id,'model'),vision:this.file(id,'vision')};}
 readyAgents(roles:AgentRole[]=AGENT_ROLES){return roles.every(role=>{const id=this.deps.settings.get().aiAgents?.[role]??DEFAULT_AGENTS[role];return this.catalog().some(m=>m.id===id)&&this.ready(id);});}
 async assign(role:AgentRole,id:string){
  const pin=this.pin(id);
  if(!pin.family)throw Error('Choose a specialist model for this agent.');
  if(!familyFits(role,pin.family))throw Error('Choose a model compatible with this agent protocol.');
  if(!this.ready(id))throw Error('Download both verified model components before assigning this agent.');
  this.deps.settings.update({aiAgents:{...DEFAULT_AGENTS,...this.deps.settings.get().aiAgents,[role]:id}});
  await this.deps.onSelected();publish('settings:changed',this.deps.settings.get());this.broadcast();return this.list();
 }
 list():ModelList{
  const downloads=this.deps.repo.list();
  return {selectedId:this.deps.settings.get().aiModelId,agents:AGENT_ROLES.map(role=>{const modelId=this.deps.settings.get().aiAgents?.[role]??DEFAULT_AGENTS[role];return {role,modelId,installed:this.catalog().some(m=>m.id===modelId)&&this.ready(modelId)};}),models:this.catalog().map(p=>{
   const {files,...meta}=p;
   return {...meta,bytes:files.reduce((s,f)=>s+f.size,0),installed:this.ready(p.id),downloads:files.map(f=>{
    const d=downloads.filter(d=>d.modelAsset?.modelId===p.id&&d.modelAsset.role===f.role).at(-1);
    return {id:d?.id??0,role:f.role,state:this.verified(p.id,f.role)?'installed':d?.installState==='installing'?'verifying':d?.installState==='failed'?'failed':d?.state??'missing',receivedBytes:d?.receivedBytes??0,totalBytes:f.size,detail:d?.installDetail??d?.errorDetail??null};
   })};
  })};
 }
 private broadcast(){publish('models:changed',this.list());this.deps.downloads.broadcastList();}
 async select(id:string){
  this.pin(id);if(!this.ready(id))throw Error('Download this model and its vision component before selecting it.');
  this.deps.settings.update({aiModelId:id});await this.deps.onSelected();publish('settings:changed',this.deps.settings.get());this.broadcast();return this.list();
 }
 async download(id:string){
  const pin=this.pin(id);
  // Merely viewing the catalog or selecting its dropdown never downloads files.
  for(const f of pin.files){
   if(this.verified(id,f.role))continue;
   const d=this.deps.repo.list().filter(d=>d.modelAsset?.modelId===id&&d.modelAsset.role===f.role).at(-1);
   if(d&&['active','queued'].includes(d.state))continue;
   if(d?.state==='failed'&&d.installState!=='failed'){this.deps.downloads.resume(d.id);continue;}
   if(d?.state==='paused'){this.deps.downloads.resume(d.id);continue;}
   if(d?.state==='completed'&&d.finalPath&&existsSync(d.finalPath)&&d.installState!=='failed'){void this.verify(d.id);continue;}
   const entry=d??this.deps.repo.create({catalogId:null,title:`${pin.name} · ${f.role==='model'?'GGUF model':'vision component'}`,sourceHost:'huggingface.co',state:'queued'});
   if(entry.finalPath&&entry.finalPath.startsWith(this.deps.settings.get().downloadsDir+'/'))rmSync(entry.finalPath,{force:true});
   this.deps.repo.update(entry.id,{modelAsset:{modelId:id,role:f.role},installState:'none',installDetail:'Local AI component — waiting to download',retries:0,finalPath:null,receivedBytes:0});
   this.deps.downloads.handoff(entry.id,f.url,{},`${id}-${f.role}.gguf`,f.size);
  }
  this.broadcast();toast('info',`Downloading ${pin.name} and its vision component. Pause or resume in Downloads.`);return this.list();
 }
 /** One model for every role (the recommended setup): a single reload. */
 async assignAll(id:string){
  const pin=this.pin(id);
  if(!this.ready(id))throw Error('Download both verified model components first.');
  if(!AGENT_ROLES.every(role=>familyFits(role,pin.family)))throw Error('This model cannot serve every role; assign it per role instead.');
  this.deps.settings.update({aiAgents:Object.fromEntries(AGENT_ROLES.map(role=>[role,id])) as typeof DEFAULT_AGENTS,aiModelId:id});
  await this.deps.onSelected();publish('settings:changed',this.deps.settings.get());this.broadcast();return this.list();
 }
 /** Users still on the legacy three-model team move to the single recommended model once it is verified. */
 upgradeLegacyTeam(){
  const current={...LEGACY_AGENTS,...this.deps.settings.get().aiAgents};
  const legacy=AGENT_ROLES.every(role=>current[role]===LEGACY_AGENTS[role]);
  if(!legacy||!this.catalog().some(m=>m.id===RECOMMENDED_MODEL_ID)||!this.ready(RECOMMENDED_MODEL_ID))return false;
  this.deps.settings.update({aiAgents:{...DEFAULT_AGENTS},aiModelId:RECOMMENDED_MODEL_ID});
  return true;
 }
 recover(){for(const d of this.deps.repo.byState('completed'))if(d.modelAsset&&d.installState!=='failed'&&!this.verified(d.modelAsset.modelId,d.modelAsset.role))void this.verify(d.id);}
 private async verify(id:number){
  if(this.verifying.has(id))return;this.verifying.add(id);
  const d=this.deps.repo.get(id);
  try{
   if(!d?.modelAsset||!d.finalPath)return;
   const {modelId,role}=d.modelAsset,pin=this.pin(modelId).files.find(f=>f.role===role);
   if(!pin||d.url!==pin.url)throw Error('Model package does not match the pinned catalog');
   this.deps.repo.update(id,{installState:'installing',installDetail:'Verifying local model SHA-256…'});this.broadcast();
   if(statSync(d.finalPath).size!==pin.size)throw Error('Model size mismatch');
   const hash=await this.deps.worker.call<string>('hashFile',{path:d.finalPath});
   if(hash!==pin.sha256)throw Error('Model checksum mismatch. Click Download in Settings to retry.');
   // Cancel/remove during hashing must not make a model appear installed.
   const current=this.deps.repo.get(id);if(!current||current.state!=='completed')return;
   mkdirSync(this.dir(modelId),{recursive:true});const dest=this.file(modelId,role);
   if(d.finalPath!==dest){
    try{renameSync(d.finalPath,dest);}catch(e){if((e as NodeJS.ErrnoException).code!=='EXDEV')throw e;copyFileSync(d.finalPath,dest+'.tmp');renameSync(dest+'.tmp',dest);unlinkSync(d.finalPath);}
   }
   const receipt=join(this.dir(modelId),role+'.verified.json');writeFileSync(receipt+'.tmp',JSON.stringify({sha256:hash,size:pin.size}));renameSync(receipt+'.tmp',receipt);
   this.deps.repo.update(id,{finalPath:dest,installState:'installed',installDetail:'Verified local AI component'});
   if(this.ready(modelId)){
    toast('success',`${this.pin(modelId).name} is ready for its assigned agent.`);
    if(this.deps.settings.get().aiModelId===modelId||Object.values(this.deps.settings.get().aiAgents??DEFAULT_AGENTS).includes(modelId))await this.deps.onSelected();
   }
  }catch(e){this.deps.repo.update(id,{installState:'failed',installDetail:(e as Error).message});toast('error',`Model setup failed: ${(e as Error).message}`);}
  finally{this.verifying.delete(id);this.broadcast();}
 }
}
