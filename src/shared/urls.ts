// URL helpers used for duplicate detection and per-host rate limiting.

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_[a-z]+|ref|ref_src|igshid|_ga|yclid|msclkid|si|snr)$/i;

/** Canonical form of a page URL for duplicate detection. */
export function canonicalUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  u.pathname = path;
  return u.toString();
}

export function hostOf(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Title key for fuzzy duplicate detection within one source. */
export function titleKey(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\((?:v|ver|version)?\s*\d+(?:\.\d+)*[a-z]?\)/g, '')
    .replace(/\bv\d+(?:\.\d+)+\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isHttpUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const FILE_EXT = /\.(zip|tar|tgz|tar\.gz|tar\.xz|tar\.bz2|tar\.zst|txz|tbz2|7z|rar|appimage|x86_64|sh|run|exe|msi|deb|rpm|flatpakref|apk|dmg|pkg|love|jar|(?:zip|7z|rar|tar)\.\d{3}|r\d{2})$/i;

/** Guesses whether a URL points directly at a downloadable file from its path. */
export function looksLikeFileUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return FILE_EXT.test(decodeURIComponent(u.pathname));
  } catch {
    return false;
  }
}

export function fileNameFromUrl(input: string): string | null {
  try {
    const u = new URL(input);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return last || null;
  } catch {
    return null;
  }
}

/** example.co.uk / a.b.itch.io → the site's registrable domain (approximate, no public-suffix list). */
export function siteKey(host: string): string {
  const parts = host.replace(/^www\./, '').split('.');
  const n = parts.length >= 3 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}
