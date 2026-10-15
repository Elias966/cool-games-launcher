import { describe, expect, it } from 'vitest';
import { browserPoint } from '@shared/browser-input';

describe('Firefox preview input coordinates', () => {
  it('targets the displayed control when the image has empty space beneath it', () => {
    expect(browserPoint(260, 250, { left: 100, top: 50, width: 640, height: 700 }, { width: 1280, height: 800 })).toEqual({ x: 0.25, y: 0.5 });
    expect(browserPoint(260, 600, { left: 100, top: 50, width: 640, height: 700 }, { width: 1280, height: 800 })).toBeNull();
  });
  it('accounts for horizontal margins in a wide, short drawer', () => {
    expect(browserPoint(480, 200, { left: 0, top: 0, width: 960, height: 400 }, { width: 1280, height: 800 })).toEqual({ x: 0.5, y: 0.5 });
    expect(browserPoint(10, 200, { left: 0, top: 0, width: 960, height: 400 }, { width: 1280, height: 800 })).toBeNull();
  });
});
