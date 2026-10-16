import { describe, expect, it } from 'vitest';
import { imageWouldBeStale, promptPieces } from '../src/workers/prompt-cache';

const img = (n: string) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${n}` } });
const cover = (n: string) => promptPieces([{ role: 'system', content: 'Judge covers.' }, { role: 'user', content: [img(n), { type: 'text', text: 'Is it a woman?' }] }]);

describe('prompt cache and images', () => {
  it('skips the cache when only the image differs from the cached prompt', () => {
    expect(imageWouldBeStale(cover('aaa'), cover('bbb'))).toBe(true);
  });
  it('keeps the cache for the same image, a first request, or text that differs before the image', () => {
    expect(imageWouldBeStale(cover('aaa'), cover('aaa'))).toBe(false);
    expect(imageWouldBeStale(null, cover('aaa'))).toBe(false);
    const task = (goal: string, n: string) => promptPieces([{ role: 'system', content: 'Agent.' }, { role: 'user', content: goal }, { role: 'user', content: [img(n), { type: 'text', text: 'next' }] }]);
    expect(imageWouldBeStale(task('find game A', 'aaa'), task('find game B', 'bbb'))).toBe(false);
  });
  it('keeps the cache when a conversation continues with a new screenshot after the cached ones', () => {
    const step1 = [{ role: 'system', content: 'Agent.' }, { role: 'user', content: [img('s1'), { type: 'text', text: 'step' }] }];
    const step2 = [...step1, { role: 'assistant', content: 'click' }, { role: 'user', content: [img('s2'), { type: 'text', text: 'step' }] }];
    expect(imageWouldBeStale(promptPieces(step1), promptPieces(step2))).toBe(false);
  });
});
