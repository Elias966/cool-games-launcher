// Download hosts often count down before their link works ("Your download will
// start in 15 seconds", "Please wait 10 sec"). This reads the remaining time
// from the page text so the launcher can wait for it.

const PATTERNS = [
  /\b(?:starts?|begins?|ready|available|unlocks?|appears?|redirect(?:ing|s)?|generated?|link)\b[^.\n]{0,40}?\b(?:in|after)\s+(\d{1,3})\s*(?:s\b|secs?\b|seconds?\b)/i,
  /\b(?:wait|waiting)\b[^.\n]{0,20}?\b(\d{1,3})\s*(?:s\b|secs?\b|seconds?\b)/i,
  /\b(\d{1,3})\s*(?:s\b|secs?\b|seconds?\b)\s*(?:left|remaining)\b/i,
];

/** Seconds a page says to wait before its download works (1..300), or null. */
export function countdownSeconds(text: string): number | null {
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 300) return n;
    }
  }
  return null;
}

/** How long to wait for one "wait" step: the countdown shown (plus a second), at most 30 s; 3 s when none is shown. */
export function waitMs(text: string): number {
  const s = countdownSeconds(text);
  return s === null ? 3000 : Math.min(30, s + 1) * 1000;
}
