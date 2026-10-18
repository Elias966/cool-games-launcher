// The cover filter: games whose cover likely shows a woman are hidden while it
// is on; covers not scored yet wait hidden; an image model scores them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/main/db';
import { CatalogRepo, ConsentRepo, SettingsRepo, SourcesRepo, ImageClassRepo, defaultSettings } from '../src/main/repos';
import { PolicyService } from '../src/main/policy-service';
import { CoverCheckService } from '../src/main/cover-check';
import { CoverModel } from '../src/main/cover-model';
import { womanScore } from '../src/workers/cover-score';
import prompts from '../src/workers/cover-prompts.json';
import { ClassificationService } from '../src/main/classification';
import { CLASSIFIER_VERSION } from '../src/main/ai';

let dir: string;
let db: Db;
const services: CoverCheckService[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cgl-covers-')); db = openDb(join(dir, 'launcher.db')); });
afterEach(() => { services.splice(0).forEach((s) => s.stop()); db.close(); rmSync(dir, { recursive: true, force: true }); });

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

    services.push(covers);
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


describe('cover queue latency and recovery', () => {
  function service(s: ReturnType<typeof setup>, ai: { coverScore: ReturnType<typeof vi.fn> }, fetch = vi.fn()) {
    const changed = vi.fn();
    const ensure = vi.fn(async () => undefined);
    const covers = new CoverCheckService({ ai: ai as never, artwork: { path: (f: string) => join(s.art, f), fetch } as never,
      catalog: s.catalog, settings: s.settings, model: { path: '/model.onnx', ensure } as never, changed });
    services.push(covers);
    return { covers, changed, ensure };
  }

  it('keeps scoring and publishing fast covers while the first host is stalled, with bounded concurrency', async () => {
    const s = setup();
    const slow = s.mk('slow');
    s.catalog.setArtwork(slow, null);
    s.catalog.setDetail(slow, { thumbnailUrl: 'https://slow.test/cover.jpg', downloadStatus: 'available' });
    db.prepare('UPDATE catalog SET pop_score = 100 WHERE id = ?').run(slow);
    for (let i = 0; i < 120; i++) s.mk('fast' + i);
    let resolve!: (f: string) => void;
    const fetch = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    let active = 0, peak = 0;
    const ai = { coverScore: vi.fn(async () => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 1)); active--; return 0.03; }) };
    const { covers, changed } = service(s, ai, fetch);
    s.policy.setHideWomenCovers(true); covers.poke();
    try {
      await vi.waitFor(() => expect(s.catalog.coverCounts().checked).toBe(120));
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 600 });
      expect(s.catalog.coverCounts().pending).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(peak).toBeLessThanOrEqual(8);
      s.mk('late-arrival');
      await vi.waitFor(() => expect(s.catalog.coverCounts().checked).toBe(121));
      expect(s.catalog.coverCounts().pending).toBe(1);
    } finally { resolve('fast0.png'); }
    await vi.waitFor(() => expect(s.catalog.coverCounts().checked).toBe(122));
    expect(s.catalog.raw(slow)?.artworkFile).toBe('fast0.png');
  });

  it('checks newly eligible games immediately and reuses persisted scores after toggling', async () => {
    const s = setup(); s.mk('first');
    const ai = { coverScore: vi.fn(async () => 0.03) };
    const { covers, ensure } = service(s, ai);
    s.policy.setHideWomenCovers(true); covers.poke();
    await vi.waitFor(() => expect(s.catalog.coverCounts().checked).toBe(1));
    s.mk('new'); // no explicit poke, Store switch or minute-long timer
    await vi.waitFor(() => expect(s.catalog.coverCounts().checked).toBe(2));
    expect(ai.coverScore).toHaveBeenCalledTimes(2);
    s.policy.setHideWomenCovers(false); covers.poke();
    s.policy.setHideWomenCovers(true); covers.poke();
    await new Promise(r => setTimeout(r, 20));
    expect(ai.coverScore).toHaveBeenCalledTimes(2);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('redownloads a missing cached image and never marks failed/nonfinite scores as checked', async () => {
    const s = setup(), id = s.mk('missing');
    unlinkSync(join(s.art, 'missing.png'));
    s.catalog.setDetail(id, { thumbnailUrl: 'https://games.test/missing.png', downloadStatus: 'available' });
    writeFileSync(join(s.art, 'fresh.png'), 'png');
    const fetch = vi.fn(async () => 'fresh.png');
    const ai = { coverScore: vi.fn(async () => NaN) };
    const { covers } = service(s, ai, fetch);
    s.policy.setHideWomenCovers(true); covers.poke();
    await vi.waitFor(() => expect(covers.failed()).toBe(1));
    expect(s.catalog.coverCounts()).toEqual({ checked: 0, women: 0, pending: 1 });
    expect(() => s.catalog.setCoverScore(id, NaN)).toThrow('Invalid cover score');
    expect(titles(s.catalog, s.policy)).toEqual([]);
    ai.coverScore.mockResolvedValue(0.03);
    s.catalog.setArtwork(id, 'fresh.png');
    await vi.waitFor(() => expect(s.catalog.coverCounts().checked).toBe(1));
    expect(covers.failed()).toBe(0);
    expect(fetch).toHaveBeenCalled();
  });

  it('cancels in-flight work when disabled and stops listening before database shutdown', async () => {
    const s = setup(); s.mk('pending');
    let signal: AbortSignal | undefined;
    const ai = { coverScore: vi.fn((_m: string, _f: string, sig: AbortSignal) => { signal = sig; return new Promise<number>((_r,j) => sig.addEventListener('abort', () => j(sig.reason), { once: true })); }) };
    const { covers, changed } = service(s, ai);
    s.policy.setHideWomenCovers(true); covers.poke();
    await vi.waitFor(() => expect(signal).toBeDefined());
    s.policy.setHideWomenCovers(false); covers.poke();
    expect(signal?.aborted).toBe(true);
    covers.stop(); s.mk('after-stop');
    await new Promise(r => setTimeout(r, 20));
    expect(ai.coverScore).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  });
});


describe('website image verification retry budget', () => {
  it('does not retry one broken cover hundreds of times; refreshing the page allows a new check', async () => {
    const s = setup(), id = s.mk('Mortal Kombat');
    s.catalog.setDetail(id, { thumbnailUrl: 'https://games.test/cover.jpg', downloadStatus: 'available' });
    s.catalog.invalidateRating(id);
    const fetch = vi.fn(async () => { throw Error('Image HTTP 404'); });
    const ai = { classify: vi.fn(async () => [0.01]) };
    const classification = new ClassificationService(ai as never, { fileFor: () => null, fetch, path: (f: string) => join(s.art, f) } as never, s.catalog, new ImageClassRepo(db));
    for (let i = 0; i < 30; i++) await classification.classifyEntry(id);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(s.catalog.raw(id)?.classifyAttempts).toBe(4);
    expect(s.catalog.raw(id)?.rating).toBe('unknown');
    expect(s.catalog.raw(id)?.classifierVersion).toBe(CLASSIFIER_VERSION);
    s.catalog.invalidateRating(id);
    fetch.mockImplementation(async () => 'fresh.png' as never);
    await classification.classifyEntry(id);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(ai.classify).toHaveBeenCalledTimes(1);
    expect(s.catalog.raw(id)?.rating).toBe('safe');
  });
});


describe('cover score identity', () => {
  it('keeps the score for unchanged artwork and rechecks a replacement', () => {
    const s = setup(), id = s.mk('Orbit');
    s.catalog.setCoverScore(id, 0.03);
    s.catalog.setArtwork(id, 'Orbit.png');
    expect(s.catalog.coverCounts().checked).toBe(1);
    s.catalog.setArtwork(id, 'replacement.png');
    expect(s.catalog.coverCounts().pending).toBe(1);
    s.catalog.setCoverScore(id, 0.9);
    s.catalog.setDetail(id, { thumbnailUrl: 'https://games.test/new-cover.jpg', downloadStatus: 'available' });
    expect(s.catalog.coverCounts().pending).toBe(1);
    expect(s.catalog.raw(id)?.artworkFile).toBeNull();
  });

  it('repairs old unverified flag covers once, retaining verified artwork and unavailable entries', () => {
    const s = setup(), broken = s.mk('broken'), verified = s.mk('verified'), unavailable = s.mk('unavailable');
    for (const id of [broken, verified, unavailable]) s.catalog.setDetail(id, { thumbnailUrl: 'https://games.test/static/img/flags/pt.svg', downloadStatus: 'available' });
    s.catalog.setRating(broken, 'unknown', 0, [], CLASSIFIER_VERSION);
    s.catalog.setRating(unavailable, 'unknown', 0, [], CLASSIFIER_VERSION);
    s.catalog.setDetail(unavailable, { downloadStatus: 'unavailable' });
    db.prepare('UPDATE catalog SET classify_attempts = 912 WHERE id = ?').run(broken);
    expect(s.catalog.repairDecorativeCovers()).toBe(1);
    expect(s.catalog.raw(broken)).toMatchObject({ thumbnailUrl: null, artworkFile: null, detailFetchedAt: null, classifyAttempts: 0 });
    expect(s.catalog.raw(verified)?.thumbnailUrl).toContain('/flags/');
    expect(s.catalog.raw(unavailable)?.downloadStatus).toBe('unavailable');
    expect(s.catalog.repairDecorativeCovers()).toBe(0);
  });
});

describe('old language-switch listings', () => {
  it('retires a switch endpoint without navigating it, even if an earlier repair cleared its flag URL', () => {
    const s = setup(), src = new SourcesRepo(db).list()[0];
    const id = s.catalog.upsertListing(src.id, { pageUrl: 'https://games.test/lang/pt', title: 'Mortal Kombat 1', titleKey: 'bad-language' }).id;
    s.catalog.setDetail(id, { downloadStatus: 'available' });
    db.prepare('UPDATE catalog SET detail_fetched_at = NULL WHERE id = ?').run(id);
    expect(s.catalog.repairDecorativeCovers()).toBe(1);
    expect(s.catalog.raw(id)?.downloadStatus).toBe('unavailable');
    expect(s.catalog.needingDetail(src.id, s.policy.policy(), 20).some(e => e.id === id)).toBe(false);
    expect(s.catalog.repairDecorativeCovers()).toBe(0);
    expect(s.catalog.raw(id)?.title).toBe('Mortal Kombat 1');
  });
});
