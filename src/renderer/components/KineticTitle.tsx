import { useMotionPrefs } from '../hooks/useMotion';

/**
 * Page heading that resolves out of a blur with its letter-spacing tightening,
 * then a light glint sweeps through the letters. The text stays one intact
 * node: per-letter boxes clip glyph overhangs in Chromium and garble the title.
 */
export function KineticTitle({ text, className = 'page__title' }: { text: string; className?: string }) {
  const { reduced, low } = useMotionPrefs();
  if (reduced) return <h1 className={className}>{text}</h1>;
  // key restarts the CSS animation whenever the tab (text) changes.
  return <h1 key={text} className={`${className} kinetic${low ? ' kinetic--low' : ''}`}>{text}</h1>;
}
