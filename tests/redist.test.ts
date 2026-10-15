import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRedists, redistFor } from '../src/workers/redist';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

describe('game runtimes', () => {
  it('knows how to install common runtimes silently, and skips .NET', () => {
    expect(redistFor('VisualCppRedist_AIO_x86_x64.exe')?.args).toEqual(['/ai']);
    expect(redistFor('VC_redist.x64.exe')?.args).toEqual(['/install', '/quiet', '/norestart']);
    expect(redistFor('vcredist_x86.exe')?.args).toEqual(['/q', '/norestart']);
    expect(redistFor('DXSETUP.exe')?.args).toEqual(['/silent']);
    expect(redistFor('oalinst.exe')?.args).toEqual(['/s']);
    expect(redistFor('xnafx40_redist.msi')).toEqual({ label: 'XNA Framework', args: ['/qn'] });
    expect(redistFor('UEPrereqSetup_x64.exe')?.label).toBe('Unreal Engine prerequisites');
    expect(redistFor('dotNetFx40_Full_setup.exe')).toBeNull();
    expect(redistFor('X4.exe')).toBeNull();
  });
  it('finds them in an X4-like folder, Visual C++ first', () => {
    const root = mkdtempSync(join(tmpdir(), 'cgl-redist-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '_CommonRedist'));
    mkdirSync(join(root, 'X4 Foundations Envoy Pack'));
    for (const f of ['oalinst.exe', 'VisualCppRedist_AIO_x86_x64.exe', 'dxwebsetup.exe', 'xnafx40_redist.msi', 'dotNetFx40_Full_setup.exe']) writeFileSync(join(root, '_CommonRedist', f), 'x');
    writeFileSync(join(root, 'X4 Foundations Envoy Pack', 'X4.exe'), 'x');
    const r = findRedists(root);
    expect(r.map((x) => x.rel).sort()).toEqual(['_CommonRedist/VisualCppRedist_AIO_x86_x64.exe', '_CommonRedist/dxwebsetup.exe', '_CommonRedist/oalinst.exe', '_CommonRedist/xnafx40_redist.msi'].sort());
    expect(r).toHaveLength(4);
    expect(r[0].label).toBe('Visual C++ runtimes');
  });
});
