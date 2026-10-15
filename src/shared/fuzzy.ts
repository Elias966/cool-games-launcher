// Typo-tolerant title matching for Store search ("witcer 3" → "The Witcher 3:
// Wild Hunt", "eldn ring" → "ELDEN RING").

export function normTitle(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1: how well a typed query matches a title (each typed word against its best title word). */
export function titleSimilarity(query: string, title: string): number {
  const q = normTitle(query);
  const t = normTitle(title);
  if (!q || !t) return 0;
  if (t.includes(q)) return 1;
  const words = t.split(' ');
  const typed = q.split(' ');
  let sum = 0;
  for (const w of typed) {
    let best = 0;
    const number = /^\d+$/.test(w);
    for (const x of words) {
      // Numbers must match exactly: "Portal 2" is not "Portal 3", "3" is not "360".
      if (number || /^\d+$/.test(x)) { if (w === x) { best = 1; break; } continue; }
      if (x.startsWith(w)) { best = 1; break; }
      // Compare with the whole word and with its beginning (a word typed partly).
      const d = Math.min(lev(w, x), lev(w, x.slice(0, w.length)));
      const sim = 1 - d / Math.max(w.length, 3);
      best = Math.max(best, sim);
    }
    sum += best;
  }
  return sum / typed.length;
}
