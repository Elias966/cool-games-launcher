// Main-side handle for a utility-process worker: request/response with ids,
// cancellation through AbortSignal, event fan-out and automatic restart.
import { utilityProcess, type UtilityProcess } from 'electron';
import { EventEmitter } from 'node:events';
import type { FromWorker } from '@shared/worker-protocol';
import { WorkerError } from '@shared/worker-protocol';

interface Pending {
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  cleanup: () => void;
}

export class WorkerHost extends EventEmitter {
  private proc: UtilityProcess | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private initParams: { method: string; params: unknown } | null = null;
  private stopped = false;
  private restarts: number[] = [];

  constructor(
    readonly name: string,
    private modulePath: string,
    private serviceName: string,
  ) {
    super();
  }

  start() {
    if (this.proc) return;
    this.stopped = false;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    const proc = utilityProcess.fork(this.modulePath, [], { serviceName: this.serviceName, stdio: 'pipe', env });
    proc.stdout?.on('data', (d) => process.stdout.write(`[${this.name}] ${d}`));
    proc.stderr?.on('data', (d) => process.stderr.write(`[${this.name}] ${d}`));
    proc.on('message', (msg: FromWorker) => this.onMessage(msg));
    proc.on('exit', (code) => this.onExit(code));
    this.proc = proc;
    if (this.initParams) void this.call(this.initParams.method, this.initParams.params).catch(() => undefined);
  }

  /** Stores parameters re-sent automatically after a restart. */
  async init(method: string, params: unknown) {
    this.initParams = { method, params };
    return this.call(method, params);
  }

  private onMessage(msg: FromWorker) {
    if (msg.kind === 'event') {
      this.emit('event', msg.event, msg.data);
      this.emit(`event:${msg.event}`, msg.data);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    p.cleanup();
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new WorkerError(msg.error?.message ?? 'Worker error', msg.error?.code));
  }

  private onExit(code: number) {
    if (!this.stopped) console.warn(`[${this.name}] worker exited (${code})`);
    this.proc = null;
    for (const [, p] of this.pending) {
      p.cleanup();
      p.reject(new WorkerError(`${this.name} worker stopped`, 'worker-exit'));
    }
    this.pending.clear();
    this.emit('exit', code);
    if (this.stopped) return;
    const t = Date.now();
    this.restarts = this.restarts.filter((r) => t - r < 60_000);
    this.restarts.push(t);
    if (this.restarts.length > 5) {
      console.error(`[${this.name}] crashed repeatedly; not restarting`);
      this.emit('failed');
      return;
    }
    setTimeout(() => this.start(), 500 * this.restarts.length);
  }

  call<T = any>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.proc) this.start();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new WorkerError('Cancelled', 'cancelled'));
      const onAbort = () => this.proc?.postMessage({ kind: 'cancel', id });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', onAbort) });
      this.proc!.postMessage({ kind: 'req', id, method, params });
    });
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }

  get alive() {
    return !!this.proc;
  }
}
