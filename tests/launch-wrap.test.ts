import { describe, expect, it } from 'vitest';
import { applyExtras, type LaunchExtras } from '../src/workers/launch-wrap';

const tools = { gamescope: '/usr/bin/gamescope', mangohud: '/usr/bin/mangohud', gamemode: '/usr/games/gamemoderun' };
const base = { cmd: '/opt/umu-run', args: ['/games/X4/X4.exe'], env: { WINEPREFIX: '/p', PATH: '/usr/bin' } };
const opts = (o: Partial<LaunchExtras>): LaunchExtras => ({ gamescope: false, resolution: null, upscale: 'off', fpsLimit: null, mangohud: false, gamemode: false, nvapi: false, wined3d: false, env: '', tools, ...o });

describe('launch options', () => {
  it('wraps the game outermost-first: gamemode, gamescope, mangohud', () => {
    const r = applyExtras(base, opts({ gamemode: true, gamescope: true, resolution: '2560x1440', upscale: 'fsr', fpsLimit: 60, mangohud: true }), true);
    expect(r.cmd).toBe('/usr/games/gamemoderun');
    expect(r.args).toEqual(['/usr/bin/gamescope', '-f', '-W', '2560', '-H', '1440', '-w', '1707', '-h', '960', '-F', 'fsr', '-r', '60', '--', '/usr/bin/mangohud', '/opt/umu-run', '/games/X4/X4.exe']);
    expect(r.env.MANGOHUD).toBe('1');
    expect(r.env.DXVK_FRAME_RATE).toBeUndefined();
  });
  it('caps frames through DXVK without Gamescope and sets Proton switches', () => {
    const r = applyExtras(base, opts({ fpsLimit: 90, nvapi: true, wined3d: true }), true);
    expect(r.cmd).toBe('/opt/umu-run');
    expect(r.env).toMatchObject({ DXVK_FRAME_RATE: '90', VKD3D_FRAME_RATE: '90', PROTON_ENABLE_NVAPI: '1', PROTON_USE_WINED3D: '1' });
  });
  it('skips helpers that are not installed and protects launcher variables', () => {
    const r = applyExtras(base, opts({ gamescope: true, mangohud: true, tools: { gamescope: null, mangohud: null, gamemode: null }, env: 'DXVK_HUD=fps\nWINEPREFIX=/evil\n# comment\nBAD LINE' }), true);
    expect(r.cmd).toBe('/opt/umu-run');
    expect(r.env.DXVK_HUD).toBe('fps');
    expect(r.env.WINEPREFIX).toBe('/p');
  });
});
