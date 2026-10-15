// Per-host politeness: a minimum interval between requests to the same host.

export class HostRateLimiter {
  private next = new Map<string, number>();

  /** Waits until a request to `host` is allowed, then reserves the slot. */
  async wait(host: string, intervalMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw Object.assign(Error('Cancelled'),{code:'cancelled'});
    const t = Date.now();
    const previous = this.next.get(host) ?? 0;
    const at = Math.max(t, previous);
    const reserved = at + intervalMs;
    this.next.set(host, reserved);
    const delay = at - t;
    if (delay <= 0) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(Object.assign(Error('Cancelled'), {code:'cancelled'})); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort',abort); resolve(); }, delay);
        signal?.addEventListener('abort',abort,{once:true});
      });
    } catch(error) {
      // An interrupted discovery request must not reserve an unused slot in
      // front of the user's search. Preserve newer reservations/backoff.
      if(this.next.get(host)===reserved)this.next.set(host,previous);
      throw error;
    }
  }

  /** Pushes the next allowed time out, e.g. after HTTP 429. */
  backoff(host: string, ms: number) {
    this.next.set(host, Math.max(this.next.get(host) ?? 0, Date.now() + ms));
  }

  /** A completed human check releases the old block delay; ordinary pacing still applies. */
  verified(host: string) {
    this.next.delete(host);
  }
}
