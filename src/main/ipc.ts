// Validated IPC: one entry point, sender check, schema validation, typed handlers.
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { requests, type Channel, type Responses, type InvokeResult } from '@shared/ipc';
import type { z } from 'zod';

type Handler<C extends Channel> = (payload: z.output<(typeof requests)[C]>, event: IpcMainInvokeEvent) => Promise<Responses[C]> | Responses[C];
export type Handlers = { [C in Channel]: Handler<C> };

export function registerIpc(handlers: Handlers, isTrustedSender: (e: IpcMainInvokeEvent) => boolean) {
  ipcMain.handle('cgl:invoke', async (event, channel: unknown, payload: unknown): Promise<InvokeResult<unknown>> => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted sender' };
    if (typeof channel !== 'string' || !Object.prototype.hasOwnProperty.call(requests, channel)) return { ok: false, error: 'Unknown channel' };
    const schema = requests[channel as Channel];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
    try {
      const handler = handlers[channel as Channel] as Handler<Channel>;
      const value = await handler(parsed.data as never, event);
      return { ok: true, value };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (process.env.CGL_DEBUG) console.error(`[ipc] ${channel}`, e);
      return { ok: false, error: msg };
    }
  });
}
