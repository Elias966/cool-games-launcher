import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractPage, type PageExtract } from '@shared/page-extract';
import { downloadEvidence, isHostLanding } from '@shared/download-evidence';
import { LocalGameAgent } from '../src/main/game-agent';
import { fixtureAgent } from './helpers/fixture-agent';
import { Discovery } from '../src/main/discovery';
import { StoreSession } from '../src/main/store-session';
import { openDb } from '../src/main/db';
import { CatalogRepo, ConsentRepo, DownloadsRepo, SettingsRepo, SourcesRepo, defaultSettings } from '../src/main/repos';
import { PolicyService } from '../src/main/policy-service';
import { HostRateLimiter } from '../src/main/rate-limit';
import { CLASSIFIER_VERSION } from '../src/main/ai';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((f) => f()); vi.useRealTimers(); });
function page(html: string, url = 'https://games.test/drapline-free-download/') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  cleanup.push(() => dom.window.close());
  return dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;
}

describe('selected-game resolution', () => {
  it('asks the local model even when a familiar download control exists', async () => {
    const ex = page('<main><a href="/drift21-free-download-1t/">DRIFT21 Free Download</a><a href="https://uploadhaven.com/download/abc">UploadHaven</a></main>');
    const chosen = ex.controls.find(c => c.text === 'UploadHaven')!;
    const chatJson = vi.fn(async () => ({action:'click',element:chosen.i,reason:'Selected game host'}));
    const session = new StoreSession(); const token = session.enter();
    const agent = new LocalGameAgent({chatJson,setStatus:vi.fn()} as never, {snapshot:async()=>({png:''})} as never, session);
    expect((await agent.transfer(ex,token,'DRAPLINE',[],[])).index).toBe(chosen.i);
    expect(chatJson).toHaveBeenCalledOnce(); session.leave();
  });

  it('rejects a model decision to follow another game rather than silently substituting automation', async () => {
    const ex = page('<main><a href="/drift21-free-download-1t/">DRIFT21 Free Download</a></main>');
    const session = new StoreSession(); const token = session.enter();
    const agent = new LocalGameAgent({chatJson:async()=>({action:'click',element:ex.controls[0].i,reason:'wrong game'}),setStatus:vi.fn()} as never, {snapshot:async()=>({png:''})} as never, session);
    await expect(agent.transfer(ex,token,'DRAPLINE',[],[])).rejects.toThrow('unavailable or unrelated'); session.leave();
  });

  it('accepts Manual Download as a file action while excluding a downloadable instruction manual', () => {
    const ex = page('<main><a href="/orbit.zip">Manual Download</a><a href="/instructions.zip">Download Manual</a></main>');
    expect(downloadEvidence(ex).map((c) => c.url)).toEqual(['https://games.test/orbit.zip']);
  });

  it('recognizes HTMX file-host controls without href and excludes copy-link actions', () => {
    const ex = page('<main><a hx-get="/file/download?t=observed-token">Download File <span>546.8MB</span></a><a onclick="copyDownloadLink()">Copy download link</a><a data-hx-get="/file/download?alt=true">Slow? Try mirror 2</a></main>', 'https://bzzhr.to/file');
    expect(downloadEvidence(ex).map((c) => c.label)).toEqual(['Download File 546.8MB', 'Slow? Try mirror 2']);
    expect(ex.controls.find((c) => c.text.startsWith('Download File'))?.href).toBeNull();
  });

  it('does not treat file-host pricing and navigation as a file landing page', async () => {
    expect(isHostLanding('https://bzzhr.to/2lztdg6cs7ph')).toBe(true);
    expect(isHostLanding('https://bzzhr.to/pricing')).toBe(false);
    expect(isHostLanding('https://bzzhr.to/developers')).toBe(false);
    const ex = page('<a href="/pricing">Pricing</a><a href="/blog">Blog</a><a href="/help">Help</a><a href="?lang=en">En</a>', 'https://bzzhr.to/2lztdg6cs7ph');
    expect(downloadEvidence(ex)).toEqual([]);

  });
});

describe('website verification recovery', () => {
  it('ignores hidden or successfully answered challenge widgets retained on a game page', () => {
    expect(page('<main><h1>Orbit</h1><a href="/orbit.zip">Download</a></main><div class="cf-turnstile" style="display:none"></div>').gates.captcha).toBe(false);
    expect(page('<main><h1>Orbit</h1><a href="/orbit.zip">Download</a></main><div class="cf-turnstile"><input name="cf-turnstile-response" value="user-supplied-response"></div>').gates.captcha).toBe(false);
    expect(page('<title>Just a moment</title><form id="challenge-form"><p>Verify you are human</p></form>').gates.captcha).toBe(true);
  });

  it('resumes a solved listing gate and adds games without resetting the crawl', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'cgl-recovery-')); const db = openDb(join(dir, 'x.db'));
    const session = new StoreSession();
    cleanup.push(() => { session.leave(); db.close(); rmSync(dir, { recursive: true, force: true }); });
    const settings = new SettingsRepo(db, defaultSettings({ games: dir, downloads: dir }));
    const sources = new SourcesRepo(db); const catalog = new CatalogRepo(db); const policy = new PolicyService(settings, new ConsentRepo(db));
    const source = sources.add('https://games.test/'); sources.update(source.id, { rateLimitMs: 0 });
    let solved = false, current = source.url;
    const gate = page('<title>Just a moment</title><form id="challenge-form">Verify you are human</form>', source.url);
    gate.gates.blocked = true;
    const listing = page('<main>'+[1,2,3].map((n) => `<article><h2><a href="/orbit-${n}">Orbit ${n}</a></h2><img src="/cover.png"></article>`).join('')+'</main>', source.url);
    const browser = { navigate: vi.fn(async (_: string, url: string) => { current = url; }), extract: vi.fn(async () => !solved ? gate : current === source.url ? listing : page('<script type="application/ld+json">{"@type":"VideoGame","name":"Orbit"}</script><main><a href="/orbit.zip">Download</a></main>', current)), stopLoading: async () => {} };
    const handoff = vi.fn();
    const ai = { setStatus: vi.fn(), chatJson: vi.fn(async () => { throw new Error('Unexpected model call'); }) };
    const discovery = new Discovery({ agent: fixtureAgent(), sources, catalog, settings, session, browser, ai, classification: { classifyEntry: async (id: number) => catalog.setRating(id, 'safe', 0, [], CLASSIFIER_VERSION) }, limiter: new HostRateLimiter(), policy, onVerificationRequired: handoff } as never);
    session.enter(); await vi.advanceTimersByTimeAsync(100);
    expect(sources.get(source.id)?.status).toBe('blocked'); expect(handoff).toHaveBeenCalledOnce();
    solved = true;
    // While direct Firefox owns the profile, no discovery polling may run.
    session.leave(); await vi.advanceTimersByTimeAsync(100);
    const readsAtLeave = browser.extract.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(browser.extract).toHaveBeenCalledTimes(readsAtLeave);
    // Models closing the full Firefox window after the human verified it.
    session.enter();
    await vi.advanceTimersByTimeAsync(6000);
    expect(catalog.query(policy.policy(), {}).total).toBe(3);
    expect(sources.get(source.id)?.status).toBe('ok');
    expect(browser.navigate.mock.calls.filter(([,url]) => url === source.url)).toHaveLength(1);
    session.leave(); await vi.advanceTimersByTimeAsync(100);
    void discovery;
  });
});


describe('continued indexing', () => {
  it('keeps pagination past the batch limit and resumes after leaving Store', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'cgl-pages-')); const db = openDb(join(dir, 'x.db')); const session = new StoreSession();
    cleanup.push(() => { session.leave(); db.close(); rmSync(dir, { recursive: true, force: true }); });
    const settings = new SettingsRepo(db, defaultSettings({ games: dir, downloads: dir }));
    const sources = new SourcesRepo(db); const catalog = new CatalogRepo(db); const policy = new PolicyService(settings, new ConsentRepo(db));
    const source = sources.add('https://games.test/'); sources.update(source.id, { rateLimitMs: 0, maxPages: 1 });
    const listing = (n: number) => page('<main>'+[1,2,3].map((i) => `<article><h2><a href="/orbit-${n}-${i}">Orbit ${n}-${i}</a></h2><img src="/cover.png"></article>`).join('')+(n===1?'<a class="next page-numbers" href="/page/2">Next →</a><a href="/category/puzzle/">Puzzle</a>':'')+'</main>', n===1?source.url:n===2?'https://games.test/page/2':'https://games.test/category/puzzle/');
    let current = source.url;
    const navigate = vi.fn(async (_: string, url: string) => { current = url; });
    const discovery = new Discovery({ agent: fixtureAgent(), sources, catalog, settings, session, browser: { navigate, extract: async () => current===source.url?listing(1):current.endsWith('/page/2')?listing(2):current.includes('/category/')?listing(3):page('<script type="application/ld+json">{"@type":"VideoGame","name":"Orbit"}</script><a href="/orbit.zip">Download</a>', current), stopLoading: async () => {} }, ai: { setStatus: () => {}, chatJson: async () => { throw new Error('Unexpected model call'); } }, classification: { classifyEntry: async (id: number) => catalog.setRating(id, 'safe', 0, [], CLASSIFIER_VERSION) }, limiter: new HostRateLimiter(), policy } as never);
    // Exercise each bounded batch directly, with session lifecycle checks.
    session.removeAllListeners('enter');
    const t = session.enter();
    await (discovery as any).crawlSource(sources.get(source.id), t);
    expect(catalog.query(policy.policy(), {}).total).toBe(3);
    expect(sources.cursor(source.id)?.pending).toEqual(['https://games.test/page/2', 'https://games.test/category/puzzle']);
    session.leave(); const resumed = session.enter();
    await (discovery as any).crawlSource(sources.get(source.id), resumed);
    expect(catalog.query(policy.policy(), {}).total).toBe(6);
    expect(sources.cursor(source.id)?.pending).toEqual(['https://games.test/category/puzzle']);
    await (discovery as any).crawlSource(sources.get(source.id), resumed);
    expect(catalog.query(policy.policy(), {}).total).toBe(9);
    expect(sources.cursor(source.id)).toBeNull();
    expect(navigate.mock.calls.filter(([, url]) => url === source.url)).toHaveLength(1);
  });

  it('upgrade requeues old completed crawls without hiding verified catalog entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-upgrade-')); const file = join(dir, 'x.db');
    let db = openDb(file);
    const sources = new SourcesRepo(db); const catalog = new CatalogRepo(db);
    const source = sources.add('https://games.test/'); sources.markCrawled(source.id); sources.setStatus(source.id, 'ok', '3 games ready');
    const id = catalog.upsertListing(source.id, { pageUrl: 'https://games.test/orbit', title: 'Orbit', titleKey: 'orbit' }).id;
    catalog.setDetail(id, { candidates: [{ url: 'https://files.test/orbit.zip', label: 'Download', fileName: 'orbit.zip', platform: 'linux', sizeText: null }] }); catalog.setRating(id, 'safe', 0, [], CLASSIFIER_VERSION);
    const downloads = new DownloadsRepo(db);
    const pending = downloads.create({ catalogId: id, title: 'Orbit', sourceHost: 'games.test', state: 'needs-user' });
    downloads.update(pending.id, { resolution: { pageUrl: 'https://games.test/unrelated-game', steps: 5, history: [] }, userPrompt: { kind: 'captcha', message: 'Check' } });
    db.exec('ALTER TABLE downloads DROP COLUMN preparation_json; ALTER TABLE downloads DROP COLUMN model_json; ALTER TABLE sources DROP COLUMN recipe_json; ALTER TABLE catalog DROP COLUMN version_json; ALTER TABLE catalog DROP COLUMN listing_title; ALTER TABLE games DROP COLUMN installed_version_json; ALTER TABLE games DROP COLUMN update_json; ALTER TABLE games DROP COLUMN previous_json; ALTER TABLE games DROP COLUMN update_checked_at; ALTER TABLE downloads DROP COLUMN update_game_id; ALTER TABLE catalog DROP COLUMN popularity_json; ALTER TABLE catalog DROP COLUMN published_at; ALTER TABLE catalog DROP COLUMN rank_popular; ALTER TABLE catalog DROP COLUMN rank_trending; ALTER TABLE catalog DROP COLUMN pop_score; ALTER TABLE catalog DROP COLUMN trend_score; ALTER TABLE catalog DROP COLUMN description_source; ALTER TABLE downloads DROP COLUMN group_id; ALTER TABLE downloads DROP COLUMN part_index; ALTER TABLE downloads DROP COLUMN part_total; ALTER TABLE games DROP COLUMN archive_kept; ALTER TABLE games DROP COLUMN launch_json; ALTER TABLE catalog DROP COLUMN steam_json; DROP TABLE wishlist; ALTER TABLE games DROP COLUMN redist_json; DROP TABLE play_sessions; ALTER TABLE catalog DROP COLUMN cover_woman; ALTER TABLE catalog DROP COLUMN cover_score; UPDATE schema_version SET version = 2'); db.close(); db = openDb(file);
    cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    expect(new SourcesRepo(db).get(source.id)?.lastCrawlAt).toBeNull();
    expect(new DownloadsRepo(db).get(pending.id)).toMatchObject({ state: 'needs-resolution', resolution: null, userPrompt: null, errorCode: 'interrupted' });
    expect(new CatalogRepo(db).query({ showNsfw: false, revision: 1 }, {}).total).toBe(1);
  });
});

describe('portal homepages', () => {
  it('retains multiple game-card layouts instead of only one genre section', () => {
    const ex = page('<main><section>'+[1,2,3,4,5].map(i=>`<article><h2><a href="/game-${i}-free-download/">Game ${i} Free Download</a></h2><img src="/cover-${i}.png"></article>`).join('')+'</section><section>'+[6,7,8].map(i=>`<div class="compact"><a href="/game-${i}-free-download/"><img src="/cover-${i}.png" alt="Game ${i}"><strong>2026 | 310.8 MBGame ${i}</strong></a></div>`).join('')+'</section><a href="/category/puzzle/">Puzzle</a></main>', 'https://games.test/');
    expect(new Set(ex.cards.map(c=>c.href)).size).toBe(8);
    expect(ex.cards.every(c=>!/^2026|^310/.test(c.title))).toBe(true);
    expect(ex.cards.some(c=>c.href.includes('/category/'))).toBe(false);
  });
});


it('reads illustrated download listings with a different DOM layout for every card', () => {
  const ex = page('<main><article><a href="/one-free-download"><img src="/one.png" alt="One">Build 25801659 2026 | 672.2 MB One Free Download</a></article><figure><a href="/two-free-download"><img src="/two.png">Two Free Download</a></figure><div><a href="/three-free-download"><img src="/three.png">Three Free Download</a></div></main>', 'https://games.test/');
  expect(ex.cards.map(c=>c.title).sort()).toEqual(['One', 'Three', 'Two']);
  expect(ex.cardConfidence).toBeGreaterThanOrEqual(0.8);
});
