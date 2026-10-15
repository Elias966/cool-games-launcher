// What people play: popularity signals a game page publishes (download, view
// and rating counts), the site's own "Popular"/"Trending" lists, and the
// scores the Store sorts by. Also: telling a real game description from SEO
// boilerplate, and keeping the tag list free of noise.
import type { PageExtract } from './page-extract';

export interface PopularitySignals {
  downloads: number | null;
  views: number | null;
  ratings: number | null;
  /** 0..5 when the page publishes a star rating. */
  rating: number | null;
}

/** "12,345", "12.3K", "1.2M", "4 523" → number. */
export function parseCount(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^([\d][\d.,\s]*)\s*([kmb])?$/i.exec(s.trim());
  if (!m) return null;
  let digits = m[1].replace(/\s/g, '');
  const unit = m[2]?.toLowerCase();
  // "12.3K" keeps its decimal point; "12,345" / "12.345" are thousands separators.
  if (unit) digits = digits.replace(',', '.');
  else digits = digits.replace(/[.,](?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : 1));
}

const NUM = String.raw`(\d[\d.,\s]{0,14}\s*[kKmMbB]?)`;
const AFTER = (word: string) => new RegExp(String.raw`${NUM}\s*(?:total\s+)?(?:${word})\b`, 'i');
const BEFORE = (word: string) => new RegExp(String.raw`\b(?:${word})\s*[:：]?\s*${NUM}(?![\d.,])`, 'i');

function firstCount(text: string, words: string): number | null {
  for (const re of [BEFORE(words), AFTER(words)]) {
    const m = re.exec(text);
    const n = m ? parseCount(m[1]) : null;
    if (n !== null && n > 0 && n < 5e9) return n;
  }
  return null;
}

/** Counters from structured data first, then from the page's own text. */
export function popularitySignals(ex: Pick<PageExtract, 'jsonLd' | 'text'> & { mainText?: string | null }): PopularitySignals {
  const out: PopularitySignals = { downloads: null, views: null, ratings: null, rating: null };
  for (const o of ex.jsonLd as Array<Record<string, any>>) {
    const agg = o?.aggregateRating;
    if (agg) {
      out.ratings ??= parseCount(String(agg.ratingCount ?? agg.reviewCount ?? '')) ?? null;
      const value = Number(agg.ratingValue), best = Number(agg.bestRating ?? 5) || 5;
      if (Number.isFinite(value) && value > 0) out.rating ??= Math.round((value / best) * 5 * 10) / 10;
    }
    for (const st of [o?.interactionStatistic].flat().filter(Boolean)) {
      const kind = String(st?.interactionType?.['@type'] ?? st?.interactionType ?? '');
      const n = parseCount(String(st?.userInteractionCount ?? ''));
      if (n === null) continue;
      if (/Download/i.test(kind)) out.downloads ??= n;
      else if (/View|Watch|Play/i.test(kind)) out.views ??= n;
    }
  }
  // The game's own article only: sidebars list other games' counters.
  const text = (ex.mainText ?? ex.text ?? '').slice(0, 20000);
  out.downloads ??= firstCount(text, 'downloads?|downloaded|installs?');
  out.views ??= firstCount(text, 'views?|plays|played|visits');
  out.ratings ??= firstCount(text, 'ratings|votes|reviews');
  return out;
}

export type RankKind = 'popular' | 'trending';

const POPULAR_TEXT = /\b(?:most\s+)?popular\b|most\s+(?:downloaded|played|viewed)|\btop\s+(?:games|downloads|rated|\d+|charts?)\b|^top$|best\s+(?:games|of|sellers?)|all[- ]time/i;
const TRENDING_TEXT = /\btrending\b|\bhot\b(?!\s*(?:key|fix|line|spot|dog|wheels?))|this\s+week|rising|new\s+(?:and|&)\s+popular|right\s+now/i;
const POPULAR_PATH = /\/(?:popular|most[-_](?:popular|downloaded|played|viewed)|top[-_]?(?:games|rated|downloads)?)(?:\/|$|\?)|[?&](?:sort|order|orderby)=(?:popular|downloads|most|top|views|rating)/i;
const TRENDING_PATH = /\/(?:trending|hot|new[-_]and[-_]popular|this[-_]week|rising)(?:\/|$|\?)|[?&](?:sort|order|orderby)=(?:trending|hot)/i;

/** What a heading or link text says about the list under it. */
export function rankKindOf(text: string): RankKind | null {
  const t = text.trim();
  if (!t || t.length > 50) return null;
  if (TRENDING_TEXT.test(t)) return 'trending';
  if (POPULAR_TEXT.test(t)) return 'popular';
  return null;
}

/** The site's own "Popular" and "Trending" listing pages, from its menus and links. */
export function rankLinks(ex: Pick<PageExtract, 'url' | 'links'> & { menuLinks?: Array<{ href: string; text: string }> }): Partial<Record<RankKind, string>> {
  const out: Partial<Record<RankKind, string>> = {};
  let host = '';
  try { host = new URL(ex.url).hostname.replace(/^www\./, ''); } catch { return out; }
  for (const l of [...(ex.menuLinks ?? []), ...ex.links]) {
    let u: URL;
    try { u = new URL(l.href); } catch { continue; }
    if (u.hostname.replace(/^www\./, '') !== host || u.href.split('#')[0] === ex.url.split('#')[0]) continue;
    const kind = rankKindOf(l.text) ?? (TRENDING_PATH.test(u.pathname + u.search) ? 'trending' : POPULAR_PATH.test(u.pathname + u.search) ? 'popular' : null);
    if (kind && !out[kind]) out[kind] = u.href.split('#')[0];
  }
  return out;
}

/** Larger is more popular; ranks from the site's own lists outrank counters. */
export function popularScore(p: { signals: PopularitySignals | null; rank: number | null; tags: string[] }): number {
  const s = p.signals;
  const base = Math.max(
    s?.downloads ? Math.log10(1 + s.downloads) : 0,
    s?.views ? Math.log10(1 + s.views) - 0.7 : 0,
    s?.ratings ? Math.log10(1 + s.ratings) + 1 : 0,
  );
  const tagged = p.tags.some((t) => /^(?:top|popular|most popular|featured|editor'?s choice|best seller)$/i.test(t)) ? 0.5 : 0;
  if (p.rank !== null) return 100 + (1000 - Math.min(p.rank, 999)) / 10 + base / 100;
  return base + tagged;
}

/** Popular recently: the site's trending list, else popularity weighted by the page's age. */
export function trendingScore(p: { signals: PopularitySignals | null; rank: number | null; popularRank: number | null; tags: string[]; published: string | null; discovered: string; now?: number }): number {
  if (p.rank !== null) return 100 + (1000 - Math.min(p.rank, 999)) / 10;
  const known = !!(p.signals?.downloads || p.signals?.views || p.signals?.ratings) || p.popularRank !== null;
  // Nothing known about it: after every game that is known to be popular now.
  if (!known) return -10 + (p.tags.some((t) => /^(?:trending|hot|top|popular)$/i.test(t)) ? 1 : 0);
  const ageDays = Math.max(0, ((p.now ?? Date.now()) - Date.parse(p.published ?? p.discovered)) / 86_400_000);
  const pop = popularScore({ signals: p.signals, rank: p.popularRank, tags: p.tags });
  const hot = p.tags.some((t) => /^(?:trending|hot|updated)$/i.test(t)) ? 0.4 : 0;
  // A popular game from this month beats an all-time classic.
  return (pop > 100 ? 6 + (pop - 100) / 50 : pop) + hot - 2 * Math.log10(2 + ageDays);
}

// ── Descriptions ───────────────────────────────────────────────────────────

const BOILERPLATE = /\bfree download\b|\bdownload (?:it )?(?:for )?free\b|pre-?installed|\btorrent\b|direct (?:download )?links?\b|\bpc game for free\b|\bfull version\b|\bcrack(?:ed)?\b|\brepack\b|\bfor free instantly\b/i;

/** SEO lines ("X Free Download SITE.com Get X PC game for free…") are not descriptions. */
export function isBoilerplate(text: string | null | undefined, site?: string | null): boolean {
  const t = (text ?? '').trim();
  if (t.length < 60) return true;
  if (BOILERPLATE.test(t)) return true;
  const domain = site?.replace(/^www\./, '').split('.')[0];
  if (domain && domain.length > 3 && new RegExp(`\\b${domain.replace(/[^a-z0-9]/gi, '')}(?:\\.com)?\\b`, 'i').test(t) && t.length < 260) return true;
  return false;
}

/** The best real description among what a page offers, or null. */
export function pickDescription(options: Array<string | null | undefined>, site?: string | null): string | null {
  for (const o of options) {
    const t = (o ?? '').replace(/\s+/g, ' ').trim();
    if (t && !isBoilerplate(t, site)) return t.slice(0, 1500);
  }
  return null;
}

// ── Tags ───────────────────────────────────────────────────────────────────

const NOISE_TAGS = /^(?:updated?|new|top|hot|free|download|downloads?|pc|game|games|full|latest|ltd\.?|inc\.?|co\.?|llc|corp\.?|gmbh|s\.?a\.?|s\.?r\.?o\.?|limited|studio|studios|other|misc|uncategori[sz]ed|featured|post|posts|news|\d+)$/i;

/** A tag worth offering as a filter. */
export function usefulTag(tag: string): boolean {
  const t = tag.trim();
  return t.length >= 2 && t.length <= 32 && !NOISE_TAGS.test(t) && !/https?:|www\.|\.com\b|free download/i.test(t) && t.split(/\s+/).length <= 4;
}
