// The cover filter: games whose cover shows a woman as the main subject are hidden
// while it is on; covers not looked at yet wait hidden; the local AI checks them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/main/db';
import { CatalogRepo, ConsentRepo, SettingsRepo, SourcesRepo, defaultSettings } from '../src/main/repos';
import { PolicyService } from '../src/main/policy-service';
import { CoverCheckService } from '../src/main/cover-check';

let dir: string;
let db: Db;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cgl-covers-')); db = openDb(join(dir, 'launcher.db')); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const settings = new SettingsRepo(db, defaultSettings({ games: '/tmp/g', downloads: '/tmp/d' }));
  const policy = new PolicyService(settings, new ConsentRepo(db));
  const catalog = new CatalogRepo(db);
  const src = new SourcesRepo(db).add('https://games.test/browse');
  const art = join(dir, 'art');
  mkdirSync(art);
  const mk = (title: string) => {
    const id = catalog.upsertListing(src.id, { pageUrl: `https://games.test/${title}`, title, titleKey: title }).id;
    catalog.setDetail(id, { candidates: [{ url: `https://games.test/${title}.zip`, label: 'Download game', fileName: `${title}.zip`, platform: 'linux', sizeText: null }] });
    catalog.setRating(id, 'safe', 0.01, [], 'v1');
    const file = `${title}.png`;
    writeFileSync(join(art, file), 'png');
    catalog.setArtwork(id, file);
    return id;
  };
  return { settings, policy, catalog, art, mk };
}

const titles = (catalog: CatalogRepo, policy: PolicyService) => catalog.query(policy.policy(), { sort: 'title' }).entries.map((e) => e.title);

describe('cover filter', () => {
  it('hides women covers and unchecked covers only while it is on, and bumps the policy', () => {
    const { policy, catalog, mk } = setup();
    const heroine = mk('heroine'), racer = mk('racer');
    mk('unchecked');
    catalog.setCoverWoman(heroine, true);
    catalog.setCoverWoman(racer, false);
    expect(titles(catalog, policy)).toEqual(['heroine', 'racer', 'unchecked']);
    const before = policy.policy().revision;
    policy.setHideWomenCovers(true);
    expect(policy.policy().revision).toBe(before + 1);
    expect(titles(catalog, policy)).toEqual(['racer']);
    expect(catalog.get(heroine, policy.policy())).toBeNull();
    expect(catalog.hiddenIds(policy.policy())).toContain(heroine);
    expect(catalog.artworkVisible('heroine.png', policy.policy())).toBe(false);
    expect(catalog.artworkVisible('racer.png', policy.policy())).toBe(true);
    expect(catalog.coverCounts()).toEqual({ checked: 2, women: 1, pending: 1 });
    policy.setHideWomenCovers(false);
    expect(titles(catalog, policy)).toEqual(['heroine', 'racer', 'unchecked']);
  });

  it('checks every waiting cover with the local AI once the filter is on, and retries a failing one only three times', async () => {
    const { settings, policy, catalog, art, mk } = setup();
    const heroine = mk('heroine'), racer = mk('racer'), broken = mk('broken');
    const session = Object.assign(new EventEmitter(), { token: () => ({ epoch: 1, signal: new AbortController().signal }) });
    const asked: string[] = [];
    const ai = { coverJpeg: vi.fn(async () => 'anBn'), chatJson: vi.fn(async (_t: unknown, req: { cacheKey: string; user: Array<{ type: string; image_url?: { url: string } }> }) => {
      asked.push(req.cacheKey);
      expect(req.user[0].image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
      if (req.cacheKey.includes('broken')) throw new Error('model error');
      const woman = req.cacheKey.includes('heroine');
      return { mainSubject: woman ? 'a woman with a sword' : 'a race car', woman };
    }) };
    const changed = vi.fn();
    const covers = new CoverCheckService({ ai: ai as never, artwork: { path: (f: string) => join(art, f), fetch: vi.fn() } as never, catalog, settings, session: session as never, changed, pendingChanged: vi.fn() });

    covers.poke();
    await new Promise((r) => setTimeout(r, 20));
    expect(ai.chatJson).not.toHaveBeenCalled(); // the filter is off: nothing is checked

    policy.setHideWomenCovers(true);
    expect(covers.pending()).toBe(3);
    covers.poke();
    await vi.waitFor(() => expect(catalog.coverCounts()).toEqual({ checked: 2, women: 1, pending: 1 }));
    await vi.waitFor(() => expect(covers.pending()).toBe(0)); // the broken cover was given up for this run
    expect(asked.filter((k) => k.includes('broken'))).toHaveLength(3);
    expect(titles(catalog, policy)).toEqual(['racer']);
    expect(changed).toHaveBeenCalled();
    expect([heroine, racer, broken]).toHaveLength(3);
  });
});
