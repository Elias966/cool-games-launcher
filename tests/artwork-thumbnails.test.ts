import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cardArtworkUrl } from '@shared/artwork';
import { ArtworkThumbnails } from '../src/main/artwork-thumbnails';
import { makeCardThumbnail } from '../src/workers/artwork-thumbnail';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'cgl-thumbnails-')); dirs.push(dir); return dir; };

describe('persistent card thumbnails', () => {
  it('keeps a stable card URL without changing original hero URLs', () => {
    const src = 'cgl-media://artwork/' + 'a'.repeat(40) + '.jpg';
    const card = cardArtworkUrl(src);
    expect(card).toBe(src + '?thumbnail=card-v1');
    expect(cardArtworkUrl(card)).toBe(card);
    expect(cardArtworkUrl('https://cdn.test/art.jpg')).toBe('https://cdn.test/art.jpg');
    expect(cardArtworkUrl(null)).toBeNull();
  });

  it('shrinks a large cover, preserves the original and reuses its disk thumbnail after restart', async () => {
    const dir = tmp(), file = 'a'.repeat(40) + '.jpg';
    const v = await require('wasm-vips')({ dynamicLibraries: [] }); v.concurrency(1);
    const source = v.Image.black(2560, 1440, { bands: 3 });
    writeFileSync(join(dir, file), source.writeToBuffer('.jpg')); source.delete();
    const hash = () => createHash('sha256').update(readFileSync(join(dir, file))).digest('hex');
    const before = hash(), dest = await makeCardThumbnail(dir, file);
    const thumbnail = v.Image.newFromBuffer(readFileSync(dest), '');
    expect([thumbnail.width, thumbnail.height]).toEqual([480, 270]); thumbnail.delete();
    expect(hash()).toBe(before);
    const written = statSync(dest).mtimeMs;
    const worker = { call: vi.fn() };
    const reopened = new ArtworkThumbnails(dir, worker);
    expect(await reopened.get(file)).toBe(dest);
    expect(worker.call).not.toHaveBeenCalled();
    expect(statSync(dest).mtimeMs).toBe(written);
    await expect(makeCardThumbnail(dir, '../elsewhere.png')).rejects.toThrow('Invalid artwork');
  });

  it('deduplicates concurrent requests and retries generation after worker failure', async () => {
    const dir = tmp(), file = 'b'.repeat(40) + '.png';
    let resolve!: (path: string) => void;
    const call = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const cache = new ArtworkThumbnails(dir, { call } as never);
    const first = cache.get(file), second = cache.get(file);
    expect(call).toHaveBeenCalledOnce(); resolve('/thumbnail.jpg');
    expect(await Promise.all([first, second])).toEqual(['/thumbnail.jpg', '/thumbnail.jpg']);
    const fail = vi.fn().mockRejectedValueOnce(new Error('worker stopped')).mockResolvedValue('/retry.jpg');
    const retry = new ArtworkThumbnails(dir, { call: fail });
    await expect(retry.get(file)).rejects.toThrow('worker stopped');
    expect(await retry.get(file)).toBe('/retry.jpg'); expect(fail).toHaveBeenCalledTimes(2);
  });
});
