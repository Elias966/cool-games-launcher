// One foreground AI task owns Firefox/model decisions at a time. Discovery
// drains its cancelled request before ownership changes; its cursor survives.
import { StoreSession, StaleResultError, type SessionToken } from './store-session';

type Work = { priority: number; token: SessionToken; run: (token: SessionToken) => Promise<unknown>; resolve: (value: any) => void; reject: (error: unknown) => void; cleanup: () => void };
export class ForegroundWork {
  private queue: Work[] = [];
  private busy = false;
  private holds = new Set<string>();
  private handoffTimer: NodeJS.Timeout | null = null;
  constructor(private session: StoreSession, private background: { setPaused(paused: boolean): Promise<void> }) {
    session.on('leave', () => {
      if(this.handoffTimer)clearTimeout(this.handoffTimer);
      this.handoffTimer=null;this.holds.delete('transfer-handoff');
      this.holds.delete('search-input'); this.sync();
    });
  }
  /** Allow the transfer's completion event to queue preparation before restarting
   * background Qwen. Long downloads resume indexing after this bounded window. */
  transferHandoff() {
    if(this.handoffTimer)clearTimeout(this.handoffTimer);
    this.hold('transfer-handoff',true);
    this.handoffTimer=setTimeout(()=>{
      this.handoffTimer=null;this.hold('transfer-handoff',false);
    },1500);
    this.handoffTimer.unref();
  }
  hold(key: string, held: boolean) {
    if (held) this.holds.add(key); else this.holds.delete(key);
    this.sync();
  }
  private sync() { void this.background.setPaused(this.busy || !!this.queue.length || !!this.holds.size).catch(error => console.error('[foreground] background pause failed', error)); }
  run<T>(priority: number, run: (token: SessionToken) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const parent = this.session.token();
    if (!parent) return Promise.reject(new StaleResultError('foreground task'));
    const token = { epoch: parent.epoch, signal: signal ? AbortSignal.any([parent.signal, signal]) : parent.signal };
    if (token.signal.aborted) return Promise.reject(new StaleResultError('foreground task'));
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(work);
        if (index < 0) return; // Running work must finish draining before reuse.
        this.queue.splice(index, 1);
        work.cleanup();
        reject(new StaleResultError('foreground task'));
        this.sync();
      };
      const work: Work = { priority, token, run, resolve, reject, cleanup: () => token.signal.removeEventListener('abort', abort) };
      token.signal.addEventListener('abort', abort, { once: true });
      this.queue.push(work);
      this.queue.sort((a, b) => b.priority - a.priority);
      this.sync();
      void this.pump();
    });
  }
  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.background.setPaused(true);
      while (this.queue.length) {
        const work = this.queue.shift()!;
        work.cleanup();
        try { this.session.assertLive(work.token); work.resolve(await work.run(work.token)); }
        catch (error) { work.reject(error); }
      }
    } catch (error) {
      // A failed discovery drain must settle callers, not strand their UI in
      // "resolving" with an unresolved promise and no queued task running.
      for (const work of this.queue.splice(0)) { work.cleanup(); work.reject(error); }
    } finally { this.busy = false; this.sync(); }
  }
}
