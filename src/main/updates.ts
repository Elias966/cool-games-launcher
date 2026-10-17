// Game update checks. Installed games are re-checked on their own schedule,
// independent of the Store tab and without the AI: their saved page is read
// in a background Firefox tab and fingerprinted (version, download files, page
// date), and the originally downloaded file is probed for changed HTTP
// validators. A newer build is announced in the Library, or installed
// automatically when the user chose that.
import type { PageExtract } from '@shared/page-extract';
import { downloadEvidence } from '@shared/download-evidence';
import { detectUpdate, fileChanged, fingerprintKey, makeFingerprint, versionLabel, type InstalledFile, type UpdateVerdict, type VersionFingerprint } from '@shared/game-version';
import { hostOf, siteKey } from '@shared/urls';
import type { CatalogRepo, DownloadRecord, DownloadsRepo, GameRecord, GamesRepo, SettingsRepo, SourcesRepo } from './repos';
import type { PageFetcher } from './page-fetcher';
import type { HostRateLimiter } from './rate-limit';
import { toast } from './bus';
import { tm } from './i18n';
import { inspectedInstalledVersion } from './installed-version';

/** The build a game page offers. */
export function pageFingerprint(ex: PageExtract, candidates: Array<{ fileName: string | null; label: string; sizeText: string | null }>, listingTitle?: string | null): VersionFingerprint {
  const fingerprint = makeFingerprint({
    titles: [ex.game?.title, ex.meta['og:title'], ex.title, listingTitle],
    text: ex.text,
    meta: ex.meta,
    candidates,
  });
  if (fingerprint.version) fingerprint.scheme = /^build /.test(fingerprint.version) ? (/\bsteam(?:works)?\s*(?:build|buildid)\s*[:#=-]?\s*\d+/i.test(ex.text) ? 'steam-build' : 'site-build') : 'semantic';
  return fingerprint;
}

/** What the launcher knows about the file it downloaded for a game. */
export function installedFile(d: DownloadRecord | null | undefined): InstalledFile | null {
  if (!d) return null;
  return { url: d.url, name: d.fileName, bytes: d.totalBytes ?? (d.receivedBytes || null), etag: d.etag, lastModified: d.lastModified };
}

const BUSY = new Set(['downloading', 'preparing', 'waiting']);

export class UpdateService {
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;
  private controller = new AbortController();

  constructor(
    private deps: {
      games: GamesRepo;
      catalog: CatalogRepo;
      sources: SourcesRepo;
      downloads: DownloadsRepo;
      settings: SettingsRepo;
      limiter: HostRateLimiter;
      fetcher: PageFetcher | null;
      inspectLocal?: (game: GameRecord, signal: AbortSignal) => Promise<import('../workers/version-evidence').VersionEvidenceResult>;
      readPage?: (url: string, signal: AbortSignal) => Promise<PageExtract>;
      startUpdate: (gameId: number) => Promise<void> | void;
      isRunning: (gameId: number) => boolean;
      broadcast: () => void;
    },
  ) {}

  /** Checks every installed game whose last check is older than the refresh interval, then repeats. */
  start(initialDelayMs = 90_000) {
    this.tracked();
    const tick = () => {
      this.timer = null;
      void this.checkDue().finally(() => { if (!this.controller.signal.aborted) this.timer = setTimeout(tick, 15 * 60_000); this.timer?.unref?.(); });
    };
    this.timer = setTimeout(tick, initialDelayMs);
    this.timer.unref?.();
  }

  stop() {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
  }

  /** Installed games from a website, with the catalog entry they came from. */
  private tracked(): GameRecord[] {
    const out: GameRecord[] = [];
    for (let g of this.deps.games.list()) {
      if (g.update?.unverified && !BUSY.has(g.update.state)) { this.deps.games.update(g.id, { update: null }); this.deps.broadcast(); }
      if (g.store || g.status !== 'installed' || !g.installDir) continue;
      if (g.catalogId === null) {
        const id = this.deps.catalog.matchInstalled(g.title, g.art?.appid);
        if (id === null) continue;
        const entry = this.deps.catalog.raw(id)!;
        this.deps.games.update(g.id, { catalogId: id, sourceHost: hostOf(entry.pageUrl), updateCheckedAt: null });
        g = this.deps.games.get(g.id)!;
      }
      out.push(g);
    }
    return out;
  }

  /** "Check for updates" from the Library: everything, now. */
  checkNow(): number {
    const games = this.tracked();
    for (const g of games) this.deps.games.update(g.id, { updateCheckedAt: null });
    void this.checkDue();
    return games.length;
  }

  checkDue(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const intervalMs = this.deps.settings.get().crawlRefreshHours * 3600_000;
      const due = this.tracked().filter((g) => !this.deps.isRunning(g.id) && (!g.updateCheckedAt || Date.now() - Date.parse(g.updateCheckedAt) >= intervalMs));
      for (const g of due) {
        if (this.controller.signal.aborted) break;
        try { await this.checkGame(g.id, this.controller.signal); }
        catch (e) { if (!this.controller.signal.aborted) console.warn('[updates] check failed', g.title, (e as Error).message); }
      }
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  /** Reads the game's page over HTTP and compares the build it offers with the installed one. */
  async checkGame(gameId: number, signal: AbortSignal) {
    const g = this.deps.games.get(gameId);
    const entry = g?.catalogId ? this.deps.catalog.raw(g.catalogId) : null;
    if (!g || !entry) return;
    const source = this.deps.sources.get(entry.sourceId);
    if (g.store || source?.enabled === false) return;
    if (this.deps.inspectLocal) {
      const evidence = await this.deps.inspectLocal(g, signal);
      if (signal.aborted) return;
      const d = g.downloadId ? this.deps.downloads.get(g.downloadId) : null;
      this.deps.games.update(g.id, { installedVersion: inspectedInstalledVersion(g, d, evidence), ...(g.update?.unverified ? { update: null } : {}) });
      this.deps.broadcast();
    }
    let current: VersionFingerprint | null = null;
    const fetcher = this.deps.fetcher;
    if (this.deps.readPage || fetcher) {
      await this.deps.limiter.wait(siteKey(hostOf(entry.pageUrl)), source?.rateLimitMs ?? 1000, signal);
      // Firefox shares the user's website cookies, renders script links, and
      // reads a dedicated background tab without visiting a homepage/search.
      const ex = this.deps.readPage ? await this.deps.readPage(entry.pageUrl, signal).catch(() => null)
        : await fetcher!.fetch(entry.pageUrl, signal).then(r => r.ok ? r.extract : null).catch(() => null);
      if (signal.aborted) return;
      const samePage = ex && new URL(ex.url).origin === new URL(entry.pageUrl).origin && new URL(ex.url).pathname.replace(/\/$/, '') === new URL(entry.pageUrl).pathname.replace(/\/$/, '');
      if (ex && samePage && !ex.gates.captcha && !ex.gates.blocked && !ex.gates.login) {
        const evidence = downloadEvidence(ex, Number.MAX_SAFE_INTEGER);
        if (evidence.length) {
          current = pageFingerprint(ex, evidence);
          // Keep the indexed bookmark and crawl checkpoint intact. Challenge
          // tokens in a rendered URL must never become the saved game link.
          this.deps.catalog.setVersion(entry.id, current, evidence);
        } else {
          // Download buttons drawn by scripts: the Store's next pass reads it in Firefox.
          this.deps.catalog.markStale([entry.id]);
        }
      }
      if (!current) {
        // A failed/gated read must not report a successful check using stale
        // catalog data. The next check retries after the website is verified.
        console.warn('[updates] could not verify current game page', g.title);
        toast('info', tm('Could not check {title}. Open its saved website page in the Store browser to complete any verification, then check again.', { title: g.title }));
        return;
      }
    }
    // The file the game was installed from, at the same address: changed validators mean a re-upload.
    let head: Awaited<ReturnType<PageFetcher['headFile']>> | null = null;
    const file = this.deps.games.get(gameId)?.installedVersion?.file;
    if (fetcher && file?.url && /^https?:/i.test(file.url)) {
      await this.deps.limiter.wait(siteKey(hostOf(file.url)), 1000, signal);
      head = await fetcher.headFile(file.url, signal, entry.pageUrl).catch(() => null);
    }
    this.evaluate(gameId, current ?? entry.version, head);
  }

  /** Compares a game's installed build with the page's current one and records the verdict. */
  evaluate(gameId: number, current: VersionFingerprint | null, head?: Parameters<typeof fileChanged>[1]) {
    let g = this.deps.games.get(gameId);
    if (!g) return;
    const checkedAt = new Date().toISOString();
    if (!current && !head) { this.deps.games.update(gameId, { updateCheckedAt: checkedAt }); return; }
    if (!g.installedVersion) {
      const d = g.downloadId ? this.deps.downloads.get(g.downloadId) : null;
      this.deps.games.update(gameId, { installedVersion: inspectedInstalledVersion(g, d, { evidence: [], inspectedPaths: [], rejectedResources: [], candidateSnippets: [], limitsReached: false, limitations: [] }) });
      g = this.deps.games.get(gameId)!;
    }
    const installed = g.installedVersion!;
    const scheme = current?.scheme ?? (current?.version ? /^build /.test(current.version) ? 'site-build' : 'semantic' : undefined);
    const matched = installed.identifiers?.find(e => e.scheme === scheme);
    const comparable = matched ? { ...installed, version: matched.version, scheme: matched.scheme } : installed;
    let verdict: UpdateVerdict = detectUpdate(comparable, current);
    const incompatible = !!installed.version && !!current?.version && (installed.scheme && scheme && installed.scheme !== scheme && !matched || !matched && /^build /.test(installed.version) !== /^build /.test(current.version));
    if (installed.inspection) {
      this.deps.games.update(gameId, { installedVersion: { ...installed, inspection: {
        ...installed.inspection, checkedAt, state: incompatible ? 'incomparable' : installed.version ? 'identified' : 'unresolved',
        detail: incompatible ? `Installed ${versionLabel(installed)}; the website publishes ${versionLabel(current)} using a different build system. A newer game version could not be verified.` : installed.inspection.detail,
      } } });
    }
    const unresolved = installed.inspection?.state === 'unresolved';
    const reuploaded = !unresolved && fileChanged(g.installedVersion!.file, head ?? null);
    if (!verdict.update && !incompatible && reuploaded) {
      verdict = { update: true, from: versionLabel(g.installedVersion) ?? 'installed build', to: versionLabel(current) ?? 'new build', reason: 'the download file changed on the server' };
    }
    const key = [current ? fingerprintKey(current) : '', reuploaded && head ? `h:${head.etag ?? head.bytes ?? head.lastModified}` : ''].filter(Boolean).join('|') || checkedAt;
    const prev = g.update;
    if (incompatible || unresolved) verdict = { update: false, from: versionLabel(installed), to: versionLabel(current), reason: 'different version identifiers cannot be compared' };
    if (!verdict.update) {
      // The site went back to the installed build: nothing to offer any more.
      const clear = prev?.state === 'available' || prev?.state === 'failed';
      this.deps.games.update(gameId, { updateCheckedAt: checkedAt, ...(clear ? { update: null } : {}) });
      this.deps.broadcast();
      return;
    }
    // A stored "downloading" whose download failed or was removed is no longer in progress.
    const stalled = prev?.state === 'downloading' && (() => { const d = prev.downloadId ? this.deps.downloads.get(prev.downloadId) : null; return !d || d.state === 'failed' || d.state === 'cancelled'; })();
    if (prev && ((BUSY.has(prev.state) && !stalled) || prev.key === key)) {
      this.deps.games.update(gameId, { updateCheckedAt: checkedAt });
      return;
    }
    console.log(`[updates] ${g.title}: ${verdict.reason}`);
    this.deps.games.update(gameId, {
      updateCheckedAt: checkedAt,
      update: { state: 'available', from: verdict.from, to: verdict.to, reason: verdict.reason, detectedAt: checkedAt, key, unverified: false },
    });
    this.deps.broadcast();
    if (this.deps.settings.get().gameUpdates === 'auto') {
      toast('info', verdict.to ? tm('Updating {title} to {version}…', { title: g.title, version: verdict.to }) : tm('Updating {title}…', { title: g.title }));
      void Promise.resolve(this.deps.startUpdate(gameId)).catch((e) => toast('error', tm('Could not update {title}: {detail}', { title: g.title, detail: (e as Error).message })));
    } else {
      toast('info', verdict.from && verdict.to ? tm('Update available for {title}: {from} → {to}. Open the Library to update.', { title: g.title, from: verdict.from, to: verdict.to }) : tm('Update available for {title}. Open the Library to update.', { title: g.title }));
    }
  }

  /** The Store re-verified a game page: installed copies compare against it right away. */
  afterDetail(catalogId: number) {
    const entry = this.deps.catalog.raw(catalogId);
    if (!entry?.version) return;
    for (const g of this.deps.games.list()) if (g.catalogId === catalogId && !g.store && g.status === 'installed') this.evaluate(g.id, entry.version);
  }
}
