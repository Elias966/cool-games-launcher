// Downloads utility process: runs transfers independently of the UI, the
// browser and the AI, so they keep going when the user leaves the Store.
import { emit, serve } from './rpc';
import { bandwidth, probeUrl, runTransfer, TransferError, removePartial, type TransferSpec } from './transfer';

process.title = 'cgl-downloads';

interface Running {
  ac: AbortController;
  done: Promise<void>;
  deletePart: string | null;
}

const active = new Map<number, Running>();

serve({
  async start(p: { id: number; spec: TransferSpec }) {
    const existing = active.get(p.id);
    if (existing && !existing.ac.signal.aborted) return { alreadyRunning: true };
    // A stopping transfer must release the .part file before a new one opens it.
    if (existing) await existing.done;
    const ac = new AbortController();
    const entry: Running = { ac, done: Promise.resolve(), deletePart: null };
    entry.done = (async () => {
      try {
        const result = await runTransfer(
          p.spec,
          ac.signal,
          (meta) => emit('meta', { id: p.id, meta }),
          (progress) => emit('progress', { id: p.id, ...progress }),
        );
        emit('done', { id: p.id, result });
      } catch (e) {
        const err = e instanceof TransferError ? e : new TransferError('io', (e as Error).message);
        emit('error', { id: p.id, code: err.code, message: err.message, retryable: err.retryable });
      } finally {
        if (active.get(p.id) === entry) active.delete(p.id);
        if (entry.deletePart) removePartial(entry.deletePart);
      }
    })();
    active.set(p.id, entry);
    return { started: true };
  },
  async stop(p: { id: number; deletePart?: string }) {
    const running = active.get(p.id);
    if (running) {
      running.deletePart = p.deletePart ?? null;
      running.ac.abort();
      await running.done;
    } else if (p.deletePart) {
      removePartial(p.deletePart);
    }
    return { ok: true };
  },
  async probe(p: { url: string; headers: Record<string, string> }, signal: AbortSignal) {
    return probeUrl(p.url, p.headers, signal);
  },
  list() {
    return [...active.keys()];
  },
  /** Bandwidth cap for all transfers together, in bytes per second (0 = no limit). */
  setLimit(p: { bytesPerSecond: number }) {
    bandwidth.setLimit(p.bytesPerSecond);
    return { ok: true };
  },
});
