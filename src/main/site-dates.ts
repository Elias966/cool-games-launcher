// Posting-date reads belong to the launcher, not a model or browser agent.
import type { CatalogRepo, SourcesRepo } from './repos';
import type { PageFetcher } from './page-fetcher';
import type { PageExtract } from '@shared/page-extract';
import type { HostRateLimiter } from './rate-limit';
import { recipeCards, recentListingLinks } from '@shared/site-recipe';
import { titleKey, hostOf, siteKey } from '@shared/urls';

export class SiteDates {
  private active = false;
  private controller: AbortController | null = null;
  private task: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private priority: number[] = [];
  private again = false;
  private fronts = new Map<number, number>();
  private retry = new Map<number, number>();
  private gate: {url: string; sourceId: number; entryId: number | null} | null = null;

  constructor(private deps: {
    catalog: CatalogRepo; sources: SourcesRepo; fetcher: PageFetcher;
    limiter: HostRateLimiter; changed: () => void;
    classify?: (id: number, signal: AbortSignal) => Promise<unknown>;
    verify?: () => void;
  }) {}

  setActive(active: boolean) {
    this.active = active;
    if (!active) {
      this.controller?.abort();
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    } else {
      if (!this.timer) {
        this.timer = setInterval(() => this.poke(), 5 * 60_000);
        this.timer.unref();
      }
      this.poke();
    }
  }

  prioritize(ids: number[]) {
    this.priority = [...new Set([...ids, ...this.priority])].slice(0, 1000);
    this.poke();
  }

  stop() { this.setActive(false); }

  private poke() {
    if (!this.active) return;
    if (this.task) { this.again = true; return; }
    const controller = new AbortController();
    this.controller = controller;
    this.task = this.run(controller.signal).catch(error => {
      if (!controller.signal.aborted) console.warn('[site-dates]', (error as Error).message);
    }).finally(() => {
      this.task = null;
      if (this.active && (this.priority.length || this.again)) {
        this.again = false;
        setTimeout(() => this.poke(), 0).unref();
      }
    });
  }

  private askForVerification(ex: PageExtract, url: string, sourceId: number, entryId: number | null) {
    if (!this.deps.verify || !ex.gates.captcha && !ex.gates.login && !ex.gates.blocked) return false;
    this.gate = {url,sourceId,entryId};
    this.setActive(false);
    this.deps.verify();
    return true;
  }

  /** Read a solved live page before any front-page refresh can navigate away. */
  private async resumeVerification(signal: AbortSignal) {
    const gate = this.gate;
    if (!gate) return;
    const r = await this.deps.fetcher.fetchBackground(gate.url,signal,gate.entryId !== null);
    if (signal.aborted || !r.ok) return;
    if (this.askForVerification(r.extract,gate.url,gate.sourceId,gate.entryId)) return;
    if (gate.entryId !== null && r.extract.url.replace(/\/$/,'') === gate.url.replace(/\/$/,'')) {
      this.deps.catalog.recordSiteDate(gate.entryId,r.extract.published ?? null,r.extract.observedAt);
      this.retry.delete(gate.entryId);
      this.deps.changed();
    }
    this.gate = null;
    this.fronts.delete(gate.sourceId);
  }

  /** Learned URL patterns identify recent links without model navigation.
   * New covers retain the normal content classification. */
  private async readFrontPages(signal: AbortSignal) {
    for (const source of this.deps.sources.list().filter(s => s.enabled)) {
      if (signal.aborted) return;
      const recipe = this.deps.sources.recipe(source.id);
      if (!recipe?.game.length || Date.now() - (this.fronts.get(source.id) ?? 0) < 5 * 60_000) continue;
      this.fronts.set(source.id, Date.now());
      const pages = [source.url];
      for (let n = 0; n < pages.length && n < 3 && !signal.aborted; n++) {
        try {
          await this.deps.limiter.wait(siteKey(hostOf(pages[n])), source.rateLimitMs, signal);
          const r = await this.deps.fetcher.fetchBackground(pages[n], signal);
          if (signal.aborted) return;
          if (r.ok && this.askForVerification(r.extract,pages[n],source.id,null)) return;
          if (!r.ok || r.extract.gates.captcha || r.extract.gates.blocked || r.extract.gates.login) continue;
          const ex = r.extract, recent = new Set(ex.recentGameLinks ?? []);
          const cards = recipeCards(ex, recipe).sort((a, b) => Number(recent.has(b.href)) - Number(recent.has(a.href)));
          const ids: number[] = [];
          for (const card of cards) {
            if (signal.aborted) return;
            // Ordering must not retitle existing games from weaker listing markup.
            const existing = this.deps.catalog.idByUrl(source.id,card.href);
            const id = existing ?? this.deps.catalog.upsertListing(source.id, {
              pageUrl: card.href, title: card.title, titleKey: titleKey(card.title),
              thumbnailUrl: card.img, tags: card.tags, categories: card.categories,
            }).id;
            ids.push(id);
            if (existing === null) this.deps.catalog.markListed([id]);
            if (this.deps.catalog.raw(id)?.rating === 'unknown') await this.deps.classify?.(id, signal);
          }
          this.priority = [...ids, ...this.priority];
          for (const url of recentListingLinks(ex)) if (!pages.includes(url)) pages.push(url);
          if (ids.length) this.deps.changed();
        } catch { if (signal.aborted) return; }
      }
    }
  }

  private async run(signal: AbortSignal) {
    await this.resumeVerification(signal);
    for (;;) {
      if (signal.aborted || !this.active) return;
      await this.readFrontPages(signal);
      const prioritized = this.deps.catalog.datesNeedingCheck(this.priority, 1000);
      this.priority = [];
      const ids = [...new Set([...prioritized, ...this.deps.catalog.dateCheckBatch(10000)])]
        .filter(id => (this.retry.get(id) ?? 0) <= Date.now()).slice(0, 80);
      if (!ids.length) return;
      let next = 0, changed = false;
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (next < ids.length && !signal.aborted) {
          const id = ids[next++], entry = this.deps.catalog.raw(id);
          if (!entry) continue;
          const source = this.deps.sources.get(entry.sourceId);
          if (!source?.enabled) continue;
          try {
            await this.deps.limiter.wait(siteKey(hostOf(entry.pageUrl)), source.rateLimitMs, signal);
            const r = await this.deps.fetcher.fetchBackground(entry.pageUrl, signal, true);
            if (signal.aborted) return;
            const ex = r.ok ? r.extract : null;
            if (ex && this.askForVerification(ex,entry.pageUrl,source.id,id)) return;
            const expected = new URL(entry.pageUrl), actual = ex ? new URL(ex.url) : null;
            if (ex && actual?.origin === expected.origin && actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '') &&
              !ex.gates.captcha && !ex.gates.login && !ex.gates.blocked) {
              this.deps.catalog.recordSiteDate(id, ex.published ?? null, ex.observedAt);
              changed = true;
            } else this.retry.set(id, Date.now() + 10 * 60_000);
          } catch {
            if (signal.aborted) return;
            this.retry.set(id, Date.now() + 10 * 60_000);
          }
        }
      }));
      if (changed) this.deps.changed();
    }
  }
}
