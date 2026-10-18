import { hostOf } from '@shared/urls';
import type { CatalogRepo, DownloadRecord, GameRecord } from './repos';

/** Folder labels are hints only when they name a known website, not a file host. */
export function folderSource(paths: Array<string | null>, hosts: string[]): string | null {
  const found = new Set<string>();
  for (const host of new Set(['steamrip.com', 'ankergames.net', 'zeigames.com', ...hosts])) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|[^a-z0-9.])(?:www\\.)?${escaped}(?=$|[^a-z0-9.])`, 'i');
    if (paths.some(p => p && pattern.test(p))) found.add(host);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** A download receipt pins its website forever. A saved source is retained;
 * folder hints fill only unknown imported sources. Unknown stays unknown. */
export function gameSource(g: GameRecord, d: DownloadRecord | null, catalog: CatalogRepo, hosts: string[] = []): string | null {
  if (d) {
    // pageUrl is a mutable browser resume point and may be a third-party host.
    const page = hostOf(d.resolution?.linkPage?.url ?? d.resolution?.pageUrl ?? '');
    const known = ['steamrip.com', 'ankergames.net', 'zeigames.com', ...hosts];
    const original = d.sourceHost || (d.catalogId ? hostOf(catalog.raw(d.catalogId)?.pageUrl ?? '') : null) || (known.includes(page) ? page : null);
    if (original) return original.toLowerCase().replace(/^www\./, '');
  }
  return g.sourceHost?.toLowerCase().replace(/^www\./, '') || folderSource([g.installDir, g.executable], hosts);
}
