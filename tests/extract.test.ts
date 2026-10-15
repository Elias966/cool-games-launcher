// Safe extraction: archives are built with Python's zipfile/tarfile so we can craft malicious entries.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractArchive, safeJoin, safeLinkTarget, ExtractError, archiveKind, DEFAULT_LIMITS } from '../src/workers/extract';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cgl-extract-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function py(code: string) {
  const r = spawnSync('python3', ['-I', '-c', code], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

const run = (archive: string, dest = join(dir, 'out'), limits?: Parameters<typeof extractArchive>[4]) =>
  extractArchive(join(dir, archive), dest, new AbortController().signal, () => {}, limits);

describe('path checks', () => {
  it('rejects absolute and parent paths', () => {
    expect(safeJoin('/games/x', 'a/b.txt')).toBe('/games/x/a/b.txt');
    expect(safeJoin('/games/x', '../evil')).toBeNull();
    expect(safeJoin('/games/x', 'a/../../evil')).toBeNull();
    expect(safeJoin('/games/x', '/etc/passwd')).toBeNull();
    expect(safeJoin('/games/x', 'C:\\Windows\\x')).toBeNull();
    expect(safeLinkTarget('/games/x', '/games/x/lib/a.so', 'a.so.1')).toBe(true);
    expect(safeLinkTarget('/games/x', '/games/x/a', '../../etc/passwd')).toBe(false);
    expect(safeLinkTarget('/games/x', '/games/x/a', '/etc/passwd')).toBe(false);
    expect(archiveKind('Game-1.0.tar.xz')).toBe('tar.xz');
    expect(archiveKind('setup.exe')).toBeNull();
  });
});

describe('zip', () => {
  it('extracts files and keeps executable bits', async () => {
    py(`
import zipfile
z = zipfile.ZipFile('ok.zip', 'w')
i = zipfile.ZipInfo('Game/run.sh'); i.external_attr = (0o100755 << 16); z.writestr(i, '#!/bin/sh\\necho hi\\n')
i = zipfile.ZipInfo('Game/data/readme.txt'); i.external_attr = (0o100644 << 16); z.writestr(i, 'hello')
z.close()`);
    await run('ok.zip');
    expect(readFileSync(join(dir, 'out/Game/data/readme.txt'), 'utf8')).toBe('hello');
    expect(statSync(join(dir, 'out/Game/run.sh')).mode & 0o111).not.toBe(0);
  });

  it('refuses path traversal', async () => {
    py(`
import zipfile
z = zipfile.ZipFile('evil.zip', 'w')
z.writestr('../escape.txt', 'x')
z.close()`);
    await expect(run('evil.zip')).rejects.toMatchObject({ code: 'unsafe' });
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
  });

  it('refuses links that leave the game folder', async () => {
    py(`
import zipfile
z = zipfile.ZipFile('link.zip', 'w')
i = zipfile.ZipInfo('Game/passwd'); i.external_attr = (0o120777 << 16); z.writestr(i, '../../../../etc/passwd')
z.close()`);
    await expect(run('link.zip')).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('refuses archives that expand suspiciously', async () => {
    py(`
import zipfile
z = zipfile.ZipFile('bomb.zip', 'w', compression=zipfile.ZIP_DEFLATED)
z.writestr('zeros.bin', b'\\0' * (8 * 1024 * 1024))
z.close()`);
    await expect(run('bomb.zip', join(dir, 'out'), { maxEntries: 1000, maxTotalBytes: 1024 * 1024, maxRatio: 10 })).rejects.toBeInstanceOf(ExtractError);
  });
});

describe('tar', () => {
  it('extracts gzip and xz tarballs with internal symlinks', async () => {
    py(`
import tarfile, io
for name, mode in (('ok.tar.gz', 'w:gz'), ('ok.tar.xz', 'w:xz')):
    t = tarfile.open(name, mode)
    data = b'#!/bin/sh\\n'
    ti = tarfile.TarInfo('Game/start.sh'); ti.size = len(data); ti.mode = 0o755; t.addfile(ti, io.BytesIO(data))
    lib = b'ELF'
    ti = tarfile.TarInfo('Game/lib/libfoo.so.1'); ti.size = len(lib); t.addfile(ti, io.BytesIO(lib))
    ti = tarfile.TarInfo('Game/lib/libfoo.so'); ti.type = tarfile.SYMTYPE; ti.linkname = 'libfoo.so.1'; t.addfile(ti)
    t.close()`);
    await run('ok.tar.gz', join(dir, 'gz'));
    await run('ok.tar.xz', join(dir, 'xz'));
    for (const d of ['gz', 'xz']) {
      expect(lstatSync(join(dir, d, 'Game/lib/libfoo.so')).isSymbolicLink()).toBe(true);
      expect(statSync(join(dir, d, 'Game/start.sh')).mode & 0o111).not.toBe(0);
    }
  });

  it('refuses escaping symlinks and parent paths', async () => {
    py(`
import tarfile, io
t = tarfile.open('evil.tar.gz', 'w:gz')
ti = tarfile.TarInfo('Game/etc'); ti.type = tarfile.SYMTYPE; ti.linkname = '/etc'; t.addfile(ti)
t.close()
t = tarfile.open('evil2.tar', 'w')
d = b'x'
ti = tarfile.TarInfo('../../outside.txt'); ti.size = 1; t.addfile(ti, io.BytesIO(d))
t.close()`);
    await expect(run('evil.tar.gz', join(dir, 'a'))).rejects.toMatchObject({ code: 'unsafe' });
    await expect(run('evil2.tar', join(dir, 'b'))).rejects.toMatchObject({ code: 'unsafe' });
    expect(existsSync(join(dir, 'outside.txt'))).toBe(false);
  });

  it('skips device files', async () => {
    py(`
import tarfile, io
t = tarfile.open('dev.tar', 'w')
ti = tarfile.TarInfo('Game/null'); ti.type = tarfile.CHRTYPE; ti.devmajor = 1; ti.devminor = 3; t.addfile(ti)
d = b'ok'
ti = tarfile.TarInfo('Game/ok.txt'); ti.size = 2; t.addfile(ti, io.BytesIO(d))
t.close()`);
    await run('dev.tar');
    expect(existsSync(join(dir, 'out/Game/null'))).toBe(false);
    expect(existsSync(join(dir, 'out/Game/ok.txt'))).toBe(true);
  });
});


describe('verified compatibility link graphs', () => {
  it('supports internal directory aliases and hard links without extracting through them', async () => {
    py(`
import tarfile, io
t = tarfile.open('proton.tar.gz', 'w:gz')
d = b'library'
i = tarfile.TarInfo('Proton/lib64/libfoo.so'); i.size = len(d); t.addfile(i, io.BytesIO(d))
for name, target, kind in [('Proton/lib','lib64',tarfile.SYMTYPE), ('Proton/foo','lib/libfoo.so',tarfile.SYMTYPE), ('Proton/hard','Proton/lib/libfoo.so',tarfile.LNKTYPE)]:
    i = tarfile.TarInfo(name); i.type = kind; i.linkname = target; t.addfile(i)
t.close()`);
    await run('proton.tar.gz', join(dir, 'compat'), { ...DEFAULT_LIMITS, deferInternalLinks: true });
    expect(readFileSync(join(dir, 'compat/Proton/foo'), 'utf8')).toBe('library');
    expect(statSync(join(dir, 'compat/Proton/hard')).ino).toBe(statSync(join(dir, 'compat/Proton/lib64/libfoo.so')).ino);
  });

  it('rejects chained escapes even when every individual target looks internal', async () => {
    py(`
import tarfile
t = tarfile.open('chain.tar', 'w')
for name, target in [('Game/deep/a','..'), ('Game/x','deep/a/../../escape')]:
    i = tarfile.TarInfo(name); i.type = tarfile.SYMTYPE; i.linkname = target; t.addfile(i)
t.close()`);
    await expect(run('chain.tar', join(dir, 'compat'), { ...DEFAULT_LIMITS, deferInternalLinks: true })).rejects.toMatchObject({ code: 'unsafe' });
    expect(existsSync(join(dir, 'escape'))).toBe(false);
  });

  it('rejects link cycles and missing hard-link targets', async () => {
    py(`
import tarfile
for file, entries in [('cycle.tar',[('Game/a','b',tarfile.SYMTYPE),('Game/b','a',tarfile.SYMTYPE)]), ('missing.tar',[('Game/a','Game/missing',tarfile.LNKTYPE)])]:
    with tarfile.open(file,'w') as t:
        for name,target,kind in entries:
            i = tarfile.TarInfo(name); i.type=kind; i.linkname=target; t.addfile(i)`);
    await expect(run('cycle.tar', join(dir, 'cycle'), { ...DEFAULT_LIMITS, deferInternalLinks: true })).rejects.toMatchObject({ code: 'unsafe' });
    await expect(run('missing.tar', join(dir, 'missing'), { ...DEFAULT_LIMITS, deferInternalLinks: true })).rejects.toMatchObject({ code: 'corrupt' });
  });
});
