import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cabsIn, isWineDll, needsVcRuntime, VcRuntime, VC_OVERRIDES } from '../src/main/vc-runtime';
import { applyExtras } from '../src/workers/launch-wrap';

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'cgl-vc-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const put = (p: string, body: string | Buffer) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };
const wineDll = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(0x3e), Buffer.from('Wine builtin DLL\0')]);

describe('Microsoft\'s C++ runtime for Valve Proton', () => {
  it('only for a Proton without game fixes', () => {
    const valve = temp(), ge = temp();
    mkdirSync(join(ge, 'protonfixes'));
    expect(needsVcRuntime(valve)).toBe(true);
    expect(needsVcRuntime(ge)).toBe(false);
  });

  it('finds the CAB archives inside a bundle and tells Wine\'s DLLs from Microsoft\'s', () => {
    const cab = (n: number) => { const b = Buffer.alloc(40); b.write('MSCF', 0, 'latin1'); b.writeUInt32LE(40, 8); b.fill(n, 12); return b; };
    expect(cabsIn(Buffer.concat([Buffer.from('MZ junk'), cab(1), Buffer.from('gap'), cab(2)])).map((c) => c[20])).toEqual([1, 2]);
    const d = temp();
    put(join(d, 'wine.dll'), wineDll());
    put(join(d, 'ms.dll'), Buffer.concat([Buffer.from('MZ'), Buffer.alloc(0x80)]));
    expect(isWineDll(join(d, 'wine.dll'))).toBe(true);
    expect(isWineDll(join(d, 'ms.dll'))).toBe(false);
  });

  it('replaces Wine\'s stand-ins in the prefix, keeps real DLLs, and makes a missing prefix first', async () => {
    const data = temp(), prefix = join(temp(), 'game-7');
    const store = join(data, 'vc-runtime', '14.44.35211.0');
    for (const arch of ['x64', 'x86']) for (const f of ['msvcp140.dll', 'vcruntime140.dll']) put(join(store, arch, f), `${arch} ${f} microsoft`);
    writeFileSync(join(data, 'vc-runtime', 'current.json'), JSON.stringify({ version: '14.44.35211.0', dir: store, at: Date.now() }));
    const vc = new VcRuntime({ dataDir: data, fetch: async () => { throw new Error('no download expected'); }, sevenZip: 'unused' });
    let created = 0;
    const win = join(prefix, 'pfx', 'drive_c', 'windows');
    const create = async () => {
      created++;
      put(join(win, 'system32', 'msvcp140.dll'), wineDll());
      put(join(win, 'system32', 'vcruntime140.dll'), 'a real one the game installed');
      put(join(win, 'syswow64', 'msvcp140.dll'), wineDll());
    };
    expect(await vc.ensure(prefix, create)).toBe(3);
    expect(created).toBe(1);
    expect(readFileSync(join(win, 'system32', 'msvcp140.dll'), 'utf8')).toBe('x64 msvcp140.dll microsoft');
    expect(readFileSync(join(win, 'system32', 'vcruntime140.dll'), 'utf8')).toBe('a real one the game installed');
    expect(readFileSync(join(win, 'syswow64', 'msvcp140.dll'), 'utf8')).toBe('x86 msvcp140.dll microsoft');
    expect(await vc.ensure(prefix, create)).toBe(0);
    expect(created).toBe(1);
  });

  it('adds up DLL overrides from the launcher and the person, the person\'s last', () => {
    const o = { gamescope: false, resolution: null, upscale: 'off' as const, fpsLimit: null, mangohud: false, gamemode: false, nvapi: false, wined3d: false, tools: { gamescope: null, mangohud: null, gamemode: null } };
    const r = applyExtras({ cmd: 'umu-run', args: [], env: {} }, { ...o, env: `WINEDLLOVERRIDES=${VC_OVERRIDES}\nWINEDLLOVERRIDES=dxgi=n,b\nWINEDLLOVERRIDES=msvcp140=b` }, true);
    expect(r.env.WINEDLLOVERRIDES).toBe(`${VC_OVERRIDES};dxgi=n,b;msvcp140=b`);
  });
});
