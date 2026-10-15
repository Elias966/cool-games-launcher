// Games split into several downloads: RAR volumes (game.part1.rar …), split
// archives (game.7z.001 …), old-style RAR volumes (game.rar, game.r00 …) and
// separately packed parts (Game-Part1.zip …). The launcher downloads every
// part and unpacks them together.

export type PartStyle = 'rar-part' | 'split' | 'rar-old' | 'labeled';

export interface PartName {
  /** File name without the part marker, lowercased: parts of one set share it. */
  set: string;
  index: number;
  style: PartStyle;
}

/** The part a file name belongs to, or null for a single-file download. */
export function partOf(fileName: string | null | undefined): PartName | null {
  const n = (fileName ?? '').trim();
  let m = /^(.+)\.part0*(\d{1,4})\.rar$/i.exec(n);
  if (m) return { set: `${m[1].toLowerCase()}.rar`, index: Number(m[2]), style: 'rar-part' };
  m = /^(.+\.(?:7z|zip|rar|tar(?:\.(?:gz|xz|bz2|zst))?))\.0*(\d{1,4})$/i.exec(n);
  if (m) return { set: m[1].toLowerCase(), index: Number(m[2]), style: 'split' };
  m = /^(.+)\.r(\d{2})$/i.exec(n);
  if (m) return { set: `${m[1].toLowerCase()}.rar`, index: Number(m[2]) + 2, style: 'rar-old' };
  m = /^(.+?)[\s._-]*part[\s._-]*0*(\d{1,3})\.(zip|rar|7z)$/i.exec(n);
  if (m) return { set: `${m[1].toLowerCase()}.${m[3].toLowerCase()}`, index: Number(m[2]), style: 'labeled' };
  return null;
}

/** "Part 2", "Part 2 of 5", "PART-02" in a link label. */
export function partFromLabel(label: string | null | undefined): { index: number; total: number | null } | null {
  const m = /\bpart[\s._#-]*0*(\d{1,3})(?:\s*(?:of|\/)\s*(\d{1,3}))?\b/i.exec(label ?? '');
  return m ? { index: Number(m[1]), total: m[2] ? Number(m[2]) : null } : null;
}

/**
 * How many parts the set has, from what a page lists: part file names of the
 * same set, "Part N" link labels and "Part N of M". Null when the page does
 * not say (then parts are looked for one after another until none is found).
 */
export function partTotal(first: PartName, offered: Array<{ fileName: string | null; label: string }>): number | null {
  let max = first.index;
  let stated: number | null = null;
  for (const o of offered) {
    const p = partOf(o.fileName);
    if (p && p.set === first.set) max = Math.max(max, p.index);
    // Labels only: another game's file ("other.part9.rar") must not count.
    const l = p ? null : partFromLabel(o.label);
    if (l) {
      max = Math.max(max, l.index);
      if (l.total) stated = Math.max(stated ?? 0, l.total);
    }
  }
  const total = Math.max(max, stated ?? 0);
  return total > 1 ? total : null;
}

/** The file name a given part of a set is expected to have (for the AI's instructions). */
export function partFileName(fileName: string, index: number): string {
  const p = partOf(fileName);
  if (!p) return fileName;
  if (p.style === 'rar-part') return fileName.replace(/\.part0*\d{1,4}\.rar$/i, (s) => `.part${String(index).padStart(s.match(/\d+/)![0].length, '0')}.rar`);
  if (p.style === 'split') return fileName.replace(/\.0*\d{1,4}$/, (s) => `.${String(index).padStart(s.length - 1, '0')}`);
  if (p.style === 'rar-old') return index === 1 ? fileName.replace(/\.r\d{2}$/i, '.rar') : fileName.replace(/\.r\d{2}$/i, `.r${String(index - 2).padStart(2, '0')}`);
  return fileName.replace(/(part[\s._-]*)0*(\d{1,3})(\.(?:zip|rar|7z))$/i, (_, a: string, d: string, ext: string) => `${a}${String(index).padStart(d.length, '0')}${ext}`);
}
