// Typed push channel from main to the renderer window(s).
import type { WebContents } from 'electron';
import type { EventName, Events } from '@shared/ipc';

const targets = new Set<WebContents>();

export function attach(wc: WebContents) {
  targets.add(wc);
  wc.once('destroyed', () => targets.delete(wc));
}

export function publish<E extends EventName>(event: E, payload: Events[E]) {
  for (const wc of targets) {
    if (!wc.isDestroyed()) wc.send('cgl:event', event, payload);
  }
}

export function toast(kind: Events['toast']['kind'], message: string) {
  publish('toast', { kind, message });
}
