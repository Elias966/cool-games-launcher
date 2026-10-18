// Game version fingerprints: what a game page says about the build it offers
// (a version or build number, the download file names and sizes, the page's
// "updated" date). Comparing the fingerprint recorded at install time with the
// page's current one tells whether an installed game has an update.

export type VersionScheme = 'semantic' | 'steam-build' | 'gog-build' | 'epic-build' | 'developer-build' | 'site-build' | 'date';
export interface VersionIdentifier { version: string; scheme: VersionScheme; source: string }
export interface VersionInspection { state: 'identified' | 'unresolved' | 'incomparable'; detail: string; checkedAt: string; revision?: number }
export interface VersionFingerprint {
  scheme?: VersionScheme;
  /** "1.2.3" or "build 15623144", from the title, file names or a labelled line. */
  version: string | null;
  /** The page's own modification date (ISO), when it publishes one. */
  updated: string | null;
  /** Download file names, lowercased and sorted. */
  files: string[];
  /** Download size texts ("1.2 GB"), normalised and sorted. */
  sizes: string[];
  /** When this fingerprint was observed (ISO). */
  at: string;
}

/** The downloaded file itself, for HTTP validator checks. */
export interface InstalledFile {
  url: string | null;
  name: string | null;
  bytes: number | null;
  etag: string | null;
  lastModified: string | null;
}

export interface InstalledVersion extends VersionFingerprint {
  file?: InstalledFile | null;
  identifiers?: VersionIdentifier[];
  inspection?: VersionInspection;
  evidenceIdentity?: Array<{ path: string; bytes: number; modified: number }>;
  executableIdentity?: { path: string; bytes: number; modified: number };
}

export interface UpdateVerdict {
  update: boolean;
  from: string | null;
  to: string | null;
  reason: string;
}

const NUM = String.raw`(\d+(?:\.\d+){0,4}[a-z]?)`;
type Pattern = [RegExp, 'version' | 'build'];
// Strongest first. Titles and file names are trusted; page text only through
// explicitly labelled "Version:" lines (system requirements also say "Version").
const TITLE_PATTERNS: Pattern[] = [
  // A bare "V2" is often part of the name ("Sniper Elite V2"): a "v" needs a dotted number.
  [new RegExp(String.raw`\b(?:ver\.?|version)\s*${NUM}(?![\w.])`, 'i'), 'version'],
  [/\bv(\d+(?:\.\d+){1,4}[a-z]?)(?![\w.])/i, 'version'],
  [/\bbuild\s*[#:.]?\s*(\d{3,})\b/i, 'build'],
  [/\b(?:patch|update|hotfix)\s+(\d+(?:\.\d+){1,4}[a-z]?)(?![\w.])/i, 'version'],
];
const FILE_PATTERNS: Pattern[] = [
  [/(?:^|[-_ .(\[])v(?:er)?[-_ .]?(\d+(?:[._]\d+){1,4}[a-z]?)(?=[-_ .)\]]|$)/i, 'version'],
  [/(?:^|[-_ .(\[])build[-_ .]?(\d{3,})(?=[-_ .)\]]|$)/i, 'build'],
];
const TEXT_LABEL = /\b(game version|current version|latest version|version|build)\s*[:：]\s*(?:v\s*)?(build\s*)?(\d+(?:\.\d+){0,4}[a-z]?)(?![\w.])/gi;
const NOT_GAME = /directx|opengl|vulkan|shader|windows|\bos\b|macos|ubuntu|python|java|\.net|android|ios|driver|steam/i;

function fromPatterns(text: string, patterns: Pattern[]): string | null {
  for (const [re, kind] of patterns) {
    const m = re.exec(text);
    if (m) return kind === 'build' ? `build ${m[1]}` : m[1].replace(/_/g, '.');
  }
  return null;
}

/** The version or build a game page offers, or null when it does not say. */
export function findVersion(input: { titles?: Array<string | null | undefined>; files?: Array<string | null | undefined>; text?: string | null }): string | null {
  for (const t of input.titles ?? []) {
    const v = t ? fromPatterns(t, TITLE_PATTERNS) : null;
    if (v) return v.toLowerCase();
  }
  for (const f of input.files ?? []) {
    const v = f ? fromPatterns(f.replace(/\.(zip|rar|7z|tar|gz|xz|exe|appimage|iso)$/i, ''), FILE_PATTERNS) : null;
    if (v) return v.toLowerCase();
  }
  const text = (input.text ?? '').slice(0, 8000);
  for (const m of text.matchAll(TEXT_LABEL)) {
    if (NOT_GAME.test(text.slice(Math.max(0, m.index - 40), m.index + m[1].length))) continue;
    return (m[1].toLowerCase() === 'build' || m[2] ? `build ${m[3]}` : m[3]).toLowerCase();
  }
  return null;
}

function isoDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const normSize = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/,/g, '.');

function versionDate(v: string): number | null {
  const parts = /^(\d{1,4})[.-](\d{1,2})[.-](\d{1,4})$/.exec(v);
  if (!parts) return null;
  const [, a, b, c] = parts.map(Number);
  const [year, month, day] = a >= 1990 ? [a, b, c] : c >= 1990 ? [c, b, a] : [0, 0, 0];
  if (year < 1990 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() : null;
}

/** Legacy fingerprints may have called dates/large site integers semantic. */
export function versionScheme(f: Pick<VersionFingerprint, 'version' | 'scheme'>): VersionScheme | undefined {
  if (!f.version) return f.scheme;
  if (versionDate(f.version) !== null) return 'date';
  if (/^\d{4,}$/.test(f.version)) return f.scheme && f.scheme !== 'semantic' ? f.scheme : 'site-build';
  return f.scheme ?? (/^build /.test(f.version) ? 'site-build' : 'semantic');
}

export function makeFingerprint(input: {
  titles: Array<string | null | undefined>;
  text?: string | null;
  meta?: Record<string, string>;
  candidates: Array<{ fileName: string | null; label: string; sizeText: string | null }>;
  at?: string;
}): VersionFingerprint {
  const files = [...new Set(input.candidates.map((c) => c.fileName?.trim().toLowerCase()).filter((f): f is string => !!f))].sort();
  const meta = input.meta ?? {};
  return {
    version: findVersion({ titles: input.titles, files: [...files, ...input.candidates.map((c) => c.label)], text: input.text }),
    updated: isoDate(meta['article:modified_time'] || meta['og:updated_time'] || meta['datemodified'] || meta['last-modified'] || null),
    files,
    sizes: [...new Set(input.candidates.map((c) => c.sizeText && normSize(c.sizeText)).filter((s): s is string => !!s))].sort(),
    at: input.at ?? new Date().toISOString(),
  };
}

/** Numeric comparison of dotted versions or build numbers; null when they cannot be ordered. */
export function compareVersions(a: string, b: string): number | null {
  const da = versionDate(a), db = versionDate(b);
  if (da !== null || db !== null) return da !== null && db !== null ? Math.sign(da - db) : null;
  const build = (v: string) => /^build (\d+)$/.exec(v)?.[1];
  const ba = build(a), bb = build(b);
  if (ba || bb) return ba && bb ? Math.sign(Number(ba) - Number(bb)) : null;
  const parse = (v: string) => /^(\d+(?:\.\d+)*)([a-z]?)$/.exec(v);
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return null;
  if (/^\d{4,}$/.test(a) !== /^\d{4,}$/.test(b)) return null;
  const na = pa[1].split('.').map(Number), nb = pb[1].split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return Math.sign(pa[2].localeCompare(pb[2]));
}

const disjoint = (a: string[], b: string[]) => a.length > 0 && b.length > 0 && !a.some((x) => b.includes(x));
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** A short, stable identity for "this build", used to remember an ignored update. */
export function fingerprintKey(f: VersionFingerprint): string {
  return f.version ? `v:${f.scheme ? f.scheme + ':' : ''}${f.version}` : f.files.length ? `f:${f.files.join('|')}` : f.sizes.length ? `s:${f.sizes.join('|')}` : f.updated ? `d:${f.updated}` : '';
}

/** A readable label for a build ("v1.3", "build 1234", "updated 3 Oct 2026"). */
export function versionLabel(f: VersionFingerprint | null | undefined): string | null {
  if (!f) return null;
  if (f.version) return f.scheme === 'developer-build' ? `game ${f.version}` : /^build /.test(f.version) ? f.version : `v${f.version}`;
  if (f.updated) return `updated ${day(f.updated)}`;
  return null;
}

/**
 * Does the page now offer a newer build than the one installed? Version
 * numbers decide when both sides have one; otherwise a completely different
 * set of download files (or sizes) means a new build. The page date alone is
 * used only when nothing else is published: sites touch it for small edits.
 */
export function detectUpdate(installed: InstalledVersion | null | undefined, current: VersionFingerprint | null | undefined): UpdateVerdict {
  const none = (reason: string): UpdateVerdict => ({ update: false, from: versionLabel(installed), to: versionLabel(current), reason });
  if (!installed || !current) return none('no fingerprint');
  const from = versionLabel(installed), to = versionLabel(current);
  if (installed.version && current.version) {
    if (versionScheme(installed) !== versionScheme(current)) return none('different version identifiers cannot be compared');
    const c = compareVersions(current.version, installed.version);
    if (c === null) return none('different version identifiers cannot be compared');
    return c > 0 ? { update: true, from, to, reason: 'the site lists a newer version' } : none(c === 0 ? 'same version' : 'page offers an older version');
  }
  if (current.version && !installed.version && disjoint(installed.files, current.files)) return { update: true, from: from ?? 'installed build', to, reason: 'new download files with a version number' };
  if (disjoint(installed.files, current.files)) return { update: true, from: from ?? 'installed build', to: to ?? 'new build', reason: `download files changed (${installed.files[0]} → ${current.files[0]})` };
  if (!installed.files.length && !current.files.length && disjoint(installed.sizes, current.sizes)) return { update: true, from: from ?? 'installed build', to: to ?? 'new build', reason: `download size changed (${installed.sizes[0]} → ${current.sizes[0]})` };
  const nothingElse = !installed.version && !current.version && !installed.files.length && !current.files.length && !installed.sizes.length && !current.sizes.length;
  if (nothingElse && installed.updated && current.updated && Date.parse(current.updated) - Date.parse(installed.updated) > 3600_000) {
    return { update: true, from: from ?? 'installed build', to, reason: `page updated ${day(current.updated)}` };
  }
  return none('unchanged');
}

/** HTTP validators of the originally downloaded file changed (same URL, new content). */
export function fileChanged(installed: InstalledFile | null | undefined, head: { status: number; etag: string | null; lastModified: string | null; bytes: number | null } | null): boolean {
  if (!installed || !head || head.status < 200 || head.status >= 300) return false;
  if (installed.etag && head.etag) return installed.etag.replace(/^W\//, '') !== head.etag.replace(/^W\//, '');
  if (installed.bytes && head.bytes) return installed.bytes !== head.bytes;
  if (installed.lastModified && head.lastModified) return Date.parse(head.lastModified) - Date.parse(installed.lastModified) > 60_000;
  return false;
}

/**
 * Maps a file's path inside the old build to the new build. Archives often
 * rename the top folder per release ("Game v1.2/…" → "Game v1.3/…"); the
 * executable's position in both builds tells which prefix changed.
 */
export function rebaser(oldExeRel: string, newExeRel: string): (rel: string) => string {
  const a = oldExeRel.split('/').slice(0, -1), b = newExeRel.split('/').slice(0, -1);
  let common = 0;
  while (common < a.length && common < b.length && a[a.length - 1 - common] === b[b.length - 1 - common]) common++;
  const oldPrefix = a.slice(0, a.length - common).join('/'), newPrefix = b.slice(0, b.length - common).join('/');
  if (oldPrefix === newPrefix) return (rel) => rel;
  return (rel) => {
    if (oldPrefix === '') return newPrefix ? `${newPrefix}/${rel}` : rel;
    if (rel === oldPrefix || rel.startsWith(`${oldPrefix}/`)) return (newPrefix ? newPrefix + rel.slice(oldPrefix.length) : rel.slice(oldPrefix.length + 1));
    return rel;
  };
}
