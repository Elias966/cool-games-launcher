// Download hours, the speed limit and pausing while a game runs.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { inWindow, nextOpening } from '../src/shared/schedule';
import { bandwidth, runTransfer } from '../src/workers/transfer';
import type { Settings } from '../src/shared/types';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, dialog: {}, shell: {} }));

const at = (hh: number, mm = 0) => new Date(2026, 9, 15, hh, mm);

describe('download hours', () => {
  it('handles windows inside a day and across midnight', () => {
    expect(inWindow(at(3), '01:00', '07:00')).toBe(true);
    expect(inWindow(at(7), '01:00', '07:00')).toBe(false);
    expect(inWindow(at(23, 30), '23:00', '06:00')).toBe(true);
    expect(inWindow(at(2), '23:00', '06:00')).toBe(true);
    expect(inWindow(at(12), '23:00', '06:00')).toBe(false);
    expect(inWindow(at(12), '05:00', '05:00')).toBe(true);
  });

  it('finds the next opening', () => {
    expect(nextOpening(at(12), '01:00')).toEqual(new Date(2026, 9, 16, 1, 0));
    expect(nextOpening(at(0, 30), '01:00')).toEqual(new Date(2026, 9, 15, 1, 0));
  });
});

describe('speed limit', () => {
  const DATA = randomBytes(1536 * 1024);
  let server: Server;
  let base: string;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cgl-limit-'));
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-length', DATA.length);
      res.end(DATA);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); bandwidth.setLimit(0); });

  const fetchOnce = async (name: string) => {
    const t0 = Date.now();
    const r = await runTransfer({ url: `${base}/${name}.zip`, headers: {}, partPath: join(dir, `${name}.part`), finalDir: dir, fileNameHint: `${name}.zip`, etag: null, lastModified: null, expectedTotal: null, connections: 1 }, new AbortController().signal, () => undefined, () => undefined);
    expect(r.receivedBytes).toBe(DATA.length);
    return Date.now() - t0;
  };

  it('caps the speed of a transfer, and lifts the cap', async () => {
    bandwidth.setLimit(1024 * 1024); // 1.5 MB at 1 MB/s
    const limited = await fetchOnce('limited');
    expect(limited).toBeGreaterThan(1100);
    bandwidth.setLimit(0);
    const free = await fetchOnce('free');
    expect(free).toBeLessThan(600);
  });
});

describe('holding downloads', () => {
  const dirs: string[] = [];
  afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });

  async function setup(patch: Partial<Settings>) {
    const { openDb } = await import('../src/main/db');
    const { DownloadsRepo } = await import('../src/main/repos');
    const { DownloadManager } = await import('../src/main/downloads');
    const dir = mkdtempSync(join(tmpdir(), 'cgl-hold-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'db.sqlite'));
    const repo = new DownloadsRepo(db);
    const settings = { maxConcurrentDownloads: 3, downloadsDir: dir, downloadConnections: 1, downloadSpeedLimit: 0, downloadWindow: { enabled: false, start: '01:00', end: '07:00' }, pauseDownloadsWhilePlaying: false, ...patch } as Settings;
    const calls: Array<[string, unknown]> = [];
    const worker = Object.assign(new EventEmitter(), { call: async (m: string, p: unknown) => { calls.push([m, p]); return {}; } });
    const policy = Object.assign(new EventEmitter(), { policy: () => ({ showNsfw: false, revision: 1 }) });
    const manager = new DownloadManager(worker as never, repo, {} as never, { get: () => settings } as never, policy as never, {} as never);
    const d = repo.create({ catalogId: null, title: 'Game', sourceHost: 'example.test', state: 'queued' });
    repo.update(d.id, { url: 'https://example.test/game.zip' });
    return { manager, repo, settings, calls, id: d.id };
  }

  it('waits outside the download hours, and “Download now” starts them anyway', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(14));
    const { manager, repo, calls, id } = await setup({ downloadWindow: { enabled: true, start: '01:00', end: '07:00' } });
    manager.applySchedule();
    manager.pump();
    expect(manager.holdStatus()).toEqual({ reason: 'window', until: new Date(2026, 9, 16, 1, 0).toISOString() });
    expect(repo.get(id)!.state).toBe('queued');
    expect(calls.some(([m]) => m === 'start')).toBe(false);

    manager.runNow();
    expect(manager.holdStatus().reason).toBeNull();
    expect(repo.get(id)!.state).toBe('active');
    expect(calls.some(([m]) => m === 'start')).toBe(true);
  });

  it('pauses transfers while a game runs and continues afterwards, when chosen', async () => {
    const { manager, repo, calls, id } = await setup({ pauseDownloadsWhilePlaying: true });
    manager.applySchedule();
    manager.pump();
    expect(repo.get(id)!.state).toBe('active');
    manager.setPlaying(true);
    expect(manager.holdStatus().reason).toBe('playing');
    expect(repo.get(id)!.state).toBe('queued');
    expect(calls.some(([m, p]) => m === 'stop' && (p as { id: number }).id === id)).toBe(true);
    manager.setPlaying(false);
    expect(repo.get(id)!.state).toBe('active');
  });

  it('keeps downloading while playing unless chosen, and sends the speed limit to the worker', async () => {
    const { manager, repo, calls, id } = await setup({ downloadSpeedLimit: 5 * 1024 * 1024 });
    manager.applySchedule();
    manager.pump();
    manager.setPlaying(true);
    expect(repo.get(id)!.state).toBe('active');
    expect(calls).toContainEqual(['setLimit', { bytesPerSecond: 5 * 1024 * 1024 }]);
  });
});
