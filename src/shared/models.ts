import catalog from './model-catalog.json';
export interface ModelAssetPin { role:'model'|'vision'; url:string; sha256:string; size:number }
export type AgentRole = 'browsing' | 'computer' | 'analysis';
export const AGENT_ROLES: AgentRole[] = ['browsing', 'computer', 'analysis'];
/** One resident model for every role: no reloads between browsing, analysis and file tasks. */
export const RECOMMENDED_MODEL_ID = 'fara-1.5-9b';
export const DEFAULT_AGENTS: Record<AgentRole, string> = { browsing: RECOMMENDED_MODEL_ID, computer: RECOMMENDED_MODEL_ID, analysis: RECOMMENDED_MODEL_ID };
/** The 0.1.5–0.1.9 three-model team; upgraded automatically once the recommended model is installed. */
export const LEGACY_AGENTS: Record<AgentRole, string> = { browsing:'fara-1.5-4b', computer:'holo-3.1-4b', analysis:'qwen-3.5-4b' };
export const AGENT_LABELS: Record<AgentRole, string> = { browsing:'Browser agent', computer:'Computer agent', analysis:'Page analysis' };
export const AGENT_FAMILIES: Record<AgentRole,'fara'|'holo'|'qwen'>={browsing:'fara',computer:'holo',analysis:'qwen'};
export interface ModelPin {id:string;name:string;parameters:number;variant:string;family?:'fara'|'holo'|'qwen';quantization:string;minRamGb:number;pageUrl:string;conversionUrl:string;revision:string;recommended?:boolean;summary?:string;files:ModelAssetPin[]}
export interface ModelOption extends Omit<ModelPin,'files'> {bytes:number;installed:boolean;downloads:Array<{id:number;role:string;state:string;receivedBytes:number;totalBytes:number;detail:string|null}>}
export interface ModelList {selectedId:string;models:ModelOption[];agents:Array<{role:AgentRole;modelId:string;installed:boolean}>}
export const MODEL_CATALOG = catalog as ModelPin[];
export const DEFAULT_MODEL_ID=RECOMMENDED_MODEL_ID;
/** Fara's native function-call protocol carries any role's tools, so it may serve every role. */
export function familyFits(role:AgentRole,family:ModelPin['family']){return family==='fara'||family===AGENT_FAMILIES[role];}
