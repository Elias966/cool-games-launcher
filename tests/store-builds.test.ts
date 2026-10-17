import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { installedExecutable, readGogInfo, seedGogRepairManifest } from '../src/main/store-builds';
const clean: string[]=[];
afterEach(()=>clean.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cgl-build-'));clean.push(dir);return dir;}
describe('store build verification',()=>{
  it('uses exact game metadata and rejects an executable outside the install',()=>{
    const dir=fixture();writeFileSync(join(dir,'goggame-123.info'),JSON.stringify({rootGameId:'456',buildId:'b1'}));
    expect(()=>readGogInfo(dir,'123')).toThrow(/different game/);
    mkdirSync(join(dir,'Bin'));writeFileSync(join(dir,'Bin/game.exe'),'exe');
    expect(installedExecutable(dir,'Bin\\game.exe')).toBe(join(dir,'Bin/game.exe'));
    expect(()=>installedExecutable(dir,'../other.exe')).toThrow(/outside/);
    expect(()=>installedExecutable(dir,'Bin/missing.exe')).toThrow(/missing/);
  });
  it('seeds a repair from the selected compressed manifest, never another game',async()=>{
    const dir=fixture(),file=join(dir,'manifests/123');
    const target={buildId:'b2',builds:{items:[{build_id:'b2',generation:2,link:'https://gog.test/meta'}]}};
    const seed=(meta:unknown)=>seedGogRepairManifest({file,id:'123',target,signal:new AbortController().signal,http:(async()=>new Response(deflateSync(JSON.stringify(meta)))) as typeof fetch});
    await expect(seed({baseProductId:'456',buildId:'b2'})).rejects.toThrow(/different game/);
    await expect(seed({baseProductId:'123',buildId:'b1'})).rejects.toThrow(/different game/);
    await seed({baseProductId:'123',buildId:'b2',depots:[]});
    expect(JSON.parse(readFileSync(file,'utf8'))).toMatchObject({baseProductId:'123',buildId:'b2',version:2,HGLInstallLanguage:'en-US'});
    await seedGogRepairManifest({file,id:'123',target,signal:new AbortController().signal,http:(async()=>{throw Error('offline')}) as typeof fetch});
  });
});
