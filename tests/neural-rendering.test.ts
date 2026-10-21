import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archFor, compareVersions, identifyBuild, NeuralRendering, nightlyAssets, renderFolder, setIniKey } from '../src/main/neural-rendering';
import type { Settings } from '../src/shared/types';

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'cgl-nr-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const put = (path: string, body = 'x') => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body); };

describe('neural rendering helpers', () => {
  it('names builds and GPU generations', () => {
    expect(identifyBuild('e67dee209320cdaf' + '0'.repeat(48))).toBe('cross-generation');
    expect(identifyBuild('8270b350cd82de5c' + '0'.repeat(48))).toBe('patched');
    expect(identifyBuild('e16bcf15e16e13f5' + '0'.repeat(48))).toBe('nvidia');
    expect(archFor('8.6')).toBe('ampere');
    expect(archFor('7.5')).toBe('turing');
    expect(archFor('8.9')).toBe('ada');
    expect(archFor('12.0')).toBe('blackwell');
    expect(archFor(null)).toBeNull();
    expect(compareVersions('310.9.16.0', '310.8.0.0')).toBeGreaterThan(0);
  });

  it('sets a key in an ini section', () => {
    const ini = '[Upscalers]\nDx12Upscaler=auto\n\n[DlssNr]\nToggleKey=auto\nEnabled=auto\n\n[Log]\nLevel=2\n';
    const out = setIniKey(setIniKey(ini, 'DlssNr', 'Enabled', 'true'), 'DlssNr', 'WorkingScale', '0.75');
    expect(out).toContain('[DlssNr]\nWorkingScale=0.75\nToggleKey=auto\nEnabled=true');
    expect(out).toContain('[Log]\nLevel=2');
    expect(setIniKey('[A]\nx=1', 'DlssNr', 'Enabled', 'true')).toContain('[DlssNr]\nEnabled=true');
  });

  it('lists nightly OptiScaler builds newest first, without the copies carrying NVIDIA files', () => {
    const d = (n: string) => ({ name: n, browser_download_url: `https://example.invalid/${n}`, digest: `sha256:${'a'.repeat(64)}` });
    const list = nightlyAssets([d('OptiScaler_v10.0.0-pre1_20260906.7z'), d('OptiScaler_v10.0.0-pre1_20261021.7z'), d('OptiScaler_v10.0.0-dev_20260905_with_DLSS.7z'), { name: 'OptiScaler_v10.0.0-pre1_20261001.7z' }]);
    expect(list.map((a) => a.date)).toEqual(['20261021', '20260906']);
  });

  it('finds the Unreal shipping build next to the game\'s DLSS', () => {
    const root = temp();
    put(join(root, 'Game.exe'));
    put(join(root, 'Game/Binaries/Win64/Game-Win64-Shipping.exe'));
    put(join(root, 'Game/Binaries/Win64/nvngx_dlss.dll'));
    put(join(root, 'Engine/Binaries/Win64/CrashReportClient.exe'));
    expect(renderFolder(root, join(root, 'Game.exe'))).toBe(join(root, 'Game/Binaries/Win64'));
  });
});

describe('neural rendering in a game folder', () => {
  it('puts OptiScaler and the model in, then restores the game as it was', async () => {
    const data = temp(), game = temp();
    const sha = 'e67dee209320cdaf' + '1'.repeat(48);
    const base = join(data, 'neural-rendering');
    put(join(base, 'runtimes', sha, 'nvngx_dlssnr.dll'), 'model');
    writeFileSync(join(base, 'runtimes', sha, 'meta.json'), JSON.stringify({ sha256: sha, version: '310.9.16.0', source: 'test', addedAt: '' }));
    const opti = join(base, 'optiscaler', 'OptiScaler_v10.0.0-pre1_20260906.7z');
    for (const f of ['.ok', 'OptiScaler.dll', 'nvngx.dll_dlssnr.dll', 'OptiScaler/libxess.dll', 'nvngx.dll_dlssnr.pdb', 'setup_linux.sh', 'Licenses/XeSS_LICENSE.txt']) put(join(opti, f), f);
    put(join(opti, 'OptiScaler.ini'), '[DlssNr]\nEnabled=auto\nWorkingScale=auto\n');
    const exe = join(game, 'Bin/Win64/Game-Win64-Shipping.exe');
    put(exe);
    put(join(game, 'Bin/Win64/dxgi.dll'), 'the game\'s own dxgi');
    put(join(game, 'Plugins/DLSS/Win64/nvngx_dlss.dll'));
    put(join(game, 'Plugins/DLSS/Win64/nvngx_dlssnr.dll'), 'older model');

    const settings = { nrRuntime: 'latest', nrOptiscaler: 'OptiScaler_v10.0.0-pre1_20260906.7z', nrQuality: 'balanced', nrPasses: 1 } as Settings;
    const nr = new NeuralRendering({
      dataDir: data, settings: () => settings, gameDirs: () => [], changed: () => undefined,
      fetch: async () => new Response('', { status: 503 }), extract: async () => { throw new Error('no download in tests'); },
    });

    const env = await nr.apply({ id: 7, installDir: game, executable: exe });
    const win64 = join(game, 'Bin/Win64');
    // dxgi.dll belongs to the game, so OptiScaler takes the next proxy name.
    expect(env).toContain('WINEDLLOVERRIDES=winmm=n,b');
    expect(readFileSync(join(win64, 'winmm.dll'), 'utf8')).toBe('OptiScaler.dll');
    expect(readFileSync(join(win64, 'dxgi.dll'), 'utf8')).toBe('the game\'s own dxgi');
    expect(existsSync(join(win64, 'OptiScaler/libxess.dll'))).toBe(true);
    expect(existsSync(join(win64, 'nvngx.dll_dlssnr.dll'))).toBe(true);
    expect(existsSync(join(win64, 'nvngx.dll_dlssnr.pdb'))).toBe(false);
    expect(existsSync(join(win64, 'setup_linux.sh'))).toBe(false);
    expect(readFileSync(join(win64, 'nvngx_dlssnr.dll'), 'utf8')).toBe('model');
    expect(readFileSync(join(game, 'Plugins/DLSS/Win64/nvngx_dlssnr.dll'), 'utf8')).toBe('model');
    const ini = readFileSync(join(win64, 'OptiScaler.ini'), 'utf8');
    expect(ini).toContain('Enabled=true');
    expect(ini).toContain('WorkingScale=0.75');

    expect(ini).toContain('Passes=auto');
    expect(ini).toContain('Dx11Upscaler=dlss_12');

    // A second start leaves the install alone, and takes the new strength: three passes, later ones eased.
    settings.nrPasses = 3;
    expect(await nr.apply({ id: 7, installDir: game, executable: exe })).toEqual(env);
    const ini3 = readFileSync(join(win64, 'OptiScaler.ini'), 'utf8');
    expect(ini3).toContain('Passes=3');
    expect(ini3).toContain('PassOverrides=3:intensity=0.80');

    nr.removeFrom(7);
    expect(existsSync(join(win64, 'winmm.dll'))).toBe(false);
    expect(existsSync(join(win64, 'OptiScaler.ini'))).toBe(false);
    expect(existsSync(join(win64, 'nvngx_dlssnr.dll'))).toBe(false);
    expect(readFileSync(join(game, 'Plugins/DLSS/Win64/nvngx_dlssnr.dll'), 'utf8')).toBe('older model');
    expect(readFileSync(join(win64, 'dxgi.dll'), 'utf8')).toBe('the game\'s own dxgi');
    expect(nr.installed(7)).toBeNull();
  });

  it('gives AMD cards FSR 4 through OptiScaler, without NVIDIA\'s model', async () => {
    const data = temp(), game = temp();
    const opti = join(data, 'neural-rendering', 'optiscaler', 'OptiScaler_v10.0.0-pre1_20261021.7z');
    for (const f of ['.ok', 'OptiScaler.dll', 'OptiScaler/amd_fidelityfx_upscaler_dx12.dll']) put(join(opti, f), f);
    put(join(opti, 'OptiScaler.ini'), '[Upscalers]\nDx11Upscaler=auto\nDx12Upscaler=auto\n\n[DlssNr]\nEnabled=auto\n');
    const exe = join(game, 'game.exe');
    put(exe);
    const nr = new NeuralRendering({
      dataDir: data, settings: () => ({ nrRuntime: 'latest', nrOptiscaler: 'latest', nrQuality: 'auto', nrPasses: 1, fsr4Version: '4.1.1' }) as Settings, gameDirs: () => [], changed: () => undefined,
      fetch: async () => new Response('', { status: 503 }), extract: async () => undefined,
    });
    const env = await nr.apply({ id: 3, installDir: game, executable: exe }, 'fsr4');
    expect(env).toEqual(['WINEDLLOVERRIDES=dxgi=n,b', 'PROTON_FSR4_UPGRADE=4.1.1']);
    const ini = readFileSync(join(game, 'OptiScaler.ini'), 'utf8');
    expect(ini).toContain('Dx12Upscaler=ffx');
    expect(ini).toContain('Dx11Upscaler=ffx_12');
    expect(ini).toContain('Enabled=false');
    expect(existsSync(join(game, 'nvngx_dlssnr.dll'))).toBe(false);
    // Switching to Neural Rendering needs NVIDIA's model; nothing changes in the game without it.
    await expect(nr.apply({ id: 3, installDir: game, executable: exe }, 'nr')).rejects.toThrow(/nvngx_dlssnr/);
    nr.removeFrom(3);
    expect(existsSync(join(game, 'dxgi.dll'))).toBe(false);
    expect(existsSync(join(game, 'OptiScaler.ini'))).toBe(false);
    expect(existsSync(join(game, 'OptiScaler'))).toBe(false);
  });

  it('asks for the model before anything goes into the game', async () => {
    const data = temp(), game = temp();
    const nr = new NeuralRendering({
      dataDir: data, settings: () => ({ nrRuntime: 'latest', nrOptiscaler: 'latest', nrQuality: 'auto' }) as Settings, gameDirs: () => [], changed: () => undefined,
      fetch: async () => new Response('', { status: 503 }), extract: async () => undefined,
    });
    await expect(nr.apply({ id: 1, installDir: game, executable: join(game, 'g.exe') })).rejects.toThrow(/nvngx_dlssnr\.dll/);
  });
});

describe('CUDA tools from NVIDIA', () => {
  const archives = () => {
    const src = temp();
    const make = (name: string, tools: string[]) => {
      for (const t of tools) put(join(src, name, 'bin', t), `#!/bin/sh\necho ${t}\n`);
      const file = join(src, `${name}.tar.xz`);
      execFileSync('tar', ['-cJf', file, '-C', src, name]);
      return { file, sha: createHash('sha256').update(readFileSync(file)).digest('hex') };
    };
    return { nvcc: make('cuda_nvcc-linux-x86_64-13.3.73-archive', ['ptxas', 'fatbinary', 'nvcc']), obj: make('cuda_cuobjdump-linux-x86_64-13.3.73-archive', ['cuobjdump']) };
  };
  const service = (a: ReturnType<typeof archives>, tamper = false) => async (url: string) => {
    if (url.endsWith('redistrib_13.3.1.json')) return Response.json({
      cuda_nvcc: { 'linux-x86_64': { relative_path: 'cuda_nvcc/linux-x86_64/cuda_nvcc-linux-x86_64-13.3.73-archive.tar.xz', sha256: a.nvcc.sha } },
      cuda_cuobjdump: { 'linux-x86_64': { relative_path: 'cuda_cuobjdump/linux-x86_64/cuda_cuobjdump-linux-x86_64-13.3.73-archive.tar.xz', sha256: a.obj.sha } },
    });
    const body = readFileSync(url.includes('cuobjdump') ? a.obj.file : a.nvcc.file);
    return new Response(tamper ? Buffer.concat([body, Buffer.from('x')]) : body);
  };
  const extract = async (archive: string, dest: string) => { mkdirSync(dest, { recursive: true }); execFileSync('tar', ['-xJf', archive, '-C', dest]); };

  it('keeps ptxas, fatbinary and cuobjdump in the launcher\'s folder', async () => {
    const data = temp();
    const nr = new NeuralRendering({ dataDir: data, settings: () => ({}) as Settings, gameDirs: () => [], changed: () => undefined, fetch: service(archives()), extract });
    const bin = await nr.fetchCuda();
    expect(bin).toBe(join(data, 'neural-rendering', 'cuda', 'bin'));
    for (const t of ['ptxas', 'fatbinary', 'cuobjdump']) expect(statSync(join(bin, t)).mode & 0o111).toBeTruthy();
    expect(existsSync(join(bin, 'nvcc'))).toBe(false);
    expect(existsSync(join(data, 'neural-rendering', 'cuda', 'work'))).toBe(false);
    expect(nr.cudaBin()).toBe(bin);
  });

  it('refuses a download that does not match NVIDIA\'s SHA-256', async () => {
    const data = temp();
    const nr = new NeuralRendering({ dataDir: data, settings: () => ({}) as Settings, gameDirs: () => [], changed: () => undefined, fetch: service(archives(), true), extract });
    await expect(nr.fetchCuda()).rejects.toThrow(/SHA-256/);
    expect(existsSync(join(data, 'neural-rendering', 'cuda', 'bin', 'ptxas'))).toBe(false);
  });
});

describe('Neural Rendering files from the Downloads folder', () => {
  const unzip = async (archive: string, dest: string) => { mkdirSync(dest, { recursive: true }); execFileSync('unzip', ['-q', '-o', archive, '-d', dest]); };
  it('says what a DLSS archive held when it is not Neural Rendering, and opens each archive once', async () => {
    const data = temp(), dl = temp(), src = temp();
    put(join(src, 'nvngx_dlss.dll'), 'MZ not really');
    execFileSync('zip', ['-q', '-j', join(dl, 'nvngx_dlss_310.9.1.zip'), join(src, 'nvngx_dlss.dll')]);
    put(join(dl, 'holiday.zip'), 'ignored: no DLSS in the name');
    let opened = 0;
    const nr = new NeuralRendering({
      dataDir: data, settings: () => ({}) as Settings, gameDirs: () => [], changed: () => undefined, downloadsDir: () => dl,
      fetch: async () => new Response('', { status: 503 }), extract: async (a, d) => { opened++; await unzip(a, d); },
    });
    expect(await nr.fromDownloads()).toBe(0);
    expect(opened).toBe(1);
    const st = await nr.status(false);
    expect(st.downloads).toEqual([{ file: 'nvngx_dlss_310.9.1.zip', files: [{ name: 'nvngx_dlss.dll', version: null, kind: 'super-resolution' }] }]);
    expect(st.runtimes).toEqual([]);
    await nr.fromDownloads();
    expect(opened).toBe(1);
  });
});
