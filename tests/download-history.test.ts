// Clearing finished downloads from the history in one go.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, dialog: {}, shell: {} }));

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function setup() {
  const { openDb } = await import('../src/main/db');
  const { DownloadsRepo } = await import('../src/main/repos');
  const { DownloadManager } = await import('../src/main/downloads');
  const dir = mkdtempSync(join(tmpdir(), 'cgl-history-'));
  dirs.push(dir);
  const downloadsDir = join(dir, 'downloads');
  mkdirSync(downloadsDir);
  const repo = new DownloadsRepo(openDb(join(dir, 'db.sqlite')));
  const settings = { maxConcurrentDownloads: 2, downloadsDir, downloadConnections: 1 };
  const worker = Object.assign(new EventEmitter(), { call: async () => ({}) });
  const policy = Object.assign(new EventEmitter(), { policy: () => ({ showNsfw: false, revision: 1 }) });
  const manager = new DownloadManager(worker as never, repo, {} as never, { get: () => settings } as never, policy as never, {} as never);
  const add = (title: string, state: 'completed' | 'failed' | 'cancelled' | 'active', extra: Record<string, unknown> = {}) => {
    const d = repo.create({ catalogId: null, title, sourceHost: 'example.test', state });
    const file = join(downloadsDir, `${title}.zip`);
    if (state === 'completed') writeFileSync(file, 'x'.repeat(1000));
    repo.update(d.id, { finalPath: state === 'completed' ? file : null, ...extra });
    return { id: d.id, file };
  };
  return { manager, repo, add };
}

describe('clearing the download history', () => {
  it('drops installed and failed entries, keeps unprepared downloads and the AI model', async () => {
    const { manager, repo, add } = await setup();
    const installed = add('installed', 'completed', { installState: 'installed', catalogId: null });
    const proton = add('proton', 'completed', { installState: 'installed' });
    const failed = add('failed', 'failed');
    const cancelled = add('cancelled', 'cancelled');
    const model = add('model', 'completed', { modelAsset: { modelId: 'fara', role: 'model', file: 'm.gguf' } });
    const running = add('running', 'active');

    expect(manager.historySize('completed')).toEqual({ entries: 2, bytes: 2000 });
    expect(await manager.clearHistory('completed', false)).toEqual({ removed: 2 });
    expect(repo.get(installed.id)).toBeNull();
    expect(repo.get(proton.id)).toBeNull();
    expect(existsSync(installed.file)).toBe(true); // files stay unless asked
    expect(repo.get(model.id)).not.toBeNull();
    expect(existsSync(model.file)).toBe(true);
    expect(repo.get(running.id)).not.toBeNull();

    expect(await manager.clearHistory('failed', false)).toEqual({ removed: 1 });
    expect(repo.get(failed.id)).toBeNull();
    expect(repo.list().some((d) => d.id === cancelled.id)).toBe(false); // cancelled ones are never listed
  });

  it('deletes the files too when asked, and keeps a completed game that is not prepared yet', async () => {
    const { manager, repo, add } = await setup();
    const game = add('game', 'completed', { installState: 'installed' });
    const waiting = add('waiting', 'completed', { installState: 'none' });
    repo.update(waiting.id, { catalogId: null });
    await manager.clearHistory('completed', true);
    expect(existsSync(game.file)).toBe(false);
    expect(repo.get(game.id)).toBeNull();
  });
});
