// Typed wrapper around the browser worker.
import type { WorkerHost } from './worker-host';
import type { PageExtract } from '@shared/page-extract';

export type BrowserContext = 'interactive' | 'discovery';

export interface SnapshotResult {
  png: string;
  url: string;
  title: string;
  loading: boolean;
  dpr: number;
  w: number;
  h: number;
  media: PageExtract['media'];
  adultSignals: string[];
}

export interface BrowserDownload {
  url: string;
  referrer: string | null;
  target: string;
  contentType: string | null;
  totalBytes: number | null;
  currentBytes: number;
  succeeded: boolean;
  stopped: boolean;
}

export class BrowserClient {
  constructor(readonly worker: WorkerHost) {}

  navigate(context: BrowserContext, url: string, signal?: AbortSignal) {
    return this.worker.call<{ url: string; title: string }>('navigate', { context, url }, signal);
  }
  extract(context: BrowserContext, signal?: AbortSignal) {
    return this.worker.call<PageExtract>('extract', { context }, signal);
  }
  snapshot(context: BrowserContext, withMedia: boolean, signal?: AbortSignal, labels = false) {
    return this.worker.call<SnapshotResult>('snapshot', { context, withMedia, labels }, signal);
  }
  clickElement(context: BrowserContext, index: number, signal?: AbortSignal) {
    return this.worker.call<{ before: string; after: string }>('clickElement', { context, index }, signal);
  }
  pointer(context: BrowserContext, x: number, y: number, button: 'left' | 'middle' | 'right' = 'left', signal?:AbortSignal) {
    return this.worker.call('pointer', { context, x, y, button },signal);
  }
  inspectPoint(context:BrowserContext,x:number,y:number,signal?:AbortSignal){return this.worker.call<{text:string;index:number|null;password:boolean;untrustedRegion:boolean;download:boolean}>('inspectPoint',{context,x,y},signal);}
  movePointer(context:BrowserContext,x:number,y:number,drag:boolean,signal?:AbortSignal){return this.worker.call('movePointer',{context,x,y,drag},signal);}
  scroll(context: BrowserContext, x: number, y: number, dx: number, dy: number, signal?: AbortSignal) {
    return this.worker.call('scroll', { context, x, y, dx, dy }, signal);
  }
  type(context: BrowserContext, input: { text?: string; key?: string; keys?: string[] },signal?:AbortSignal) {
    return this.worker.call('type', { context, ...input },signal);
  }
  history(context: BrowserContext, action: 'back' | 'forward' | 'reload', signal?: AbortSignal) {
    return this.worker.call('history', { context, action }, signal);
  }
  beginHuman(context: BrowserContext) {
    return this.worker.call<{ active: boolean }>('beginHuman', { context });
  }
  endHuman() {
    return this.worker.call<{ active: boolean }>('endHuman');
  }
  async takeDownloads(cancel: boolean, target?: string): Promise<BrowserDownload[]> {
    const r = await this.worker.call<BrowserDownload[] | { error: string }>('takeBrowserDownloads', { cancel, target });
    return Array.isArray(r) ? r : [];
  }
  cookieHeader(context: BrowserContext, url: string) {
    return this.worker.call<{ cookie: string; userAgent: string; currentUrl: string }>('cookieHeader', { context, url });
  }
  stopLoading(context: BrowserContext) {
    return this.worker.call('stopLoading', { context }).catch(() => undefined);
  }
  closeContext(context: BrowserContext) {
    return this.worker.call('closeContext', { context }).catch(() => undefined);
  }
  clearData() {
    return this.worker.call('clearData');
  }
  shutdown() {
    return this.worker.call('shutdown').catch(() => undefined);
  }
}
