import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type Db } from '../src/main/db';
import { DownloadsRepo, SettingsRepo, defaultSettings } from '../src/main/repos';
import { CompatManager } from '../src/main/compat';

let dir: string;
let db: Db;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cgl-compat-')); db = openDb(join(dir, 'x.db')); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const pin = { version: 'GE-Test', dir: 'GE-Test', url: 'https://github.com/example/releases/download/v1/proton.tar.gz', sha256: 'a'.repeat(64), size: 100 };

function setup(python3 = true, detected: string[] = []) {
  const settings = new SettingsRepo(db, defaultSettings({ games: dir, downloads: dir }));
  const repo = new DownloadsRepo(db);
  const downloads = Object.assign(new EventEmitter(), {
    handoff: vi.fn((id: number, url: string) => repo.update(id, { url, state: 'active' })),
    resume: vi.fn((id: number) => repo.update(id, { state: 'queued' })),
    broadcastList: vi.fn(),
  });
  const worker = { call: vi.fn(async (method: string, args: any) => {
    if (method === 'hashFile') return pin.sha256;
    if (method === 'extractCompat') { mkdirSync(join(args.dest, 'proton-root'), { recursive: true }); writeFileSync(join(args.dest, 'proton-root', 'proton'), '#!/usr/bin/python3'); }
  }) };
  const compat = new CompatManager({ settings, repo, downloads: downloads as never, worker: worker as never, dataDir: dir, pin, detectProton: () => detected, pythonAvailable: () => python3 });
  return { settings, repo, downloads, worker, compat };
}

describe('Proton provisioning', () => {
  it('enqueues once and resumes a paused setup', async () => {
    const { compat, repo, downloads } = setup();
    await expect(compat.ensureProton()).rejects.toThrow('Preparing Proton');
    await expect(compat.ensureProton()).rejects.toThrow('Preparing Proton');
    expect(downloads.handoff).toHaveBeenCalledTimes(1);
    const d = repo.list()[0];
    expect(d.compatPackage).toMatchObject({ version: 'GE-Test', sha256: pin.sha256 });
    repo.update(d.id, { state: 'paused' });
    await compat.installProton();
    expect(downloads.resume).toHaveBeenCalledWith(d.id);
  });
  it('verifies before extraction, selects the installation, and cleans staging', async () => {
    const { compat, repo, downloads, worker, settings } = setup();
    await compat.installProton();
    const d = repo.list()[0];
    const archive = join(dir, 'proton.tar.gz'); writeFileSync(archive, 'fixture');
    repo.update(d.id, { state: 'completed', finalPath: archive });
    downloads.emit('completed', d.id, archive);
    await vi.waitFor(() => expect(repo.get(d.id)?.installState).toBe('installed'));
    expect(worker.call.mock.calls.map((c) => c[0])).toEqual(['hashFile', 'extractCompat']);
    expect(settings.get().protonPath).toBe(join(dir, 'compat', pin.dir));
    expect(await compat.ensureProton()).toBe(settings.get().protonPath);
    expect(existsSync(join(dir, 'compat', `.staging-${d.id}`))).toBe(false);
  });
  it('rejects a checksum mismatch without extracting or changing selection', async () => {
    const { compat, repo, downloads, worker, settings } = setup();
    worker.call.mockImplementation(async () => 'b'.repeat(64));
    await compat.installProton();
    const d = repo.list()[0];
    const archive = join(dir, 'bad.tar.gz'); writeFileSync(archive, 'bad');
    repo.update(d.id, { state: 'completed', finalPath: archive });
    downloads.emit('completed', d.id, archive);
    await vi.waitFor(() => expect(repo.get(d.id)?.installState).toBe('failed'));
    expect(worker.call).toHaveBeenCalledTimes(1);
    expect(settings.get().protonPath).toBe('');
    await compat.installProton();
    expect(downloads.handoff).toHaveBeenCalledTimes(2);
  });
  it('recovers an interrupted completed archive without redownloading', async () => {
    const { compat, repo, downloads } = setup();
    const archive = join(dir, 'proton.tar.gz'); writeFileSync(archive, 'fixture');
    const d = repo.create({ catalogId: null, title: 'GE-Test', sourceHost: 'github.com', state: 'completed' });
    repo.update(d.id, { url: pin.url, finalPath: archive, installState: 'installing', compatPackage: { ...pin, provider: 'ge' } });
    compat.recover();
    await vi.waitFor(() => expect(repo.get(d.id)?.installState).toBe('installed'));
    expect(downloads.handoff).not.toHaveBeenCalled();
  });
  it('uses configured Proton before detected installations and skips nonexistent paths', async () => {
    const official = join(dir, 'official'); mkdirSync(official); writeFileSync(join(official, 'proton'), 'fixture');
    const custom = join(dir, 'custom'); mkdirSync(custom); writeFileSync(join(custom, 'proton'), 'fixture');
    const { compat, settings, downloads } = setup(true, [join(dir, 'missing'), official]);
    settings.update({ protonPath: custom });
    expect(await compat.ensureProton()).toBe(custom);
    settings.update({ protonPath: join(dir, 'bad') });
    expect(await compat.ensureProton()).toBe(official);
    expect(compat.installed().map((p) => p.path)).toEqual([official]);
    expect(downloads.handoff).not.toHaveBeenCalled();
  });
  it('explains missing Python and prevents conflicting simultaneous builds', async () => {
    const missing = setup(false);
    await expect(missing.compat.ensureProton()).rejects.toThrow('Python 3');
    expect(missing.downloads.handoff).not.toHaveBeenCalled();
    const ready = setup();
    await ready.compat.installProton();
    await expect(ready.compat.installPackage({ ...pin, provider: 'cachyos', dir: 'cachyos-v1', url: pin.url + '?other' })).rejects.toThrow('Finish or cancel');
  });
});
