// The cover filter: games whose cover likely shows a woman are hidden while it
// is on; covers not scored yet wait hidden; an image model scores them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/main/db';
import { CatalogRepo, ConsentRepo, SettingsRepo, SourcesRepo, defaultSettings } from '../src/main/repos';
import { PolicyService } from '../src/main/policy-service';
import { CoverCheckService } from '../src/main/cover-check';
import { CoverModel } from '../src/main/cover-model';
import { womanScore } from '../src/workers/cover-score';
import prompts from '../src/workers/cover-prompts.json';

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
  mkdirSync(art, { recursive: true });
  const mk = (title: string) => {
    const id = catalog.upsertListing(src.id, { pageUrl: `https://games.test/${title}`, title, titleKey: title }).id;
    catalog.setDetail(id, { candidates: [{ url: `https://games.test/${title}.zip`, label: 'Download game', fileName: `${title}.zip`, platform: 'linux', sizeText: null }] });
    catalog.setRating(id, 'safe', 0.01, [], 'v1');
    writeFileSync(join(art, `${title}.png`), 'png');
    catalog.setArtwork(id, `${title}.png`);
    return id;
  };
  return { settings, policy, catalog, art, mk };
}

const titles = (catalog: CatalogRepo, policy: PolicyService) => catalog.query(policy.policy(), { sort: 'title' }).entries.map((e) => e.title);

describe('cover filter visibility', () => {
  it('hides likely women covers and unscored covers only while on, at the chosen strictness', () => {
    const { settings, policy, catalog, mk } = setup();
    const heroine = mk('heroine'), cartoon = mk('cartoon'), racer = mk('racer');
    mk('unscored');
    catalog.setCoverScore(heroine, 0.9);
    catalog.setCoverScore(cartoon, 0.25);
    catalog.setCoverScore(racer, 0.02);
    expect(titles(catalog, policy)).toEqual(['cartoon', 'heroine', 'racer', 'unscored']);
    const before = policy.policy().revision;
    policy.setHideWomenCovers(true);
    expect(policy.policy().revision).toBe(before + 1);
    expect(titles(catalog, policy)).toEqual(['racer']); // strict: 0.25 is hidden too
    expect(catalog.get(heroine, policy.policy())).toBeNull();
    expect(catalog.hiddenIds(policy.policy())).toEqual(expect.arrayContaining([heroine, cartoon]));
    expect(catalog.artworkVisible('heroine.png', policy.policy())).toBe(false);
    expect(catalog.artworkVisible('racer.png', policy.policy())).toBe(true);
    expect(catalog.coverCounts(0.2)).toEqual({ checked: 3, women: 2, pending: 1 });
    settings.setCoverStrictness('balanced');
    expect(titles(catalog, policy)).toEqual(['cartoon', 'racer']);
    policy.setHideWomenCovers(false);
    expect(titles(catalog, policy)).toEqual(['cartoon', 'heroine', 'racer', 'unscored']);
  });
});

describe('cover scoring', () => {
  it('scores an image close to a "woman" description high and one close to a "monster" description low', () => {
    const woman = prompts.positiveEmbeds[2];
    const monster = prompts.negativeEmbeds[prompts.negative.findIndex((p) => p.includes('monster'))];
    expect(womanScore(woman)).toBeGreaterThan(0.5);
    expect(womanScore(monster)).toBeLessThan(0.1);
  });

  it('downloads the model once, checks its hash, and scores every waiting cover', async () => {
    const { settings, policy, catalog, art, mk } = setup();
    mk('heroine'); mk('racer'); mk('broken');
    const blob = Buffer.from('model-bytes');
    const pin = { url: 'https://huggingface.co/x/model.onnx', sha256: createHash('sha256').update(blob).digest('hex'), size: blob.length, dir: 'clip', file: 'model.onnx' };
    const fetch = vi.fn(async () => new Response(new Uint8Array(blob), { status: 200 }));
    const model = new CoverModel({ modelsDir: join(dir, 'models'), fetch, pin });
    const ai = { coverScore: vi.fn(async (_m: string, image: string) => {
      if (image.includes('broken')) throw new Error('unreadable');
      return image.includes('heroine') ? 0.8 : 0.03;
    }) };
    const covers = new CoverCheckService({ ai: ai as never, artwork: { path: (f: string) => join(art, f), fetch: vi.fn() } as never, catalog, settings, model, changed: vi.fn() });

    covers.poke();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled(); // the filter is off

    policy.setHideWomenCovers(true);
    covers.poke();
    await vi.waitFor(() => expect(catalog.coverCounts(0.2)).toEqual({ checked: 2, women: 1, pending: 1 }));
    await vi.waitFor(() => expect(covers.pending()).toBe(0)); // the unreadable cover was given up for this run
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(model.ready()).toBe(true);
    expect(ai.coverScore.mock.calls.filter(([, i]) => i.includes('broken'))).toHaveLength(3);
    expect(titles(catalog, policy)).toEqual(['racer']);
  });

  it('refuses a download that does not match its checksum and keeps nothing', async () => {
    const pin = { url: 'https://huggingface.co/x/model.onnx', sha256: 'a'.repeat(64), size: 3, dir: 'clip', file: 'model.onnx' };
    const model = new CoverModel({ modelsDir: join(dir, 'models'), fetch: async () => new Response('bad', { status: 200 }), pin });
    await expect(model.ensure()).rejects.toThrow('checksum');
    expect(model.ready()).toBe(false);
    expect(model.status().state).toBe('error');
    expect(existsSync(join(dir, 'models', 'clip', 'model.onnx'))).toBe(false);
  });
});
