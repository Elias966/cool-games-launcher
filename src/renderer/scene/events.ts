// Lightweight bridge from the HTML interface to the 3D scene: interface events
// (a download starting, a game becoming ready, hovering a card) trigger
// matching effects in the scene without re-rendering React.

export type SceneEvent = 'shockwave' | 'burst' | 'focus';

const listeners = new Set<(e: SceneEvent) => void>();

export function emitScene(e: SceneEvent) {
  for (const l of listeners) l(e);
}

export function onScene(l: (e: SceneEvent) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
