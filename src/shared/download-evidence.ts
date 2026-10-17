// Only observed page controls count as evidence. AI-generated prose never
// creates a download URL, and a mirror's landing page is not a game file.
import type { ExtractControl, PageExtract } from './page-extract';
import type { DownloadCandidate, Platform } from './types';

const FILE = /\.(?:zip|7z|rar|tar(?:\.(?:gz|xz|bz2|zst))?|tgz|txz|appimage|x86_64|sh|run|exe|msi|deb|rpm|apk|dmg|love|jar|(?:zip|7z|rar|tar)\.\d{3}|r\d{2})$/i;
const AVOID = /\b(?:advertisement|sponsored|download manager|browser extension|driver updater|source code|soundtrack|wallpaper|trailer|manual|subscribe|checkout|sign up|log in)\b/i;
const DOWNLOAD = /\b(?:download(?:s|ing)?|get (?:the )?game|mirror|direct link|windows build|linux build|portable build)\b/i;
const HOST_LABEL = /^(?:mediafire|mega(?:\.nz)?|google drive|gdrive|dropbox|pixeldrain|gofile|sourceforge|uploadhaven|buzzheavier|vikingfile|datanodes|fileditch|1fichier)(?:\s+(?:mirror|link|download|\d+))*$/i;

function excluded(text: string): boolean {
  if (/^copy\b.*\b(?:download|link)\b/i.test(text.trim())) return true;
  // “Manual Download” means a normal file download, not an instruction manual.
  return AVOID.test(text.replace(/\bmanual\s+download\b|\bdownload\s+manually\b/gi, 'download'));
}

/** Never let resolver fallbacks turn recommendations or catalog navigation into download actions. */
export function isCatalogNavigation(ex: PageExtract, c: ExtractControl): boolean {
  if (!c.href || isFileUrl(c.href)) return false;
  const u = new URL(c.href);
  const page = new URL(ex.url);
  if (u.origin === page.origin && u.pathname === page.pathname && (u.searchParams.has('lang') || u.searchParams.has('language'))) return true;
  if (isHostLanding(c.href)) return false;
  if (u.hash && u.origin === new URL(ex.url).origin && u.pathname === new URL(ex.url).pathname) return false;
  if (ex.cards.some((card) => card.href === c.href && card.href !== ex.url)) return true;
  if (u.origin !== new URL(ex.url).origin) return false;
  if (/^\/(?:$|category(?:\/|$)|tags?(?:\/|$)|page(?:\/|$)|games\/?$|(?:pricing|blog|speedtest|developers|privacy|terms|proxy|contact|help|faq|report)(?:\/|$))/i.test(u.pathname)) return true;
  return /\bfree download\b/i.test(c.text) && !/^(?:(?:free|manual)\s+)?download\b/i.test(c.text)
    || /(?:^|\/)\S+-free-download[^/]*\/?$/i.test(u.pathname) && u.pathname.replace(/\/$/, '') !== new URL(ex.url).pathname.replace(/\/$/, '');
}

export function platformFrom(s: string): Platform | null {
  if (/linux|\.appimage|\.x86_64|\.deb\b|\.sh\b/i.test(s)) return 'linux';
  if (/windows|\bwin(?:32|64)?\b|\.exe\b|\.msi\b/i.test(s)) return 'windows';
  if (/macos|mac os|osx|\.dmg\b/i.test(s)) return 'macos';
  if (/android|\.apk\b/i.test(s)) return 'android';
  return null;
}

export function isFileUrl(url: string): boolean {
  try { return FILE.test(decodeURIComponent(new URL(url).pathname)); } catch { return false; }
}

export function isHostLanding(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    if (/^\/(?:pricing|blog|speedtest|developers|privacy|terms|proxy|contact|help|faq|report)\/?$/i.test(u.pathname)) return false;
    if (h === 'uploadhaven.com') return /^\/download\//.test(u.pathname);
    if (h === 'bzzhr.to') return /^\/[a-z0-9]{10,32}\/?$/i.test(u.pathname);
    if (h === 'buzzheavier.com' || h === 'vikingfile.com' || h === 'datanodes.to' || h === '1fichier.com') return u.pathname !== '/' || u.searchParams.has('id') || u.search.length > 1;
    if (h === 'fileditch.com') return /^\/(?:file|download|d)\//.test(u.pathname);
    if (h === 'mediafire.com') return /^\/file\//.test(u.pathname);
    if (h === 'mega.nz' || h === 'mega.co.nz') return /^\/(file|folder)\//.test(u.pathname) || /^#!/.test(u.hash);
    if (h === 'drive.google.com') return /^\/file\/d\//.test(u.pathname) || /^\/(uc|open)$/.test(u.pathname) && u.searchParams.has('id');
    if (h === 'dropbox.com') return /^\/(s|scl\/fi)\//.test(u.pathname) && u.searchParams.get('dl') !== '1';
    if (h === 'pixeldrain.com') return /^\/u\//.test(u.pathname);
    if (h === 'gofile.io') return /^\/d\//.test(u.pathname);
    if (h === 'sourceforge.net') return /\/files\//.test(u.pathname) && !u.pathname.endsWith('/download');
    return false;
  } catch { return false; }
}

export function isDownloadControl(c: ExtractControl): boolean {
  if (c.inContent === false || excluded(c.text)) return false;
  return DOWNLOAD.test(c.text) || HOST_LABEL.test(c.text.trim()) || !!c.href && (isHostLanding(c.href) || isFileUrl(c.href));
}

export function downloadControls(ex: PageExtract): ExtractControl[] {
  return ex.controls.filter((c) => {
    if (!isDownloadControl(c)) return false;
    // A linked recommendation titled “Other Game Free Download” is a page
    // listing, not a download action for the game currently being inspected.
    if (isCatalogNavigation(ex, c)) return false;
    return true;
  });
}

export function downloadEvidence(ex: PageExtract, limit = 30): DownloadCandidate[] {
  const out: DownloadCandidate[] = [];
  for (const l of ex.fileLinks) {
    const control = ex.controls.find((c) => c.i === l.i);
    if (l.inContent === false || control?.inContent === false || excluded(l.text)) continue;
    out.push({ url: l.href, label: l.text || l.href, fileName: fileName(l.href), platform: platformFrom(`${l.text} ${l.href}`), sizeText: null });
  }
  for (const c of downloadControls(ex)) {
    out.push({ url: c.href ?? `${ex.url.split('#')[0]}#cgl-control-${c.i}`, label: c.text, fileName: c.href && isFileUrl(c.href) ? fileName(c.href) : null, platform: platformFrom(c.text), sizeText: null });
  }
  for (const [i, u] of (ex.game?.uploads ?? []).entries()) {
    if (!u.href && (u.i === null || !Number.isFinite(u.i))) continue;
    out.push({ url: u.href ?? `${ex.url.split('#')[0]}#cgl-upload-${i}`, label: u.name, fileName: u.name, platform: (u.platforms[0] as Platform | undefined) ?? platformFrom(u.name), sizeText: u.size });
  }
  return [...new Map(out.map((c) => [c.url, c])).values()].slice(0, limit);
}

function fileName(url: string): string | null {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || null; } catch { return null; }
}

// Repeated labels on different hosts are distinct actions; the same control
// on the same page must not trap the resolver in an infinite click loop.
export function actionKey(pageUrl: string, c: ExtractControl): string {
  return `click:${JSON.stringify([pageUrl, c.href ?? c.i, c.text])}`;
}
