import { describe, expect, it } from 'vitest';
import { MAX_CLIP_SECONDS, clipWindow } from '../src/renderer/sound-clip';

const RATE = 8000;
function signal(silenceBefore: number, sound: number, silenceAfter: number) {
  const s = new Float32Array(Math.round((silenceBefore + sound + silenceAfter) * RATE));
  for (let i = Math.round(silenceBefore * RATE); i < Math.round((silenceBefore + sound) * RATE); i++) s[i] = Math.sin(i / 5) * 0.5;
  return s;
}

describe('recorded sound clips', () => {
  it('skips leading and trailing silence', () => {
    const w = clipWindow(signal(1, 0.5, 2), RATE);
    expect(w.start).toBeGreaterThan(0.99);
    expect(w.start).toBeLessThan(1.01);
    expect(w.end - w.start).toBeLessThan(0.6);
    expect(w.cut).toBe(false);
  });

  it('never plays longer than five seconds', () => {
    const w = clipWindow(signal(0.3, 180, 0), RATE);
    expect(MAX_CLIP_SECONDS).toBe(5);
    expect(w.end - w.start).toBeCloseTo(5, 5);
    expect(w.start).toBeGreaterThan(0.29);
    expect(w.cut).toBe(true);
  });

  it('copes with a silent file', () => {
    const w = clipWindow(new Float32Array(RATE * 10), RATE);
    expect(w.end - w.start).toBeLessThanOrEqual(5);
  });
});
