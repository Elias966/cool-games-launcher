// Leaving the Store must stop AI work immediately and discard late results.
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoreSession, StaleResultError } from '../src/main/store-session';
import { AiService, CLASSIFIER_VERSION } from '../src/main/ai';
import { Discovery } from '../src/main/discovery';
import { fixtureAgent } from './helpers/fixture-agent';
import { openDb } from '../src/main/db';
import { AiCacheRepo, CatalogRepo, ConsentRepo, SettingsRepo, SourcesRepo, defaultSettings } from '../src/main/repos';
import { PolicyService } from '../src/main/policy-service';
import { HostRateLimiter } from '../src/main/rate-limit';
import type { PageExtract } from '@shared/page-extract';

/** Worker stub whose chat answers arrive after a delay and ignore cancellation (worst case). */
class SlowWorker extends EventEmitter {
  calls: string[] = [];
  aborted = 0;
  call(method: string, _params: unknown, signal?: AbortSignal) {
    this.calls.push(method);
    signal?.addEventListener('abort', () => this.aborted++);
    return new Promise((resolve) => setTimeout(() => resolve({ content: '{"games":[{"link":0,"title":"Late"}],"next":null}' }), 80));
  }
}

function page(url: string, links: number): PageExtract {
  return {
    url,
    title: 'Unfamiliar site',
    site: null,
    meta: {},
    jsonLd: [],
    cards: [],
    cardConfidence: 0,
    nextPage: null,
    game: null,
    controls: [],
    links: Array.from({ length: links }, (_, i) => ({ i, href: `https://odd.test/item/${i}`, text: `Item ${i}`, img: null, rect: { x: 0, y: 0, w: 10, h: 10 }, download: false })),
    fileLinks: [],
    gates: { login: false, captcha: false, payment: false, ageGate: false, blocked: false },
    adultSignals: [],
    text: '',
    media: [],
    viewport: { w: 1280, h: 800, scrollY: 0, docH: 800 },
  };
}

describe('StoreSession', () => {
  it('invalidates tokens when the Store is left', () => {
    const s = new StoreSession();
    const t = s.enter();
    expect(s.isLive(t)).toBe(true);
    s.leave();
    expect(s.isLive(t)).toBe(false);
    expect(t.signal.aborted).toBe(true);
    expect(() => s.assertLive(t)).toThrow(StaleResultError);
    const t2 = s.enter();
    expect(t2.epoch).toBeGreaterThan(t.epoch);
    expect(s.isLive(t)).toBe(false);
  });
});

describe('AI calls', () => {
  it('cancels inference and drops the answer when the Store is left mid-request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-test-'));
    const db = openDb(join(dir, 'x.db'));
    try {
      const session = new StoreSession();
      const worker = new SlowWorker();
      const ai = new AiService(worker as never, session, new AiCacheRepo(db));
      const token = session.enter();
      const pending = ai.chatJson(token, { system: 's', user: 'u', schema: {} });
      setTimeout(() => session.leave(), 10);
      await expect(pending).rejects.toBeInstanceOf(StaleResultError);
      expect(worker.aborted).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to start AI work outside the Store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-test-'));
    const db = openDb(join(dir, 'x.db'));
    try {
      const session = new StoreSession();
      const worker = new SlowWorker();
      const ai = new AiService(worker as never, session, new AiCacheRepo(db));
      const token = session.enter();
      session.leave();
      await expect(ai.chatJson(token, { system: 's', user: 'u', schema: {} })).rejects.toBeInstanceOf(StaleResultError);
      expect(worker.calls).toHaveLength(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Discovery', () => {
  it('cancels AI without stopping a live website check during human handoff', () => {
    const session = new StoreSession(), token = session.enter(), stopLoading = vi.fn();
    new Discovery({ session, agent: fixtureAgent(), browser: {stopLoading} } as never);
    session.leave({preserveBrowser:true});
    expect(token.signal.aborted).toBe(true);
    expect(stopLoading).not.toHaveBeenCalled();
    const ordinary = new StoreSession(); ordinary.enter();
    new Discovery({ session:ordinary, agent:fixtureAgent(), browser:{stopLoading} } as never);
    ordinary.leave();
    expect(stopLoading).toHaveBeenCalledWith('discovery');
  });

  it('applies the agent decision before artwork classification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-test-'));
    const db = openDb(join(dir, 'x.db'));
    const session = new StoreSession();
    try {
      const settings = new SettingsRepo(db, defaultSettings({ games: dir, downloads: dir }));
      const sources = new SourcesRepo(db);
      const catalog = new CatalogRepo(db);
      const policy = new PolicyService(settings, new ConsentRepo(db));
      const worker = new SlowWorker();
      const ai = new AiService(worker as never, session, new AiCacheRepo(db));
      const ex = page('https://odd.test/orbit', 0);
      ex.game = { title: 'Orbit', description: 'A space puzzle', cover: null, screenshots: [], platforms: ['linux'], tags: ['space'], categories: ['Puzzle'], author: null, price: 'Free', uploads: [] };
      ex.links = [{ i: 0, href: 'https://files.test/orbit-linux.zip', text: 'Download Linux build', img: null, rect: { x: 0, y: 0, w: 10, h: 10 }, download: true, inContent: true }];
      ex.fileLinks = ex.links;
      const source = sources.add(ex.url);
      sources.update(source.id, { rateLimitMs: 0 });
      const token = session.enter();
      const discovery = new Discovery({ agent: fixtureAgent(), sources, catalog, settings, session, ai, classification: { classifyEntry: async (id: number) => catalog.setRating(id, 'safe', 0, [], CLASSIFIER_VERSION) } as never, browser: { navigate: async () => ({}), extract: async () => ex, stopLoading: async () => undefined } as never, limiter: new HostRateLimiter(), policy });
      await (discovery as any).crawlSource(sources.get(source.id), token);
      expect(worker.calls).toEqual([]);
      expect(catalog.query(policy.policy(), {}).entries.map((e) => e.title)).toEqual(['Orbit']);
    } finally {
      session.leave();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an article hidden when the agent finds no playable download', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-test-'));
    const db = openDb(join(dir, 'x.db'));
    const session = new StoreSession();
    try {
      const settings = new SettingsRepo(db, defaultSettings({ games: dir, downloads: dir }));
      const sources = new SourcesRepo(db);
      const catalog = new CatalogRepo(db);
      const policy = new PolicyService(settings, new ConsentRepo(db));
      const worker = new SlowWorker();
      const ai = new AiService(worker as never, session, new AiCacheRepo(db));
      const listing = page('https://odd.test/', 0);
      listing.cardConfidence = 1;
      listing.cards = [{ href: 'https://odd.test/article', title: 'An article', img: 'https://odd.test/art.jpg', text: '', platforms: [], price: null, author: null, tags: [] }];
      let current = listing.url;
      const events: string[] = [];
      const source = sources.add(listing.url);
      sources.update(source.id, { rateLimitMs: 0 });
      const token = session.enter();
      const discovery = new Discovery({ agent: fixtureAgent(), sources, catalog, settings, session, ai, classification: { classifyEntry: async () => events.push('classify') } as never,
        browser: { navigate: async (_ctx: string, url: string) => { current = url; events.push(url); }, extract: async () => current === listing.url ? listing : page(current, 0), stopLoading: async () => undefined } as never, limiter: new HostRateLimiter(), policy });
      await (discovery as any).crawlSource(sources.get(source.id), token);
      // The AI-confirmed card gets its cover checked right away; the detail
      // visit then finds no download route and hides it for good.
      expect(events).toEqual([listing.url, 'classify', 'https://odd.test/article']);
      expect(worker.calls).toEqual([]);
      expect(catalog.query(policy.policy(), {}).total).toBe(0);
      expect(catalog.raw(catalog.query({ ...policy.policy(), showNsfw: true } as never, {}).entries[0]?.id ?? 1)?.downloadStatus).toBe('unavailable');
    } finally {
      session.leave(); db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pauses on a human verification gate and does not recrawl a blocked checkpoint until retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-test-'));
    const db = openDb(join(dir, 'x.db'));
    const session = new StoreSession();
    vi.useFakeTimers();
    try {
      const settings = new SettingsRepo(db, defaultSettings({ games: dir, downloads: dir }));
      const sources = new SourcesRepo(db);
      const catalog = new CatalogRepo(db);
      const policy = new PolicyService(settings, new ConsentRepo(db));
      const ai = new AiService(new SlowWorker() as never, session, new AiCacheRepo(db));
      const ex = page('https://odd.test/', 0);
      ex.gates.captcha = true;
      const source = sources.add(ex.url);
      sources.update(source.id, { rateLimitMs: 0 });
      const token = session.enter();
      const handoff = vi.fn();
      const navigate = vi.fn(async () => undefined);
      const discovery = new Discovery({ agent: fixtureAgent(), sources, catalog, settings, session, ai, classification: {} as never, browser: { navigate, extract: async () => ex, stopLoading: async () => undefined } as never, limiter: new HostRateLimiter(), policy, onVerificationRequired: handoff });
      const crawl = (discovery as any).crawlSource(sources.get(source.id), token);
      await vi.runAllTimersAsync();
      await crawl;
      expect(handoff).toHaveBeenCalledOnce();
      expect(sources.get(source.id)?.status).toBe('blocked');
      expect(sources.cursor(source.id)).not.toBeNull();
      expect((discovery as any).pickSource()).toBeNull();
      expect(await (discovery as any).detailBacklog(token)).toBe(false);
      expect(navigate).toHaveBeenCalledOnce();
      discovery.recrawl(source.id);
      expect((discovery as any).pickSource()?.id).toBe(source.id);
    } finally {
      session.leave(); vi.useRealTimers(); db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skipping a human check sets the gated page aside and indexing continues with the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-test-'));
    const db = openDb(join(dir, 'x.db'));
    const session = new StoreSession();
    vi.useFakeTimers();
    try {
      const settings = new SettingsRepo(db, defaultSettings({ games: dir, downloads: dir }));
      const sources = new SourcesRepo(db);
      const catalog = new CatalogRepo(db);
      const policy = new PolicyService(settings, new ConsentRepo(db));
      const ai = new AiService(new SlowWorker() as never, session, new AiCacheRepo(db));
      const ex = page('https://odd.test/', 0);
      ex.gates.captcha = true;
      const source = sources.add(ex.url);
      sources.update(source.id, { rateLimitMs: 0 });
      sources.saveCursor(source.id, { pending: [ex.url, 'https://odd.test/page/2'], visited: [], pagesDone: 0, startedAt: '' });
      const token = session.enter();
      const discovery = new Discovery({ agent: fixtureAgent(), sources, catalog, settings, session, ai, classification: {} as never, browser: { navigate: vi.fn(async () => undefined), extract: async () => ex, stopLoading: async () => undefined } as never, limiter: new HostRateLimiter(), policy });
      const crawl = (discovery as any).crawlSource(sources.get(source.id), token);
      await vi.runAllTimersAsync();
      await crawl;
      expect(sources.get(source.id)?.status).toBe('blocked');
      discovery.skipVerification(source.id);
      expect(sources.get(source.id)?.status).toBe('idle');
      expect(sources.cursor(source.id)?.pending).toEqual(['https://odd.test/page/2']);
      expect((discovery as any).pickSource()?.id).toBe(source.id);
    } finally {
      session.leave(); vi.useRealTimers(); db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes no further browser or AI calls and no catalog writes after leaving the Store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-test-'));
    const db = openDb(join(dir, 'x.db'));
    try {
      const settings = new SettingsRepo(db, defaultSettings({ games: dir, downloads: dir }));
      const sources = new SourcesRepo(db);
      const catalog = new CatalogRepo(db);
      const policy = new PolicyService(settings, new ConsentRepo(db));
      const session = new StoreSession();
      const worker = new SlowWorker();
      const ai = new AiService(worker as never, session, new AiCacheRepo(db));
      const browserCalls: string[] = [];
      const browser = {
        navigate: async (_c: string, url: string) => {
          browserCalls.push(`navigate ${url}`);
          return { url, title: '' };
        },
        extract: async () => {
          browserCalls.push('extract');
          return page('https://odd.test/list', 6);
        },
        snapshot: async () => {
          browserCalls.push('snapshot');
          return { png: '', url: '', title: '', loading: false, dpr: 1, w: 1, h: 1, media: [], adultSignals: [] };
        },
        stopLoading: async () => browserCalls.push('stopLoading'),
      };
      const classification = { classifyEntry: async () => 'safe' };
      sources.add('https://odd.test/list');
      const discovery = new Discovery({ sources, catalog, settings, session, ai, classification: classification as never, browser: browser as never, limiter: new HostRateLimiter(), policy });
      void discovery;

      session.enter();
      // Wait until the AI request is in flight, then leave the Store.
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (worker.calls.includes('chat')) {
            clearInterval(t);
            resolve();
          }
        }, 2);
      });
      const callsAtLeave = browserCalls.length;
      session.leave();
      await new Promise((r) => setTimeout(r, 300)); // the late AI answer arrives in the meantime

      expect(catalog.count(1)).toBe(0); // the late answer was not written
      expect(browserCalls.slice(callsAtLeave).filter((c) => c !== 'stopLoading')).toEqual([]);
      expect(worker.calls.filter((c) => c === 'chat')).toHaveLength(1);
      expect(sources.cursor(1)).not.toBeNull(); // checkpoint kept for resumption
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
