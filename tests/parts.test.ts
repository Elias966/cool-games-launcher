import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomFillSync } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { partFileName, partFromLabel, partOf, partTotal } from '@shared/parts';
import { prepareGame } from '../src/workers/prepare-game';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cgl-parts-')); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };
const SEVEN = resolve('vendor/7zip/7zzs');

describe('part names', () => {
  it('recognises the common split styles', () => {
    expect(partOf('X4.Foundations.part03.rar')).toEqual({ set: 'x4.foundations.rar', index: 3, style: 'rar-part' });
    expect(partOf('game.7z.002')).toEqual({ set: 'game.7z', index: 2, style: 'split' });
    expect(partOf('game.r00')).toEqual({ set: 'game.rar', index: 2, style: 'rar-old' });
    expect(partOf('Cool_Game-Part2.zip')).toEqual({ set: 'cool_game.zip', index: 2, style: 'labeled' });
    expect(partOf('game.rar')).toBeNull();
    expect(partOf('game-v1.2.zip')).toBeNull();
  });
  it('works out how many parts a page lists', () => {
    const first = partOf('game.part1.rar')!;
    expect(partTotal(first, [{ fileName: 'game.part1.rar', label: '' }, { fileName: 'game.part2.rar', label: '' }, { fileName: null, label: 'Part 3' }])).toBe(3);
    expect(partTotal(first, [{ fileName: null, label: 'Download Part 1 of 5' }])).toBe(5);
    expect(partTotal(first, [{ fileName: 'other.part9.rar', label: 'Mirror' }])).toBeNull();
    expect(partFromLabel('PART-02')).toEqual({ index: 2, total: null });
  });
  it('names the other parts for the AI', () => {
    expect(partFileName('game.part01.rar', 7)).toBe('game.part07.rar');
    expect(partFileName('game.7z.001', 12)).toBe('game.7z.012');
    expect(partFileName('game.r00', 1)).toBe('game.rar');
    expect(partFileName('Game-Part1.zip', 3)).toBe('Game-Part3.zip');
  });
});

describe.skipIf(!existsSync(SEVEN))('preparing split games', () => {
  function gameFolder(root: string) {
    const src = join(root, 'src', 'Orbit');
    mkdirSync(join(src, 'data'), { recursive: true });
    writeFileSync(join(src, 'orbit.x86_64'), '#!/bin/sh\necho orbit\n', { mode: 0o755 });
    const blob = Buffer.alloc(90_000); randomFillSync(blob);
    writeFileSync(join(src, 'data', 'level.pak'), blob);
    return join(root, 'src');
  }
  it('unpacks a split 7z from its first volume', async () => {
    const root = tmp(); const src = gameFolder(root);
    execFileSync(SEVEN, ['a', '-v40k', '-mx0', join(root, 'orbit.7z'), 'Orbit'], { cwd: src });
    const parts = readdirSync(root).filter((f) => f.startsWith('orbit.7z.')).sort().map((f) => join(root, f));
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const r = await prepareGame({ downloadId: 1, filePath: parts[0], parts, gameDir: join(root, 'games', 'orbit'), title: 'Orbit' }, new AbortController().signal, () => {});
    expect(existsSync(join(r.installDir, 'Orbit', 'orbit.x86_64'))).toBe(true);
    expect(existsSync(join(r.installDir, 'Orbit', 'data', 'level.pak'))).toBe(true);
  });
  it('unpacks separately packed parts into one folder', async () => {
    const root = tmp(); const src = gameFolder(root);
    execFileSync(SEVEN, ['a', '-tzip', join(root, 'Orbit-Part1.zip'), 'Orbit/orbit.x86_64'], { cwd: src });
    execFileSync(SEVEN, ['a', '-tzip', join(root, 'Orbit-Part2.zip'), 'Orbit/data'], { cwd: src });
    const parts = [join(root, 'Orbit-Part1.zip'), join(root, 'Orbit-Part2.zip')];
    const r = await prepareGame({ downloadId: 2, filePath: parts[0], parts, gameDir: join(root, 'games', 'orbit2'), title: 'Orbit' }, new AbortController().signal, () => {});
    expect(existsSync(join(r.installDir, 'Orbit', 'orbit.x86_64'))).toBe(true);
    expect(existsSync(join(r.installDir, 'Orbit', 'data', 'level.pak'))).toBe(true);
  });
});

describe('split files on game pages', () => {
  it('counts .001 and .r00 links as game downloads', async () => {
    const { downloadEvidence } = await import('@shared/download-evidence');
    const { JSDOM } = await import('jsdom');
    const { extractPage } = await import('@shared/page-extract');
    const dom = new JSDOM('<article><h1>Nebula Drift</h1><p><a href="/files/nebula.7z.001">Download Part 1 of 2</a></p><p><a href="/files/nebula.7z.002">Download Part 2 of 2</a></p></article>', { url: 'https://s.test/nebula/', runScripts: 'outside-only' });
    const ex = dom.window.eval(`(${extractPage.toString()})({})`);
    dom.window.close();
    expect(downloadEvidence(ex as never).map((c: { fileName: string | null }) => c.fileName)).toEqual(['nebula.7z.001', 'nebula.7z.002']);
  });
});
