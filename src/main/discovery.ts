// Website discovery. Runs only while the Store is active: crawls the user's
// sources incrementally (checkpointed). DOM extraction supplies observations;
// the local vision model chooses games, navigation and download routes.
import { canonicalUrl, hostOf, siteKey, titleKey, languageSwitchUrl } from '@shared/urls';
import { textAdultSignals } from '@shared/policy';
import { downloadEvidence } from '@shared/download-evidence';
import { catalogLinks, isListingRoute, inducePatterns, matchesAny, moreFromExamples, paginationLinks, recentListingLinks, recipeCards, recipeRoutes, ROUTES_VERSION, type SiteRecipe } from '@shared/site-recipe';
import type { PageExtract, ExtractCard } from '@shared/page-extract';
import type { Platform, Source } from '@shared/types';
import type { SourcesRepo, CatalogRepo, SettingsRepo, CrawlCursor } from './repos';
import type { StoreSession, SessionToken } from './store-session';
import type { AiService } from './ai';
import { CLASSIFIER_VERSION } from './ai';
import { LocalGameAgent } from './game-agent';
import type { PageFetcher } from './page-fetcher';
import { sitemapEntries, titleFromUrl, type SitemapEntry } from './sitemap';
import { pickDescription, popularitySignals, rankLinks, type RankKind } from '@shared/popularity';
import { pageFingerprint } from './updates';
import type { ClassificationService } from './classification';
import type { BrowserClient } from './browser-client';
import type { HostRateLimiter } from './rate-limit';
import type { PolicyService } from './policy-service';
import { publish } from './bus';
import { isCancelled } from '@shared/worker-protocol';
import { tm } from './i18n';
import { decorativeArtwork } from '@shared/artwork';

const DETAILS_PER_PASS = 48;
/** Game pages read at once. Per-host spacing still applies to every request. */
const DETAIL_CONCURRENCY = 6;
const AUTO_RECHECK_MS = 5 * 60_000;
/** Incremental re-checks assume newest-first listings; a weekly full walk catches the rest. */
const FULL_CRAWL_EVERY_MS = 7 * 24 * 3600_000;

const PLATFORMS: Platform[] = ['linux', 'windows', 'macos', 'android', 'web'];

function asPlatforms(list: unknown): Platform[] {
  return Array.isArray(list) ? (list.filter((p) => PLATFORMS.includes(p as Platform)) as Platform[]) : [];
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' })); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' }));
    }, { once: true });
  });
}

/** The site says the page does not exist (HTTP 404/410): skip it, no browser or AI. */
class GoneError extends Error {
  constructor(url: string) { super(`Page not found: ${url}`); }
}

/** A page that needs the browser while it is reserved for a human check. */
class DeferredError extends Error {
  constructor() { super('Waiting for the browser'); }
}
class RateLimitedError extends Error {
  constructor(readonly retryAt: number) { super('Website is limiting requests'); }
}

export class Discovery {
  private agent: LocalGameAgent;
  private running: Promise<void> | null = null;
  private paused = false;
  private controller: AbortController | null = null;
  private activeSourceId: number | null = null;
  private lastSourceId: number | null = null;
  private working = false;
  get isWorking() { return this.working; }
  private setWorking(working: boolean) {
    if (working === this.working) return;
    this.working = working;
    this.deps.onWorkChanged?.();
  }
  private forced = new Set<number>();
  private frontPage = new Map<number, PageExtract>();
  private manualSourceId: number | null = null;
  private verification: { sourceId: number; url: string; entryId: number | null } | null = null;
  private verifiedPage: { sourceId: number; url: string; entryId: number | null } | null = null;
  private changedTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private browserLock: Promise<unknown> = Promise.resolve();
  private browserRequiredUntil = new Map<string, number>();
  private cooldown = new Map<number, number>();
  private verificationCheckedAt = Date.now();
  private recheckFailures = 0;

  constructor(
    private deps: {
      sources: SourcesRepo;
      catalog: CatalogRepo;
      settings: SettingsRepo;
      session: StoreSession;
      isModelReady?:()=>boolean;
      ai: AiService;
      classification: ClassificationService;
      browser: BrowserClient;
      limiter: HostRateLimiter;
      policy: PolicyService;
      agent?: LocalGameAgent;
      fetcher?: PageFetcher;
      onVerificationRequired?: (sourceId: number, message: string, captcha: boolean) => void;
      onVerificationResolved?: (sourceId: number) => void;
      onWorkChanged?: () => void;
      /** A game page was re-verified: installed copies compare their build with it. */
      updates?: { afterDetail(catalogId: number): void };
      wishlist?: { afterDetail(catalogId: number): void };
    },
  ) {
    this.agent = deps.agent ?? new LocalGameAgent(deps.ai, deps.browser, deps.session);
    deps.session.on('enter', (token: SessionToken) => this.start(token));
    deps.session.on('leave', (options?: {preserveBrowser?: boolean}) => {
      if(this.changedTimer){clearTimeout(this.changedTimer);this.changedTimer=null;}
      if (!options?.preserveBrowser) void deps.browser.stopLoading('discovery');
      this.wake?.();
    });
  }

  /** Requests an immediate crawl of a source on the next loop iteration. */
  recrawl(sourceId: number) {
    const cursor = this.deps.sources.cursor(sourceId);
    if (this.manualSourceId === sourceId) this.manualSourceId = null;
    if (this.verification?.sourceId === sourceId) this.verification = null;
    if (this.verifiedPage?.sourceId === sourceId) this.verifiedPage = null;
    this.deps.limiter.verified(hostOf(this.deps.sources.get(sourceId)?.url ?? ''));
    const lastCrawlAt = this.deps.sources.get(sourceId)?.lastCrawlAt;
    if (cursor) {
      delete cursor.retryAt; delete cursor.failures;
      // Retry resumes the durable queue. A fresh scan starts only when the
      // previous scan actually finished, and retains every verified game.
      this.deps.sources.saveCursor(sourceId, cursor);
    } else if (lastCrawlAt) {
      // Already fully indexed: look for new games from the first page.
      const source = this.deps.sources.get(sourceId)!;
      this.deps.sources.saveCursor(sourceId, { pending: [source.url], visited: [], pagesDone: 0, startedAt: new Date().toISOString(), refresh: this.incremental(source) });
    } else this.deps.sources.resetCrawl(sourceId);
    this.deps.catalog.retryUnfinishedDetails(sourceId);
    this.notifyCatalog(sourceId);
    if (this.activeSourceId !== sourceId) this.forced.add(sourceId);
    this.wake?.();
  }

  poke() {
    this.wake?.();
  }

  /** Keep the current checkpoint and already verified games after a human check. */
  resumeVerification(sourceId = this.manualSourceId) {
    if (sourceId === null) return;
    const source = this.deps.sources.get(sourceId);
    if (!source) return;
    const cursor = this.deps.sources.cursor(sourceId);
    const check = this.verification?.sourceId === sourceId ? this.verification : cursor?.verification ? { ...cursor.verification, sourceId } : null;
    if (check) this.verifiedPage = check;
    if (this.manualSourceId === sourceId) this.manualSourceId = null;
    this.verification = null;
    if (cursor) { delete cursor.verification; this.deps.sources.saveCursor(sourceId, cursor); }
    this.deps.limiter.verified(hostOf(source.url));
    this.deps.catalog.retryUnfinishedDetails(sourceId);
    this.progress(source, 'idle', 'Website check completed — continuing discovery', cursor?.pagesDone ?? 0, this.deps.catalog.count(sourceId));
    this.deps.onVerificationResolved?.(sourceId);
    this.wake?.();
  }

  /**
   * Moves past a page that wants a human check: the listing page (or game) is
   * set aside for a later re-check and indexing continues with the rest.
   */
  skipVerification(sourceId = this.manualSourceId, reason = 'Skipped a page that needs a human check — continuing with the rest of the site') {
    if (sourceId === null) return;
    const source = this.deps.sources.get(sourceId);
    if (!source) return;
    const cursor = this.deps.sources.cursor(sourceId);
    const check = this.verification?.sourceId === sourceId ? this.verification : cursor?.verification ? { ...cursor.verification, sourceId } : null;
    if (check?.entryId != null) this.deps.catalog.recordDetailFailure(check.entryId);
    if (cursor) {
      const gated = check ? canonicalUrl(check.url) ?? check.url : null;
      if (gated && check?.entryId == null) {
        cursor.pending = cursor.pending.filter((u) => (canonicalUrl(u) ?? u) !== gated);
        if (!cursor.visited.includes(gated)) cursor.visited.push(gated);
      }
      delete cursor.verification; delete cursor.page; delete cursor.retryAt; delete cursor.failures;
      this.deps.sources.saveCursor(sourceId, cursor);
    }
    if (this.manualSourceId === sourceId) this.manualSourceId = null;
    this.verification = null;
    this.verifiedPage = null;
    this.recheckFailures = 0;
    this.progress(source, 'idle', reason, cursor?.pagesDone ?? 0, this.deps.catalog.count(sourceId));
    this.deps.onVerificationResolved?.(sourceId);
    this.wake?.();
  }

  private async checkVerification(token: SessionToken): Promise<boolean> {
    const { session, browser, sources } = this.deps;
    let restored = false;
    // Restore an interrupted human-check checkpoint after restarting the app.
    if (this.manualSourceId === null) {
      const blocked = sources.list().find((s) => s.enabled && s.status === 'blocked');
      if (!blocked) return false;
      const cursor = sources.cursor(blocked.id);
      this.manualSourceId = blocked.id;
      this.verification = { sourceId: blocked.id, url: cursor?.verification?.url ?? cursor?.pending[0] ?? blocked.url, entryId: cursor?.verification?.entryId ?? null };
      restored = true;
    }
    const check = this.verification;
    if (!check || !sources.get(check.sourceId)?.enabled) {
      this.manualSourceId = null; this.verification = null; return false;
    }
    let ex = await browser.extract('discovery', token.signal);
    session.assertLive(token);
    // Every few minutes, reload the blocked page and give it time: rate limits
    // lift and many checks pass on their own in a real browser.
    if (Date.now() - this.verificationCheckedAt > AUTO_RECHECK_MS && (ex.gates.captcha || ex.gates.blocked || !this.samePage(ex.url, check.url))) {
      this.verificationCheckedAt = Date.now();
      ex = await this.withBrowser(async () => {
        await browser.navigate('discovery', check.url, token.signal);
        return this.agent.verify(await browser.extract('discovery', token.signal), 'discovery', token);
      });
      session.assertLive(token);
      // Last resort, automatically: after two failed re-checks (~10 min) the
      // page is set aside and the rest of the site keeps indexing.
      if ((ex.gates.captcha || ex.gates.blocked) && ++this.recheckFailures >= 2) {
        this.skipVerification(check.sourceId, 'A page kept asking for a human check, so it was skipped automatically');
        return true;
      }
    }
    if (!/^https?:/i.test(ex.url)) {
      ex = await this.withBrowser(async () => {
        await browser.navigate('discovery', check.url, token.signal);
        return browser.extract('discovery', token.signal);
      });
      session.assertLive(token);
    }
    if (restored) this.deps.onVerificationRequired?.(check.sourceId, sources.get(check.sourceId)?.statusDetail ?? 'Complete the website check.', ex.gates.captcha);
    if (ex.gates.captcha || ex.gates.blocked || ex.gates.login) return false;
    this.resumeVerification(check.sourceId);
    return true;
  }

  private samePage(a: string, b: string) {
    return (canonicalUrl(a) ?? a).replace(/\/$/, '') === (canonicalUrl(b) ?? b).replace(/\/$/, '');
  }

  private async openPage(url: string, token: SessionToken) {
    if (this.verifiedPage && this.samePage(this.verifiedPage.url, url)) {
      this.verifiedPage = null;
      const ex = await this.deps.browser.extract('discovery', token.signal);
      this.deps.session.assertLive(token);
      if (this.samePage(ex.url, url)) return ex;
    }
    await this.deps.browser.navigate('discovery', url, token.signal);
    return this.readPage(token);
  }

  async setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) {
      this.controller?.abort();
      this.wake?.();
      await this.running;
      if (this.paused && this.deps.ai.getStatus?.()?.context === 'discovery') this.deps.ai.setStatus({phase:'idle',detail:null,context:null});
    } else {
      const token = this.deps.session.token();
      if (token) this.start(token);
    }
  }

  private start(parent: SessionToken) {
    if (this.running || this.paused) return;
    // Coming back to the Store re-checks a blocked page at once.
    this.verificationCheckedAt = 0;
    this.controller = new AbortController();
    const token = { epoch: parent.epoch, signal: AbortSignal.any([parent.signal, this.controller.signal]) };
    this.running = this.loop(token).finally(() => {
      this.running = null;
      this.setWorking(false);
      // Re-entering quickly may have created a new session while the old loop wound down.
      const t = this.deps.session.token();
      if (t && !this.paused) this.start(t);
    });
  }

  private notifyCatalog(sourceId: number | null) {
    if (this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null;
      publish('catalog:changed', { policyRevision: this.deps.policy.policy().revision, sourceId });
    }, 100);
  }

  private progress(source: Source, status: Source['status'], detail: string | null, pagesDone: number, entriesFound: number) {
    this.deps.sources.setStatus(source.id, status, detail);
    publish('crawl:progress', { sourceId: source.id, status, detail, pagesDone, entriesFound });
    publish('sources:changed', this.deps.sources.list());
  }

  private pickSource(): Source | null {
    const refreshMs = this.deps.settings.get().crawlRefreshHours * 3600_000;
    const all = this.deps.sources.list().filter((s) => {
      if (!s.enabled) return false;
      const cursor = this.deps.sources.cursor(s.id);
      return !cursor || ((cursor.failures ?? 0) < 3 && (cursor.retryAt ?? 0) <= Date.now());
    });
    // Each checkpointed batch gives the next website a turn. A large first
    // site's listing/detail backlog must not starve a newly added source.
    const last = all.findIndex(s => s.id === this.lastSourceId);
    if (last >= 0) all.push(...all.splice(0, last + 1));
    if (this.manualSourceId !== null && !all.some((s) => s.id === this.manualSourceId)) this.manualSourceId = null;
    for (const s of all) if (this.forced.has(s.id) && s.id !== this.manualSourceId) return s;
    return (
      all.find((s) => s.status !== 'blocked' && s.id !== this.manualSourceId && (this.deps.sources.cursor(s.id) || !s.lastCrawlAt || Date.now() - Date.parse(s.lastCrawlAt) > refreshMs)) ??
      // A site whose recipe predates route learning is not really finished.
      all.find((s) => { const r = this.deps.sources.recipe(s.id); return s.status !== 'blocked' && s.id !== this.manualSourceId && !!r && (r.routesVersion ?? 1) < ROUTES_VERSION; }) ??
      // Nor is one whose site map has never been read.
      (this.deps.fetcher ? all.find((s) => { const r = this.deps.sources.recipe(s.id); return s.status !== 'blocked' && s.id !== this.manualSourceId && !!r?.game.length && !r.sitemapAt; }) : undefined) ??
      null
    );
  }

  private async loop(token: SessionToken) {
    const { session } = this.deps;
    while (session.isLive(token)) {
      try {
        if(this.deps.isModelReady&&!this.deps.isModelReady()){
          this.setWorking(false);
          this.deps.ai.setStatus({phase:'paused',detail:tm('Download the browsing and analysis agents in Settings → Local AI'),context:'discovery'});
          await this.wait(60_000);continue;
        }
        // A site waiting for a human check steps aside; every other source
        // and backlog keeps indexing meanwhile.
        if (this.manualSourceId !== null || this.deps.sources.list().some((s) => s.enabled && s.status === 'blocked')) {
          if (await this.checkVerification(token)) continue;
        }
        const source = this.pickSource();
        if (source) {
          this.setWorking(true);
          this.forced.delete(source.id);
          await this.crawlSource(source, token);
          continue;
        }
        // Nothing to crawl: work through classification and detail backlogs.
        if (await this.detailBacklog(token)) continue;
        if (this.manualSourceId === null && await this.classifyBacklog(token)) continue;
        this.setWorking(false);
        this.deps.ai.setStatus({ phase: 'idle', detail: this.manualSourceId !== null ? tm('Waiting for human website verification') : null });
        const retryAt = this.deps.sources.list().map(s => this.deps.sources.cursor(s.id))
          .filter(c => c && (c.failures ?? 0) < 3 && (c.retryAt ?? 0) > Date.now())
          .map(c => c!.retryAt!);
        // While a check is pending, look again soon so indexing resumes the moment it clears.
        const idle = this.manualSourceId !== null ? 3000 : 60_000;
        await this.wait(retryAt.length ? Math.min(idle, Math.max(1, Math.min(...retryAt) - Date.now())) : idle);
      } catch (e) {
        if (isCancelled(e) || !session.isLive(token)) break;
        console.error('[discovery]', e);
        await sleep(5000, token.signal).catch(() => undefined);
      }
    }
  }

  private async wait(ms: number) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => { clearTimeout(t); resolve(); };
    });
    this.wake = null;
  }

  /** Firefox is one window: fallbacks from parallel detail checks take turns. */
  private withBrowser<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.browserLock.then(fn, fn);
    this.browserLock = run.catch(() => undefined);
    return run;
  }

  private gated(ex: PageExtract) {
    return ex.gates.captcha || ex.gates.blocked || ex.gates.login;
  }

  /**
   * Reads a page: plain HTTP first (parallel, no rendering), Firefox when the
   * site needs scripts, a session or a website check, or its recipe says so.
   * `rendered` says when a script-built page has rendered enough: a Firefox
   * read asked for by `mode` waits for it in the same turn, before another
   * check can navigate the window to a different page.
   */
  private async load(source: Source, url: string, token: SessionToken, mode: 'http' | 'browser' = 'http', rendered?: (ex: PageExtract) => boolean): Promise<{ ex: PageExtract; via: 'http' | 'browser' }> {
    const { fetcher, limiter, session } = this.deps;
    if ((this.cooldown.get(source.id) ?? 0) > Date.now()) throw new RateLimitedError(this.cooldown.get(source.id)!);
    const resumingCheck = this.verifiedPage && this.samePage(this.verifiedPage.url, url);
    const site = siteKey(hostOf(url));
    // A script-only listing, collection, or missing page says nothing about
    // other game pages. Cache browser requirements for this URL only.
    const kind = `${source.id}:${canonicalUrl(url) ?? url}`;
    // Older recipes may have learned "browser" from a temporary HTTP block.
    // Probe the fast reader again, but avoid repeatedly probing script shells.
    if (fetcher && !resumingCheck && (mode === 'http' || Date.now() >= (this.browserRequiredUntil.get(kind) ?? 0))) {
      {
        await limiter.wait(site, this.spacing(source), token.signal);
        session.assertLive(token);
        const r = await fetcher.fetch(url, token.signal);
        session.assertLive(token, 'page read');
        if (process.env.CGL_DEBUG) console.log(`[index] http ${r.status} ${r.ms}ms ${r.ok ? `${r.extract.cards.length} cards` : r.reason} ${url.slice(0, 120)}`);
        // Defer this website instead of tying up every parallel worker (and
        // all other sources) through repeated sleep/retry cycles.
        if (r.status === 429 || r.status === 503 && !(r.ok && r.extract.gates.captcha)) {
          if ((this.cooldown.get(source.id) ?? 0) <= Date.now()) this.slowDown(source);
          const retryAt = Date.now() + (r.retryAfterMs ?? 30_000);
          this.cooldown.set(source.id,retryAt);
          limiter.backoff(site,retryAt-Date.now());
          throw new RateLimitedError(retryAt);
        }
        if (r.ok && !this.gated(r.extract)) {
          const complete = !rendered || rendered(r.extract);
          if (!complete) this.browserRequiredUntil.set(kind, Date.now() + 5 * 60_000);
          if (mode === 'http' || complete) { this.speedUp(source); return { ex: r.extract, via: 'http' }; }
        }
        if (!r.ok && r.reason === 'not-html') throw new Error(`Not a web page (${r.detail})`);
        if (!r.ok && (r.status === 404 || r.status === 410)) throw new GoneError(url);
      }
      this.browserRequiredUntil.set(kind, Date.now() + 5 * 60_000);
      fetcher.stats.fallbacks++;
    }
    // The discovery window is parked on another site's human check; don't
    // navigate it away. This page is retried once the check is done.
    if (this.manualSourceId !== null && this.manualSourceId !== source.id) throw new DeferredError();
    return this.withBrowser(async () => {
      await limiter.wait(site, this.spacing(source), token.signal);
      session.assertLive(token);
      const ex = await this.openPage(url, token);
      return { ex: rendered && mode === 'browser' ? await this.settle(ex, token, rendered) : ex, via: 'browser' as const };
    });
  }

  /** Per-site request spacing: the configured value, widened while the site rate-limits us. */
  private pace = new Map<number, { ms: number; ok: number }>();
  private spacing(source: Source) {
    return Math.max(source.rateLimitMs, this.pace.get(source.id)?.ms ?? 0);
  }
  private slowDown(source: Source) {
    const p = this.pace.get(source.id) ?? { ms: source.rateLimitMs, ok: 0 };
    this.pace.set(source.id, { ms: Math.min(5000, Math.max(500, p.ms * 2)), ok: 0 });
  }
  private speedUp(source: Source) {
    const p = this.pace.get(source.id);
    if (!p) return;
    if (++p.ok >= 15) { p.ms = Math.max(source.rateLimitMs, Math.round(p.ms * 0.75)); p.ok = 0; }
  }

  /** Re-check only the newest listings, unless a full walk is due. */
  private incremental(source: Source) {
    const full = this.deps.sources.recipe(source.id)?.fullCrawlAt;
    return !!full && this.deps.catalog.count(source.id) > 0 && Date.now() - Date.parse(full) < FULL_CRAWL_EVERY_MS;
  }

  private status(source: Source, detail: string, pagesDone: number) {
    const total = this.deps.catalog.query(this.deps.policy.policy(), { sourceIds: [source.id] }).total;
    this.progress(source, 'crawling', detail, pagesDone, total);
  }

  private async crawlSource(source: Source, token: SessionToken) {
    this.activeSourceId = source.id;
    this.lastSourceId = source.id;
    const { sources, catalog, session } = this.deps;
    // A site indexed before is re-checked incrementally (see staleRun below).
    const cursor: CrawlCursor = sources.cursor(source.id) ?? { pending: [source.url], visited: [], pagesDone: 0, startedAt: new Date().toISOString(), refresh: this.incremental(source) };
    cursor.pending = [...new Set(cursor.pending.filter(isListingRoute))];
    const savedRecipe=sources.recipe(source.id);
    if(savedRecipe && savedRecipe.listingExtractVersion!==2){
      // Older extractors saved at most 150 cards from a complete single-page
      // catalog. Re-read its starting listing once without discarding games.
      const start=canonicalUrl(source.url)??source.url;
      cursor.pending=[start,...cursor.pending.filter(url=>(canonicalUrl(url)??url)!==start)];
      cursor.visited=cursor.visited.filter(url=>(canonicalUrl(url)??url)!==start);
      savedRecipe.listingExtractVersion=2;savedRecipe.recentPages=savedRecipe.recentPages?.filter(isListingRoute);sources.saveRecipe(source.id,savedRecipe);
    }
    // Older checkpoints lost lastCrawlAt while retaining a proven full crawl.
    if (!cursor.refresh && this.incremental(source)) { cursor.refresh = true; cursor.staleRun = 0; }
    this.progress(source, 'crawling', 'Reading listing pages', cursor.pagesDone, catalog.count(source.id));
    this.deps.ai.setStatus({ phase: 'navigating', detail: tm('Indexing {name}', { name: source.name }), context: 'discovery' });
    const host = hostOf(source.url);
    const batchStart = cursor.pagesDone;
    const started = Date.now();

    try {
      sources.saveCursor(source.id, cursor);
      // Finish content checks an interrupted session left behind (no page re-read needed).
      const unrated = catalog.needingClassification(CLASSIFIER_VERSION, 200, true).filter((e) => e.sourceId === source.id).map((e) => e.id);
      if (unrated.length) await this.classifyListed(unrated, token);
      if (this.verifiedPage?.sourceId === source.id && this.verifiedPage.entryId !== null) {
        await this.fetchDetail(this.verifiedPage.entryId, token);
        if (sources.get(source.id)?.status === 'blocked') return;
      }
      while (cursor.pending.length && cursor.pagesDone - batchStart < source.maxPages) {
        session.assertLive(token);
        if (!sources.get(source.id)?.enabled) return;
        const url = cursor.pending[0];
        let recipe = sources.recipe(source.id);
        const listed = (e: PageExtract) => e.cards.length >= 3 || !!e.game || !!recipe && recipeCards(e, recipe).length > 0;
        let loaded: { ex: PageExtract; via: 'http' | 'browser' };
        try {
          loaded = await this.load(source, url, token, recipe?.listingMode, listed);
        } catch (e) {
          if (!(e instanceof GoneError)) throw e;
          cursor.pending.shift();
          cursor.visited.push(canonicalUrl(url) ?? url);
          sources.saveCursor(source.id, cursor);
          continue;
        }
        let { ex, via } = loaded;
        session.assertLive(token, 'page extraction');
        if (this.gated(ex)) {
          sources.saveCursor(source.id, cursor);
          this.blockSource(source, ex, url, null, cursor.pagesDone);
          return;
        }

        if (process.env.CGL_DEBUG) console.log(`[index] listing via=${via} links=${ex.links.length} cards=${ex.cards.length} ${ex.url.slice(0, 100)}`);
        // The front page also carries the menus and "Popular" blocks the ranked-list pass reads.
        if (this.samePage(url, source.url)) this.frontPage.set(source.id, ex);
        let cards = recipe ? recipeCards(ex, recipe) : [];
        // Script-rendered listings: the HTTP copy has no games, Firefox might.
        if (!cards.length && via === 'http' && (recipe || !ex.cards.length)) {
          const rendered = await this.load(source, url, token, 'browser', listed);
          if (this.gated(rendered.ex)) { this.blockSource(source, rendered.ex, url, null, cursor.pagesDone); return; }
          ({ ex, via } = rendered);
          if (process.env.CGL_DEBUG) console.log(`[index] rendered links=${ex.links.length} cards=${ex.cards.length} title=${JSON.stringify(ex.title)} text=${JSON.stringify(ex.text.slice(0, 300))} gates=${JSON.stringify(ex.gates)}`);
          if (recipe) cards = recipeCards(ex, recipe);
        }
        let extraRoutes: string[] = [];
        if (!recipe || !cards.length) {
          this.status(source, recipe ? 'Site layout changed — local AI is re-learning it' : 'Local AI is learning this site’s layout', cursor.pagesDone);
          const learned = await this.learn(source, ex, via, token);
          recipe = learned.recipe;
          cards = learned.cards;
          extraRoutes = learned.more;
        }
        // Recipes learned with older instructions only knew pagination: ask the
        // AI once which links lead to more games (browse/category/game-list
        // pages), then walk the whole site instead of an incremental re-check.
        if ((recipe.routesVersion ?? 1) < ROUTES_VERSION) {
          this.status(source, 'Local AI is finding the rest of this site’s games', cursor.pagesDone);
          const relearned = await this.agent.learnListing(ex, token);
          session.assertLive(token, 'route learning');
          const more = [...new Set([...relearned.more, ...paginationLinks(ex), ...catalogLinks(ex)])];
          recipe = { ...recipe, more: [...recipe.more, ...moreFromExamples(more)], routesVersion: ROUTES_VERSION, fullCrawlAt: undefined };
          sources.saveRecipe(source.id, recipe);
          extraRoutes = [...extraRoutes, ...more];
          cursor.refresh = false;
          delete cursor.staleRun;
          console.log(`[discovery] ${source.name}: re-learned routes, ${more.length} listing links`);
        }
        const recent = recentListingLinks(ex).filter(url => !matchesAny(url, recipe!.game));
        if (recent.length) {
          recipe = { ...recipe, recentPages: [...new Set([...(recipe.recentPages ?? []), ...recent])].slice(0, 6), siteDatesVersion: 1 };
          sources.saveRecipe(source.id, recipe);
        }
        const pagination = new Set(paginationLinks(ex));
        for (const route of [...recipeRoutes(ex, recipe), ...catalogLinks(ex), ...extraRoutes]) {
          const next = canonicalUrl(route);
          if (next && isListingRoute(next) && hostOf(next) === host && !cursor.visited.includes(next) && !cursor.pending.includes(next)) {
            if (recent.includes(next) || pagination.has(next)) cursor.pending.splice(1, 0, next);
            else cursor.pending.push(next);
          }
        }
        cursor.pending.shift();
        // Exhaust the observed all-games listing before fanning out into
        // overlapping genre menus. Pagination of that listing comes first.
        const catalogStarts = new Set([...ex.links,...(ex.menuLinks ?? [])].filter(l=>/^(?:all games|games? list|browse(?: games)?|catalog(?:ue)?|a\s*[-–]\s*z|all titles|full list)$/i.test(l.text.trim())).map(l=>l.href));
        const sourcePath = new URL(source.url).pathname.replace(/\/$/,'');
        const priority = (url:string) => {
          const u=new URL(url),path=u.pathname.replace(/\/$/,'');
          const global=path===sourcePath || path.replace(/\/page\/\d+$/,'')===sourcePath || catalogStarts.has(url) || /^\/(?:games|games-list|game-list|all-games|browse|catalog)(?:\/page\/\d+)?$/i.test(path);
          const paged=pagination.has(url) || /(?:\/page\/\d+$|[?&](?:page|paged|p|pg)=\d+)/i.test(path+u.search);
          return recent.includes(url)?6:global?(paged?5:4):paged?2:0;
        };
        cursor.pending.sort((a,b)=>priority(b)-priority(a));
        cursor.visited.push(canonicalUrl(url) ?? url);
        cursor.pagesDone++;
        delete cursor.page; delete cursor.retryAt; delete cursor.failures;
        const recentGames = new Set((ex.recentGameLinks ?? []).map(url => canonicalUrl(url)));
        cards.sort((a,b)=>Number(recentGames.has(canonicalUrl(b.href)))-Number(recentGames.has(canonicalUrl(a.href))));
        // Games and routes commit together: closing mid-page loses nothing.
        let created = 0;
        const stored = sources.checkpoint(source.id, cursor, () => cards.map((card) => { const r = this.storeCard(source.id, card, ex); if (r?.created || r?.changed) created++; return r?.id; }).filter((id): id is number => id !== undefined));
        // Listings are newest-first on almost every site: once two pages in a
        // row bring nothing new, the rest is already indexed.
        if (cursor.refresh) {
          cursor.staleRun = created ? 0 : (cursor.staleRun ?? 0) + 1;
          if (cursor.staleRun >= 2) { cursor.pending = cursor.pending.filter(url => recipe?.recentPages?.includes(url)); cursor.staleRun = 0; sources.saveCursor(source.id, cursor); }
        }
        // AI-confirmed games appear as soon as their cover passes the content
        // check; download routes are verified in the background right after.
        catalog.markListed(stored);
        this.notifyCatalog(source.id);
        this.status(source,tm('Found {n} games on this page — checking covers',{n:cards.length}),cursor.pagesDone);
        await this.classifyListed(stored, token);
        this.notifyCatalog(source.id);
        const secs = Math.max(1, (Date.now() - started) / 1000);
        this.status(source, `Read ${cursor.pagesDone} page${cursor.pagesDone === 1 ? '' : 's'} · ${cards.length} games on this page · ${(cursor.pagesDone - batchStart) / secs >= 1 ? `${((cursor.pagesDone - batchStart) / secs).toFixed(1)} pages/s` : `${secs.toFixed(0)} s`}`, cursor.pagesDone);
        // Download routes verify in the background while later listing pages
        // load; both share the site's request pacing.
        this.kickDetails(source, token);
        if (sources.get(source.id)?.status === 'blocked') return;
      }

      await this.kickDetails(source, token);
      if (!sources.get(source.id)?.enabled) return;
      // Prioritize finding the catalog while listing pages remain. Large
      // detail backlogs must not consume the site's entire request budget
      // before the next listing batch (or the next website) gets a turn.
      if (!cursor.pending.length) await this.detailPass(source, token);
      if (sources.get(source.id)?.status === 'blocked') return;
      // Listings exhausted: the sitemap reaches the rest of the catalog.
      if (!cursor.pending.length && await this.sitemapPass(source, cursor, token)) {
        await this.kickDetails(source, token);
        if (sources.get(source.id)?.status === 'blocked') return;
      }
      if (!cursor.pending.length && await this.rankPass(source, cursor, token)) {
        await this.kickDetails(source, token);
        if (sources.get(source.id)?.status === 'blocked') return;
      }
      const total = catalog.query(this.deps.policy.policy(), { sourceIds: [source.id] }).total;
      if (!cursor.pending.length && catalog.needingDetail(source.id, this.deps.policy.policy(), 1).length) {
        this.progress(source, 'idle', `${total} games ready — continuing unfinished game checks`, cursor.pagesDone, total);
        return;
      }
      if (cursor.pending.length) {
        sources.saveCursor(source.id, cursor);
        this.progress(source, 'idle', `${total} games ready — continuing with the next listing batch`, cursor.pagesDone, total);
        return;
      }
      if (!cursor.refresh) { const r = sources.recipe(source.id); if (r) sources.saveRecipe(source.id, { ...r, fullCrawlAt: new Date().toISOString() }); }
      sources.markCrawled(source.id);
      if (catalog.count(source.id) === 0) {
        this.progress(source, 'unsupported', 'No games could be recognised on this site. Try a page that lists games (for example a “browse” or “new releases” page).', cursor.pagesDone, 0);
      } else {
        const next = new Date(Date.now() + this.deps.settings.get().crawlRefreshHours * 3600_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.progress(source, 'ok', total ? `Up to date · ${total} game${total === 1 ? '' : 's'} · next check for new games at ${next}` : 'No downloadable games passed verification yet. Some pages may need a retry.', cursor.pagesDone, total);
      }
    } catch (e) {
      if (isCancelled(e) || !session.isLive(token)) {
        // The checkpoint is saved; listing pages still pending resume next time the Store opens.
        const saved = sources.cursor(source.id);
        this.progress(source, saved ? 'idle' : 'ok', saved ? (this.paused ? 'Paused for your selected task — indexing will resume' : 'Paused — resumes when you return to the Store') : 'Up to date', saved?.pagesDone ?? cursor.pagesDone, catalog.count(source.id));
        throw e;
      }
      const saved = sources.cursor(source.id) ?? cursor;
      if (e instanceof RateLimitedError) {
        saved.retryAt = e.retryAt;
        sources.saveCursor(source.id,saved);
        this.progress(source,'idle',`Website is limiting requests — retrying in ${Math.max(1,Math.ceil((e.retryAt-Date.now())/1000))} seconds`,cursor.pagesDone,catalog.count(source.id));
        return;
      }
      if (e instanceof DeferredError) {
        saved.retryAt = Date.now() + 60_000;
        sources.saveCursor(source.id, saved);
        this.progress(source, 'idle', 'Waiting for the browser — another site is showing a human check', cursor.pagesDone, catalog.count(source.id));
        return;
      }
      saved.failures = (saved.failures ?? 0) + 1;
      saved.retryAt = Date.now() + Math.min(300_000, 30_000 * 2 ** (saved.failures - 1));
      sources.saveCursor(source.id, saved);
      this.progress(source, 'error', (e as Error).message.slice(0, 300), cursor.pagesDone, catalog.count(source.id));
    } finally {
      if (this.detailRunner?.sourceId === source.id) await this.detailRunner.run.catch(() => undefined);
      if (this.activeSourceId === source.id) this.activeSourceId = null;
    }
  }

  private async classifyListed(ids: number[], token: SessionToken) {
    const todo = ids.filter((id) => {
      const e = this.deps.catalog.raw(id);
      return e?.rating === 'unknown' && e.downloadStatus !== 'unavailable'
        && (e.classifyAttempts < 4 || e.classifierVersion !== CLASSIFIER_VERSION);
    });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
      while (next < todo.length) {
        this.deps.session.assertLive(token);
        const id = todo[next++];
        try { await this.deps.classification.classifyEntry(id, token.signal); } catch (e) { if (isCancelled(e) || !this.deps.session.isLive(token)) throw e; }
        if (next % 6 === 0) this.notifyCatalog(this.deps.catalog.raw(id)?.sourceId ?? null);
      }
    }));
  }

  /**
   * Reads the site's sitemap (robots.txt / sitemap.xml) at most once a day and
   * queues every page matching the AI-learned game pattern for verification.
   * Returns true when new pages were queued.
   */
  private async sitemapPass(source: Source, cursor: CrawlCursor, token: SessionToken): Promise<boolean> {
    const { fetcher, sources, catalog, session, limiter } = this.deps;
    const recipe = sources.recipe(source.id);
    if (!fetcher || !recipe?.game.length) return false;
    if (recipe.sitemapAt && Date.now() - Date.parse(recipe.sitemapAt) < 24 * 3600_000) return false;
    this.status(source, 'Reading the site map for the rest of the catalog', cursor.pagesDone);
    const origin = new URL(source.url).origin;
    let entries: SitemapEntry[] = [];
    try {
      entries = await sitemapEntries(origin, async (u) => {
        await limiter.wait(siteKey(hostOf(u)), this.spacing(source), token.signal);
        session.assertLive(token, 'sitemap');
        return fetcher.fetchText(u, token.signal);
      });
    } catch (e) {
      if (isCancelled(e) || !session.isLive(token)) throw e;
      console.warn(`[discovery] ${source.name}: site map unreadable: ${(e as Error).message}`);
    }
    session.assertLive(token, 'sitemap result');
    const urls = entries.map((e) => e.url);
    // Pages the site says changed since they were verified (often a new build) are checked again.
    const known = catalog.verifiedByUrl(source.id);
    const changed = entries.flatMap((e) => {
      const k = known.get(canonicalUrl(e.url) ?? e.url);
      return k && e.lastmod && Date.parse(e.lastmod) - Date.parse(k.fetchedAt) > 60_000 ? [k.id] : [];
    }).slice(0, 300);
    if (changed.length) { catalog.markStale(changed); console.log(`[discovery] ${source.name}: ${changed.length} game pages changed since they were verified`); }
    const games = urls.filter((u) => (matchesAny(u, recipe.game) || matchesAny(canonicalUrl(u) ?? u, recipe.game)) && !this.samePage(u, source.url));
    let added = 0;
    sources.checkpoint(source.id, cursor, () => {
      for (const raw of games) {
        // Same form as listing cards, so a game seen both ways is one entry.
        const pageUrl = canonicalUrl(raw);
        if (!pageUrl) continue;
        const title = titleFromUrl(pageUrl);
        if (title.length < 2) continue;
        if (catalog.upsertListing(source.id, { pageUrl, title, titleKey: titleKey(title) }).created) added++;
      }
    });
    sources.saveRecipe(source.id, { ...recipe, sitemapAt: new Date().toISOString() });
    console.log(`[discovery] ${source.name}: sitemap listed ${urls.length} pages, ${games.length} match the game pattern, ${added} new`);
    if (added) this.status(source, `Found ${added} more games in the site map — verifying them`, cursor.pagesDone);
    return added > 0 || changed.length > 0;
  }

  /**
   * Reads the site's own "Popular" and "Trending" lists (dedicated pages from
   * its menus, or ranked sections on its front page) so the Store can sort by
   * what people actually download. Returns true when it listed new games.
   */
  private async rankPass(source: Source, cursor: CrawlCursor, token: SessionToken): Promise<boolean> {
    const { sources, catalog, session } = this.deps;
    const recipe = sources.recipe(source.id);
    if (!recipe?.game.length) return false;
    const every = this.deps.settings.get().crawlRefreshHours * 3600_000;
    if (recipe.rankAt && Date.now() - Date.parse(recipe.rankAt) < every) return false;
    const soft = async <T>(fn: () => Promise<T>): Promise<T | null> => {
      try { return await fn(); } catch (e) { if (isCancelled(e) || !session.isLive(token)) throw e; console.warn(`[discovery] ${source.name}: ranked list unreadable: ${(e as Error).message}`); return null; }
    };
    // Only right after the crawl read the front page itself: a resumed crawl never re-reads it.
    const cached = this.frontPage.get(source.id);
    this.frontPage.delete(source.id);
    if (!cached) return false;
    const home = { ex: cached };
    this.status(source, 'Reading the site’s Popular and Trending lists', cursor.pagesDone);
    const pages = { ...recipe.rankPages, ...rankLinks(home.ex) };
    let added = 0;
    const idFor = (url: string, card?: ExtractCard, page?: PageExtract) => {
      const r = card && page ? this.storeCard(source.id, card, page) : catalog.upsertListing(source.id, { pageUrl: url, title: titleFromUrl(url), titleKey: titleKey(titleFromUrl(url)) });
      if (r?.created) added++;
      return r?.id ?? null;
    };
    for (const kind of ['popular', 'trending'] as RankKind[]) {
      const ids: number[] = [];
      const seen = new Set<string>();
      let next: string | null = pages[kind] ?? null;
      for (let n = 0; next && n < 3; n++) {
        const page = await soft(() => this.load(source, next!, token, recipe.listingMode, (e) => recipeCards(e, recipe).length > 0));
        if (!page) break;
        sources.checkpoint(source.id, cursor, () => {
          for (const card of recipeCards(page.ex, recipe)) {
            const url = canonicalUrl(card.href, page.ex.url);
            if (!url || seen.has(url)) continue;
            seen.add(url);
            const id = idFor(url, card, page.ex);
            if (id !== null) ids.push(id);
          }
        });
        const following = page.ex.nextPage;
        next = following && following !== next ? following : null;
      }
      // No dedicated page: a "Popular games" block on the front page.
      if (!ids.length) {
        const section = home.ex.rankedSections?.find((r) => r.kind === kind);
        sources.checkpoint(source.id, cursor, () => {
          for (const href of section?.links ?? []) {
            const url = canonicalUrl(href);
            if (!url || seen.has(url) || !matchesAny(url, recipe.game) || this.samePage(url, source.url)) continue;
            seen.add(url);
            const id = idFor(url);
            if (id !== null) ids.push(id);
          }
        });
      }
      catalog.setRanks(source.id, kind, ids.slice(0, 300));
      if (ids.length) console.log(`[discovery] ${source.name}: ${kind} list has ${ids.length} games${pages[kind] ? ` (${pages[kind]})` : ' (front page)'}`);
    }
    sources.saveRecipe(source.id, { ...recipe, rankPages: pages, rankAt: new Date().toISOString() });
    this.notifyCatalog(source.id);
    return added > 0;
  }

  /** The local AI picks games and pagination once; the recipe repeats it for free. */
  private async learn(source: Source, ex: PageExtract, via: 'http' | 'browser', token: SessionToken): Promise<{ recipe: SiteRecipe; cards: ExtractCard[]; more: string[] }> {
    const previous = this.deps.sources.recipe(source.id);
    const r = await this.agent.learnListing(ex, token);
    this.deps.session.assertLive(token, 'site recipe');
    const listings = new Set([...r.more, ...catalogLinks(ex), ...paginationLinks(ex)]);
    const recipe: SiteRecipe = {
      version: 1,
      game: inducePatterns(r.games.filter(url => !listings.has(url))),
      // The AI's listing routes plus structural pagination, so later pages
      // follow the same paths without another model call.
      more: moreFromExamples([...new Set([...r.more, ...paginationLinks(ex), ...catalogLinks(ex)])]),
      listingMode: via,
      detailMode: previous?.detailMode ?? 'http',
      learnedAt: new Date().toISOString(),
      origin: 'ai',
      routesVersion: ROUTES_VERSION,
      siteDatesVersion: 1,
      listingExtractVersion: 2,
      recentPages: previous?.recentPages,
    };
    const chosen = new Set(r.games.map((u) => u.split('#')[0]));
    let cards = recipeCards(ex, recipe);
    // A pattern that re-selects far more than the AI chose is too broad to
    // reuse; keep this page's exact choices and ask again on the next page.
    const tooBroad = cards.length > chosen.size * 2 + 6 || cards.filter((c) => chosen.has(c.href.split('#')[0])).length < Math.min(chosen.size, 2);
    if (tooBroad || chosen.size < 2) {
      cards = cards.filter((c) => chosen.has(c.href));
      for (const href of chosen) {
        if (cards.some((c) => c.href === href)) continue;
        const link = ex.links.find((l) => l.href.split('#')[0] === href && l.text);
        if (link) cards.push({ href, title: link.text, img: ex.links.find((l) => l.href.split('#')[0] === href && l.img)?.img ?? null, text: '', platforms: [], price: null, author: null, tags: [], categories: [] });
      }
    } else {
      this.deps.sources.saveRecipe(source.id, recipe);
    }
    if (r.pageIsGame && !cards.length) {
      cards.push({ href: ex.url, title: ex.game?.title ?? ex.title, img: ex.game?.cover ?? ex.meta['og:image'] ?? null, text: '', platforms: [], price: null, author: null, tags: [], categories: [] });
    }
    return { recipe, cards, more: [...new Set([...r.more, ...catalogLinks(ex)])] };
  }

  private blockSource(source: Source, ex: PageExtract, url: string, entryId: number | null, pagesDone: number) {
    const message = ex.gates.captcha
      ? 'This website shows a human check. Open the Store browser, complete it yourself, and indexing continues automatically.'
      : ex.gates.login ? 'This page requires sign-in. Open the Store browser to sign in, then indexing continues.'
        : 'The website refused access (blocked or rate-limited). Indexing will retry later.';
    this.progress(source, 'blocked', message, pagesDone, this.deps.catalog.count(source.id));
    if (ex.gates.blocked && !ex.gates.captcha) this.deps.limiter.backoff(hostOf(url), 10 * 60_000);
    this.requestVerification(source.id, url, entryId, ex.gates.captcha);
  }

  private requestVerification(sourceId: number, url: string, entryId: number | null, captcha: boolean) {
    // The user takes over this exact Firefox window, with its current URL,
    // cookies and challenge state. Do not navigate it again until they retry.
    this.manualSourceId = sourceId;
    this.verification = { sourceId, url, entryId };
    this.verificationCheckedAt = Date.now();
    this.recheckFailures = 0;
    const cursor = this.deps.sources.cursor(sourceId) ?? { pending: [], visited: [], pagesDone: 0, startedAt: new Date().toISOString() };
    cursor.verification = { url, entryId };
    this.deps.sources.saveCursor(sourceId, cursor);
    this.deps.onVerificationRequired?.(sourceId, this.deps.sources.get(sourceId)?.statusDetail ?? 'Complete the website check, then resume discovery.', captcha);
  }

  /** Allow automatic page verification/redirects to settle, without clicking challenges. */
  private async readPage(token: SessionToken): Promise<PageExtract> {
    let ex = await this.deps.browser.extract('discovery', token.signal);
    for (const delay of [1000, 2000, 3000]) {
      this.deps.session.assertLive(token, 'page verification');
      if (!ex.gates.captcha || ex.gates.blocked) break;
      this.deps.ai.setStatus({ phase: 'navigating', detail: tm('Waiting for website verification'), context: 'discovery' });
      await sleep(delay, token.signal);
      ex = await this.deps.browser.extract('discovery', token.signal);
    }
    if (ex.gates.captcha) ex = await this.agent.verify(ex, 'discovery', token);
    return ex;
  }

  /**
   * Script-built pages (single-page apps) render after "load". Used when the
   * plain HTTP copy was an empty shell: wait until the content stops growing,
   * nudging lazy lists with one scroll.
   */
  private async settle(ex: PageExtract, token: SessionToken, done: (ex: PageExtract) => boolean): Promise<PageExtract> {
    if (ex.gates.captcha || ex.gates.blocked || done(ex)) return ex;
    let last = ex.links.length;
    for (let i = 0; i < 6; i++) {
      this.deps.session.assertLive(token, 'page render');
      await sleep(i === 2 ? 400 : 900, token.signal);
      if (i === 2) await this.deps.browser.scroll('discovery', 640, 400, 0, 1200, token.signal).catch(() => undefined);
      ex = await this.deps.browser.extract('discovery', token.signal);
      if (done(ex) || i >= 3 && ex.links.length === last) break;
      last = ex.links.length;
    }
    return ex;
  }

  storeCard(sourceId: number, card: ExtractCard, page: PageExtract) {
    const pageUrl = canonicalUrl(card.href, page.url);
    if (!pageUrl || languageSwitchUrl(pageUrl) || !card.title.trim()) return null;
    const signals = textAdultSignals(card.title, card.text, [...card.tags, ...(card.categories ?? [])].join(' ')).map((s) => `text:${s}`);
    return this.deps.catalog.upsertListing(sourceId, {
      pageUrl,
      title: card.title.trim().slice(0, 200),
      titleKey: titleKey(card.title),
      description: card.text && card.text !== card.title ? card.text.slice(0, 600) : null,
      author: card.author,
      priceText: card.price,
      platforms: asPlatforms(card.platforms),
      tags: card.tags,
      categories: card.categories,
      thumbnailUrl: card.img,
      textSignals: signals,
    });
  }

  private async classifyBacklog(token: SessionToken, limit = 25): Promise<boolean> {
    const { catalog, classification, session } = this.deps;
    const todo = catalog.needingClassification(CLASSIFIER_VERSION, limit, true);
    if (!todo.length) return false;
    this.setWorking(true);
    this.deps.ai.setStatus({ phase: 'classifying', detail: tm('Checking artwork for {n} games', { n: todo.length }), context: 'discovery' });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
      while (next < todo.length) {
        session.assertLive(token);
        const e = todo[next++];
        await classification.classifyEntry(e.id, token.signal);
        this.notifyCatalog(e.sourceId);
      }
    }));
    return true;
  }

  private async detailBacklog(token: SessionToken): Promise<boolean> {
    if (this.manualSourceId !== null) return false;
    const all = this.deps.sources.list().filter((x) => x.enabled && x.status !== 'blocked' && x.status !== 'error' && (this.deps.sources.cursor(x.id)?.retryAt ?? 0) <= Date.now());
    const last = all.findIndex(s => s.id === this.lastSourceId);
    if (last >= 0) all.push(...all.splice(0, last + 1));
    for (const s of all) {
      if (this.deps.catalog.needingDetail(s.id, this.deps.policy.policy(), 1).length) {
        this.setWorking(true);
        this.lastSourceId = s.id;
        await this.detailPass(s, token);
        if (this.deps.sources.get(s.id)?.status === 'blocked') return true;
        const total = this.deps.catalog.query(this.deps.policy.policy(), { sourceIds: [s.id] }).total;
        this.progress(s, 'ok', `${total} game${total === 1 ? '' : 's'} ready in the Store`, 0, total);
        return true;
      }
    }
    return false;
  }

  private detailRunner: { sourceId: number; run: Promise<void> } | null = null;
  /** Starts (or joins) the background verification stream for a source. */
  private kickDetails(source: Source, token: SessionToken): Promise<void> {
    if (this.detailRunner?.sourceId === source.id) return this.detailRunner.run;
    const holder: { run?: Promise<void> } = {};
    const run = (async () => {
      await Promise.resolve();
      try {
        // A bounded pass lets other websites run. In particular, a deferred
        // browser request must not retry the same unchanged backlog forever.
        if (this.deps.sources.get(source.id)?.enabled && this.deps.sources.get(source.id)?.status !== 'blocked') {
          await this.detailPass(source, token, this.deps.sources.cursor(source.id)?.pending.length ? 8 : DETAILS_PER_PASS);
        }
      } finally {
        if (this.detailRunner?.run === holder.run) this.detailRunner = null;
      }
    })();
    holder.run = run;
    run.catch(() => undefined);
    this.detailRunner = { sourceId: source.id, run };
    return run;
  }

  private gatedStreak = new Map<number, {at: number; ids: Set<number>}>();
  /**
   * One gated game page is skipped and retried later; the user is asked only
   * when the site gates page after page (then nothing else can proceed).
   */
  private gatedDetail(source: Source, ex: PageExtract, url: string, id: number) {
    const recent = this.gatedStreak.get(source.id);
    const gates = recent && Date.now() - recent.at < 5 * 60_000 ? recent : {at: Date.now(), ids: new Set<number>()};
    gates.ids.add(id);
    this.gatedStreak.set(source.id, gates);
    const streak = gates.ids.size;
    console.warn('[discovery] game page gated', url, ex.title, `(${streak} in a row)`);
    if (streak >= 3) { this.gatedStreak.delete(source.id); this.blockSource(source, ex, url, id, this.deps.sources.cursor(source.id)?.pagesDone ?? 0); return; }
    this.deps.catalog.recordDetailFailure(id);
    if (ex.gates.blocked) this.deps.limiter.backoff(siteKey(hostOf(url)), 30_000);
  }

  /** Verifies game pages in parallel: description, artwork and download routes. */
  private async detailPass(source: Source, token: SessionToken, limit = DETAILS_PER_PASS) {
    const { catalog, session, sources } = this.deps;
    const todo = catalog.needingDetail(source.id, this.deps.policy.policy(), limit);
    if (!todo.length) return;
    let next = 0;
    let done = 0;
    let deferred = 0;
    let limited: RateLimitedError | null = null;
    const started = Date.now();
    const worker = async () => {
      while (next < todo.length && !limited) {
        session.assertLive(token);
        if (!sources.get(source.id)?.enabled || sources.get(source.id)?.status === 'blocked') return;
        const entry = todo[next++];
        // The policy may have changed while we worked; re-check visibility rules for adult entries.
        if (entry.rating === 'adult' && !this.deps.policy.policy().showNsfw) continue;
        try {
          await this.fetchDetail(entry.id, token);
        } catch (e) {
          if (isCancelled(e) || !session.isLive(token)) throw e;
          if (e instanceof DeferredError) { deferred++; continue; }
          if (e instanceof RateLimitedError) { limited = e; return; }
          if (e instanceof GoneError) { catalog.setDetail(entry.id, { title: null, description: null, author: null, priceText: null, platforms: [], tags: [], categories: [], thumbnailUrl: null, screenshots: [], candidates: [], downloadStatus: 'unavailable' }); continue; }
          catalog.recordDetailFailure(entry.id);
          console.warn('[discovery] detail deferred', entry.pageUrl, (e as Error).message);
        }
        done++;
        if (!sources.get(source.id)?.enabled || sources.get(source.id)?.status === 'blocked') return;
        const rate = done / Math.max(0.5, (Date.now() - started) / 1000);
        this.deps.ai.setStatus({ phase: 'navigating', detail: tm('Verifying games {done}/{total} · {rate}/s', { done, total: todo.length, rate: rate.toFixed(1) }), context: 'discovery' });
        this.status(source, `Verifying games ${done}/${todo.length} · ${rate.toFixed(1)} per second`, sources.cursor(source.id)?.pagesDone ?? 0);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, todo.length) }, worker));
    if (limited) throw limited;
    if (!done && deferred) throw new DeferredError();
  }

  async fetchDetail(id: number, token: SessionToken, options: { refresh?: boolean; foreground?: boolean } = {}) {
    const { catalog, session } = this.deps;
    const entry = catalog.raw(id);
    if (!entry) return;
    session.assertLive(token, 'detail checkpoint');
    if (languageSwitchUrl(entry.pageUrl)) { catalog.setDetail(id, { downloadStatus: 'unavailable' }); return; }
    if (entry.detailFetchedAt && !options.refresh) {
      if (entry.downloadStatus === 'available' && entry.rating === 'unknown' && (entry.classifyAttempts < 4 || entry.classifierVersion !== CLASSIFIER_VERSION)) {
        await this.deps.classification.classifyEntry(id, token.signal);
        this.notifyCatalog(entry.sourceId);
      }
      return;
    }
    await this.inspectDetail(id, token);
  }

  private async inspectDetail(id: number, token: SessionToken) {
    const started = Date.now();
    const { catalog, session, sources } = this.deps;
    const entry = catalog.raw(id);
    if (!entry) return;
    const source = sources.get(entry.sourceId);
    if (!source) return;
    const hasEvidence = (e: PageExtract) => downloadEvidence(e).length > 0;
    let { ex, via } = await this.load(source, entry.pageUrl, token, sources.recipe(source.id)?.detailMode, hasEvidence);
    session.assertLive(token, 'game page');
    if (this.gated(ex)) return this.gatedDetail(source, ex, entry.pageUrl, id);
    let evidence = downloadEvidence(ex);
    // Download buttons rendered by scripts are invisible to the HTTP copy.
    if (!evidence.length && via === 'http') {
      const rendered = await this.load(source, entry.pageUrl, token, 'browser', hasEvidence);
      if (this.gated(rendered.ex)) return this.gatedDetail(source, rendered.ex, entry.pageUrl, id);
      const found = downloadEvidence(rendered.ex);
      if (found.length) {
        ({ ex, via } = rendered);
        evidence = found;
        // Keep the rendered fallback local to this page. A pair of unusual
        // pages must not serialize the site's whole verification backlog.
      }
    }

    const pageReadMs = Date.now() - started;
    let game = ex.game;
    if (evidence.length && !game) {
      // Sitemap entries carry a placeholder from the URL; prefer the page's own title.
      const fromSlug = entry.title === titleFromUrl(entry.pageUrl);
      const pageTitle = (ex.meta['og:title'] || ex.title || '').replace(/\s+[|–—-]\s+[^|–—-]{2,40}$/, '').replace(/\s+free download\b.*$/i, '').trim();
      if (titleMatches(entry.title, ex)) game = pageGame(ex, fromSlug && pageTitle ? pageTitle : entry.title);
      else {
        // Structure alone cannot tell a game page from an article that links
        // downloads; the local AI reads it (text only, no screenshot).
        const checked = await this.agent.confirmGame(ex, token, entry.title, evidence.map((c) => c.label));
        if (checked) game = { ...pageGame(ex, checked.title), description: checked.description || null, platforms: checked.platforms, categories: checked.categories.slice(0, 4), tags: checked.tags.slice(0, 12) };
      }
    }
    const candidates = game ? evidence : [];
    session.assertLive(token, 'download evidence');
    const signals = [
      ...ex.adultSignals,
      ...textAdultSignals(game?.title, game?.description, [...(game?.tags ?? []), ...(game?.categories ?? [])].join(', '), ex.meta['keywords']).map((s) => `text:${s}`),
    ];
    // New descriptions, taxonomy and images must pass content checks before
    // any concurrent catalog request can display the updated detail.
    catalog.invalidateRating(id);
    catalog.setDetail(id, {
      title: game?.title ?? null,
      // The page's own text about the game; SEO lines ("X Free Download …") are skipped.
      description: pickDescription([game?.description, ex.about, ex.meta['og:description'], ex.meta['description']], hostOf(entry.pageUrl)),
      author: game?.author ?? null,
      priceText: game?.price ?? null,
      platforms: asPlatforms([...new Set([...(game?.platforms ?? []), ...candidates.map((c) => c.platform).filter(Boolean)])]),
      tags: game?.tags ?? [],
      categories: game?.categories ?? [],
      thumbnailUrl: entry.thumbnailUrl && !decorativeArtwork(entry.thumbnailUrl) ? null : game?.cover ?? ex.meta['og:image'] ?? null,
      screenshots: game?.screenshots ?? [],
      candidates,
      downloadStatus: game && candidates.length ? 'available' : 'unavailable',
      version: game && candidates.length ? pageFingerprint(ex, candidates) : null,
      popularity: game ? popularitySignals(ex) : null,
      published: ex.published ?? null,
      observedAt: ex.observedAt,
    });
    if (signals.length) catalog.addTextSignals(id, signals);
    const classificationStarted = Date.now();
    if (game && candidates.length) await this.deps.classification.classifyEntry(id, token.signal);
    if (process.env.CGL_DEBUG || Date.now() - started > 2000) console.log('[verification] game', {
      id, sourceId: source.id, via, pageReadMs,
      routeMs: classificationStarted - started - pageReadMs,
      classificationMs: Date.now() - classificationStarted, totalMs: Date.now() - started,
    });
    // After the content check: an automatic update may start downloading right away.
    if (game && candidates.length) { this.deps.updates?.afterDetail(id); this.deps.wishlist?.afterDetail(id); }
    this.notifyCatalog(entry.sourceId);
  }
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

/** The listing's title appears in the page's own heading/title metadata. */
export function titleMatches(title: string, ex: PageExtract): boolean {
  const want = norm(title);
  if (want.length < 3) return false;
  return [ex.game?.title, ex.meta['og:title'], ex.title, ex.text.slice(0, 300)].some((t) => {
    const have = norm(t);
    return have.length >= 3 && (have.includes(want) || want.includes(have) && have.length >= want.length * 0.6);
  });
}

function pageGame(ex: PageExtract, title: string): NonNullable<PageExtract['game']> {
  return {
    title,
    description: ex.meta['og:description'] ?? ex.meta['description'] ?? null,
    cover: ex.meta['og:image'] ?? null,
    screenshots: [],
    platforms: [],
    tags: (ex.meta['keywords'] ?? '').split(',').map((t) => t.trim()).filter((t) => t && t.length <= 40).slice(0, 12),
    categories: [],
    author: null,
    price: null,
    uploads: [],
  };
}
