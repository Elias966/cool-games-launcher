// Consent lifecycle, policy revisions and catalog gating against a real SQLite file.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/main/db';
import { CatalogRepo, ConsentRepo, SettingsRepo, SourcesRepo, defaultSettings } from '../src/main/repos';
import { PolicyService } from '../src/main/policy-service';

let dir: string;
let db: Db;

function services(d: Db) {
  const settings = new SettingsRepo(d, defaultSettings({ games: '/tmp/g', downloads: '/tmp/d' }));
  const consent = new ConsentRepo(d);
  const policy = new PolicyService(settings, consent);
  return { settings, consent, policy, sources: new SourcesRepo(d), catalog: new CatalogRepo(d) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cgl-test-'));
  db = openDb(join(dir, 'launcher.db'));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('adult content', () => {
  it('is hidden on a fresh installation', () => {
    const { policy, consent } = services(db);
    expect(policy.policy().showNsfw).toBe(false);
    expect(consent.current().accepted).toBe(false);
  });

  it('is hidden again, and the old consent forgotten, where an earlier version showed it', () => {
    const { settings, consent } = services(db);
    consent.accept('earlier-warning');
    settings.update({ showNsfw: true });
    const before = settings.get().policyRevision;
    db.close();
    db = openDb(join(dir, 'launcher.db'));
    const again = services(db);
    expect(again.policy.policy().showNsfw).toBe(false);
    expect(again.settings.get().showNsfw).toBe(false);
    expect(again.consent.current().accepted).toBe(false);
    // A new revision makes every cached Store list hide adult games right away.
    expect(again.policy.policy().revision).toBe(before + 1);
  });

  it('stays hidden even if the stored setting says otherwise', () => {
    const { settings, policy } = services(db);
    settings.update({ showNsfw: true });
    expect(policy.policy().showNsfw).toBe(false);
  });
});

describe('catalog gating', () => {
  function seed(s: ReturnType<typeof services>) {
    const src = s.sources.add('https://games.test/browse');
    const mk = (title: string) => {
      const id = s.catalog.upsertListing(src.id, { pageUrl: `https://games.test/${title}`, title, titleKey: title }).id;
      s.catalog.setDetail(id, { candidates: [{ url: `https://games.test/${title}.zip`, label: 'Download game', fileName: `${title}.zip`, platform: 'linux', sizeText: null }] });
      return id;
    };
    const safe = mk('safe-game');
    const adult = mk('adult-game');
    const unknown = mk('unknown-game');
    s.catalog.setRating(safe, 'safe', 0.01, [], 'v1');
    s.catalog.setRating(adult, 'adult', 0.9, ['image:0.90'], 'v1');
    s.catalog.setArtwork(safe, 'a'.repeat(40) + '.png');
    s.catalog.setArtwork(adult, 'b'.repeat(40) + '.png');
    return { safe, adult, unknown };
  }

  it('returns only safe entries while NSFW is off', () => {
    const s = services(db);
    const ids = seed(s);
    const page = s.catalog.query(s.policy.policy(), {});
    expect(page.entries.map((e) => e.id)).toEqual([ids.safe]);
    expect(s.catalog.get(ids.adult, s.policy.policy())).toBeNull();
  });

  it('never shows adult or unclassified entries, or adult artwork', () => {
    const s = services(db);
    const ids = seed(s);
    expect(s.catalog.get(ids.unknown, s.policy.policy())).toBeNull();
    expect(s.catalog.artworkVisible('b'.repeat(40) + '.png', s.policy.policy())).toBe(false);
    expect(s.catalog.artworkVisible('a'.repeat(40) + '.png', s.policy.policy())).toBe(true);
    expect(s.catalog.hiddenIds(s.policy.policy()).length).toBe(2);
  });

  it('gates screenshots on their own score', () => {
    const s = services(db);
    const ids = seed(s);
    s.catalog.setScreenshotFiles(ids.safe, [
      { file: 'c'.repeat(40) + '.png', score: 0.05 },
      { file: 'd'.repeat(40) + '.png', score: 0.95 },
    ]);
    const entry = s.catalog.get(ids.safe, s.policy.policy())!;
    expect(entry.screenshots).toHaveLength(1);
    expect(s.catalog.artworkVisible('d'.repeat(40) + '.png', s.policy.policy())).toBe(false);
  });

  it('detects duplicates by URL and by normalised title within a source', () => {
    const s = services(db);
    const src = s.sources.add('https://games.test/');
    const a = s.catalog.upsertListing(src.id, { pageUrl: 'https://games.test/x', title: 'Game X', titleKey: 'game x' });
    const b = s.catalog.upsertListing(src.id, { pageUrl: 'https://games.test/x', title: 'Game X', titleKey: 'game x' });
    const c = s.catalog.upsertListing(src.id, { pageUrl: 'https://games.test/x?ref=feed', title: 'Game X (v2)', titleKey: 'game x' });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(c.id).toBe(a.id);
  });
});
