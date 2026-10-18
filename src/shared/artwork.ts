/** Stable cache keys and bounds for Library card images. Originals remain available for heroes. */
export const CARD_THUMBNAIL = 'card-v1';
export const CARD_WIDTH = 480;
export const CARD_HEIGHT = 384;

/** Navigation artwork is not a game cover, even when it appears inside a card. */
export function decorativeArtwork(url: string | null): boolean {
  if (!url) return false;
  try { return /\/(?:flags?|avatars?|icons?)\/|\/(?:favicon|site-logo)[^/]*$/i.test(new URL(url).pathname); }
  catch { return false; }
}

export function cardArtworkUrl(src: string | null): string | null {
  if (!src?.startsWith('cgl-media://artwork/')) return src;
  const url = new URL(src);
  url.searchParams.set('thumbnail', CARD_THUMBNAIL);
  return url.href;
}
