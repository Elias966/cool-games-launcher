import { describe, expect, it } from 'vitest';
import { compareVersions, detectUpdate, fileChanged, findVersion, fingerprintKey, makeFingerprint, rebaser, type InstalledVersion } from '@shared/game-version';

const fp = (p: Partial<InstalledVersion>): InstalledVersion => ({ version: null, updated: null, files: [], sizes: [], at: '2026-10-01T00:00:00.000Z', ...p });

describe('findVersion', () => {
  it('reads versions and builds from titles', () => {
    expect(findVersion({ titles: ['Orbit Run v1.2.3 Free Download'] })).toBe('1.2.3');
    expect(findVersion({ titles: ['Star Miner (Build 15623144)'] })).toBe('build 15623144');
    expect(findVersion({ titles: ['Neon Kart – Version 2'] })).toBe('2');
    expect(findVersion({ titles: ['Cave Dash Update 1.05'] })).toBe('1.05');
  });
  it('does not mistake names for versions', () => {
    expect(findVersion({ titles: ['Sniper Elite V2'] })).toBeNull();
    expect(findVersion({ titles: ['Half-Life 2'] })).toBeNull();
    expect(findVersion({ titles: ['Survivor 3D'] })).toBeNull();
  });
  it('reads versions from file names', () => {
    expect(findVersion({ files: ['orbit-run_v1_4.zip'] })).toBe('1.4');
    expect(findVersion({ files: ['StarMiner-build-2201.7z'] })).toBe('build 2201');
    expect(findVersion({ files: ['game-linux.zip'] })).toBeNull();
  });
  it('reads labelled version lines but ignores system requirements', () => {
    expect(findVersion({ text: 'Genre: Action Game Version: 1.0.7 Size: 2 GB' })).toBe('1.0.7');
    expect(findVersion({ text: 'Game Version: Build 15623144 Size' })).toBe('build 15623144');
    expect(findVersion({ text: 'Requirements OS: Windows 10 DirectX: Version 11 Storage: 4 GB' })).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders dotted versions and builds', () => {
    expect(compareVersions('1.10', '1.9')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2.0a', '2.0')).toBe(1);
    expect(compareVersions('build 200', 'build 1999')).toBe(-1);
    expect(compareVersions('build 200', '1.2')).toBeNull();
  });
});

describe('detectUpdate', () => {
  it('flags newer versions only', () => {
    expect(detectUpdate(fp({ version: '1.2' }), fp({ version: '1.3' }))).toMatchObject({ update: true, from: 'v1.2', to: 'v1.3' });
    expect(detectUpdate(fp({ version: '1.3' }), fp({ version: '1.3', files: ['other.zip'] })).update).toBe(false);
    expect(detectUpdate(fp({ version: '1.3' }), fp({ version: '1.2' })).update).toBe(false);
  });
  it('uses completely different download files when no version is published', () => {
    expect(detectUpdate(fp({ files: ['game-20261001.zip'] }), fp({ files: ['game-20261012.zip'] })).update).toBe(true);
    // An extra mirror of the same file is not an update.
    expect(detectUpdate(fp({ files: ['game.zip'] }), fp({ files: ['game.zip', 'game.zip.torrent'] })).update).toBe(false);
  });
  it('uses the page date only when nothing else is known', () => {
    expect(detectUpdate(fp({ updated: '2026-10-01T00:00:00Z' }), fp({ updated: '2026-10-09T00:00:00Z' })).update).toBe(true);
    expect(detectUpdate(fp({ files: ['g.zip'], updated: '2026-10-01T00:00:00Z' }), fp({ files: ['g.zip'], updated: '2026-10-09T00:00:00Z' })).update).toBe(false);
  });
  it('builds fingerprints from page evidence', () => {
    const f = makeFingerprint({ titles: ['Orbit Run'], meta: { 'article:modified_time': '2026-10-02T10:00:00+00:00' }, candidates: [{ fileName: 'Orbit-Run-v1.4.zip', label: 'Download', sizeText: '1.2 GB' }] });
    expect(f).toMatchObject({ version: '1.4', files: ['orbit-run-v1.4.zip'], sizes: ['1.2gb'], updated: '2026-10-02T10:00:00.000Z' });
    expect(fingerprintKey(f)).toBe('v:1.4');
  });
});

describe('fileChanged', () => {
  const file = { url: 'https://x.test/g.zip', name: 'g.zip', bytes: 100, etag: '"a"', lastModified: null };
  it('compares HTTP validators', () => {
    expect(fileChanged(file, { status: 200, etag: '"b"', lastModified: null, bytes: 100 })).toBe(true);
    expect(fileChanged(file, { status: 200, etag: 'W/"a"', lastModified: null, bytes: 999 })).toBe(false);
    expect(fileChanged({ ...file, etag: null }, { status: 200, etag: null, lastModified: null, bytes: 120 })).toBe(true);
    expect(fileChanged(file, { status: 403, etag: '"b"', lastModified: null, bytes: 1 })).toBe(false);
  });
});

describe('rebaser', () => {
  it('follows a renamed top folder', () => {
    const map = rebaser('Game v1.2/Binaries/Win64/Game.exe', 'Game v1.3/Binaries/Win64/Game.exe');
    expect(map('Game v1.2/Saved/slot1.sav')).toBe('Game v1.3/Saved/slot1.sav');
    expect(map('notes.txt')).toBe('notes.txt');
  });
  it('handles an added or removed wrapper folder', () => {
    expect(rebaser('game.x86_64', 'Game/game.x86_64')('saves/a.sav')).toBe('Game/saves/a.sav');
    expect(rebaser('Game/game.x86_64', 'game.x86_64')('Game/saves/a.sav')).toBe('saves/a.sav');
    expect(rebaser('Game/game.x86_64', 'Game/game.x86_64')('Game/saves/a.sav')).toBe('Game/saves/a.sav');
  });
});
