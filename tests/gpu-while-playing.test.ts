import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { AiService } from '../src/main/ai';
import { StoreSession } from '../src/main/store-session';

describe('freeing the GPU while a game runs', () => {
  it('unloads the model and holds AI requests until the game closes', async () => {
    const worker = Object.assign(new EventEmitter(), { call: vi.fn(async (method: string) => (method === 'chat' ? { message: { role: 'assistant', content: 'ok' }, modelId: 'm' } : {})) });
    const session = new StoreSession();
    const token = session.enter();
    const ai = new AiService(worker as never, session, {} as never, () => ({ browsing: 'm', computer: 'm', analysis: 'm' }) as never);
    await ai.pauseForGame(true);
    expect(worker.call).toHaveBeenCalledWith('unload');
    expect(ai.getStatus().phase).toBe('paused');
    let done = false;
    const request = ai.chatTools(token, 'computer', [], []).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    expect(worker.call).not.toHaveBeenCalledWith('chat', expect.anything(), expect.anything());
    await ai.pauseForGame(false);
    await request;
    expect(done).toBe(true);
    session.leave();
  });
});
