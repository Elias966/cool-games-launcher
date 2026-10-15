// Site recipes: the local AI looks at a source's first listing page once and
// picks which links are games and which lead to more listings. From those
// choices we induce URL patterns, so later pages of the same site are indexed
// instantly without another model call. The AI is asked again only when a
// recipe stops matching.
import type { ExtractCard, ExtractLink, PageExtract } from './page-extract';

export interface UrlPattern {
  host: string; // RegExp source, anchored
  path: string; // RegExp source, anchored
}

export interface SiteRecipe {
  version: 1;
  game: UrlPattern[];
  more: UrlPattern[];
  /** Where pages render their game lists: plain HTTP is fast; some sites need Firefox. */
  listingMode: 'http' | 'browser';
  detailMode: 'http' | 'browser';
  learnedAt: string;
  /** How the recipe was learned, shown in Settings. */
  origin: 'ai' | 'structure';
  /** Last time every listing page was walked (incremental re-checks stop early). */
  fullCrawlAt?: string;
  /**
   * 2 = "more games" routes learned with the current instructions (pagination,
   * browse and category listings). Older recipes only knew pagination and
   * re-learn their routes once.
   */
  routesVersion?: number;
  /** Last time the site's sitemap was read for games the listings do not reach. */
  sitemapAt?: string;
  /** The site's own Popular / Trending listing pages, and when they were last read. */
  rankPages?: { popular?: string; trending?: string };
  rankAt?: string;
}

// 3: the AI also sees menu links when choosing routes (catalogs often live there).
export const ROUTES_VERSION = 3;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hostPattern(hosts: string[]): string {
  const unique = [...new Set(hosts)];
  if (unique.length === 1) return `^${escape(unique[0])}$`;
  // Games on per-author subdomains (author.example.com) share a parent domain.
  const parts = unique.map((h) => h.split('.'));
  const suffix: string[] = [];
  for (let i = 1; i <= Math.min(...parts.map((p) => p.length)); i++) {
    const label = parts[0][parts[0].length - i];
    if (parts.every((p) => p[p.length - i] === label)) suffix.unshift(label);
    else break;
  }
  if (suffix.length < 2) return `^(?:${unique.map(escape).join('|')})$`;
  // When every example sits on a subdomain, the bare parent domain (its own
  // nav pages: /jams, /tools…) is not a game page.
  const allSub = parts.every((p) => p.length > suffix.length);
  return `^(?:[a-z0-9-]+\\.)${allSub ? '+' : '*'}${escape(suffix.join('.'))}$`;
}

function segmentPattern(values: string[]): string {
  const unique = [...new Set(values)];
  if (unique.length === 1) {
    // A single example: numbers are page/ID counters, everything else literal.
    return unique[0].split(/(\d+)/).map((part, i) => (i % 2 ? '\\d+' : escape(part))).join('');
  }
  if (unique.every((v) => /^\d+$/.test(v))) return '\\d+';
  // Shared prefix/suffix (e.g. "-free-download") stays literal.
  let pre = 0;
  while (unique.every((v) => v.length > pre && v[pre] === unique[0][pre])) pre++;
  let suf = 0;
  while (unique.every((v) => v.length - suf > pre && v[v.length - 1 - suf] === unique[0][unique[0].length - 1 - suf])) suf++;
  const prefix = unique[0].slice(0, pre);
  const suffix = suf ? unique[0].slice(unique[0].length - suf) : '';
  // Only keep affixes that look like words, not accidental shared letters.
  const keepPre = /[-_]$/.test(prefix) || prefix.length >= 4 ? prefix : '';
  const keepSuf = /^[-_.]/.test(suffix) || suffix.length >= 5 ? suffix : '';
  return `${escape(keepPre)}[^/]+${escape(keepSuf)}`;
}

/** Generalises example URLs into host/path patterns, one per path shape. */
export function inducePatterns(urls: string[]): UrlPattern[] {
  const parsed = urls.flatMap((u) => {
    try { return [new URL(u)]; } catch { return []; }
  });
  const byShape = new Map<number, URL[]>();
  for (const u of parsed) {
    const segs = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    const list = byShape.get(segs.length) ?? [];
    list.push(u);
    byShape.set(segs.length, list);
  }
  const out: UrlPattern[] = [];
  for (const [n, list] of byShape) {
    if (n === 0) continue;
    const segs = list.map((u) => u.pathname.replace(/\/+$/, '').split('/').filter(Boolean));
    const path = segs[0].map((_, i) => segmentPattern(segs.map((s) => s[i]))).join('/');
    const queryKeys = [...new Set(list.flatMap((u) => [...u.searchParams.keys()]))].filter((k) => list.every((u) => u.searchParams.has(k)));
    // Anchored at the end so "/[^/]+" cannot also match deeper or shallower pages.
    const query = queryKeys.length ? `\\?(?:.*&)?${queryKeys.map(escape).join('=[^&]*(?:&.*)?&?')}=[^&]*(?:&.*)?$` : '(?:\\?.*)?$';
    out.push({ host: hostPattern(list.map((u) => u.hostname.replace(/^www\./, ''))), path: `^/${path}/?${query}` });
  }
  return out;
}

export function matchesAny(url: string, patterns: UrlPattern[]): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname + u.search;
  return patterns.some((p) => {
    try { return new RegExp(p.host, 'i').test(host) && new RegExp(p.path, 'i').test(path); } catch { return false; }
  });
}

function sameDoc(a: string, b: string) {
  return a.split('#')[0].replace(/\/$/, '') === b.split('#')[0].replace(/\/$/, '');
}

/** Game cards on a page per the recipe, enriched with the heuristic card data when available. */
export function recipeCards(ex: PageExtract, recipe: SiteRecipe): ExtractCard[] {
  const out = new Map<string, ExtractCard>();
  for (const card of ex.cards) {
    if (matchesAny(card.href, recipe.game) && !sameDoc(card.href, ex.url)) out.set(card.href.split('#')[0], card);
  }
  const byHref = new Map<string, ExtractLink[]>();
  for (const l of ex.links) {
    if (l.inContent === false || sameDoc(l.href, ex.url) || !matchesAny(l.href, recipe.game)) continue;
    const key = l.href.split('#')[0];
    byHref.set(key, [...(byHref.get(key) ?? []), l]);
  }
  for (const [href, links] of byHref) {
    if (out.has(href)) continue;
    // Several links often point at one game (image + title); the longest
    // non-generic label is the title, any image is the artwork.
    const title = links.map((l) => l.text).filter((t) => t && !/^(?:download|more|read more|view|details|play)$/i.test(t)).sort((a, b) => b.length - a.length)[0];
    if (!title || title.length > 160) continue;
    out.set(href, { href, title, img: links.find((l) => l.img)?.img ?? null, text: '', platforms: [], price: null, author: null, tags: [], categories: [] });
  }
  return [...out.values()];
}

const PAGE_TEXT = /^(?:\d{1,4}|next(?: page)?|older(?: posts| entries)?|more games|load more|[›»→>]{1,2}|next\s*[›»→>])$/i;
const PAGE_HREF = /(?:\/page\/\d+\/?$|[?&](?:page|p|paged|pg|pagenum)=\d+)/i;

/** Pagination links any layout uses: numbered pages, "next", /page/N or ?page=N. */
export function paginationLinks(ex: PageExtract): string[] {
  let origin: string;
  try { origin = new URL(ex.url).origin; } catch { return []; }
  const out = new Set<string>();
  for (const l of ex.links) {
    let u: URL;
    try { u = new URL(l.href); } catch { continue; }
    if (u.origin !== origin || sameDoc(l.href, ex.url)) continue;
    const text = l.text.trim();
    if (PAGE_HREF.test(u.pathname + u.search) && (PAGE_TEXT.test(text) || !text || /\d/.test(text))) out.add(l.href.split('#')[0]);
    else if (PAGE_TEXT.test(text) && !/^\d+$/.test(text)) out.add(l.href.split('#')[0]);
  }
  return [...out];
}

const CATALOG_TEXT = /^(?:all games|games? list|browse(?: games)?|catalog(?:ue)?|a\s*[-–]\s*z|all titles|game library|full list)$/i;
const CATALOG_HREF = /\/(?:category|categories|genre|genres|games-list|game-list|all-games|browse|catalog|tag)\b|\/games\/?$/i;

/**
 * Links that open a site's catalog: "All games", A–Z lists, browse, category
 * and genre pages. A structural safety net next to the AI's own choices.
 */
export function catalogLinks(ex: PageExtract): string[] {
  let origin: string;
  try { origin = new URL(ex.url).origin; } catch { return []; }
  const out = new Set<string>();
  for (const l of [...ex.links, ...(ex.menuLinks ?? [])]) {
    let u: URL;
    try { u = new URL(l.href); } catch { continue; }
    if (u.origin !== origin || sameDoc(l.href, ex.url)) continue;
    const text = l.text.trim();
    if (CATALOG_TEXT.test(text) || CATALOG_HREF.test(u.pathname) && text.length > 0 && text.length <= 40) out.add(l.href.split('#')[0]);
  }
  return [...out].slice(0, 40);
}

/** More-listing routes per the recipe plus the page's own declared next page. */
export function recipeRoutes(ex: PageExtract, recipe: SiteRecipe | null): string[] {
  const routes = new Set<string>(paginationLinks(ex));
  if (ex.nextPage) routes.add(ex.nextPage);
  if (recipe) {
    for (const l of ex.links) {
      if (l.inContent === false && !/^(?:\d+|next|older|more|[›»→>])/i.test(l.text)) continue;
      if (!sameDoc(l.href, ex.url) && matchesAny(l.href, recipe.more) && !matchesAny(l.href, recipe.game)) routes.add(l.href.split('#')[0]);
    }
  }
  return [...routes];
}

/** Pagination-style links (?page=2, /page/3/) induce better from one example each. */
export function moreFromExamples(urls: string[]): UrlPattern[] {
  return urls.flatMap((u) => inducePatterns([u]));
}
