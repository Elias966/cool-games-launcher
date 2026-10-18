// Only observed page controls count as evidence. AI-generated prose never
// creates a download URL, and a mirror's landing page is not a game file.
import type { ExtractControl, PageExtract } from './page-extract';
import type { DownloadCandidate, Platform } from './types';

const FILE = /\.(?:zip|7z|rar|tar(?:\.(?:gz|xz|bz2|zst))?|tgz|txz|appimage|x86_64|sh|run|exe|msi|deb|rpm|apk|dmg|love|jar|(?:zip|7z|rar|tar)\.\d{3}|r\d{2})$/i;
const AVOID = /\b(?:advertisement|sponsored|download manager|browser extension|driver updater|source code|soundtrack|wallpaper|trailer|manual|subscribe|checkout|sign up|log in)\b/i;
const DOWNLOAD = /\b(?:download(?:s|ing)?|get (?:the )?game|mirror|direct link|windows build|linux build|portable build)\b/i;
const HOST_LABEL = /^(?:mediafire|mega(?:\.nz)?|megadb|google drive|gdrive|dropbox|pixeldrain|gofile|sourceforge|uploadhaven|buzzheavier|bzzhr|vikingfile|datanodes|fileditch|1fichier|qiwi|ranoz|fuckingfast|datavaults|filekeeper|fileq|akirabox)(?:\s+(?:mirror|link|download|\d+))*$/i;

/** Torrents are not supported game archives, including extensionless buttons. */
export function isTorrentDownload(text: string, url?: string | null): boolean {
  if (/\b(?:torrent|bittorrent|magnet)\b/i.test(text)) return true;
  if (!url) return false;
  try {
    const u=new URL(url);
    return u.protocol==='magnet:' || /\.torrent(?:$|[/?&#])/i.test(decodeURIComponent(u.pathname+u.search)) || [...u.searchParams].some(([key,value])=>/^(?:torrent|magnet)$/i.test(key)||/^(?:format|type|method|download|mode|protocol)$/i.test(key)&&/^(?:torrent|bittorrent|magnet)$/i.test(value));
  } catch { return /^magnet:/i.test(url); }
}

export function excludedDownloadLabel(text: string): boolean {
  if (isTorrentDownload(text)) return true;
  if (/^copy\b.*\b(?:download|link)\b/i.test(text.trim())) return true;
  if (/\b(?:watch (?:the )?(?:guide|tutorial)|how to (?:download|install)|download (?:guide|instructions|tutorial))\b/i.test(text)) return true;
  if (/\b(?:verified players|confirmed downloads|enable filter|download (?:count|history|statistics)|downloads? (?:filter|only))\b/i.test(text)) return true;
  // “Manual Download” means a normal file download, not an instruction manual.
  return AVOID.test(text.replace(/\bmanual\s+download\b|\bdownload\s+manually\b/gi, 'download'));
}
const excluded=excludedDownloadLabel;

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
    if (h === 'megadb.net') return /^\/[a-z0-9]{8,32}\/?$/i.test(u.pathname);
    if (['qiwi.gg', 'ranoz.gg', 'fuckingfast.co'].includes(h)) return u.pathname !== '/';
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
  if (c.inContent === false || excluded(c.text) || isTorrentDownload(c.text,c.href)) return false;
  return DOWNLOAD.test(c.text) || HOST_LABEL.test(c.text.trim()) || !!c.href && (isHostLanding(c.href) || isFileUrl(c.href));
}

export function downloadControls(ex: PageExtract): ExtractControl[] {
  const eligible=ex.controls.filter((c) => {
    if (!isDownloadControl(c)) return false;
    // A linked recommendation titled “Other Game Free Download” is a page
    // listing, not a download action for the game currently being inspected.
    if (isCatalogNavigation(ex, c)) return false;
    return true;
  });
  return eligible.some(c=>c.inDialog)?eligible.filter(c=>c.inDialog):eligible;
}

export function downloadEvidence(ex: PageExtract, limit = 30): DownloadCandidate[] {
  const out: DownloadCandidate[] = [];
  const modal=downloadControls(ex).some(c=>c.inDialog);
  for (const l of ex.fileLinks) {
    if(modal&&!l.inDialog)continue;
    const control = ex.controls.find((c) => c.i === l.i);
    if (l.inContent === false || control?.inContent === false || excluded(l.text) || isTorrentDownload(l.text,l.href)) continue;
    out.push({ url: l.href, label: l.text || l.href, fileName: fileName(l.href), platform: platformFrom(`${l.text} ${l.href}`), sizeText: null });
  }
  for (const c of downloadControls(ex)) {
    out.push({ url: c.href ?? `${ex.url.split('#')[0]}#cgl-control-${c.i}`, label: c.text, fileName: c.href && isFileUrl(c.href) ? fileName(c.href) : null, platform: platformFrom(c.text), sizeText: null });
  }
  // Controls are a bounded AI observation. Host links later in a long page
  // still belong in the complete comparison, even outside that observation.
  for (const l of ex.links) {
    if(modal&&!l.inDialog)continue;
    if (l.inContent === false || excluded(l.text) || isTorrentDownload(l.text,l.href) || !isHostLanding(l.href) || out.some(c => c.url === l.href)) continue;
    if (isCatalogNavigation(ex, { ...l, tag: 'a', inViewport: false, rect: l.rect ?? { x: 0, y: 0, w: 0, h: 0 } })) continue;
    out.push({ url: l.href, label: l.text || new URL(l.href).hostname, fileName: null, platform: platformFrom(l.text), sizeText: null });
  }
  for (const [i, u] of (ex.game?.uploads ?? []).entries()) {
    if(modal&&!ex.controls.some(c=>c.i===u.i&&c.inDialog))continue;
    if (isTorrentDownload(u.name,u.href)) continue;
    if (!u.href && (u.i === null || !Number.isFinite(u.i))) continue;
    out.push({ url: u.href ?? `${ex.url.split('#')[0]}#cgl-upload-${i}`, label: u.name, fileName: u.name, platform: (u.platforms[0] as Platform | undefined) ?? platformFrom(u.name), sizeText: u.size });
  }
  return [...new Map(out.map((c) => [c.url, c])).values()].slice(0, limit);
}

/** Hosts behind selector buttons are alternative routes, not extra parts.
 * Ignore the currently selected host's duplicate Download anchor in this case.
 */
export function revealedMirrors(ex:PageExtract):DownloadCandidate[]{
  const tabs=downloadControls(ex).filter(c=>!c.href&&HOST_LABEL.test(c.text.trim()));
  const evidence=downloadEvidence(ex,Number.MAX_SAFE_INTEGER);
  if(tabs.length>1){const ids=new Set(tabs.map(c=>c.i));return evidence.filter(c=>{const id=/#cgl-control-(\d+)$/.exec(c.url);return !!id&&ids.has(Number(id[1]));});}
  return evidence.filter(c=>!/#cgl-/.test(c.url)&&(isHostLanding(c.url)||new URL(c.url).origin!==new URL(ex.url).origin));
}

function fileName(url: string): string | null {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || null; } catch { return null; }
}

// Repeated labels on different hosts are distinct actions; the same control
// on the same page must not trap the resolver in an infinite click loop.
/** Rebind a script mirror after banners/modals change numeric DOM IDs. */
export function scriptMirrorControl(ex:PageExtract,route:DownloadCandidate):ExtractControl|null {
  if(!/#cgl-control-\d+$/.test(route.url))return null;
  const label=(text:string)=>text.replace(/\s+/g,' ').trim().toLowerCase();
  const matches=ex.controls.filter(c=>!c.href&&label(c.text)===label(route.label));
  return matches.length===1?matches[0]:null;
}

export function actionKey(pageUrl: string, c: ExtractControl): string {
  return `click:${JSON.stringify([pageUrl, c.href ?? c.i, c.text])}`;
}
