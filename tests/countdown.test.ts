import { describe, expect, it } from 'vitest';
import { countdownSeconds, waitMs } from '../src/shared/countdown';

describe('download countdowns', () => {
  it('reads the time a host asks to wait', () => {
    expect(countdownSeconds('Your download will start in 15 seconds.')).toBe(15);
    expect(countdownSeconds('Please wait 10 sec')).toBe(10);
    expect(countdownSeconds('Download link ready in 45s')).toBe(45);
    expect(countdownSeconds('8 seconds remaining')).toBe(8);
    expect(countdownSeconds('Generating link… available after 20 seconds')).toBe(20);
  });

  it('ignores pages without a countdown', () => {
    expect(countdownSeconds('Size: 1.2 GB · Released in 2019 · 4 screenshots')).toBeNull();
    expect(countdownSeconds('Download now')).toBeNull();
  });

  it('waits for the countdown, at most 30 seconds per step', () => {
    expect(waitMs('starts in 12 seconds')).toBe(13000);
    expect(waitMs('please wait 90 seconds')).toBe(30000);
    expect(waitMs('no timer here')).toBe(3000);
  });
});
