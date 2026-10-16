// Preload: exposes a narrow, typed API. No Node.js objects reach the page.
import { contextBridge, ipcRenderer } from 'electron';
import type { CglApi, InvokeResult } from '@shared/ipc';

const listeners = new Map<string, Set<(payload: unknown) => void>>();

ipcRenderer.on('cgl:event', (_e, event: string, payload: unknown) => {
  for (const l of listeners.get(event) ?? []) {
    try {
      l(payload);
    } catch (err) {
      console.error(err);
    }
  }
});

const api: CglApi = {
  async invoke(channel: string, ...payload: unknown[]) {
    const res = (await ipcRenderer.invoke('cgl:invoke', channel, payload[0])) as InvokeResult<unknown>;
    if (!res.ok) throw new Error(res.error ?? 'Request failed');
    return res.value as never;
  },
  on(event: string, listener: (payload: never) => void) {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(listener as (payload: unknown) => void);
    return () => set!.delete(listener as (payload: unknown) => void);
  },
  windowControl(action: 'minimize' | 'maximize' | 'close' | 'fullscreen-on' | 'fullscreen-off' | `close-sound:${number}`) {
    ipcRenderer.send('cgl:window', action);
  },
} as CglApi;

contextBridge.exposeInMainWorld('cgl', api);
