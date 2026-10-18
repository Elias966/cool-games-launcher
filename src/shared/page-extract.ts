// DOM extraction that runs inside web pages through WebDriver executeScript.
// It must stay self-contained: no imports, no closures over module scope,
// because it is serialised with Function.prototype.toString().
// The page's content is untrusted data; this only reads the DOM.

export interface ExtractRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExtractLink {
  i: number;
  href: string;
  text: string;
  img: string | null;
  rect: ExtractRect;
  download: boolean;
  inContent?: boolean;
  inDialog?: boolean;
}

export interface ExtractCard {
  href: string;
  title: string;
  img: string | null;
  text: string;
  platforms: string[];
  price: string | null;
  author: string | null;
  tags: string[];
  categories?: string[];
}

export interface ExtractControl {
  i: number;
  tag: string;
  text: string;
  href: string | null;
  rect: ExtractRect;
  inViewport: boolean;
  inContent?: boolean;
  inDialog?: boolean;
}

export interface ExtractUpload {
  i: number | null;
  name: string;
  size: string | null;
  platforms: string[];
  href: string | null;
}

export interface ExtractGame {
  title: string | null;
  description: string | null;
  cover: string | null;
  screenshots: string[];
  platforms: string[];
  tags: string[];
  categories?: string[];
  author: string | null;
  price: string | null;
  uploads: ExtractUpload[];
}

export interface PageExtract {
  /** Trusted browser recovery metadata, never read from website content. */
  navigationRecovery?: 'closed-tab';
  url: string;
  title: string;
  site: string | null;
  meta: Record<string, string>;
  jsonLd: unknown[];
  cards: ExtractCard[];
  cardConfidence: number;
  nextPage: string | null;
  game: ExtractGame | null;
  controls: ExtractControl[];
  links: ExtractLink[];
  fileLinks: ExtractLink[];
  gates: { login: boolean; captcha: boolean; payment: boolean; ageGate: boolean; blocked: boolean };
  adultSignals: string[];
  text: string;
  media: Array<{ src: string; rect: ExtractRect }>;
  viewport: { w: number; h: number; scrollY: number; docH: number };
  inputState?: { focused: string; fields: Array<{ id: number; label: string; type: string; value: string; focused: boolean }> };
  /**
   * Same-site links inside menus, headers, footers and sidebars, including
   * collapsed dropdowns that are not visible: catalogs ("All games",
   * categories, A–Z) usually live there.
   */
  menuLinks?: Array<{ href: string; text: string }>;
  /** The game's own description: the text under "Overview"/"About the game", or the first real paragraph. */
  about?: string | null;
  /** Text of the main article only (no menus or sidebars), for counters like "12K downloads". */
  mainText?: string | null;
  /** Short visible headings/alerts, excluding navigation and help sections. */
  notices?: string[];
  /** When the page was first published (ISO), if it says. */
  published?: string | null;
  observedAt?: string;
  recentGameLinks?: string[];
  /** Lists under headings like "Popular games" or "Trending", in page order. */
  rankedSections?: Array<{ kind: 'popular' | 'trending'; heading: string; links: string[] }>;
}

export function extractPage(opts: { maxLinks?: number; maxCards?: number; maxControls?: number; mark?: boolean; fast?: boolean } = {}): PageExtract {
  const doc = document;
  const win = window;
  // Keep page shims of closest() from losing controls, dialogs and article scope.
  const closest = (el: Element | null | undefined, selector: string): Element | null => {
    for (let node = el; node; node = node.parentElement) if (win.Element.prototype.matches.call(node, selector)) return node;
    return null;
  };
  const maxLinks = opts.maxLinks ?? 400;
  const maxCards = Math.max(0,Math.min(10000,opts.maxCards ?? 150));
  const maxControls = opts.maxControls ?? 80;
  const vw = win.innerWidth || 1280;
  const vh = win.innerHeight || 800;

  const clean = (s: string | null | undefined, max = 300): string =>
    (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const observedAt = new Date().toISOString();
  const dateCache = new WeakMap<Element, string | null>();
  const dateIn = (root: Element): string | null => {
    if (dateCache.has(root)) return dateCache.get(root)!;
    let found: string | null = null;
    const selector = '[itemprop="datePublished"],time,[data-published],[data-date],[data-timestamp],.date,.time,.post-time,.entry-time,.timestamp,.post-meta,.entry-meta,.post-date,.entry-date,.posted-on,.published,.timeago,[class*="post_date"],[class*="post-date"],[class*="time-ago"],[class*="time_ago"]';
    // Named form controls can shadow methods such as matches/querySelectorAll.
    const nodes = [...(win.Element.prototype.matches.call(root,selector) ? [root] : []), ...win.Element.prototype.querySelectorAll.call(root,selector)].slice(0, 30);
    for (const node of nodes) {
      if (closest(node,'aside,footer,nav,[class*="related"],[class*="comment"],[class*="release-date"],[class*="release_date"]')) continue;
      const label = `${node.className} ${node.getAttribute('itemprop') ?? ''} ${node.textContent ?? ''}`;
      if (/updated|modified|release|copyright/i.test(label) && !/datePublished|\bpublished\b/.test(label)) continue;
      const relative = clean([...node.childNodes].map(n=>n.textContent).join(' '),300).match(/\b(?:just now|yesterday|(?:\d+(?:\.\d+)?|an?|one)\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|[smhdw])\s+ago)\b/i)?.[0];
      found = clean(node.getAttribute('datetime') || node.getAttribute('content') || node.getAttribute('data-published') || node.getAttribute('data-date') || node.getAttribute('data-timestamp') || node.getAttribute('title') || relative || node.textContent, 150) || null;
      if (found) break;
    }
    if (!found) {
      const text = clean([...root.childNodes].map(n=>n.textContent).join(' '), 2000);
      found = text.match(/\b(?:added|posted|published)(?:\s+on)?\s*[:：-]?\s*(just now|yesterday|(?:\d+(?:\.\d+)?|an?|one)\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago)\b/i)?.[1] ?? null;
      if (/updated|modified|release|playtime/i.test(text.slice(Math.max(0, text.indexOf(found ?? '') - 30), text.indexOf(found ?? '')))) found = null;
    }
    if (!found) found = clean([...root.childNodes].map(n=>n.textContent).join(' '), 2000).match(/\b(?:added|posted|published)(?:\s+on)?\s*[:：-]\s*([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]+\s+\d{4})/i)?.[1] ?? null;
    dateCache.set(root, found);
    return found;
  };
  const abs = (u: string | null | undefined): string | null => {
    if (!u || !u.trim() || u.trim().startsWith('#') || /^\s*javascript:/i.test(u)) return null;
    try {
      const url = new URL(u, doc.baseURI);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const rectOf = (el: Element): ExtractRect => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  // Without a layout engine (tests under jsdom) every rect is empty.
  const hasLayout = !!doc.documentElement && doc.documentElement.getBoundingClientRect().width > 0;
  // HTTP-fetched pages have no layout engine, and jsdom's getComputedStyle is
  // far too slow to call per element and ancestor. Fast mode reads only
  // markup-level hiding, memoised per ancestor.
  const hiddenMemo = new Map<Element, boolean>();
  const markupHidden = (el: Element | null): boolean => {
    if (!el) return false;
    const known = hiddenMemo.get(el);
    if (known !== undefined) return known;
    const style = (el.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
    const own = (el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true' && !el.querySelector('a[href]') || style.includes('display:none') || style.includes('visibility:hidden') || /^(?:TEMPLATE|NOSCRIPT)$/.test(el.tagName);
    const result = own || markupHidden(el.parentElement);
    hiddenMemo.set(el, result);
    return result;
  };
  const visible = (el: Element): boolean => {
    if (opts.fast && !hasLayout) return !markupHidden(el);
    const st = win.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || (el as HTMLElement).hidden) return false;
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if ((parent as HTMLElement).hidden || win.getComputedStyle(parent).display === 'none') return false;
    }
    if (!hasLayout) return true;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && Number(st.opacity) > 0.05;
  };
  const imgSrc = (img: Element | null): string | null => {
    if (!img) return null;
    const cands = [
      img.getAttribute('data-lazy_src'),
      img.getAttribute('data-src'),
      img.getAttribute('data-original'),
      img.getAttribute('data-lazy-src'),
      (img as HTMLImageElement).currentSrc,
      img.getAttribute('src'),
    ];
    const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset');
    if (srcset) {
      const best = srcset
        .split(',')
        .map((p) => p.trim().split(/\s+/))
        .sort((a, b) => parseFloat(b[1] || '0') - parseFloat(a[1] || '0'))[0];
      if (best?.[0]) cands.unshift(best[0]);
    }
    for (const c of cands) {
      if (c && !c.startsWith('data:')) {
        const a = abs(c);
        if (a) return a;
      }
    }
    return null;
  };
  const platformsFrom = (s: string): string[] => {
    const out = new Set<string>();
    const t = s.toLowerCase();
    if (/linux|ubuntu|debian|steam ?deck|appimage|\.deb\b|\.x86_64/.test(t)) out.add('linux');
    if (/windows|win32|win64|\bwin\b|\.exe\b|\.msi\b/.test(t)) out.add('windows');
    if (/mac ?os|osx|os x|apple|\.dmg\b/.test(t)) out.add('macos');
    if (/android|\.apk\b/.test(t)) out.add('android');
    if (/play in browser|html5|webgl|browser game/.test(t)) out.add('web');
    return [...out];
  };
  const host = location.hostname.replace(/^www\./, '');

  // --- metadata ---------------------------------------------------------
  const meta: Record<string, string> = {};
  doc.querySelectorAll('meta[property], meta[name], meta[itemprop]').forEach((m) => {
    const k = (m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop') || '').toLowerCase();
    const v = m.getAttribute('content');
    if (k && v && !meta[k] && Object.keys(meta).length < 60) meta[k] = clean(v, 600);
  });
  const jsonLd: unknown[] = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    if (jsonLd.length >= 10) return;
    try {
      const parsed = JSON.parse(s.textContent || 'null');
      const flat = Array.isArray(parsed) ? parsed : parsed && parsed['@graph'] ? parsed['@graph'] : [parsed];
      for (const p of flat) if (p && typeof p === 'object' && jsonLd.length < 10) jsonLd.push(p);
    } catch {
      /* ignore malformed JSON-LD */
    }
  });

  // --- adult labels -------------------------------------------------------
  const adultSignals: string[] = [];
  const rating = (meta['rating'] || meta['og:rating'] || '').toLowerCase();
  if (/adult|mature|rta-5042|restricted/.test(rating)) adultSignals.push(`meta-rating:${rating.slice(0, 40)}`);
  if (doc.querySelector('meta[content*="RTA-5042-1996-1400-1577-RTA"]')) adultSignals.push('rta-label');
  if (meta['isfamilyfriendly'] === 'false') adultSignals.push('not-family-friendly');

  // --- interactive controls (for AI navigation) -----------------------------
  // A dynamic page can hide old controls without removing them. Drop their
  // previous identities before assigning the current observation's IDs.
  if (opts.mark !== false) doc.querySelectorAll('[data-cgl-i]').forEach(el => el.removeAttribute('data-cgl-i'));
  let counter = 0;
  const controlIds = new Map<Element, number>();
  const controls: ExtractControl[] = [];
  const allControls: Array<{ c: ExtractControl; modal: boolean }> = [];
  const links: ExtractLink[] = [];
  const fileLinks: ExtractLink[] = [];
  const fileRe = /\.(zip|tar|tgz|tar\.gz|tar\.xz|tar\.bz2|txz|7z|rar|appimage|x86_64|sh|run|exe|msi|deb|rpm|apk|dmg|love|jar|(?:zip|7z|rar|tar)\.\d{3}|r\d{2})$/i;
  const inChrome = (el: Element) => !!closest(el,'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]');

  const relevant = (el: Element) => !inChrome(el) && !closest(el,'aside, [role="complementary"], .related-posts, .related_games, .related, .relatedposts, .rpwe-block, .widget, .recommendations, .advertisement, [data-ad], [aria-label="Advertisement"]');
  // HTMX hosts use anchors without href: clicking invokes hx-get with the
  // host's request headers/token handling, so retain these as click controls.
  doc.querySelectorAll('a[href], a[onclick], [hx-get], [data-hx-get], button, input[type="submit"], input[type="button"], [role="button"]').forEach((el) => {
    if (!visible(el)) return;
    const r = rectOf(el);
    const href = el.tagName === 'A' ? abs(el.getAttribute('href')) : null;
    const text = clean(
      (el as HTMLElement).innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLInputElement).value || el.querySelector('img')?.getAttribute('alt'),
      120,
    );
    const i = counter++;
    const inDialog=!!closest(el,'[role="dialog"], [aria-modal="true"], dialog[open]');
    controlIds.set(el, i);
    if (opts.mark !== false) el.setAttribute('data-cgl-i', String(i));
    if (href) {
      if (links.length < maxLinks) {
        const link: ExtractLink = {
          i,
          href,
          text,
          img: imgSrc(el.querySelector('img')),
          rect: r,
          download: el.hasAttribute('download'),
          inContent: relevant(el),
          inDialog,
        };
        links.push(link);
        let path = '';
        try {
          path = decodeURIComponent(new URL(href).pathname);
        } catch {
          path = '';
        }
        if (fileRe.test(path) || el.hasAttribute('download')) fileLinks.push(link);
      }
    }
    if (allControls.length < 600 && text && !inChrome(el)) {
      allControls.push({
        c: {
          i,
          tag: el.tagName.toLowerCase(),
          text,
          href,
          rect: r,
          inViewport: r.y + r.h > 0 && r.y < vh && r.x + r.w > 0 && r.x < vw,
          inContent: relevant(el),
          inDialog,
        },
        modal: inDialog,
      });
    }
  });
  // Open dialogs first (download interstitials often live there), then what is on screen.
  const likelyDownload = (c: ExtractControl) => /^(?:(?:free|manual) )?download\b|^(?:uploadhaven|buzzheavier|vikingfile|mediafire|mega|gofile|pixeldrain)\b/i.test(c.text) || !!c.href && fileRe.test(new URL(c.href).pathname);
  allControls.sort((a, b) => Number(b.modal) - Number(a.modal) || Number(b.c.inContent) - Number(a.c.inContent) || Number(likelyDownload(b.c)) - Number(likelyDownload(a.c)) || Number(b.c.inViewport) - Number(a.c.inViewport));
  controls.push(...allControls.slice(0, maxControls).map((x) => x.c));

  // --- gates --------------------------------------------------------------
  const bodyText = clean(doc.body?.innerText || doc.body?.textContent || '', 20000);
  const lowerTitle = doc.title.toLowerCase();
  const pw = [...doc.querySelectorAll('input[type="password"]')].some((e) => visible(e));
  const captcha =
    [...doc.querySelectorAll(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], .g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form, #cf-challenge-running',
    )].some((el) => {
      if (!visible(el)) return false;
      const root = closest(el,'form') ?? el.parentElement ?? el;
      const response = root.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="cf-turnstile-response"], [name="g-recaptcha-response"], [name="h-captcha-response"]');
      return !response?.value.trim();
    }) || /just a moment|attention required|verify you are human|are you a robot/.test(lowerTitle);
  const payment =
    !!doc.querySelector(
      'input[autocomplete^="cc-"], iframe[src*="js.stripe.com"], iframe[src*="paypal.com"], iframe[src*="braintree"], form[action*="checkout"], [data-testid*="checkout"]',
    ) || (/\b(checkout|payment method|card number|billing address)\b/i.test(bodyText.slice(0, 4000)) && /\$|€|£|¥/.test(bodyText.slice(0, 4000)));
  const ageGate =
    /\b(are you (18|over 18|of legal age)|you must be (18|over 18)|age verification|confirm (that )?you are (18|an adult))\b/i.test(
      bodyText.slice(0, 5000),
    );
  const blocked = /access denied|403 forbidden|429 too many requests|you have been blocked|error 1020/i.test(
    `${lowerTitle} ${bodyText.slice(0, 600)}`,
  );
  if (ageGate) adultSignals.push('age-gate');

  // --- itch.io adapter ------------------------------------------------------
  let site: string | null = null;
  let cards: ExtractCard[] = [];
  let cardConfidence = 0;
  let nextPage: string | null = null;
  let game: ExtractGame | null = null;

  if (/(^|\.)itch\.io$/.test(host)) {
    site = 'itch.io';
    const cells = [...doc.querySelectorAll('.game_cell')];
    for (const c of cells) {
      // The thumbnail link comes first in each cell and has no text; prefer the title link.
      const a = c.querySelector('.game_title a.title') ?? c.querySelector('.game_title a') ?? c.querySelector('a.title') ?? c.querySelector('a.game_link');
      const href = abs(a?.getAttribute('href'));
      if (!href) continue;
      const plats = [...c.querySelectorAll('.game_platform span, .game_platform [title]')]
        .map((s) => s.getAttribute('title') || s.className)
        .join(' ');
      cards.push({
        href,
        title: clean(a?.textContent, 200),
        img: imgSrc(c.querySelector('.game_thumb img, img')),
        text: clean(c.querySelector('.game_text')?.textContent, 300),
        platforms: platformsFrom(plats + (c.querySelector('.web_flag') ? ' play in browser' : '')),
        price: clean(c.querySelector('.price_value, .sale_tag')?.textContent, 40) || null,
        author: clean(c.querySelector('.game_author')?.textContent, 80) || null,
        tags: [...c.querySelectorAll('.tag, a[rel="tag"]')].map((t) => clean(t.textContent, 40)).filter(Boolean),
        categories: [clean(c.querySelector('.game_genre')?.textContent, 60)].filter(Boolean),
      });
    }
    if (cards.length) {
      cardConfidence = 1;
      const u = new URL(location.href);
      const page = parseInt(u.searchParams.get('page') || '1', 10);
      u.searchParams.set('page', String(page + 1));
      nextPage = u.toString();
    }
    const title = doc.querySelector('h1.game_title, .game_title, h2.object_title, .object_title');
    // Game pages have a title; download pages may only have the upload list (and
    // "more games" cells, so cells alone must not suppress upload parsing).
    if ((title && !cells.length) || doc.querySelector('.upload')) {
      const info: Record<string, string> = {};
      doc.querySelectorAll('.game_info_panel_widget tr').forEach((tr) => {
        const tds = tr.querySelectorAll('td');
        if (tds.length >= 2) info[clean(tds[0].textContent, 40).toLowerCase()] = clean(tds[1].textContent, 400);
      });
      const uploads: ExtractUpload[] = [];
      doc.querySelectorAll('.upload').forEach((up) => {
        const btn = up.querySelector('a.download_btn, .download_btn');
        const name = clean(up.querySelector('.upload_name .name, .name')?.getAttribute('title') || up.querySelector('.upload_name .name, .name')?.textContent, 200);
        const plats = [...up.querySelectorAll('.download_platforms [title], .upload_name [title]')].map((s) => s.getAttribute('title')).join(' ');
        uploads.push({
          i: btn ? Number(btn.getAttribute('data-cgl-i') ?? NaN) : null,
          name,
          size: clean(up.querySelector('.file_size')?.textContent, 40) || null,
          platforms: platformsFrom(`${plats} ${name}`),
          href: abs(btn?.getAttribute('href')),
        });
      });
      const tagLinks = [...doc.querySelectorAll('.game_info_panel_widget a[href*="tag-"], .game_info_panel_widget a[href*="/tag/"]')];
      const tags = tagLinks.length ? tagLinks.map((t) => clean(t.textContent, 40)).filter(Boolean) : (info['tags'] || '').split(',').map((t) => clean(t, 40)).filter(Boolean);
      game = {
        title: clean(title?.textContent, 200) || null,
        description: clean(doc.querySelector('.formatted_description')?.textContent || meta['og:description'] || meta['description'], 1500) || null,
        cover: abs(meta['og:image']),
        screenshots: [...doc.querySelectorAll('.screenshot_list a[href], .screenshot_list img')]
          .map((e) => abs(e.getAttribute('href') || e.getAttribute('src')))
          .filter((s): s is string => !!s)
          .slice(0, 6),
        platforms: platformsFrom(`${info['platforms'] || ''} ${uploads.map((u) => u.platforms.join(' ')).join(' ')}`),
        tags,
        categories: (info['genre'] || '').split(',').map((t) => clean(t, 60)).filter(Boolean),
        author: info['author'] || null,
        price: clean(doc.querySelector('.buy_row .dollars, .button_message .dollars')?.textContent, 40) || null,
        uploads,
      };
      for (const t of tags) {
        if (/^(nsfw|adult|erotic|hentai|sexual content|porn|18\+|nudity)$/i.test(t)) adultSignals.push(`tag:${t.toLowerCase()}`);
      }
      if (doc.querySelector('.content_warning, .nsfw_warning, [data-nsfw="true"]')) adultSignals.push('itch-content-warning');
    }
  }

  // --- generic structured data ----------------------------------------------
  if (!game) {
    const ld = jsonLd.find((o: any) => {
      const t = ([] as string[]).concat(o?.['@type'] ?? []).join(' ');
      return /VideoGame|SoftwareApplication|Game|Product/.test(t);
    }) as any;
    if (ld) {
      const img = Array.isArray(ld.image) ? ld.image[0] : ld.image;
      const imgUrl = typeof img === 'string' ? img : img?.url;
      const plats = ([] as unknown[]).concat(ld.gamePlatform ?? [], ld.operatingSystem ?? []).join(' ');
      const ldRating = clean(String(ld.contentRating ?? ''), 60);
      if (/adult|mature|ao\b|18/i.test(ldRating)) adultSignals.push(`ld-rating:${ldRating.toLowerCase()}`);
      game = {
        title: clean(ld.name, 200) || null,
        description: clean(ld.description, 1500) || null,
        cover: abs(imgUrl) || abs(meta['og:image']),
        screenshots: ([] as unknown[]).concat(ld.screenshot ?? []).map((s: any) => abs(typeof s === 'string' ? s : s?.url)).filter((s): s is string => !!s).slice(0, 6),
        platforms: platformsFrom(plats),
        tags: ([] as unknown[]).concat(ld.keywords ?? []).flatMap((t) => String(t).split(',')).map((t) => clean(t, 40)).filter(Boolean).slice(0, 20),
        categories: ([] as unknown[]).concat(ld.genre ?? []).flatMap((t) => String(t).split(',')).map((t) => clean(t, 60)).filter(Boolean).slice(0, 12),
        author: clean(ld.author?.name ?? ld.publisher?.name ?? ld.creator?.name, 80) || null,
        price: ld.offers ? clean(String(ld.offers.price ?? ld.offers?.[0]?.price ?? ''), 20) || null : null,
        uploads: [],
      };
    }
  }

  // Many game download catalogs publish WordPress Article metadata rather
  // than VideoGame JSON-LD. Accept it only with a specific game-download
  // heading, game context, and an actual build/mirror action in the content.
  if (!game) {
    const article = jsonLd.find((o: any) => /^(?:Article|BlogPosting)$/.test(String(o?.['@type'] ?? ''))) as any;
    const heading = clean(doc.querySelector('h1')?.textContent || article?.headline, 200);
    const downloadHeading = /^(.+?)\s+(?:free\s+)?download(?:\s|$|\()/i.exec(heading);
    const avoid = /\b(?:review|news|walkthrough|wallpaper|soundtrack|manual|source code|trailer|download manager|browser extension)\b/i;
    const buildAction = controls.some((c) => {
      if (c.inContent === false || avoid.test(c.text.replace(/\bmanual download\b/gi, 'download'))) return false;
      if (!c.href) return /^(?:download(?: now| here)?|get (?:the )?game|(?:windows|linux) build)$/i.test(c.text);
      const u = new URL(c.href);
      return (fileRe.test(u.pathname) || u.hostname !== location.hostname) && /\b(?:download|get game|mirror|mediafire|mega|gofile|pixeldrain)\b/i.test(c.text);
    });
    if (article && downloadHeading && !avoid.test(heading) && /\b(?:game|gameplay|gaming)\b/i.test(`${meta['description'] ?? ''} ${meta['og:description'] ?? ''} ${bodyText}`) && buildAction) {
      game = {
        title: clean(downloadHeading[1], 200),
        description: clean(article.description || meta['og:description'] || meta['description'], 1500) || null,
        cover: abs(article.thumbnailUrl) || abs(meta['og:image']),
        screenshots: [],
        platforms: platformsFrom(bodyText),
        tags: ([] as unknown[]).concat(article.keywords ?? []).flatMap((t) => String(t).split(',')).map((t) => clean(t, 40)).filter(Boolean).slice(0, 20),
        categories: ([] as unknown[]).concat(article.articleSection ?? []).flatMap((t) => String(t).split(',')).map((t) => clean(t, 60)).filter(Boolean).slice(0, 12),
        author: null,
        price: null,
        uploads: [],
      };
    }
  }

  const pageTags = [...doc.querySelectorAll('main a[rel="tag"], article a[rel="tag"], .game-tags a, .game_tags a, .tags a')].map((t) => clean(t.textContent, 40)).filter(Boolean).slice(0, 20);
  const pageGenres = [...doc.querySelectorAll('[itemprop="genre"], .game-genre a, .game_genre, .genres a')].map((t) => clean(t.textContent, 60)).filter(Boolean).slice(0, 12);
  if (game) {
    game.tags = [...new Set([...game.tags, ...pageTags])];
    game.categories = [...new Set([...(game.categories ?? []), ...pageGenres])];
  }

  // --- generic repeated-card detection ---------------------------------------
  if (!cards.length) {
    const sig = (el: Element | null, depth: number): string => {
      const parts: string[] = [];
      let cur: Element | null = el;
      for (let d = 0; d < depth && cur && cur !== doc.body; d++) {
        const cls = [...cur.classList].filter((c) => !/\d{3,}|active|selected|hover/.test(c)).sort().slice(0, 2).join('.');
        parts.push(cur.tagName.toLowerCase() + (cls ? `.${cls}` : ''));
        cur = cur.parentElement;
      }
      return parts.join('<');
    };
    const groups = new Map<string, Array<{ a: HTMLAnchorElement; card: Element }>>();
    doc.querySelectorAll('a[href]').forEach((a) => {
      if (inChrome(a)) return;
      const href = abs(a.getAttribute('href'));
      if (!href) return;
      try {
        const u = new URL(href);
        if (u.hostname.replace(/^www\./, '') !== host) return;
        if (u.pathname === '/' || u.pathname === location.pathname) return;
      } catch {
        return;
      }
      // The card is the closest ancestor (≤3 levels) that also contains an image.
      let card: Element = a;
      // Never climb into an element that holds several links: that is a list, not a card.
      for (let d = 0; d < 3 && card.parentElement && !card.querySelector('img') && card.parentElement.querySelectorAll('a[href]').length <= 3; d++) {
        if (card.matches('article, li') || card.parentElement.matches('main, section, body, html, ul, ol')) break;
        card = card.parentElement;
      }
      const key = sig(card, 3);
      const list = groups.get(key) ?? [];
      list.push({ a: a as HTMLAnchorElement, card });
      groups.set(key, list);
    });
    const herePath = location.pathname.replace(/\/$/, '');
    let best: { score: number; items: ExtractCard[] } = { score: 0, items: [] };
    const additional: ExtractCard[][] = [];
    let second = 0;
    for (const items of groups.values()) {
      const byHref = new Map<string, ExtractCard>();
      for (const { a, card } of items) {
        const href = abs(a.getAttribute('href'))!;
        // Prefer real headings, then elements whose class is exactly "title"/"name", then fuzzy matches.
        const heading =
          a.querySelector('h1, h2, h3, h4, h5') ??
          card.querySelector('h1, h2, h3, h4, h5') ??
          card.querySelector('.title, .name, [class~="game-title"], [class~="game_title"], [itemprop="name"]') ??
          card.querySelector('[class*="title"], [class*="name"]');
        const img = card.querySelector('img');
        const title = clean(heading?.textContent || a.getAttribute('title') || img?.getAttribute('alt') || a.textContent, 200)
          .replace(/^(?:Build\s+\d+\s*)?(?:\d{4}\s*\|\s*)?[\d.]+\s*(?:GB|MB|KB)\s*/i, '');
        const prev = byHref.get(href);
        if (prev) {
          if (!prev.img) prev.img = imgSrc(img);
          if (!prev.title && title) prev.title = title;
          continue;
        }
        byHref.set(href, {
          href,
          title,
          img: imgSrc(img),
          text: clean(card.textContent, 300),
          platforms: platformsFrom(`${card.textContent ?? ''} ${[...card.querySelectorAll('[title], [aria-label]')].map((e) => e.getAttribute('title') || e.getAttribute('aria-label')).join(' ')}`),
          price: (card.textContent ?? '').match(/(?:[$€£¥]\s?\d+(?:[.,]\d{2})?|\bfree\b)/i)?.[0] ?? null,
          author: null,
          tags: [...card.querySelectorAll('a[rel="tag"], .tag, [data-tag]')].map((t) => clean(t.textContent, 40)).filter(Boolean),
          categories: [...card.querySelectorAll('.genre, .category, [itemprop="genre"]')].map((t) => clean(t.textContent, 60)).filter(Boolean),
        });
      }
      const list = [...byHref.values()].filter((c) => c.title.length >= 2);
      if (list.length < 3) continue;
      const withImg = list.filter((c) => c.img).length / list.length;
      // Titles that look like tags, counters or menu entries rather than game names.
      const goodTitles = list.filter((c) => c.title.length <= 120 && !/^[#@]/.test(c.title) && !/^\d+$/.test(c.title)).length / list.length;
      // Links that refine the current listing (tags, filters, sorting) instead of opening an item.
      const refining =
        list.filter((c) => {
          try {
            const u = new URL(c.href);
            const p = u.pathname.replace(/\/$/, '');
            return (herePath.length > 1 && p.startsWith(herePath + '/') && !/\d/.test(p.slice(herePath.length))) || /\/(tags?|categor(y|ies)|genres?|filters?|sort)\b|[/-]tag-/i.test(p) || (p === herePath && u.search !== location.search);
          } catch {
            return true;
          }
        }).length / list.length;
      const itemLike = list.filter((c) => /\/(games?|apps?|items?|titles?|products?|p|view|play)\/|\d{3,}/i.test(new URL(c.href).pathname)).length / list.length;
      const score = list.length * (0.3 + withImg) * goodTitles * (1 - refining) * (0.7 + 0.3 * itemLike);
      if (withImg >= 0.5 && goodTitles >= 0.8 && refining < 0.2 && score > 0) additional.push(list);
      if (score > best.score) {
        second = best.score;
        best = { score, items: list };
      } else if (score > second) second = score;
    }
    if (best.items.length && best.score > 0) {
      // Homepages often use different cards for latest, popular and genre
      // sections. Retain each credible group instead of only the largest one.
      cards = [...new Map([...best.items, ...additional.flat()].map((c) => [c.href, c])).values()].slice(0, maxCards);
      const withImg = cards.filter((c) => c.img).length / cards.length;
      cardConfidence = Math.min(1, (cards.length >= 6 ? 0.5 : 0.25) + withImg * 0.5);
      // Two competing groups mean the layout is ambiguous: let the vision model decide.
      if (second > best.score * 0.7) cardConfidence *= 0.6;
    }
  }

  // Download catalogs often mix many unrelated DOM card signatures. Their
  // repeated, illustrated “Game Free Download” links are still listings;
  // each destination is independently verified before entering the Store.
  if (!game) {
    const explicit = new Map<string, ExtractCard>();
    for (const link of links) {
      if (link.inContent === false || new URL(link.href).hostname !== location.hostname) continue;
      const img = link.img ?? links.find((l) => l.href === link.href && l.img)?.img;
      if (!img || !/\bfree download\b/i.test(link.text) || /^(?:free )?download\b/i.test(link.text)) continue;
      const title = link.text.replace(/^(?:Build\s+\d+\s*|v\d+(?:\.\d+)*\s*)/i, '')
        .replace(/^(?:\d{4}\s*\|\s*)?[\d.]+\s*(?:GB|MB|KB)\s*/i, '')
        .replace(/\s+free download\b.*$/i, '').trim();
      if (title.length < 2 || title.length > 160) continue;
      explicit.set(link.href, { href: link.href, title, img, text: '', platforms: [], price: null, author: null, tags: [], categories: [] });
    }
    if (explicit.size >= 3) {
      cards = [...new Map([...cards, ...explicit.values()].map((c) => [c.href, c])).values()].slice(0, maxCards);
      cardConfidence = Math.max(cardConfidence, 0.8);
    }
  }

  // --- pagination -------------------------------------------------------------
  if (!nextPage) {
    const rel = doc.querySelector('link[rel="next"], a[rel="next"], a.next.page-numbers, .pagination a.next, .nav-previous a');
    nextPage = abs(rel?.getAttribute('href'));
    if (!nextPage) {
      const cand = [...doc.querySelectorAll('a[href]')].find((a) =>
        /^(?:next(?: page)?|older(?: posts)?|more|[›»→>])(?:\s*[›»→>])?$/i.test(clean(a.textContent || a.getAttribute('aria-label'), 30)),
      );
      nextPage = abs(cand?.getAttribute('href'));
    }
  }

  // --- visible media for snapshot classification ----------------------------------
  const menuLinks: Array<{ href: string; text: string }> = [];
  const seenMenu = new Set<string>();
  doc.querySelectorAll('nav a[href], header a[href], footer a[href], aside a[href], [role="navigation"] a[href], [class*="menu"] a[href], [class*="nav"] a[href], [id*="menu"] a[href]').forEach((a) => {
    if (menuLinks.length >= 200) return;
    const href = abs(a.getAttribute('href'));
    if (!href || seenMenu.has(href)) return;
    try { if (new URL(href).hostname.replace(/^www\./, '') !== host) return; } catch { return; }
    const text = clean(a.textContent || a.getAttribute('title') || a.getAttribute('aria-label'), 60);
    if (!text) return;
    seenMenu.add(href);
    menuLinks.push({ href, text });
  });

  const media: Array<{ src: string; rect: ExtractRect }> = [];
  doc.querySelectorAll('img, video, canvas, picture, [style*="background-image"]').forEach((el) => {
    const r = rectOf(el);
    if (r.w < 48 || r.h < 48) return;
    if (r.y + r.h < 0 || r.y > vh || r.x + r.w < 0 || r.x > vw) return;
    const src =
      el.tagName === 'IMG'
        ? imgSrc(el) || (el as HTMLImageElement).currentSrc || ''
        : el.tagName === 'VIDEO'
          ? (el as HTMLVideoElement).poster || (el as HTMLVideoElement).currentSrc || 'video'
          : el.tagName === 'CANVAS'
            ? 'canvas'
            : (win.getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1] ?? '');
    if (!src) return;
    media.push({ src, rect: r });
  });
  media.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);

  const inputState = {
    focused: doc.activeElement?.tagName.toLowerCase() ?? '',
    fields: Array.from(doc.querySelectorAll('input:not([type="hidden"]):not([type="password"]),textarea')).filter(el => visible(el)).slice(0, 20).map((el, n) => {
      const input = el as HTMLInputElement;
      // maxControls limits returned observations, not the number of DOM IDs.
      // Submit inputs already have a control identity; do not overwrite it.
      const id = controlIds.get(el) ?? counter++;
      if (opts.mark !== false) el.setAttribute('data-cgl-i', String(id));
      return { id, label: clean(input.getAttribute('aria-label') || input.placeholder || input.name || '', 100), type: input.type || 'text', value: input.value.slice(0, 120), focused: doc.activeElement === el };
    }),
  };
  // --- the game's own description, counters and the site's ranked lists ----------
  const SEO = /\bfree download\b|\bdownload (?:it )?(?:for )?free\b|pre-?installed|\btorrent\b|\bpc game for free\b|\bfor free instantly\b/i;
  const SPECS = /system requirements|\b(?:os|processor|memory|graphics|storage|directx)\s*:/i;
  const ABOUT = /^(?:game\s+)?(?:overview|description|about(?:\s+(?:this|the)\s+game)?|story|summary|synopsis|plot|introduction)\b/i;
  const prose = (el: Element) => clean((el as HTMLElement).innerText || el.textContent, 1500);
  const offTopic = 'nav,header,footer,aside,form,[class*="comment"],[class*="sidebar"],[class*="related"],[class*="widget"],[class*="share"]';
  const mainScope = doc.querySelector('[itemprop="articleBody"], .entry-content, .post-content, article .content, article, main, #content') ?? doc.body;
  let about: string | null = null;
  for (const h of doc.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,b')) {
    const heading = clean(h.textContent, 80);
    if (!ABOUT.test(heading) || heading.length > 40 || markupHidden(h) || closest(h,offTopic)) continue;
    const start = /^(?:STRONG|B)$/.test(h.tagName) ? closest(h,'p,div') ?? h : h;
    const parts: string[] = [];
    // "Overview: text…" in the same paragraph as an inline heading.
    if (start !== h) { const rest = prose(start).slice(heading.length).replace(/^[\s:–—-]+/, ''); if (rest.length >= 40 && !SEO.test(rest)) parts.push(rest); }
    for (let n = start.nextElementSibling; n && parts.join(' ').length < 900; n = n.nextElementSibling) {
      if (/^H[1-6]$/.test(n.tagName) || n.querySelector('h1,h2,h3,h4')) break;
      const t = prose(n);
      if (t.length >= 40 && !SEO.test(t) && !SPECS.test(t)) parts.push(t);
    }
    if (parts.join(' ').length >= 80) { about = clean(parts.join(' '), 1500); break; }
  }
  if (!about && mainScope) {
    const paras: string[] = [];
    for (const p of mainScope.querySelectorAll('p')) {
      if (closest(p,offTopic) || markupHidden(p)) continue;
      const t = prose(p);
      if (t.length < 100 || SEO.test(t) || SPECS.test(t) || !/[.!?](?:\s|$)/.test(t)) continue;
      paras.push(t);
      if (paras.join(' ').length >= 300 || paras.length >= 2) break;
    }
    about = paras.length ? clean(paras.join(' '), 1500) : null;
  }
  const mainText = mainScope ? clean((mainScope as HTMLElement).innerText || mainScope.textContent || '', 20000) : null;
  const ldPublished = (jsonLd as Array<Record<string, unknown>>).map((o) => o?.datePublished).find((v) => typeof v === 'string') as string | undefined;
  // Some host scripts replace closest() with a shim returning false instead
  // of null. Only accept an actual Element as a date scope.
  const articleScope=closest(mainScope,'article');
  const published = meta['article:published_time'] || meta['datepublished'] || ldPublished || (mainScope ? dateIn(articleScope instanceof win.Element ? articleScope : mainScope) : null);
  const RANK_POPULAR = /\b(?:most\s+)?popular\b|most\s+(?:downloaded|played|viewed)|\btop\s+(?:games|downloads|rated|\d+)\b|^top$|best\s+(?:games|of)|all[- ]time/i;
  const RANK_TRENDING = /\btrending\b|\bhot\b|this\s+week|rising|new\s+(?:and|&)\s+popular|right\s+now/i;
  const recentGameLinks: string[] = [];
  const rankedSections: Array<{ kind: 'popular' | 'trending'; heading: string; links: string[] }> = [];
  for (const h of doc.querySelectorAll('h1,h2,h3,h4,h5,h6,.widget-title,.widgettitle,.section-title,[class*="block-title"]')) {
    const heading = clean(h.textContent, 60);
    if (!heading || heading.length > 50) continue;
    const kind = RANK_TRENDING.test(heading) ? 'trending' : RANK_POPULAR.test(heading) ? 'popular' : null;
    const recent = /^(?:recently added(?: games)?|newly added(?: games)?|latest games|new games|new releases|recent games)$/i.test(heading);
    if (!recent && (!kind || rankedSections.some((r) => r.kind === kind))) continue;
    const box = closest(h.parentElement,'section,aside,.widget,[class*="widget"],[class*="popular"],[class*="trending"],[class*="block"]') ?? h.parentElement;
    if (!box || box === doc.body || box === doc.documentElement) continue;
    const hrefs: string[] = [];
    for (const a of box.querySelectorAll('a[href]')) {
      const u = abs(a.getAttribute('href'));
      if (!u || hrefs.includes(u.split('#')[0])) continue;
      try { if (new URL(u).hostname.replace(/^www\./, '') !== host) continue; } catch { continue; }
      hrefs.push(u.split('#')[0]);
      if (hrefs.length >= 60) break;
    }
    if (recent) recentGameLinks.push(...hrefs);
    else if (kind && hrefs.length >= 3) rankedSections.push({ kind, heading, links: hrefs });
  }

  return {
    url: location.href,
    title: clean(doc.title, 200),
    site,
    meta,
    jsonLd,
    cards,
    cardConfidence,
    nextPage,
    game,
    controls,
    links,
    fileLinks,
    gates: { login: pw, captcha, payment, ageGate, blocked },
    adultSignals,
    text: bodyText.slice(0, 4000),
    media: media.slice(0, 10),
    menuLinks,
    about,
    mainText,
    notices: [...doc.querySelectorAll('h1,h2,[role="alert"],.alert,.error-message')]
      .filter(el => !markupHidden(el) && !closest(el,'nav,header,footer,aside,[class*="faq"],[class*="comment"],[class*="related"]'))
      .map(el => clean((el as HTMLElement).innerText || el.textContent, 301))
      .filter(text => text.length > 0 && text.length <= 300).slice(0, 16),
    published,
    observedAt,
    recentGameLinks: [...new Set(recentGameLinks)],
    rankedSections,
    viewport: { w: vw, h: vh, scrollY: Math.round(win.scrollY), docH: Math.round(doc.documentElement?.scrollHeight??0) },
    inputState,
  };
}
