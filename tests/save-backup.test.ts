import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotBuild } from '../src/workers/carry-over';
import { backupSaves, pruneBackups, restoreSaves } from '../src/workers/save-backup';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cgl-saves-')); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };
const put = (root: string, rel: string, body = rel) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); };

describe('save backups', () => {
  it('backs up prefix user data and changed game files, skipping caches and programs, and restores them', () => {
    const dir = tmp(), game = join(dir, 'game'), prefix = join(dir, 'prefix');
    put(game, 'X4.exe', 'program'); put(game, 'data/cat.dat', 'data');
    snapshotBuild({ root: game, out: join(dir, 'm.json') });
    put(game, 'saves/save_001.xml.gz', 'progress');
    put(prefix, 'drive_c/users/steamuser/Documents/Egosoft/X4/12345/save/quicksave.xml.gz', 'quick');
    put(prefix, 'drive_c/users/steamuser/AppData/Local/D3DSCache/abc/blob', 'cache');
    put(prefix, 'drive_c/users/steamuser/AppData/Local/Temp/x.tmp', 'tmp');
    const out = join(dir, 'backups', 'b1');
    const r = backupSaves({ out, gameRoot: game, manifest: join(dir, 'm.json'), prefix, meta: { reason: 'after playing' } });
    expect(r.files).toBe(2);
    expect(existsSync(join(out, 'game/saves/save_001.xml.gz'))).toBe(true);
    expect(existsSync(join(out, 'prefix/steamuser/Documents/Egosoft/X4/12345/save/quicksave.xml.gz'))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, 'backup.json'), 'utf8'))).toMatchObject({ reason: 'after playing', files: 2 });
    // Lose progress, then restore.
    writeFileSync(join(game, 'saves/save_001.xml.gz'), 'broken');
    rmSync(join(prefix, 'drive_c/users/steamuser/Documents'), { recursive: true });
    expect(restoreSaves({ from: out, gameRoot: game, prefix }).files).toBe(2);
    expect(readFileSync(join(game, 'saves/save_001.xml.gz'), 'utf8')).toBe('progress');
    expect(readFileSync(join(prefix, 'drive_c/users/steamuser/Documents/Egosoft/X4/12345/save/quicksave.xml.gz'), 'utf8')).toBe('quick');
  });
  it('makes nothing when there is nothing to save, and keeps only the newest backups', () => {
    const dir = tmp(), game = join(dir, 'game');
    put(game, 'game.x86_64');
    snapshotBuild({ root: game, out: join(dir, 'm.json') });
    expect(backupSaves({ out: join(dir, 'b', 'x'), gameRoot: game, manifest: join(dir, 'm.json'), prefix: null, meta: {} })).toEqual({ files: 0, bytes: 0 });
    expect(existsSync(join(dir, 'b', 'x'))).toBe(false);
    for (const s of ['2026-01', '2026-02', '2026-03', '2026-04']) mkdirSync(join(dir, 'keep', s), { recursive: true });
    pruneBackups(join(dir, 'keep'), 2);
    expect(readdirSync(join(dir, 'keep')).sort()).toEqual(['2026-03', '2026-04']);
  });
});
