import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mock = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ protocol: { handle: mock.handle } }));
import { handleMedia } from '../src/main/media';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('cached artwork protocol', () => {
  it('refuses a queued thumbnail if visibility changes during its decode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-media-policy-')); dirs.push(dir);
    const file = 'c'.repeat(40) + '.jpg', thumb = join(dir, 'thumb.jpg'); writeFileSync(thumb, 'thumbnail');
    let visible = true, complete!: (path: string) => void;
    handleMedia({ artworkDir: dir, catalog: { artworkVisible: () => visible, isStoreArtwork: () => false }, policy: { policy: () => ({}) }, browserView: {}, thumbnails: { get: () => new Promise<string>((resolve) => { complete = resolve; }) } } as never);
    const handler = mock.handle.mock.calls.at(-1)![1];
    const pending = handler(new Request(`cgl-media://artwork/${file}?thumbnail=card-v1`));
    visible = false; complete(thumb);
    expect((await pending).status).toBe(403);
  });
  it('serves custom images and checks current visibility even on repeated requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-media-')); dirs.push(dir);
    const file = 'custom-' + 'a'.repeat(20) + '.png'; writeFileSync(join(dir, file), 'image');
    let visible = true;
    handleMedia({ artworkDir: dir, catalog: { artworkVisible: () => visible, isStoreArtwork: () => false }, policy: { policy: () => ({}) }, browserView: {} } as never);
    const handler = mock.handle.mock.calls.at(-1)![1];
    const request = new Request(`cgl-media://artwork/${file}`);
    const response = await handler(request);
    expect(response.status).toBe(200); expect(await response.text()).toBe('image');
    expect(response.headers.get('content-type')).toBe('image/png');
    visible = false; expect((await handler(request)).status).toBe(403);
    expect((await handler(new Request('cgl-media://artwork/bad-file.png'))).status).toBe(400);
  });
  it('makes store thumbnails cacheable while retaining policy checks for catalog artwork', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-media-card-')); dirs.push(dir);
    const file = 'b'.repeat(40) + '.jpg', thumb = join(dir, 'thumb.jpg'); writeFileSync(thumb, 'small thumbnail');
    let store = true, visible = true;
    const get = vi.fn(async () => thumb);
    handleMedia({ artworkDir: dir, catalog: { artworkVisible: () => visible, isStoreArtwork: () => store }, policy: { policy: () => ({}) }, browserView: {}, thumbnails: { get } } as never);
    const handler = mock.handle.mock.calls.at(-1)![1];
    const request = new Request(`cgl-media://artwork/${file}?thumbnail=card-v1`);
    const response = await handler(request);
    expect(await response.text()).toBe('small thumbnail');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(get).toHaveBeenCalledWith(file);
    store = false;
    expect((await handler(request)).headers.get('cache-control')).toBe('no-store');
    visible = false;
    expect((await handler(request)).status).toBe(403);
    expect(get).toHaveBeenCalledTimes(2); // denied requests never touch the decoder
  });

});
