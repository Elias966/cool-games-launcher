import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { proxyFor, vulkanOnly } from '../src/main/neural-rendering';

describe('the proxy name a game loads', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const game = (imports: string[]) => {
    const d = mkdtempSync(join(tmpdir(), 'cgl-vk-'));
    dirs.push(d);
    writeFileSync(join(d, 'Game.exe'), Buffer.concat([Buffer.from('MZ....'), ...imports.map((i) => Buffer.from(`\0${i}\0`))]));
    return d;
  };
  it('gives Vulkan-only games a proxy they really load', () => {
    const vk = game(['KERNEL32.dll', 'vulkan-1.dll']);
    expect(vulkanOnly(vk, join(vk, 'Game.exe'))).toBe(true);
    expect(proxyFor(vk, true)).toBe('winmm.dll');
    writeFileSync(join(vk, 'winmm.dll'), 'the game\'s own');
    expect(proxyFor(vk, true)).toBe('version.dll');
    const dx = game(['KERNEL32.dll', 'd3d12.dll', 'dxgi.dll', 'vulkan-1.dll']);
    expect(vulkanOnly(dx, join(dx, 'Game.exe'))).toBe(false);
    expect(proxyFor(dx, false)).toBe('dxgi.dll');
  });
});
