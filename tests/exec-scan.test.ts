import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickExecutable, scanExecutables } from '../src/workers/exec-scan';
import { packageType } from '../src/workers/package-type';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cgl-scan-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Minimal ELF header: magic, 64-bit, little endian, e_type at offset 16. */
function elf(type = 2, size = 2048) {
  const b = Buffer.alloc(size);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  b.writeUInt16LE(type, 16);
  return b;
}
function pe(size = 2048) {
  const b = Buffer.alloc(size);
  b.set([0x4d, 0x5a], 0);
  return b;
}
function file(rel: string, data: Buffer | string, mode = 0o644) {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data, { mode });
  return p;
}

describe('scanExecutables', () => {
  it('prefers the launcher named after the game over helpers and libraries', () => {
    file('StarDrift/StarDrift.x86_64', elf(3), 0o755);
    file('StarDrift/UnityCrashHandler64.exe', pe());
    file('StarDrift/lib/libstuff.so', elf(3), 0o755);
    file('StarDrift/tools/config-editor', elf(2), 0o755);
    file('StarDrift/readme.txt', 'hi');
    const c = scanExecutables(dir, 'Star Drift');
    expect(c[0].relPath).toBe('StarDrift/StarDrift.x86_64');
    expect(c.some((x) => x.relPath.includes('UnityCrashHandler'))).toBe(false);
    expect(c.some((x) => x.relPath.endsWith('.so'))).toBe(false);
    expect(pickExecutable(c)?.relPath).toBe('StarDrift/StarDrift.x86_64');
  });

  it('asks the user when two candidates are equally plausible', () => {
    file('a/game-one', elf(2), 0o755);
    file('b/game-two', elf(2), 0o755);
    expect(pickExecutable(scanExecutables(dir, 'Something Else'))).toBeNull();
  });

  it('marks Windows installers and never auto-picks them', () => {
    file('setup.exe', pe());
    const c = scanExecutables(dir, 'Game');
    expect(c[0].installerLike).toBe(true);
    expect(pickExecutable(c)).toBeNull();
  });

  it('recognises launch scripts by their shebang', () => {
    file('start.sh', '#!/bin/sh\nexec ./bin/game\n', 0o755);
    const c = scanExecutables(dir, 'Game');
    expect(c[0].kind).toBe('script');
  });
});

describe('packageType', () => {
  it('classifies downloads', () => {
    expect(packageType(file('g.zip', 'PK'))).toBe('archive');
    expect(packageType(file('Game.AppImage', elf(2)))).toBe('appimage');
    expect(packageType(file('setup_game.exe', pe()))).toBe('windows-installer');
    expect(packageType(file('game.exe', pe()))).toBe('windows-exe');
    expect(packageType(file('Game.x86_64', elf(3)))).toBe('linux-binary');
    expect(packageType(file('notes.pdf', '%PDF'))).toBe('unsupported');
  });
});
