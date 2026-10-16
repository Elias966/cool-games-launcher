// The falling-blocks game the 3D background plays by itself: game rules, a
// placement AI and the eased visual state the scene draws. No three.js here, so
// the rules are testable on their own. Rows count upward from 0 at the bottom.

export const COLS = 10;
export const ROWS = 20;

interface Shape { box: number; cells: Array<[number, number]> }

// I O T S Z J L, each in its rotation box (y up).
const SHAPES: Shape[] = [
  { box: 4, cells: [[0, 2], [1, 2], [2, 2], [3, 2]] },
  { box: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { box: 3, cells: [[0, 1], [1, 1], [2, 1], [1, 2]] },
  { box: 3, cells: [[0, 1], [1, 1], [1, 2], [2, 2]] },
  { box: 3, cells: [[0, 2], [1, 2], [1, 1], [2, 1]] },
  { box: 3, cells: [[0, 2], [0, 1], [1, 1], [2, 1]] },
  { box: 3, cells: [[2, 2], [0, 1], [1, 1], [2, 1]] },
];
export const KINDS = SHAPES.length;

/** Cells of a piece kind in rotation `rot` (clockwise quarter turns), relative to its box. */
const ROTATED: Array<Array<Array<[number, number]>>> = SHAPES.map(({ box, cells }) => {
  const c = (box - 1) / 2;
  const out: Array<Array<[number, number]>> = [cells];
  for (let r = 1; r < 4; r++) out.push(out[r - 1].map(([x, y]) => [c + (y - c), c - (x - c)] as [number, number]));
  return out;
});

/** Offsets of each cell from the box centre before rotation; the renderer turns these by the eased angle. */
export function pieceOffsets(kind: number): Array<[number, number]> {
  const { box, cells } = SHAPES[kind];
  const c = (box - 1) / 2;
  return cells.map(([x, y]) => [x - c, y - c]);
}

export function boxCentre(kind: number): number {
  return (SHAPES[kind].box - 1) / 2;
}

export interface Cell {
  kind: number;
  /** Eased row the cell is drawn at; it slides down after rows below it clear. */
  vy: number;
  /** 0..1 light on the cell: landing, clearing. */
  glow: number;
  /** 0..1 dissolve while the board resets. */
  fade: number;
}

export interface Piece { kind: number; rot: number; x: number; y: number }

export type BlockEvent =
  | { type: 'lock'; cells: Array<[number, number]>; kind: number }
  | { type: 'clear'; rows: number[]; cells: Array<{ x: number; y: number; kind: number }> }
  | { type: 'over' };

type Phase = 'think' | 'move' | 'drop' | 'clear' | 'over';

/** Occupancy only, for the AI. */
type Grid = Uint8Array;

function fits(g: Grid, kind: number, rot: number, x: number, y: number): boolean {
  for (const [cx, cy] of ROTATED[kind][rot & 3]) {
    const gx = x + cx, gy = y + cy;
    if (gx < 0 || gx >= COLS || gy < 0) return false;
    if (gy < ROWS && g[gy * COLS + gx]) return false;
  }
  return true;
}

// El-Tetris feature weights (Islam El-Ashi), with an extra pull toward
// four-row clears while the stack is low so the show has big moments.
const W = { landing: -4.5, eroded: 3.42, rowT: -3.22, colT: -9.35, holes: -7.9, wells: -3.39 };
// Tuned by simulation: ~one four-row clear every 1.5 minutes, the stack around 5 rows high.
const TUNE = { limit: 8, fill: 25, bonus: 60 };

export function evaluate(g: Grid, kind: number, rot: number, x: number): number | null {
  if (!fits(g, kind, rot, x, ROWS - SHAPES[kind].box)) return null;
  let y = ROWS - SHAPES[kind].box;
  while (fits(g, kind, rot, x, y - 1)) y--;
  const b = g.slice();
  const cells = ROTATED[kind][rot & 3];
  let top = -1, bottom = ROWS;
  for (const [cx, cy] of cells) {
    const gy = y + cy;
    if (gy >= ROWS) return null;
    b[gy * COLS + x + cx] = 1;
    top = Math.max(top, gy);
    bottom = Math.min(bottom, gy);
  }
  let cleared = 0, eroded = 0;
  for (let r = ROWS - 1; r >= 0; r--) {
    let full = true;
    for (let c = 0; c < COLS && full; c++) if (!b[r * COLS + c]) full = false;
    if (!full) continue;
    cleared++;
    for (const [, cy] of cells) if (y + cy === r) eroded++;
    b.copyWithin(r * COLS, (r + 1) * COLS);
    b.fill(0, (ROWS - 1) * COLS);
  }
  let rowT = 0, colT = 0, holes = 0, wells = 0, height = 0;
  for (let r = 0; r < ROWS; r++) {
    let prev = 1;
    let any = false;
    for (let c = 0; c < COLS; c++) {
      const v = b[r * COLS + c];
      if (v !== prev) rowT++;
      prev = v;
      if (v) any = true;
    }
    if (!prev) rowT++;
    if (any) height = r + 1;
  }
  for (let c = 0; c < COLS; c++) {
    let prev = 1;
    let covered = false;
    for (let r = ROWS - 1; r >= 0; r--) {
      const v = b[r * COLS + c];
      if (v) covered = true; else if (covered) holes++;
    }
    for (let r = 0; r < ROWS; r++) {
      const v = b[r * COLS + c];
      if (v !== prev) colT++;
      prev = v;
    }
    // The open right-hand column is a well on purpose while the stack is low.
    if (c === COLS - 1 && height < TUNE.limit) continue;
    let depth = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      const filled = (cc: number) => cc < 0 || cc >= COLS || b[r * COLS + cc];
      if (!b[r * COLS + c] && filled(c - 1) && filled(c + 1)) { depth++; wells += depth; } else depth = 0;
    }
  }
  let score = W.landing * (top + bottom) / 2 + W.eroded * cleared * eroded + W.rowT * rowT + W.colT * colT + W.holes * holes + W.wells * wells;
  if (height < TUNE.limit) {
    // Keep the right-hand column open for a four-row clear, and prize one.
    let rightFilled = 0;
    for (const [cx] of cells) if (x + cx === COLS - 1) rightFilled++;
    if (rightFilled && cleared < 4) score -= TUNE.fill;
    if (cleared === 4) score += TUNE.bonus;
  }
  return score;
}

export function bestMove(g: Grid, kind: number): { rot: number; x: number } | null {
  let best: { rot: number; x: number; score: number } | null = null;
  const rots = kind === 1 ? 1 : 4;
  for (let rot = 0; rot < rots; rot++) {
    for (let x = -2; x < COLS; x++) {
      const s = evaluate(g, kind, rot, x);
      if (s !== null && (!best || s > best.score)) best = { rot, x, score: s };
    }
  }
  return best && { rot: best.rot, x: best.x };
}

const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

export class BlockGame {
  readonly grid: Array<Cell | null> = new Array(COLS * ROWS).fill(null);
  piece: Piece | null = null;
  next: number;
  /** Eased drawing state of the falling piece: box centre and angle (radians). */
  readonly view = { x: 0, y: 0, angle: 0, turns: 0 };
  /** Rows being cleared right now (they flash, then go). */
  clearing: number[] = [];
  phase: Phase = 'think';
  lines = 0;
  private timer = 0;
  private gravity = 0;
  private target: { rot: number; x: number } | null = null;
  private bag: number[] = [];
  private listeners = new Set<(e: BlockEvent) => void>();
  private readonly random: () => number;

  constructor(random: () => number = Math.random, garbageRows = 4) {
    this.random = random;
    this.next = this.draw();
    this.garbage(garbageRows);
    this.spawn();
  }

  on(l: (e: BlockEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: BlockEvent) {
    for (const l of this.listeners) l(e);
  }

  private draw(): number {
    if (!this.bag.length) {
      this.bag = [0, 1, 2, 3, 4, 5, 6];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop()!;
  }

  /** A few ragged rows to dig through, so a fresh board already has something going on. */
  private garbage(rows: number) {
    for (let y = 0; y < rows; y++) {
      const gap = Math.floor(this.random() * COLS);
      for (let x = 0; x < COLS; x++) {
        if (x === gap || this.random() < 0.12) continue;
        this.grid[y * COLS + x] = { kind: Math.floor(this.random() * KINDS), vy: y, glow: 0, fade: 0 };
      }
    }
  }

  occupancy(): Grid {
    const g = new Uint8Array(COLS * ROWS);
    for (let i = 0; i < g.length; i++) if (this.grid[i]) g[i] = 1;
    return g;
  }

  /** Cells of the falling piece in grid coordinates. */
  pieceCells(p: Piece | null = this.piece): Array<[number, number]> {
    if (!p) return [];
    return ROTATED[p.kind][p.rot & 3].map(([x, y]) => [p.x + x, p.y + y]);
  }

  /** Where the falling piece would land now. */
  ghost(): Piece | null {
    if (!this.piece) return null;
    const g = this.occupancy();
    const p = { ...this.piece };
    while (fits(g, p.kind, p.rot, p.x, p.y - 1)) p.y--;
    return p;
  }

  private spawn() {
    const kind = this.next;
    this.next = this.draw();
    const box = SHAPES[kind].box;
    const p: Piece = { kind, rot: 0, x: kind === 1 ? 4 : 3, y: ROWS - box };
    if (!fits(this.occupancy(), p.kind, p.rot, p.x, p.y)) { this.gameOver(); return; }
    this.piece = p;
    const c = boxCentre(kind);
    // Enter from just above the well.
    this.view.x = p.x + c;
    this.view.y = p.y + c + 3;
    this.view.turns = 0;
    this.view.angle = 0;
    this.target = bestMove(this.occupancy(), kind);
    this.phase = 'think';
    this.timer = 0.16;
    this.gravity = 0;
  }

  private gameOver() {
    this.piece = null;
    this.phase = 'over';
    this.timer = 1.7;
    // Dissolve from the top down.
    for (let i = 0; i < this.grid.length; i++) {
      const cell = this.grid[i];
      if (cell) { cell.glow = 1; cell.fade = -(ROWS - Math.floor(i / COLS)) * 0.05; }
    }
    this.emit({ type: 'over' });
  }

  private tryMove(dx: number, dy: number, drot: number): boolean {
    const p = this.piece!;
    if (!fits(this.occupancy(), p.kind, p.rot + drot, p.x + dx, p.y + dy)) return false;
    p.x += dx;
    p.y += dy;
    p.rot = (p.rot + drot + 4) & 3;
    this.view.turns += drot;
    return true;
  }

  private lock() {
    const p = this.piece!;
    const cells = this.pieceCells();
    const c = boxCentre(p.kind);
    // Cells start where the piece is drawn so locking never pops.
    const lag = this.view.y - (p.y + c);
    for (const [x, y] of cells) {
      if (y >= ROWS) continue;
      this.grid[y * COLS + x] = { kind: p.kind, vy: y + lag, glow: 1, fade: 0 };
    }
    this.piece = null;
    this.emit({ type: 'lock', cells, kind: p.kind });
    const full: number[] = [];
    for (let y = 0; y < ROWS; y++) {
      let n = 0;
      for (let x = 0; x < COLS; x++) if (this.grid[y * COLS + x]) n++;
      if (n === COLS) full.push(y);
    }
    if (full.length) {
      this.clearing = full;
      this.phase = 'clear';
      this.timer = 0.38;
      const flash: Array<{ x: number; y: number; kind: number }> = [];
      for (const y of full) for (let x = 0; x < COLS; x++) {
        const cell = this.grid[y * COLS + x]!;
        cell.glow = 1;
        flash.push({ x, y, kind: cell.kind });
      }
      this.emit({ type: 'clear', rows: full, cells: flash });
    } else {
      this.phase = 'think';
      this.timer = 0.08;
    }
  }

  private removeRows() {
    // Highest first, so lower indices stay valid.
    for (const y of [...this.clearing].sort((a, b) => b - a)) {
      for (let r = y; r < ROWS - 1; r++) {
        for (let x = 0; x < COLS; x++) this.grid[r * COLS + x] = this.grid[(r + 1) * COLS + x];
      }
      for (let x = 0; x < COLS; x++) this.grid[(ROWS - 1) * COLS + x] = null;
    }
    this.lines += this.clearing.length;
    this.clearing = [];
  }

  /** Advances the game by `dt` seconds; `speed` above 1 plays faster. */
  update(dt: number, speed = 1) {
    dt = Math.min(dt, 0.1);
    this.timer -= dt * speed;
    switch (this.phase) {
      case 'think':
        if (this.timer <= 0) {
          if (!this.piece) this.spawn();
          else { this.phase = 'move'; this.timer = 0; }
        }
        break;
      case 'move': {
        const p = this.piece!;
        this.gravity += dt * speed;
        if (this.gravity > 0.55) {
          this.gravity = 0;
          if (!this.tryMove(0, -1, 0)) { this.lock(); break; }
        }
        if (this.timer > 0) break;
        this.timer = 0.075;
        const t = this.target;
        if (!t) { this.phase = 'drop'; break; }
        const turn = (t.rot - p.rot + 4) & 3;
        if (turn) { if (!this.tryMove(0, 0, turn === 3 ? -1 : 1)) this.phase = 'drop'; break; }
        if (t.x !== p.x) { if (!this.tryMove(Math.sign(t.x - p.x), 0, 0)) this.phase = 'drop'; break; }
        this.phase = 'drop';
        this.timer = 0.12;
        break;
      }
      case 'drop':
        // A short beat, then a fast slam down.
        if (this.timer > 0) break;
        this.timer = 0.016;
        if (!this.tryMove(0, -1, 0)) this.lock();
        else this.tryMove(0, -1, 0);
        break;
      case 'clear':
        if (this.timer <= 0) { this.removeRows(); this.phase = 'think'; this.timer = 0.1; }
        break;
      case 'over':
        if (this.timer <= 0) {
          this.grid.fill(null);
          this.lines = 0;
          this.garbage(3);
          this.phase = 'think';
          this.timer = 0.3;
        }
        break;
    }
    this.animate(dt);
  }

  private animate(dt: number) {
    const fall = ease(dt, 14);
    const glowDecay = Math.exp(-dt * 3.2);
    for (let i = 0; i < this.grid.length; i++) {
      const cell = this.grid[i];
      if (!cell) continue;
      const y = Math.floor(i / COLS);
      cell.vy += (y - cell.vy) * fall;
      if (Math.abs(cell.vy - y) < 0.001) cell.vy = y;
      if (this.phase === 'over') cell.fade += dt * 1.6;
      else if (!this.clearing.includes(y)) cell.glow *= glowDecay;
    }
    const p = this.piece;
    if (p) {
      const c = boxCentre(p.kind);
      const k = ease(dt, this.phase === 'drop' ? 40 : 18);
      this.view.x += (p.x + c - this.view.x) * k;
      this.view.y += (p.y + c - this.view.y) * k;
      this.view.angle += (-this.view.turns * Math.PI / 2 - this.view.angle) * ease(dt, 16);
    }
  }
}
