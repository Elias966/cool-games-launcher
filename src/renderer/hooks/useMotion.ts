import { useEffect, useSyncExternalStore } from 'react';
import { useApp } from '../state';

const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

function useSystemReducedMotion() {
  return useSyncExternalStore(
    (cb) => {
      mq?.addEventListener('change', cb);
      return () => mq?.removeEventListener('change', cb);
    },
    () => !!mq?.matches,
  );
}

export interface MotionPrefs {
  /** Decorative motion should be minimised (user setting or OS preference). */
  reduced: boolean;
  /** Low-effects mode: fewer particles, no blur, simpler shadows. */
  low: boolean;
  /** Decorative animation may run right now (window visible and not reduced). */
  animate: boolean;
}

export function useMotionPrefs(): MotionPrefs {
  const motion = useApp((s) => s.settings?.motion ?? 'system');
  const effects = useApp((s) => s.settings?.effects ?? 'full');
  const visible = useApp((s) => s.appVisible);
  const sys = useSystemReducedMotion();
  const reduced = motion === 'reduced' || (motion === 'system' && sys);
  return { reduced, low: effects === 'low', animate: visible && !reduced };
}

/** Mirrors motion/effects preferences onto <html> for CSS. */
export function useMotionAttributes() {
  const motion = useApp((s) => s.settings?.motion ?? 'system');
  const effects = useApp((s) => s.settings?.effects ?? 'full');
  const { reduced } = useMotionPrefs();
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.motion = reduced ? 'reduced' : motion;
    el.dataset.effects = effects;
  }, [motion, effects, reduced]);
}
