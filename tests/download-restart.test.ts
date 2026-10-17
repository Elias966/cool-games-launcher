import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, shell: {} }));
import { openDb } from '../src/main/db';
import { DownloadsRepo } from '../src/main/repos';
import { DownloadManager, moveBrowserDownload } from '../src/main/downloads';
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()));

describe('local update restart', () => {
  it('flushes a running transfer before shutdown and resumes the saved update with parallel connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-restart-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'db.sqlite'); let db = openDb(path); cleanup.push(() => db.close());
    const settings = { get: () => ({ maxConcurrentDownloads: 2, downloadConnections: 8, downloadsDir: dir }) };
    const policy = Object.assign(new EventEmitter(), { policy: () => ({ showNsfw: false, revision: 1 }) });
    let repo = new DownloadsRepo(db);
    const d = repo.create({ catalogId: null, title: 'Local update', sourceHost: 'fixture.test', state: 'active' });
    const part = join(dir, '1.part');
    repo.update(d.id, { url: 'https://fixture.test/update.zip', updateGameId: 12, partPath: part });
    const worker = Object.assign(new EventEmitter(), { call: vi.fn(async (method: string) => {
      if (method === 'stop') { writeFileSync(part, 'persisted partial'); worker.emit('event:error', { id: d.id, code: 'cancelled', message: 'stopped', retryable: false }); }
      return {};
    }) });
    const manager = new DownloadManager(worker as never, repo, {} as never, settings as never, policy as never, {} as never);
    await manager.shutdown();
    expect(repo.get(d.id)).toMatchObject({ state: 'queued', updateGameId: 12, receivedBytes: 17 });
    db.close(); db = openDb(path); repo = new DownloadsRepo(db);
    const restartedWorker = Object.assign(new EventEmitter(), { call: vi.fn(async () => ({})) });
    const reopened = new DownloadManager(restartedWorker as never, repo, {} as never, settings as never, policy as never, {} as never);
    reopened.recover();
    expect(repo.get(d.id)).toMatchObject({ state: 'active', updateGameId: 12 });
    expect(restartedWorker.call).toHaveBeenCalledWith('start', expect.objectContaining({ spec: expect.objectContaining({ partPath: part, connections: 8 }) }));
    await reopened.shutdown();
  });
});

describe('browser transfer recovery', () => {
  it('does not restart blobs or browser-only HTTP POST downloads as HTTP transfers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-browser-restart-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = openDb(join(dir, 'db')); cleanup.push(() => db.close()); const repo = new DownloadsRepo(db);
    const worker = Object.assign(new EventEmitter(), { call: vi.fn(async () => ({})) });
    for (const [url, errorCode] of [['blob:https://site.test/123', null], ['https://site.test/post', 'browser-only']] as const) {
      const d = repo.create({ catalogId: null, title: 'Browser file', sourceHost: 'site.test', state: 'active' });
      repo.update(d.id, { url, errorCode });
    }
    const policy = Object.assign(new EventEmitter(), { policy: () => ({ showNsfw: false, revision: 1 }) });
    const manager = new DownloadManager(worker as never, repo, {} as never, { get: () => ({ maxConcurrentDownloads: 2 }) } as never, policy as never, {} as never);
    manager.recover(); expect(repo.list().every(d => d.state === 'failed' && d.errorCode === 'browser-only')).toBe(true);
    expect(worker.call).not.toHaveBeenCalled(); await manager.shutdown();
  });
  it('copies across drives before removing the Firefox original, and retains it on copy failure', async () => {
    const io = { rename: vi.fn(async () => { throw Object.assign(new Error('cross device'), { code: 'EXDEV' }); }), copyFile: vi.fn(async () => {}), unlink: vi.fn(async () => {}) };
    await moveBrowserDownload('/staging/file', '/downloads/file', io);
    expect(io.copyFile).toHaveBeenCalledWith('/staging/file', '/downloads/file', expect.any(Number));
    expect(io.unlink).toHaveBeenCalledWith('/staging/file');
    io.unlink.mockClear(); io.copyFile.mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    await expect(moveBrowserDownload('/staging/file', '/downloads/file', io)).rejects.toThrow('full');
    expect(io.unlink).not.toHaveBeenCalledWith('/staging/file');
  });
});

it('drops a late Firefox poll after shutdown without touching the closed database', async () => {
  vi.useFakeTimers(); const dir = mkdtempSync(join(tmpdir(), 'cgl-late-browser-'));
  const db = openDb(join(dir, 'db')); const repo = new DownloadsRepo(db); let closed=false;
  const worker = Object.assign(new EventEmitter(), { call: vi.fn(async () => ({})) });
  const policy = Object.assign(new EventEmitter(), { policy: () => ({ showNsfw: false, revision: 1 }) });
  let finish!: (value: unknown[]) => void;
  const browser = { takeDownloads: vi.fn(() => new Promise<unknown[]>(r => { finish=r; })) };
  const manager = new DownloadManager(worker as never, repo, {} as never, { get: () => ({ downloadsDir: dir, maxConcurrentDownloads: 2 }) } as never, policy as never, browser as never);
  try {
    const d = repo.create({ catalogId:null,title:'Browser file',sourceHost:'fixture.test',state:'resolving' });
    manager.adoptBrowserDownload(d.id, { target:join(dir,'file'), url:'blob:https://fixture.test/id',totalBytes:10 } as never);
    await vi.advanceTimersByTimeAsync(1000); expect(browser.takeDownloads).toHaveBeenCalledOnce();
    await manager.shutdown(); expect(repo.get(d.id)?.state).toBe('failed'); db.close(); closed=true;
    finish([]); await vi.advanceTimersByTimeAsync(1);
  } finally { if (!closed) db.close(); rmSync(dir,{recursive:true,force:true}); vi.useRealTimers(); }
});

it('reports real Firefox download speed and retains observed progress in the queue',async()=>{
 vi.useFakeTimers();const dir=mkdtempSync(join(tmpdir(),'cgl-browser-speed-'));const db=openDb(join(dir,'db'));const repo=new DownloadsRepo(db);
 const worker=Object.assign(new EventEmitter(),{call:vi.fn(async()=>({}))});
 const original={target:join(dir,'game.zip'),url:'blob:https://host.test/file',referrer:null,contentType:null,currentBytes:1000,totalBytes:10000,succeeded:false,stopped:false};
 const browser={takeDownloads:vi.fn(async()=>[{...original,currentBytes:4000,speedBps:3000}])};
 const policy=Object.assign(new EventEmitter(),{policy:()=>({showNsfw:false,revision:1})});
 const manager=new DownloadManager(worker as never,repo,{} as never,{get:()=>({maxConcurrentDownloads:2})} as never,policy as never,browser as never);
 try{
  const d=repo.create({catalogId:null,title:'Browser file',sourceHost:'host.test',state:'resolving'});manager.adoptBrowserDownload(d.id,original);
  await vi.advanceTimersByTimeAsync(1000);
  expect(manager.items().find(x=>x.id===d.id)).toMatchObject({receivedBytes:4000,speedBps:3000,connections:1});
  expect(repo.get(d.id)?.receivedBytes).toBe(4000);
 }finally{await manager.shutdown();db.close();rmSync(dir,{recursive:true,force:true});vi.useRealTimers();}
});
