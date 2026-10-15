// Game update checks. Installed games are re-checked on their own schedule,
// independent of the Store tab and without the AI: their page is read over
// HTTP, the build it offers is fingerprinted (version, download files, page
// date), and the originally downloaded file is probed for changed HTTP
// validators. A newer build is announced in the Library, or installed
// automatically when the user chose that.
import type { PageExtract } from '@shared/page-extract';
import { downloadEvidence } from '@shared/download-evidence';
import { detectUpdate, fileChanged, fingerprintKey, makeFingerprint, versionLabel, type InstalledFile, type InstalledVersion, type UpdateVerdict, type VersionFingerprint } from '@shared/game-version';
import { hostOf, siteKey } from '@shared/urls';
import type { CatalogRepo, DownloadRecord, DownloadsRepo, GameRecord, GamesRepo, SettingsRepo, SourcesRepo } from './repos';
import type { PageFetcher } from './page-fetcher';
import type { HostRateLimiter } from './rate-limit';
import { toast } from './bus';

/** The build a game page offers. */
export function pageFingerprint(ex: PageExtract, candidates: Array<{ fileName: string | null; label: string; sizeText: string | null }>, listingTitle?: string | null): VersionFingerprint {
  return makeFingerprint({
    titles: [ex.game?.title, ex.meta['og:title'], ex.title, listingTitle],
    text: ex.text,
    meta: ex.meta,
    candidates,
  });
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
      startUpdate: (gameId: number) => Promise<void> | void;
      isRunning: (gameId: number) => boolean;
      broadcast: () => void;
    },
  ) {}

  /** Checks every installed game whose last check is older than the refresh interval, then repeats. */
  start(initialDelayMs = 90_000) {
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
    return this.deps.games.list().filter((g) => g.catalogId !== null && g.managed && g.status === 'installed');
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
      const due = this.tracked().filter((g) => !g.updateCheckedAt || Date.now() - Date.parse(g.updateCheckedAt) >= intervalMs);
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
    let current: VersionFingerprint | null = null;
    const fetcher = this.deps.fetcher;
    if (fetcher && source?.enabled !== false) {
      await this.deps.limiter.wait(siteKey(hostOf(entry.pageUrl)), source?.rateLimitMs ?? 1000, signal);
      const r = await fetcher.fetch(entry.pageUrl, signal).catch(() => null);
      if (r?.ok && !r.extract.gates.captcha && !r.extract.gates.blocked) {
        const evidence = downloadEvidence(r.extract);
        if (evidence.length) {
          current = pageFingerprint(r.extract, evidence);
          this.deps.catalog.setVersion(entry.id, current);
        } else {
          // Download buttons drawn by scripts: the Store's next pass reads it in Firefox.
          this.deps.catalog.markStale([entry.id]);
        }
      }
    }
    // The file the game was installed from, at the same address: changed validators mean a re-upload.
    let head: Awaited<ReturnType<PageFetcher['headFile']>> | null = null;
    const file = g.installedVersion?.file;
    if (fetcher && file?.url && /^https?:/i.test(file.url)) {
      await this.deps.limiter.wait(siteKey(hostOf(file.url)), 1000, signal);
      head = await fetcher.headFile(file.url, signal, entry.pageUrl).catch(() => null);
    }
    this.evaluate(gameId, current ?? entry.version, head);
  }

  /** Compares a game's installed build with the page's current one and records the verdict. */
  evaluate(gameId: number, current: VersionFingerprint | null, head?: Parameters<typeof fileChanged>[1]) {
    const g = this.deps.games.get(gameId);
    if (!g) return;
    const checkedAt = new Date().toISOString();
    if (!current && !head) { this.deps.games.update(gameId, { updateCheckedAt: checkedAt }); return; }
    if (!g.installedVersion) {
      // Installed before update tracking: today's page is the baseline.
      const d = g.downloadId ? this.deps.downloads.get(g.downloadId) : null;
      const base: InstalledVersion = { ...(current ?? { version: null, updated: null, files: [], sizes: [], at: checkedAt }), file: installedFile(d) };
      this.deps.games.update(gameId, { installedVersion: base, updateCheckedAt: checkedAt });
      return;
    }
    let verdict: UpdateVerdict = detectUpdate(g.installedVersion, current);
    const reuploaded = fileChanged(g.installedVersion.file, head ?? null);
    if (!verdict.update && reuploaded) {
      verdict = { update: true, from: versionLabel(g.installedVersion) ?? 'installed build', to: versionLabel(current) ?? 'new build', reason: 'the download file changed on the server' };
    }
    const key = [current ? fingerprintKey(current) : '', reuploaded && head ? `h:${head.etag ?? head.bytes ?? head.lastModified}` : ''].filter(Boolean).join('|') || checkedAt;
    const prev = g.update;
    if (!verdict.update) {
      // The site went back to the installed build: nothing to offer any more.
      const clear = prev?.state === 'available' || prev?.state === 'failed';
      this.deps.games.update(gameId, { updateCheckedAt: checkedAt, ...(clear ? { update: null } : {}) });
      if (clear) this.deps.broadcast();
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
      update: { state: 'available', from: verdict.from, to: verdict.to, reason: verdict.reason, detectedAt: checkedAt, key },
    });
    this.deps.broadcast();
    if (this.deps.settings.get().gameUpdates === 'auto') {
      toast('info', `Updating ${g.title}${verdict.to ? ` to ${verdict.to}` : ''}…`);
      void Promise.resolve(this.deps.startUpdate(gameId)).catch((e) => toast('error', `Could not update ${g.title}: ${(e as Error).message}`));
    } else {
      toast('info', `Update available for ${g.title}${verdict.from && verdict.to ? `: ${verdict.from} → ${verdict.to}` : ''}. Open the Library to update.`);
    }
  }

  /** The Store re-verified a game page: installed copies compare against it right away. */
  afterDetail(catalogId: number) {
    const entry = this.deps.catalog.raw(catalogId);
    if (!entry?.version) return;
    for (const g of this.deps.games.list()) if (g.catalogId === catalogId && g.managed && g.status === 'installed') this.evaluate(g.id, entry.version);
  }
}
