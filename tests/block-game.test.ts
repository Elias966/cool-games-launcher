import { describe, expect, it } from 'vitest';
import { BlockGame, COLS, ROWS, bestMove, type BlockEvent } from '../src/renderer/scene/blocks';

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

function height(game: BlockGame) {
  let h = 0;
  game.grid.forEach((c, i) => { if (c) h = Math.max(h, Math.floor(i / COLS) + 1); });
  return h;
}

describe('background block game', () => {
  it('plays itself for ten simulated minutes without topping out', () => {
    const game = new BlockGame(rng(11));
    const events: BlockEvent[] = [];
    game.on((e) => events.push(e));
    let maxH = 0;
    for (let i = 0; i < 60 * 60 * 10; i++) {
      game.update(1 / 60);
      if (i % 60 === 0) maxH = Math.max(maxH, height(game));
    }
    const clears = events.filter((e) => e.type === 'clear') as Array<Extract<BlockEvent, { type: 'clear' }>>;
    expect(events.some((e) => e.type === 'over')).toBe(false);
    expect(events.filter((e) => e.type === 'lock').length).toBeGreaterThan(400);
    expect(clears.length).toBeGreaterThan(100);
    expect(clears.some((c) => c.rows.length === 4)).toBe(true);
    expect(maxH).toBeLessThan(ROWS - 2);
  });

  it('removes cleared rows and lets the cells above slide down', () => {
    const game = new BlockGame(rng(3), 0);
    // Bottom row full except one cell, with a block resting on top of it.
    for (let x = 0; x < COLS - 1; x++) game.grid[x] = { kind: 0, vy: 0, glow: 0, fade: 0 };
    game.grid[COLS + 2] = { kind: 2, vy: 1, glow: 0, fade: 0 };
    const above = game.grid[COLS + 2]!;
    game.grid[COLS - 1] = { kind: 0, vy: 0, glow: 0, fade: 0 };
    // Run until the full row has been cleared by the engine.
    let cleared = false;
    game.on((e) => { if (e.type === 'clear') cleared = true; });
    game.piece = null;
    for (let i = 0; i < 600 && !cleared; i++) game.update(1 / 60);
    expect(cleared).toBe(true);
    for (let i = 0; i < 120; i++) game.update(1 / 60);
    expect(game.grid[2]).toBe(above);
    expect(above.vy).toBeCloseTo(0, 2);
  });

  it('drops an I piece into a four-row well', () => {
    const g = new Uint8Array(COLS * ROWS);
    for (let y = 0; y < 4; y++) for (let x = 0; x < COLS - 1; x++) g[y * COLS + x] = 1;
    const move = bestMove(g, 0)!;
    expect(move.rot % 2).toBe(1);
    // Vertical I cells sit at box column 2 or 1 depending on rotation.
    expect(move.x + (move.rot === 1 ? 2 : 1)).toBe(COLS - 1);
  });
});
