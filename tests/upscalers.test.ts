import { describe, expect, it } from 'vitest';
import { releaseVersions, upscalerEnv, UpscalerVersions } from '../src/main/upscalers';

const off = { dlssUpgrade: false, dlssVersion: 'latest', dlssPreset: 'latest', fsr4Upgrade: false, fsr4Version: 'latest' } as const;

describe('upscaler environment', () => {
  it('adds nothing while both are off', () => {
    expect(upscalerEnv(off)).toEqual([]);
  });

  it('follows the newest DLSS with the recommended model', () => {
    expect(upscalerEnv({ ...off, dlssUpgrade: true })).toEqual([
      'PROTON_ENABLE_NVAPI=1', 'PROTON_DLSS_UPGRADE=1', 'PROTON_ENABLE_NGX_UPDATER=1',
      'DXVK_NVAPI_DRS_NGX_DLSS_SR_OVERRIDE=on', 'DXVK_NVAPI_DRS_NGX_DLSS_SR_OVERRIDE_RENDER_PRESET_SELECTION=render_preset_latest',
    ]);
  });

  it('pins a DLSS version without NVIDIA\'s updater, and leaves the model to the game', () => {
    const env = upscalerEnv({ ...off, dlssUpgrade: true, dlssVersion: '310.9.16.0', dlssPreset: 'game' });
    expect(env).toEqual(['PROTON_ENABLE_NVAPI=1', 'PROTON_DLSS_UPGRADE=310.9.16.0']);
  });

  it('keeps NVIDIA and AMD apart', () => {
    expect(upscalerEnv({ ...off, fsr4Upgrade: true })).toEqual(['PROTON_FSR4_UPGRADE=1']);
    expect(upscalerEnv({ ...off, fsr4Upgrade: true, fsr4Version: '4.1.1' })).toEqual(['PROTON_FSR4_UPGRADE=4.1.1']);
  });
});

describe('upscaler versions', () => {
  it('lists releases newest first without development builds', () => {
    expect(releaseVersions([{ version: '310.9.1.0', is_dev_file: true }, { version: '310.8.0.0' }, { version: '310.9.16.0' }, { version: '310.9.1.0' }, { version: '310.10.0.0' }]))
      .toEqual(['310.10.0.0', '310.9.16.0', '310.9.1.0', '310.8.0.0']);
  });

  it('reads the manifest and spots a Linux build of DLSS-NR on AMD', async () => {
    const store = new Map<string, unknown>();
    const cache = { get: <T,>(k: string) => (store.get(k) as T) ?? null, set: (k: string, v: unknown) => void store.set(k, v) };
    const bodies: Record<string, unknown> = {
      'https://loathingkernel.github.io/proton-upscalers/manifest.json': { dlss: [{ version: '310.9.16.0' }], fsr_40_drv: [{ version: '4.0.0' }, { version: '4.1.1' }] },
      'https://api.github.com/repos/danielblnc/DLSS-NR-on-AMD/releases/latest': { tag_name: 'v0.9.0', assets: [{ name: 'NeuralHub_v0.9.0_setup.exe' }, { name: 'NeuralHub_v0.9.0_linux.tar.gz' }] },
    };
    const v = new UpscalerVersions({ cache, fetch: async (url) => new Response(JSON.stringify(bodies[url])) });
    const list = await v.list();
    expect(list.dlss).toEqual(['310.9.16.0']);
    expect(list.fsr4).toEqual(['4.1.1', '4.0.0']);
    expect(list.nrAmd).toMatchObject({ version: 'v0.9.0', linux: true });
  });
});
