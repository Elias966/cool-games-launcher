import type { DownloadItem } from './types';

/** Catalog detail responses can predate a retry; follow the live queue instead. */
export function latestCatalogDownload<T extends Pick<DownloadItem,'id'|'catalogId'|'state'>>(items: readonly T[], catalogId: number): T | null {
  let latest: T | null = null;
  for (const item of items) {
    if(item.catalogId===catalogId && item.state!=='cancelled' && (!latest || item.id>latest.id))latest=item;
  }
  return latest;
}
