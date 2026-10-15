// Download queue. Persists every record and checkpoint in SQLite, recovers
// after restarts, and hands transfers to the independent downloads worker.
// Leaving the Store never touches transfers that already started.
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { existsSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { shell } from 'electron';
import type { WorkerHost } from './worker-host';
import type { DownloadsRepo, DownloadRecord, SettingsRepo, CatalogRepo } from './repos';
import { toDownloadItem } from './repos';
import type { PolicyService } from './policy-service';
import { publish, toast } from './bus';
import type { DownloadErrorCode, DownloadItem, UserPrompt } from '@shared/types';
import { fileNameFromUrl } from '@shared/urls';
import { uniquePath, sanitizeFileName, partialBytes, removePartial } from '../workers/transfer';
import type { BrowserClient, BrowserDownload } from './browser-client';
import { tm } from './i18n';

const MAX_AUTO_RETRIES = 5;

interface Live {
  speedBps: number;
  etaSeconds: number | null;
  lastPersist: number;
  connections?: number;
}

export class DownloadManager extends EventEmitter {
  private live = new Map<number, Live>();
  private retryTimers = new Map<number, NodeJS.Timeout>();
  private browserTargets = new Map<number, string>();
  private browserWatch = new Map<number, NodeJS.Timeout>();
  private listTimer: NodeJS.Timeout | null = null;

  constructor(
    private worker: WorkerHost,
    private repo: DownloadsRepo,
    private catalog: CatalogRepo,
    private settings: SettingsRepo,
    private policy: PolicyService,
    private browser: BrowserClient,
  ) {
    super();
    worker.on('event:meta', (e: { id: number; meta: { etag: string | null; lastModified: string | null; totalBytes: number | null; resumable: boolean; fileName: string | null; finalUrl: string; connections?: number } }) => {
      const d = this.repo.get(e.id);
      if (!d || d.state !== 'active') return;
      const live = this.live.get(e.id);
      if (live) live.connections = e.meta.connections ?? 1;
      this.repo.update(e.id, {
        etag: e.meta.etag,
        lastModified: e.meta.lastModified,
        totalBytes: e.meta.totalBytes,
        resumable: e.meta.resumable,
        fileName: e.meta.fileName ? sanitizeFileName(e.meta.fileName) : d.fileName,
      });
      this.broadcastList();
    });
    worker.on('event:progress', (e: { id: number; receivedBytes: number; totalBytes: number | null; speedBps: number; etaSeconds: number | null; connections?: number }) => {
      const d = this.repo.get(e.id);
      if (!d || d.state !== 'active') return;
      const l = this.live.get(e.id) ?? { speedBps: 0, etaSeconds: null, lastPersist: 0 };
      l.speedBps = e.speedBps;
      l.etaSeconds = e.etaSeconds;
      l.connections = e.connections ?? 1;
      // Persist display progress; the transfer checkpoint records written ranges.
      if (Date.now() - l.lastPersist > 2000) {
        l.lastPersist = Date.now();
        this.repo.update(e.id, { receivedBytes: e.receivedBytes, totalBytes: e.totalBytes });
      }
      this.live.set(e.id, l);
      publish('download:progress', { id: e.id, receivedBytes: e.receivedBytes, totalBytes: e.totalBytes, speedBps: e.speedBps, etaSeconds: e.etaSeconds, connections: l.connections, state: 'active' });
    });
    worker.on('event:done', (e: { id: number; result: { path: string; receivedBytes: number; totalBytes: number | null; fileName: string | null } }) => {
      this.live.delete(e.id);
      const d = this.repo.get(e.id);
      if (!d || d.state !== 'active') return;
      this.repo.update(e.id, {
        state: 'completed',
        finalPath: e.result.path,
        receivedBytes: e.result.receivedBytes,
        totalBytes: e.result.totalBytes ?? e.result.receivedBytes,
        fileName: e.result.path.split('/').pop() ?? d.fileName,
        errorCode: null,
        errorDetail: null,
        completedAt: new Date().toISOString(),
      });
      if (d.catalogId !== null) toast('success', tm('Downloaded {title}. Preparing the game for your Library.', { title: d.title }));
      this.emit('completed', e.id, e.result.path);
      this.broadcastList();
      this.pump();
    });
    worker.on('event:error', (e: { id: number; code: DownloadErrorCode | 'cancelled'; message: string; retryable: boolean }) => this.onError(e));
    worker.on('exit', () => {
      // The worker restarts by itself; requeue anything that was running.
      for (const d of this.repo.byState('active')) {
        if (this.browserWatch.has(d.id)) continue;
        this.repo.update(d.id, { state: 'queued' });
      }
      setTimeout(() => this.pump(), 1500);
    });
    policy.on('changed', () => this.broadcastList());
  }

  /** Called once at startup: everything that was in flight resumes from its checkpoint. */
  recover() {
    for (const d of this.repo.list()) {
      if (d.state === 'active') {
        const partSize = partialBytes(d.partPath);
        this.repo.update(d.id, { state: d.url ? 'queued' : 'needs-resolution', receivedBytes: partSize, errorCode: d.url ? null : 'interrupted' });
      } else if (d.state === 'resolving') {
        this.repo.update(d.id, { state: 'needs-resolution', errorCode: 'interrupted', errorDetail: 'Link resolution was interrupted. It continues automatically.' });
      }
    }
    this.pump();
  }

  items(): DownloadItem[] {
    const policy = this.policy.policy();
    return this.repo.list().map((d) => {
      const item = toDownloadItem(d, this.live.get(d.id));
      item.artwork = d.artworkFile && this.catalog.artworkVisible(d.artworkFile, policy) ? `cgl-media://artwork/${encodeURIComponent(d.artworkFile)}` : null;
      return item;
    });
  }

  broadcastList() {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      publish('downloads:changed', this.items());
      this.emit('listChanged');
    }, 50);
  }

  partPathFor(id: number) {
    const dir = join(this.settings.get().downloadsDir, '.partial');
    mkdirSync(dir, { recursive: true });
    return join(dir, `${id}.part`);
  }

  /** Creates a record for a catalog entry; resolution is started by the caller. */
  create(catalogId: number, title: string, sourceHost: string | null): DownloadRecord {
    const existing = this.repo.activeForCatalog(catalogId);
    if (existing) return existing;
    const d = this.repo.create({ catalogId, title, sourceHost, state: 'resolving' });
    this.broadcastList();
    return d;
  }

  setPrompt(id: number, prompt: UserPrompt | null, state: DownloadRecord['state'] = prompt ? 'needs-user' : 'resolving') {
    this.repo.update(id, { userPrompt: prompt, state });
    this.broadcastList();
  }

  /** Hands a resolved HTTP(S) URL to the transfer worker. */
  handoff(id: number, url: string, headers: Record<string, string>, fileNameHint: string | null, totalBytes: number | null) {
    const d = this.repo.get(id);
    if (!d) return;
    // A different URL for the same file keeps the partial data; If-Range validation restarts it if it changed.
    this.repo.update(id, {
      url,
      headers,
      fileName: sanitizeFileName(fileNameHint ?? fileNameFromUrl(url) ?? d.fileName ?? 'download'),
      totalBytes: totalBytes ?? d.totalBytes,
      partPath: d.partPath ?? this.partPathFor(id),
      state: 'queued',
      userPrompt: null,
      resolution: null,
      errorCode: null,
      errorDetail: null,
    });
    this.broadcastList();
    this.pump();
  }

  /** A download that Firefox has to perform itself (blob:/data: URLs, POST forms). Not resumable. */
  adoptBrowserDownload(id: number, dl: BrowserDownload) {
    this.browserTargets.set(id, dl.target);
    this.repo.update(id, {
      url: dl.url.slice(0, 200),
      fileName: sanitizeFileName(dl.target.split('/').pop()),
      totalBytes: dl.totalBytes,
      resumable: false,
      state: 'active',
      userPrompt: null,
      errorCode: null,
      errorDetail: 'This site creates the file inside the browser, so it downloads through Firefox and cannot be resumed if interrupted.',
    });
    this.broadcastList();
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const list = await this.browser.takeDownloads(false);
        if (this.repo.get(id)?.state !== 'active' || this.browserTargets.get(id) !== dl.target) return;
        const cur = list.find((x) => x.target === dl.target);
        if (!cur || (cur.stopped && !cur.succeeded)) {
          clearInterval(timer);
          this.browserWatch.delete(id);
          this.browserTargets.delete(id);
          this.repo.update(id, { state: 'failed', errorCode: 'browser-only', errorDetail: 'The browser download stopped. Sites that build the file inside the browser cannot be resumed; start it again from the Store.' });
          this.broadcastList();
          return;
        }
        publish('download:progress', { id, receivedBytes: cur.currentBytes, totalBytes: cur.totalBytes, speedBps: 0, etaSeconds: null, state: 'active' });
        if (cur.succeeded) {
          clearInterval(timer);
          this.browserWatch.delete(id);
          const dir = this.settings.get().downloadsDir;
          mkdirSync(dir, { recursive: true });
          const dest = uniquePath(dir, sanitizeFileName(cur.target.split('/').pop()));
          renameSync(cur.target, dest);
          this.browserTargets.delete(id);
          this.repo.update(id, { state: 'completed', finalPath: dest, receivedBytes: cur.currentBytes, totalBytes: cur.currentBytes, completedAt: new Date().toISOString(), errorDetail: null });
          toast('success', tm('Downloaded {title}. Preparing your Library.', { title: this.repo.get(id)?.title ?? tm('the file') }));
          this.emit('completed', id, dest);
          this.broadcastList();
          this.pump();
          await this.browser.takeDownloads(true, dl.target);
        }
      } catch {
        /* browser busy; try again next tick */
      } finally {
        polling = false;
      }
    }, 1000);
    this.browserWatch.set(id, timer);
  }

  pump() {
    const max = this.settings.get().maxConcurrentDownloads;
    const all = this.repo.list();
    let active = all.filter((d) => d.state === 'active').length;
    for (const d of all) {
      if (active >= max) break;
      if (d.state !== 'queued' || !d.url) continue;
      active++;
      this.startTransfer(d);
    }
  }

  private startTransfer(d: DownloadRecord) {
    const partPath = d.partPath ?? this.partPathFor(d.id);
    this.repo.update(d.id, { state: 'active', partPath, errorCode: null, errorDetail: null });
    this.live.set(d.id, { speedBps: 0, etaSeconds: null, lastPersist: Date.now() });
    this.broadcastList();
    void this.worker
      .call('start', {
        id: d.id,
        spec: {
          url: d.url,
          headers: d.headers,
          partPath,
          finalDir: this.settings.get().downloadsDir,
          fileNameHint: d.fileName,
          etag: d.etag,
          lastModified: d.lastModified,
          expectedTotal: d.totalBytes,
          connections: this.settings.get().downloadConnections,
        },
      })
      .catch((e) => this.onError({ id: d.id, code: 'io', message: (e as Error).message, retryable: true }));
  }

  private onError(e: { id: number; code: DownloadErrorCode | 'cancelled'; message: string; retryable: boolean }) {
    this.live.delete(e.id);
    const d = this.repo.get(e.id);
    if (!d || e.code === 'cancelled') return; // pause/cancel already set the state
    if (d.state !== 'active') return;
    const partSize = partialBytes(d.partPath);
    if (e.code === 'link-expired' && d.modelAsset) {
      this.repo.update(e.id, { state: 'failed', errorCode: 'link-expired', errorDetail: 'Model download link failed. Retry from Settings → Local AI.', receivedBytes: partSize });
      toast('warning', tm('Retry the download for {title} in Settings → Local AI.', { title: d.title }));
    } else if (e.code === 'link-expired') {
      this.repo.update(e.id, { state: 'needs-resolution', errorCode: 'link-expired', errorDetail: e.message, receivedBytes: partSize });
      toast('info', tm('The link for {title} expired — finding a fresh one.', { title: d.title }));
    } else if (e.code === 'disk-full') {
      this.repo.update(e.id, { state: 'paused', errorCode: 'disk-full', errorDetail: e.message, receivedBytes: partSize });
      toast('error', tm('Downloads paused: the disk is full.'));
    } else if (e.retryable && d.retries < MAX_AUTO_RETRIES) {
      const delay = Math.min(60_000, 2000 * 2 ** d.retries);
      // Held as paused until the backoff passes, then queued again.
      this.repo.update(e.id, { state: 'paused', retries: d.retries + 1, errorCode: e.code as DownloadErrorCode, errorDetail: `${e.message} Retrying in ${Math.round(delay / 1000)} s…`, receivedBytes: partSize });
      const t = setTimeout(() => {
        this.retryTimers.delete(e.id);
        const cur = this.repo.get(e.id);
        if (cur?.state === 'paused' && cur.errorCode === e.code) {
          this.repo.update(e.id, { state: 'queued' });
          this.broadcastList();
          this.pump();
        }
      }, delay);
      this.retryTimers.set(e.id, t);
    } else {
      this.repo.update(e.id, { state: 'failed', errorCode: e.code as DownloadErrorCode, errorDetail: e.message, receivedBytes: partSize });
      toast('error', tm('Download failed: {title}', { title: d.title }));
    }
    this.broadcastList();
    this.pump();
  }

  async pause(id: number) {
    const d = this.repo.get(id);
    if (!d) return;
    if (this.browserWatch.has(id)) throw new Error('This host downloads through Firefox and cannot pause. Cancel it or let it finish.');
    if (d.state === 'active' || d.state === 'queued') {
      this.repo.update(id, { state: 'paused', errorCode: null, errorDetail: null });
      await this.worker.call('stop', { id }).catch(() => undefined);
      const partSize = partialBytes(d.partPath);
      this.repo.update(id, { receivedBytes: partSize });
      this.live.delete(id);
    }
    this.broadcastList();
    this.pump();
  }

  resume(id: number) {
    const d = this.repo.get(id);
    if (!d) return;
    if ((d.state === 'paused' || d.state === 'failed') && d.url) {
      if (d.errorCode === 'browser-only') throw new Error('This browser download cannot resume. Start the download again from the Store.');
      clearTimeout(this.retryTimers.get(id));
      this.repo.update(id, { state: 'queued', errorCode: null, errorDetail: null, retries: d.state === 'failed' ? 0 : d.retries });
    }
    this.broadcastList();
    this.pump();
  }

  async cancel(id: number) {
    const d = this.repo.get(id);
    if (!d) return;
    clearTimeout(this.retryTimers.get(id));
    clearInterval(this.browserWatch.get(id));
    this.browserWatch.delete(id);
    const target = this.browserTargets.get(id);
    this.browserTargets.delete(id);
    this.repo.update(id, { state: 'cancelled', userPrompt: null });
    if (target) await this.browser.takeDownloads(true, target);
    await this.worker.call('stop', { id, deletePart: d.partPath ?? undefined }).catch(() => undefined);
    this.live.delete(id);
    this.broadcastList();
    this.pump();
  }

  async remove(id: number, deleteFile: boolean) {
    const d = this.repo.get(id);
    if (!d) return;
    if (d.state === 'active' || d.state === 'queued') await this.cancel(id);
    if (deleteFile && d.finalPath && d.finalPath.startsWith(this.settings.get().downloadsDir + '/')) rmSync(d.finalPath, { force: true });
    if (d.partPath) removePartial(d.partPath);
    this.repo.remove(id);
    this.broadcastList();
  }

  reveal(id: number) {
    const d = this.repo.get(id);
    if (d?.finalPath && existsSync(d.finalPath)) shell.showItemInFolder(d.finalPath);
  }

  failResolution(id: number, code: DownloadErrorCode, message: string, state: DownloadRecord['state'] = 'failed') {
    this.repo.update(id, { state, errorCode: code, errorDetail: message, userPrompt: null });
    this.broadcastList();
  }
}
