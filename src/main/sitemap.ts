// Sitemap discovery: most sites publish robots.txt "Sitemap:" entries or a
// /sitemap.xml listing every page, precisely so crawlers can find everything
// without walking menus. Used once per full crawl to find games the listing
// pages do not reach.

type FetchText = (url: string) => Promise<{ status: number; text: string | null }>;

const LOC = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi;

function decode(u: string) {
  return u.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Same site regardless of http/https or a leading www. (sitemaps often differ from the address the user typed). */
function sameSite(url: string, origin: string): boolean {
  try {
    const bare = (h: string) => h.toLowerCase().replace(/^www\./, '');
    return bare(new URL(url).hostname) === bare(new URL(origin).hostname);
  } catch { return false; }
}

export interface SitemapEntry {
  url: string;
  /** The page's <lastmod>, when the sitemap gives one. */
  lastmod: string | null;
}

const URL_BLOCK = /<url>([\s\S]*?)<\/url>/gi;
const LASTMOD = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i;

/** Every page the site's sitemaps list (same site), up to `limit`. */
export async function sitemapEntries(origin: string, fetchText: FetchText, limit = 20_000, maxFiles = 40): Promise<SitemapEntry[]> {
  const queue: string[] = [];
  const robots = await fetchText(`${origin}/robots.txt`).catch(() => ({ status: 0, text: null }));
  for (const m of (robots.text ?? '').matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  if (!queue.length) queue.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`);
  const seenFiles = new Set<string>();
  const pages = new Map<string, string | null>();
  let files = 0;
  while (queue.length && files < maxFiles && pages.size < limit) {
    const file = queue.shift()!;
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    if (!sameSite(file, origin)) continue;
    const r = await fetchText(file).catch(() => ({ status: 0, text: null }));
    files++;
    if (!r.text) continue;
    if (/<sitemapindex[\s>]/i.test(r.text)) {
      for (const m of r.text.matchAll(LOC)) queue.push(decode(m[1]));
      continue;
    }
    // <url> blocks carry <lastmod>; plain <loc> lists are read as a fallback.
    const blocks = [...r.text.matchAll(URL_BLOCK)].map((b) => b[1]);
    for (const block of blocks.length ? blocks : [...r.text.matchAll(LOC)].map((m) => m[0])) {
      const loc = new RegExp(LOC.source, 'i').exec(block);
      if (!loc) continue;
      const url = decode(loc[1]);
      if (/\.xml(?:\.gz)?(?:$|\?)/i.test(url)) { queue.push(url); continue; }
      if (sameSite(url, origin)) pages.set(url, LASTMOD.exec(block)?.[1] ?? null);
      if (pages.size >= limit) break;
    }
  }
  return [...pages].map(([url, lastmod]) => ({ url, lastmod }));
}

/** Every page URL the site's sitemaps list (same site), up to `limit`. */
export async function sitemapUrls(origin: string, fetchText: FetchText, limit = 20_000, maxFiles = 40): Promise<string[]> {
  return (await sitemapEntries(origin, fetchText, limit, maxFiles)).map((e) => e.url);
}

/** A readable placeholder title from a URL slug, replaced by the game page's own title once verified. */
export function titleFromUrl(url: string): string {
  try {
    const seg = decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '').split('/').pop() ?? '');
    return seg.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 200);
  } catch { return url; }
}
