// Controller input. Polls connected gamepads (standard mapping) once per frame
// while one is connected and turns presses into navigation actions with key
// repeat. Outside couch mode the actions drive spatial focus navigation of
// the normal interface; couch mode subscribes to them directly.
//
// Chromium hands controller input to the launcher even while another window
// (the game) has focus, so input counts only while the gate allows it: the
// launcher window focused and no game running. Buttons held while the gate
// is closed stay "held", so returning to the launcher never fires a press
// that was meant for the game.

export type PadAction = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back' | 'menu' | 'secondary' | 'view';

type Listener = (a: PadAction) => boolean | void;
const listeners: Listener[] = [];

/** The most recent subscriber gets an action first; returning true stops it there. */
export function onPad(fn: Listener): () => void {
  listeners.unshift(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

function emit(a: PadAction) {
  for (const l of [...listeners]) if (l(a) === true) return;
}

const BUTTONS: Array<[number, PadAction]> = [[0, 'accept'], [1, 'back'], [3, 'secondary'], [9, 'menu'], [8, 'view'], [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']];
const REPEAT_DELAY = 380;
const REPEAT_EVERY = 110;

let raf = 0;
const held = new Map<PadAction, number>();
const lastRepeat = new Map<PadAction, number>();
let gate: () => boolean = () => document.hasFocus() && document.visibilityState === 'visible';

/** Decides whether controller input reaches the launcher right now. */
export function setPadGate(fn: () => boolean) { gate = fn; }

/** One frame of input: emits new presses (and repeats) only while live. */
export function padStep(pads: ReadonlyArray<Gamepad | null>, t: number, live: boolean) {
  const pressed = new Set<PadAction>();
  for (const pad of pads) {
    if (!pad) continue;
    for (const [i, a] of BUTTONS) if (pad.buttons[i]?.pressed) pressed.add(a);
    const [x = 0, y = 0] = pad.axes;
    if (x < -0.55) pressed.add('left');
    if (x > 0.55) pressed.add('right');
    if (y < -0.55) pressed.add('up');
    if (y > 0.55) pressed.add('down');
  }
  for (const a of pressed) {
    const since = held.get(a);
    if (since === undefined) { held.set(a, t); lastRepeat.set(a, t); if (live) emit(a); }
    else if (live && ['up', 'down', 'left', 'right'].includes(a) && t - since > REPEAT_DELAY && t - (lastRepeat.get(a) ?? 0) > REPEAT_EVERY) { lastRepeat.set(a, t); emit(a); }
  }
  for (const a of [...held.keys()]) if (!pressed.has(a)) held.delete(a);
}

function poll(t: number) {
  raf = 0;
  const pads = navigator.getGamepads?.() ?? [];
  let live = false;
  try { live = gate(); } catch { live = false; }
  padStep(pads, t, live);
  if (pads.some(Boolean)) raf = requestAnimationFrame(poll);
}

/** Starts polling while a controller is connected; reports connections. */
export function startGamepad(onConnect: (name: string) => void): () => void {
  const connected = (e: GamepadEvent) => { if (gate()) onConnect(e.gamepad.id); if (!raf) raf = requestAnimationFrame(poll); };
  window.addEventListener('gamepadconnected', connected);
  if ((navigator.getGamepads?.() ?? []).some(Boolean)) raf = requestAnimationFrame(poll);
  return () => { window.removeEventListener('gamepadconnected', connected); if (raf) cancelAnimationFrame(raf); };
}

/** Spatial focus movement for the normal interface: the nearest focusable element in that direction. */
export function moveFocus(dir: 'up' | 'down' | 'left' | 'right') {
  const all = [...document.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && !el.closest('[aria-hidden="true"]'); });
  const current = document.activeElement as HTMLElement | null;
  if (!current || current === document.body || !all.includes(current)) { all[0]?.focus(); return; }
  const from = current.getBoundingClientRect();
  const cx = from.left + from.width / 2, cy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const dx = x - cx, dy = y - cy;
    const forward = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    if (forward <= 4) continue;
    const side = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = forward + side * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) { best.focus(); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
}
