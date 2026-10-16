// Where a recorded sound starts and stops: leading and trailing silence is
// skipped, and no clip ever plays for more than MAX_CLIP_SECONDS.

/** Hard limit on how long one recorded sound plays. */
export const MAX_CLIP_SECONDS = 5;
/** Fade at the end of a clip that was cut at the limit. */
export const CUT_FADE_SECONDS = 0.25;

export interface ClipWindow { start: number; end: number; cut: boolean }

/** `samples` is one channel; returns seconds. */
export function clipWindow(samples: Float32Array, sampleRate: number, threshold = 0.004): ClipWindow {
  const loud = (i: number) => Math.abs(samples[i]) > threshold;
  let first = 0, last = samples.length - 1;
  while (first < last && !loud(first)) first++;
  while (last > first && !loud(last)) last--;
  const duration = samples.length / sampleRate;
  const start = Math.max(0, first / sampleRate - 0.005);
  let end = Math.min(duration, last / sampleRate + 0.08);
  const cut = end - start > MAX_CLIP_SECONDS;
  if (cut) end = start + MAX_CLIP_SECONDS;
  return { start, end, cut };
}
