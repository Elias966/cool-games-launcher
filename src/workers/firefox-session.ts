import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Firefox's mozLz4 session file: header, decoded byte count, then an LZ4 block. */
export function decodeFirefoxSession(data: Buffer): unknown {
  if (data.length < 13 || !data.subarray(0,8).equals(Buffer.from('mozLz40\0'))) throw Error('Invalid Firefox session');
  const size=data.readUInt32LE(8);
  if(size>32*1024*1024)throw Error('Firefox session is too large');
  const out=Buffer.alloc(size);let input=12,output=0;
  const length=(initial:number)=>{let n=initial;if(n===15){let extra;do{if(input>=data.length)throw Error('Truncated Firefox session');extra=data[input++];n+=extra;}while(extra===255);}return n;};
  while(input<data.length){
    const token=data[input++],literal=length(token>>>4);
    if(input+literal>data.length || output+literal>size)throw Error('Invalid session literal');
    data.copy(out,output,input,input+literal);input+=literal;output+=literal;
    if(input===data.length)break;
    if(input+2>data.length)throw Error('Truncated session match');
    const offset=data.readUInt16LE(input);input+=2;const match=length(token&15)+4;
    if(!offset || offset>output || output+match>size)throw Error('Invalid session match');
    for(let n=0;n<match;n++){out[output]=out[output-offset];output++;}
  }
  if(output!==size)throw Error('Incomplete Firefox session');
  return JSON.parse(out.toString('utf8'));
}

/** Read only the active tab's URL after the dedicated human Firefox exits. */
export function humanFirefoxPage(profile: string, startedAt: number): string | null {
  const candidates=['sessionstore.jsonlz4','sessionstore-backups/recovery.jsonlz4','sessionstore-backups/recovery.baklz4'].sort((a,b)=>{
    const modified=(file:string)=>{try{return statSync(join(profile,file)).mtimeMs;}catch{return 0;}};
    return modified(b)-modified(a);
  });
  for(const file of candidates){
    try{
      const path=join(profile,file),stat=statSync(path);
      if(stat.mtimeMs<=startedAt+1 || stat.size>16*1024*1024)continue;
      const session=decodeFirefoxSession(readFileSync(path)) as {selectedWindow?:number;windows?:Array<{selected?:number;tabs?:Array<{index?:number;entries?:Array<{url?:string}>}>}>};
      const win=session.windows?.[(session.selectedWindow??1)-1],tab=win?.tabs?.[(win.selected??1)-1];
      const url=tab?.entries?.[(tab.index??1)-1]?.url;
      if(url && /^https?:\/\//i.test(url))return url;
    }catch{ /* A missing/incomplete session keeps the pre-handoff bookmark. */ }
  }
  return null;
}
