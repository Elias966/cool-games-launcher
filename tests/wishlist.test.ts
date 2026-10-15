import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/main/db';
import { CatalogRepo, ConsentRepo, SettingsRepo, SourcesRepo, WishlistRepo, defaultSettings } from '../src/main/repos';
import { PolicyService } from '../src/main/policy-service';
import { WishlistService } from '../src/main/wishlist';
import { makeFingerprint } from '@shared/game-version';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cgl-wish-'));
  const db = openDb(join(dir, 'db'));
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const settings = new SettingsRepo(db, defaultSettings({ games: dir, downloads: dir }));
  const catalog = new CatalogRepo(db), sources = new SourcesRepo(db), wishlist = new WishlistRepo(db);
  const src = sources.add('https://games.test/', 'Games Test');
  const notify = vi.fn();
  const svc = new WishlistService({ wishlist, catalog, sources, policy: new PolicyService(settings, new ConsentRepo(db)), notify, changed: vi.fn() });
  const verify = (pageUrl: string, title: string, version: string) => {
    const id = catalog.upsertListing(src.id, { pageUrl, title, titleKey: title.toLowerCase() }).id;
    const candidates = [{ url: `${pageUrl}/f.zip`, label: 'Download', fileName: `f-v${version}.zip`, platform: 'linux' as const, sizeText: null }];
    catalog.setDetail(id, { candidates, version: makeFingerprint({ titles: [`${title} v${version}`], candidates }) });
    catalog.setRating(id, 'safe', 0, [], 'v');
    svc.afterDetail(id);
    return id;
  };
  return { svc, notify, verify, catalog };
}

describe('wishlist notifications', () => {
  it('tells the user when a wanted title appears, once', () => {
    const { svc, notify, verify } = setup();
    svc.add({ title: 'Hollow Knight Silksong' });
    verify('https://games.test/other', 'Star Miner', '1.0');
    expect(notify).not.toHaveBeenCalled();
    const id = verify('https://games.test/silksong', 'Hollow Knight: Silksong', '1.0');
    expect(notify).toHaveBeenCalledWith('Hollow Knight: Silksong is now available', expect.stringContaining('Games Test'), id);
    expect(svc.list()[0].catalogId).toBe(id);
  });
  it('tells the user when a wishlisted game gets a new version', () => {
    const { svc, notify, verify } = setup();
    const id = verify('https://games.test/orbit', 'Orbit Run', '1.0');
    svc.add({ catalogId: id });
    verify('https://games.test/orbit', 'Orbit Run', '1.0');
    expect(notify).not.toHaveBeenCalled();
    verify('https://games.test/orbit', 'Orbit Run', '1.1');
    expect(notify).toHaveBeenCalledWith('New version of Orbit Run', expect.stringContaining('v1.1'), id);
  });
});
