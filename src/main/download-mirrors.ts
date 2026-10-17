import { partOf, partFromLabel } from '@shared/parts';
import type { DownloadCandidate } from '@shared/types';
import { platformFrom } from '@shared/download-evidence';
import type { MirrorSample } from '../workers/mirror-probe';
import type { BrowserDownload } from './browser-client';

export interface MeasuredMirror extends MirrorSample {
  browserDownload?: BrowserDownload;
  route: string;
  url: string;
  referer: string;
  nameHint: string | null;
  platform: DownloadCandidate['platform'];
}
export interface MirrorComparison {
  sourceUrl?: string;
  sourceScrollY?: number;
  /** The exact host awaiting the user's check, retained across shutdown. */
  paused?: { route: string; pageUrl: string };
  routes: DownloadCandidate[];
  tested: string[];
  samples: MeasuredMirror[];
  failures: Array<{ route: string; reason: string }>;
  browserTransfers?: Array<{ route: string; download: BrowserDownload }>;
  finished?: boolean;
  selected?: { host: string; speedBps: number; tested: number };
}

export function mirrorRoutes(candidates: DownloadCandidate[]): DownloadCandidate[] {
  const usable = candidates.filter(c => /^https?:\/\//i.test(c.url) && !['macos', 'android', 'web'].includes(c.platform ?? ''));
  const rank = (c: DownloadCandidate) => c.platform === 'linux' ? 0 : c.platform === 'windows' ? 1 : 2;
  return [...new Map(usable.map(c => [c.url, c])).values()].sort((a, b) => rank(a) - rank(b));
}

/** Compare only the same bytes, size and platform; a faster patch/part is not a mirror. */
export const mirrorFileName = (name: string | null) => name?.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\s*\(\d+\)(?=\.[^.]+$)/, '') ?? null;

export function sameMirrorFile(a: MeasuredMirror, b: MeasuredMirror): boolean {
  const platform = (m: MeasuredMirror) => m.platform ?? platformFrom(m.fileName ?? m.nameHint ?? '');
  const nameA = mirrorFileName(a.fileName ?? a.nameHint), nameB = mirrorFileName(b.fileName ?? b.nameHint);
  return (!nameA || !nameB || nameA === nameB) && (!platform(a) || !platform(b) || platform(a) === platform(b)) &&
    a.prefixBytes === b.prefixBytes && a.prefixHash === b.prefixHash &&
    (a.totalBytes === null || b.totalBytes === null || a.totalBytes === b.totalBytes);
}

export function fastestMirrors(samples: MeasuredMirror[]): MeasuredMirror[] {
  return samples.filter(s => Number.isFinite(s.speedBps) && s.speedBps > 0).sort((a, b) => b.speedBps - a.speedBps);
}

export function recordMirror(comparison: MirrorComparison, sample: MeasuredMirror) {
  const platform = (m: MeasuredMirror) => m.platform ?? platformFrom(m.fileName ?? m.nameHint ?? '');
  const rank = (m: MeasuredMirror) => platform(m) === 'linux' ? 3 : platform(m) === 'windows' ? 2 : 1;
  const first = comparison.samples[0];
  if (first && rank(sample) > rank(first) && platform(sample) !== platform(first)) {
    for (const other of comparison.samples) comparison.failures.push({ route: other.route, reason: 'A preferred platform is available.' });
    comparison.samples = [];
  }
  if (!comparison.samples.length || sameMirrorFile(comparison.samples[0], sample)) comparison.samples.push(sample);
  else comparison.failures.push({ route: sample.route, reason: 'Different file name, prefix, size, platform or archive part.' });
}

/** Parts remain separate downloads; only mirrors of the wanted part compete. */
export function mirrorsForPart(routes: DownloadCandidate[], wantedName: string | null, wantedIndex?: number | null): DownloadCandidate[] {
  const part = (name: string | null) => partOf(name) ?? (name && routes.some(r => partOf(r.fileName)?.style === 'rar-old' && partOf(r.fileName)?.set === name.toLowerCase()) ? { set: name.toLowerCase(), index: 1 } : null);
  const known = routes.map(r => part(r.fileName)).filter((p): p is NonNullable<typeof p> => p !== null).sort((a, b) => a.index - b.index);
  const wanted = part(wantedName) ?? (wantedIndex ? known.find(p => p.index === wantedIndex) : known[0]);
  const targetIndex = wantedIndex ?? wanted?.index;
  if (!targetIndex) return routes;
  return routes.filter(r => {
    const p = part(r.fileName), label = partFromLabel(r.label);
    return p ? p.index === targetIndex && (!wanted || p.set === wanted.set) : !label || label.index === targetIndex;
  });
}
