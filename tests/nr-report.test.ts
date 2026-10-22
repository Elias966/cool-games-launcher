import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NeuralRendering, parseNrLog } from '../src/main/neural-rendering';
import type { Settings } from '../src/shared/types';

const L = (fn: string, msg: string, lvl = 'I') => `[2026-10-22 14:00:00.000] [${lvl}] ${fn} ${msg}`;

describe('reading OptiScaler\'s log', () => {
  it('sees the model running, with its size, cost and passes (ShyVortex)', () => {
    const r = parseNrLog([
      L('IFeature_Dx12::Evaluate', 'IFeature_Dx12: Scheduling DLSS-NR post-upscale pass in pipeline'),
      L('DlssNr::Proxy::Context::Impl::Prepare', 'DLSS-NR: feature created at 1920x1080 through driver'),
      L('DlssNr_Dx12::State::Run', 'DLSS-NR model passes: configured 2, effective 2'),
      L('DlssNr_Dx12::State::EndGpuTiming', 'DLSS-NR GPU window: 240 samples, total mean 24.10 / p99 30.20 ms, model mean 21.32 / p99 27.00 ms'),
    ].join('\n'));
    expect(r).toMatchObject({ state: 'running', size: '1920x1080', modelMs: 21.32, passes: 2 });
  });

  it('reads the older builds\' line too (y4my4my4m, Dagherbou)', () => {
    expect(parseNrLog(L('X', 'DLSS-NR running at 2560x1440, guides 2560x1440 (preset 0, intensity 1, style 0)'))).toMatchObject({ state: 'running', size: '2560x1440', modelMs: null });
  });

  it('names the reason when the driver refuses', () => {
    expect(parseNrLog(L('DlssNr::Proxy::Context::Impl::Prepare', 'DLSS-NR (driver): the NGX core refused its capability parameters', 'E'))).toMatchObject({ state: 'failed', reason: 'the NVIDIA driver did not accept the Neural Rendering model' });
    expect(parseNrLog(L('P', 'DLSS-NR: CreateFeature(18) failed 0xBAD00005', 'E')).reason).toContain('0xBAD00005');
    expect(parseNrLog(L('P', 'DLSS-NR unavailable: nvngx_dlssnr.dll was not found', 'E')).reason).toBe('nvngx_dlssnr.dll was not found');
  });

  it('waits while nothing is known, and notes a game that never used an upscaler', () => {
    expect(parseNrLog(L('main', 'OptiScaler v0.9.71 loaded'))).toMatchObject({ state: 'pending', reason: 'the game did not turn on DLSS, FSR or XeSS' });
    expect(parseNrLog(L('IFeature_Dx12::Init', 'IFeature_Dx12: init'))).toMatchObject({ state: 'pending', reason: null });
  });
});

describe('telling the person once', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('reports at the end of a quiet session, and not twice', () => {
    const data = mkdtempSync(join(tmpdir(), 'cgl-nrr-')), game = mkdtempSync(join(tmpdir(), 'cgl-nrg-'));
    dirs.push(data, game);
    const nr = new NeuralRendering({ dataDir: data, settings: () => ({}) as Settings, gameDirs: () => [], changed: () => undefined, fetch: async () => new Response('', { status: 503 }), extract: async () => undefined });
    mkdirSync(join(data, 'neural-rendering', 'games'), { recursive: true });
    writeFileSync(join(data, 'neural-rendering', 'games', '5.json'), JSON.stringify({ proxy: 'dxgi.dll', files: [{ path: join(game, 'dxgi.dll'), backup: null }], optiscaler: 'x', runtime: 'nvngx_dlssnr.dll', startedAt: Date.now() - 1000 }));
    const log = join(game, 'OptiScaler.log');
    writeFileSync(log, L('main', 'OptiScaler v0.9.71 loaded'));
    expect(nr.lastReport(5)).toBeNull();
    const end = nr.finish(5);
    expect(end).toMatchObject({ state: 'not-used' });
    expect(nr.lastReport(5)).toMatchObject({ state: 'not-used' });
    // An old log from before this session is not read as this session's.
    utimesSync(log, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    expect(nr.check(5)).toBeNull();
  });
});
