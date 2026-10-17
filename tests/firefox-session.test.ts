import {describe,it,expect} from 'vitest';import {mkdtempSync,writeFileSync,rmSync,utimesSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {decodeFirefoxSession,humanFirefoxPage} from '../src/workers/firefox-session';
function encode(value:unknown){const data=Buffer.from(JSON.stringify(value)),length:number[]=[];let extra=data.length-15;if(extra>=0){while(extra>=255){length.push(255);extra-=255;}length.push(extra);}const header=Buffer.alloc(12);header.write('mozLz40\0');header.writeUInt32LE(data.length,8);return Buffer.concat([header,Buffer.from([Math.min(15,data.length)<<4,...length]),data]);}
describe('human Firefox return bookmark',()=>{
 it('restores the selected final tab, not the URL captured before the check',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cgl-session-'));
  try{writeFileSync(join(dir,'sessionstore.jsonlz4'),encode({selectedWindow:2,windows:[{selected:1,tabs:[{index:1,entries:[{url:'https://source.test/'}]}]},{selected:2,tabs:[{index:1,entries:[{url:'https://ads.test/'}]},{index:2,entries:[{url:'https://host.test/challenge'},{url:'https://host.test/file/token'}]}]}]}));expect(humanFirefoxPage(dir,Date.now()-5000)).toBe('https://host.test/file/token');}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('ignores stale sessions and non-web active tabs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cgl-session-'));
  try{const p=join(dir,'sessionstore.jsonlz4');writeFileSync(p,encode({windows:[{tabs:[{entries:[{url:'file:///private'}]}]}]}));expect(humanFirefoxPage(dir,0)).toBeNull();writeFileSync(p,encode({windows:[{tabs:[{entries:[{url:'https://old.test/'}]}]}]}));utimesSync(p,new Date(0),new Date(0));expect(humanFirefoxPage(dir,Date.now()-1000)).toBeNull();}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('decodes overlapping LZ4 matches and rejects corrupt/oversized input',()=>{
  // The JSON string "aaaaaaaa" encoded with one literal run and a repeated-byte match.
  const header=Buffer.alloc(12);header.write('mozLz40\0');header.writeUInt32LE(10,8);
  const block=Buffer.from([0x23,0x22,0x61,1,0,0x10,0x22]);expect(decodeFirefoxSession(Buffer.concat([header,block]))).toBe('aaaaaaaa');
  expect(()=>decodeFirefoxSession(Buffer.from('garbage'))).toThrow();header.writeUInt32LE(0xffffffff,8);expect(()=>decodeFirefoxSession(Buffer.concat([header,block]))).toThrow();
 });
});
