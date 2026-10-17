import { canonicalUrl, hostOf, isHttpUrl, looksLikeFileUrl } from './urls';

/** CAPTCHA tokens can change while completing a check; file IDs must still match. */
export function downloadPageKey(url: string): string | null {
  try {
    const u=new URL(url);
    for(const key of [...u.searchParams.keys()])if(/^(?:__cf_chl_|cf_chl_)/i.test(key))u.searchParams.delete(key);
    return canonicalUrl(u.href);
  }catch{return null;}
}

/** Home/search/listing pages are not a substitute for an indexed game URL. */
export function isSiteBrowseUrl(url: string, gameUrl: string): boolean {
  if (!isHttpUrl(url) || hostOf(url) !== hostOf(gameUrl)) return false;
  if (looksLikeFileUrl(url)) return false;
  const u = new URL(url);
  if ([...u.searchParams.keys()].some(key => /^(?:s|q|query|search|keyword)$/i.test(key))) return true;
  if (canonicalUrl(url) === canonicalUrl(gameUrl)) return false;
  const gamePath = new URL(gameUrl).pathname.replace(/\/$/, '');
  if (gamePath && (u.pathname.replace(/\/$/, '') === gamePath || u.pathname.startsWith(gamePath + '/'))) return false;
  return /^\/(?:$|(?:home|index(?:\.html?|\.php)?|search|categories|category|tags?|page|games|blog|news|about|contact|privacy|terms)(?:\/|$))/i.test(u.pathname);
}

export function isGameBookmark(url: string, gameUrl: string): boolean {
  return isHttpUrl(url) && hostOf(url) === hostOf(gameUrl) && !isSiteBrowseUrl(url, gameUrl);
}

export function isSearchField(field: { type?: string; label?: string }): boolean {
  return field.type === 'search' || /\b(?:search|find (?:a |the )?game)\b/i.test(field.label ?? '');
}
