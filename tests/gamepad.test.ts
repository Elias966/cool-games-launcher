import { describe, expect, it } from 'vitest';
import { onPad, padStep, type PadAction } from '../src/renderer/gamepad';

const pad = (pressed: number[]) => ({ buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })), axes: [0, 0] }) as unknown as Gamepad;

describe('controller input', () => {
  it('ignores presses while a game has focus, and does not replay them on return', () => {
    const got: PadAction[] = [];
    const off = onPad((a) => { got.push(a); return true; });
    padStep([pad([9])], 0, false);      // Start pressed in the game: the launcher must not open couch mode
    padStep([pad([9, 0])], 16, false);  // A pressed in the game
    padStep([pad([9, 0])], 32, true);   // back in the launcher, still held: not a new press
    expect(got).toEqual([]);
    padStep([pad([])], 48, true);       // released
    padStep([pad([0])], 64, true);      // a real press in the launcher
    expect(got).toEqual(['accept']);
    off();
  });

  it('does not repeat directions while the gate is closed', () => {
    const got: PadAction[] = [];
    const off = onPad((a) => { got.push(a); return true; });
    padStep([pad([])], 0, true);
    for (let t = 0; t <= 2000; t += 16) padStep([pad([13])], t, false);
    expect(got).toEqual([]);
    padStep([pad([])], 2016, true);
    padStep([pad([13])], 2032, true);
    expect(got).toEqual(['down']);
    off();
  });
});
