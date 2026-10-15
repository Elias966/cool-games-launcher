// Tracks whether the Store tab is active. AI work (discovery, AI navigation,
// download resolution) may only run inside an active session. Leaving the
// Store aborts the session's signal and advances the epoch, so any result
// that arrives late is recognisably stale and dropped.
import { EventEmitter } from 'node:events';

export class StaleResultError extends Error {
  readonly code = 'cancelled';
  constructor(what = 'result') {
    super(`Discarded stale ${what}`);
    this.name = 'StaleResultError';
  }
}

export interface SessionToken {
  readonly epoch: number;
  readonly signal: AbortSignal;
}

export class StoreSession extends EventEmitter {
  private epoch = 0;
  private controller: AbortController | null = null;

  get active(): boolean {
    return this.controller !== null;
  }

  /** Current token, or null when the Store is not active. */
  token(): SessionToken | null {
    return this.controller ? { epoch: this.epoch, signal: this.controller.signal } : null;
  }

  enter(): SessionToken {
    if (this.controller) return this.token()!;
    this.epoch++;
    this.controller = new AbortController();
    this.emit('enter', this.token());
    return this.token()!;
  }

  leave() {
    if (!this.controller) return;
    const c = this.controller;
    this.controller = null;
    this.epoch++; // anything stamped with the old epoch is now stale
    c.abort();
    this.emit('leave');
  }

  /** True while `token` belongs to the live session. */
  isLive(token: SessionToken | null | undefined): boolean {
    return !!token && !!this.controller && token.epoch === this.epoch && !token.signal.aborted;
  }

  /** Throws if `token` is no longer live. Call before every AI action and before committing AI results. */
  assertLive(token: SessionToken | null | undefined, what?: string) {
    if (!this.isLive(token)) throw new StaleResultError(what);
  }
}
