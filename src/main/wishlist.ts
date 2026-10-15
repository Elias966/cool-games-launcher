// Wishlist: games the user wants. Catalog games are watched for a new version;
// titles not on any website yet are watched for until one lists them. Either
// event becomes a desktop notification that opens the game.
import { fingerprintKey, versionLabel } from '@shared/game-version';
import { titleSimilarity } from '@shared/fuzzy';
import { visibleRatings } from '@shared/policy';
import { titleKey } from '@shared/urls';
import type { WishItem } from '@shared/types';
import type { CatalogRepo, SourcesRepo, WishlistRepo } from './repos';
import type { PolicyService } from './policy-service';
import { sameGame } from './descriptions';
import { tm } from './i18n';

/** The same game, allowing small typos but never another entry of a series ("Portal" ≠ "Portal 2"). */
export function wantedMatch(wanted: string, title: string): boolean {
  return sameGame(wanted, title) || (titleSimilarity(wanted, title) >= 0.85 && titleSimilarity(title, wanted) >= 0.85);
}

export class WishlistService {
  constructor(private deps: { wishlist: WishlistRepo; catalog: CatalogRepo; sources: SourcesRepo; policy: PolicyService; notify: (title: string, body: string, catalogId: number | null) => void; changed: () => void }) {}

  list(): WishItem[] {
    return this.deps.wishlist.list().map((w) => ({ id: w.id, title: w.title, catalogId: w.catalogId, createdAt: w.createdAt }));
  }

  /** Wishlists a catalog game, or a title to watch for (linked at once when the catalog already has it). */
  add(p: { catalogId?: number; title?: string }): WishItem {
    const { wishlist, catalog } = this.deps;
    let catalogId = p.catalogId ?? null;
    let title = p.title?.trim() ?? '';
    if (catalogId === null && title) {
      const found = catalog.query(this.deps.policy.policy(), { search: title, limit: 20 }).entries.find((e) => wantedMatch(title, e.title));
      if (found) catalogId = found.id;
    }
    const entry = catalogId !== null ? catalog.raw(catalogId) : null;
    if (catalogId !== null && !entry) throw new Error('That game is no longer in the catalog');
    if (entry) title = entry.title;
    if (!title) throw new Error('Enter a game title');
    const w = wishlist.add({ catalogId, title, titleKey: titleKey(title), versionKey: entry?.version ? fingerprintKey(entry.version) : null });
    this.deps.changed();
    return { id: w.id, title: w.title, catalogId: w.catalogId, createdAt: w.createdAt };
  }

  remove(p: { id?: number; catalogId?: number }) {
    if (p.id !== undefined) this.deps.wishlist.remove(p.id);
    if (p.catalogId !== undefined) this.deps.wishlist.removeCatalog(p.catalogId);
    this.deps.changed();
  }

  /** A game page was verified: a wanted title appeared, or a wishlisted game has a new version. */
  afterDetail(catalogId: number) {
    const { wishlist, catalog, policy } = this.deps;
    const entry = catalog.raw(catalogId);
    if (!entry || entry.downloadStatus !== 'available' || !visibleRatings(policy.policy()).includes(entry.rating)) return;
    const key = entry.version ? fingerprintKey(entry.version) : null;
    const source = this.deps.sources.get(entry.sourceId)?.name ?? tm('your websites');
    const linked = wishlist.forCatalog(catalogId);
    if (linked) {
      if (key && linked.versionKey && key !== linked.versionKey) {
        wishlist.setVersion(linked.id, key, true);
        this.deps.notify(tm('New version of {title}', { title: entry.title }), versionLabel(entry.version) ? tm('{version} is on {source}.', { version: versionLabel(entry.version), source }) : tm('An updated build is on {source}.', { source }), catalogId);
      } else if (key && !linked.versionKey) wishlist.setVersion(linked.id, key, false);
      return;
    }
    for (const w of wishlist.waiting()) {
      if (!wantedMatch(w.title, entry.title)) continue;
      wishlist.link(w.id, catalogId, key);
      this.deps.notify(tm('{title} is now available', { title: entry.title }), tm('Found on {source}. Open it to download.', { source }), catalogId);
      this.deps.changed();
      return;
    }
  }
}
