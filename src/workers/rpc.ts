// Worker-side RPC: dispatches requests from the main process to handlers and
// gives each handler an AbortSignal that fires when main cancels the request.
import type { FromWorker, ToWorker } from '@shared/worker-protocol';

type Handler = (params: any, signal: AbortSignal) => Promise<unknown> | unknown;

interface ParentPort {
  on(event: 'message', listener: (e: { data: ToWorker }) => void): void;
  postMessage(message: FromWorker): void;
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort;

const inflight = new Map<number, AbortController>();

export function emit(event: string, data: unknown): void {
  port?.postMessage({ kind: 'event', event, data });
}

export function log(...args: unknown[]): void {
  console.log(`[${process.title}]`, ...args);
}

export function serve(handlers: Record<string, Handler>): void {
  if (!port) throw new Error('Worker must run inside an Electron utility process');
  port.on('message', async ({ data: msg }) => {
    if (msg.kind === 'cancel') {
      inflight.get(msg.id)?.abort();
      return;
    }
    const handler = handlers[msg.method];
    if (!handler) {
      port.postMessage({ kind: 'res', id: msg.id, ok: false, error: { message: `Unknown method ${msg.method}` } });
      return;
    }
    const ac = new AbortController();
    inflight.set(msg.id, ac);
    try {
      const value = await handler(msg.params, ac.signal);
      port.postMessage({ kind: 'res', id: msg.id, ok: true, value });
    } catch (err) {
      const e = err as Error & { code?: string };
      const code = ac.signal.aborted ? 'cancelled' : e?.code;
      port.postMessage({ kind: 'res', id: msg.id, ok: false, error: { message: e?.message ?? String(err), code } });
    } finally {
      inflight.delete(msg.id);
    }
  });
  process.on('uncaughtException', (err) => {
    console.error(`[${process.title}] uncaught`, err);
  });
  process.on('unhandledRejection', (err) => {
    console.error(`[${process.title}] unhandled rejection`, err);
  });
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const e = new Error('Cancelled') as Error & { code: string };
    e.code = 'cancelled';
    throw e;
  }
}
