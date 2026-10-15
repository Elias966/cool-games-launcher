import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { extractArchive, DEFAULT_LIMITS } from '../src/workers/extract';
import { parseSevenZipList } from '../src/workers/sevenzip';
import { prepareGame } from '../src/workers/prepare-game';
import { portableRar } from './helpers/portable-rar';
import { packageType } from '../src/workers/package-type';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cgl-prepare-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fixture = (name: string) => resolve(__dirname, 'fixtures', name);
function makeZip(name = 'portable.zip') {
  const r = spawnSync('python3', ['-I', '-c', `import zipfile
with zipfile.ZipFile('${name}','w') as z:
 z.writestr('Orbit/Orbit.exe',b'MZ'+bytes(4096))
 z.writestr('Orbit/UnityCrashHandler64.exe',b'MZ'+bytes(2048))
 z.writestr('Orbit/_CommonRedist/vcredist.exe',b'MZ'+bytes(2048))
 z.writestr('Orbit/data/content.pak',b'keep all game data')
 z.writestr('Orbit/support/install.sh',b'#!/bin/sh\\necho helper')`], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return join(dir, name);
}
const prepare = (filePath: string, gameDir = join(dir, 'games/orbit')) => prepareGame({ downloadId: 1, filePath, gameDir, title: 'Orbit' }, new AbortController().signal, () => {});

describe('portable game preparation', () => {
  it('extracts the complete ZIP game folder and chooses the main Windows executable', async () => {
    const archive = makeZip();
    const result = await prepare(archive);
    expect(result.status).toBe('installed'); expect(result.kind).toBe('windows');
    expect(result.executable).toBe(join(result.installDir, 'Orbit/Orbit.exe'));
    expect(readFileSync(join(result.installDir, 'Orbit/data/content.pak'), 'utf8')).toBe('keep all game data');
    expect(existsSync(archive)).toBe(true);
    expect(readdirSync(join(dir, 'games')).some((n) => n.includes('.extracting-'))).toBe(false);
  });
  it('extracts a ready-to-play RAR folder and chooses its main executable without an installer', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 33)]);
    const archive = join(dir, 'portable.rar');
    writeFileSync(archive, portableRar({ 'Orbit/Orbit.exe': exe, 'Orbit/data/content.pak': Buffer.from('ready-to-play data'), 'Orbit/UnityCrashHandler64.exe': Buffer.from('MZhelper') }));
    const result = await prepare(archive);
    expect(result.status).toBe('installed'); expect(result.kind).toBe('windows');
    expect(readFileSync(result.executable!)).toEqual(exe);
    expect(readFileSync(join(result.installDir, 'Orbit/data/content.pak'), 'utf8')).toBe('ready-to-play data');
  });

  it('recognises an archive when a host omits its filename extension', async () => {
    const zip = makeZip('download');
    expect(packageType(zip)).toBe('archive');
    const result = await prepare(zip);
    expect(result.status).toBe('installed');
    const rar = join(dir, 'download-from-host');
    writeFileSync(rar, portableRar({ 'Orbit/Orbit.exe': Buffer.from('MZ game executable') }));
    expect(packageType(rar)).toBe('archive');
    expect((await prepare(rar)).status).toBe('installed');
  });

  it('cleans failed extraction staging and retains the archive for retry', async () => {
    const path = join(dir, 'corrupt.rar'); writeFileSync(path, 'not a rar');
    await expect(prepare(path)).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(join(dir, 'games'))).toEqual([]);
  });
  it('does not overwrite a previous game folder', async () => {
    const target = join(dir, 'games/orbit'); mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'user-save'), 'keep');
    const result = await prepare(makeZip(), target);
    expect(result.installDir).toBe(target + '-2');
    expect(readFileSync(join(target, 'user-save'), 'utf8')).toBe('keep');
    expect(result.executable?.startsWith(result.installDir + '/')).toBe(true);
  });
  it('detects RAR/7z as archives instead of unsupported executables', () => {
    expect(packageType('game.rar')).toBe('archive'); expect(packageType('game.7z')).toBe('archive');
  });
  it('extracts real RAR4 data, subdirectories and an internal symbolic link', async () => {
    const dest = join(dir, 'rar4');
    await extractArchive(fixture('test_read_format_rar.rar'), dest, new AbortController().signal, () => {});
    expect(readFileSync(join(dest, 'test.txt'), 'utf8')).toBe('test text document\r\n');
    expect(readFileSync(join(dest, 'testdir/test.txt'), 'utf8')).toBe('test text document\r\n');
    expect(lstatSync(join(dest, 'testlink')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dest, 'testlink'), 'utf8')).toBe('test text document\r\n');
  });
  it('streams all files from a real solid RAR5 without mixing member boundaries', async () => {
    const dest = join(dir, 'rar5');
    await extractArchive(fixture('test_read_format_rar5_multiple_files_solid.rar'), dest, new AbortController().signal, () => {});
    const tool = resolve(__dirname, '../vendor/7zip/7zzs');
    for (let i = 1; i <= 4; i++) {
      const expected = spawnSync(tool, ['x', '-so', '-spd', '--', fixture('test_read_format_rar5_multiple_files_solid.rar'), `test${i}.bin`]);
      expect(expected.status).toBe(0);
      expect(readFileSync(join(dest, `test${i}.bin`))).toEqual(expected.stdout);
    }
    expect(readFileSync(join(dest, 'test1.bin')).equals(readFileSync(join(dest, 'test2.bin')))).toBe(false);
  });
  it('prepares a solid 7z game folder with exact executable/data bytes', async () => {
    const source = join(dir, 'source'); mkdirSync(join(source, 'Orbit/data'), { recursive: true });
    writeFileSync(join(source, 'Orbit/Orbit.exe'), Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 23)]));
    writeFileSync(join(source, 'Orbit/data/level.dat'), Buffer.alloc(12345, 91));
    writeFileSync(join(source, 'Orbit/empty.txt'), '');
    const archive = join(dir, 'game.7z');
    const tool = resolve(__dirname, '../vendor/7zip/7zzs');
    const r = spawnSync(tool, ['a', '-t7z', '-ms=on', archive, 'Orbit'], { cwd: source, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const result = await prepare(archive);
    expect(result.status).toBe('installed');
    expect(readFileSync(result.executable!)).toEqual(readFileSync(join(source, 'Orbit/Orbit.exe')));
    expect(readFileSync(join(result.installDir, 'Orbit/data/level.dat'))).toEqual(Buffer.alloc(12345, 91));
    expect(readFileSync(join(result.installDir, 'Orbit/empty.txt')).length).toBe(0);
  });
  it('rejects traversal, duplicate paths, special files and multipart archives before decoding', () => {
    for (const path of ['../escape', '/absolute', 'C:\\outside']) {
      expect(() => parseSevenZipList(`Path = ${path}\nFolder = -\nSize = 2\n`, dir, DEFAULT_LIMITS)).toThrow();
    }
    expect(() => parseSevenZipList('Path = file\nFolder = -\nSize = 0\n\nPath = file\nFolder = -\nSize = 0',dir,DEFAULT_LIMITS)).toThrow();
    expect(() => parseSevenZipList('Path = file\nFolder = -\nSize = 0\nAttributes =  crw-rw-rw-',dir,DEFAULT_LIMITS)).toThrow();
    expect(() => parseSevenZipList('Path = file\nFolder = -\nSize = 0\nSplit After = +',dir,DEFAULT_LIMITS)).toThrow();
  });
});
