// Updates the launcher itself from the project's GitHub releases. A release
// carries the AppImage and a SHA256SUMS file; the new AppImage is downloaded
// next to the running one, checked against SHA256SUMS, and swapped in with a
// rename (atomic on the same filesystem) before the launcher restarts.
// When the release also has a block index ("<AppImage>.blocks"), only the parts
// of the new AppImage that the installed one lacks are downloaded (HTTP range
// requests) and the rest is copied from the installed file; see
// scripts/block-delta.mjs. Anything unexpected falls back to the whole file.

/** Below this share of the whole file, downloading only the changed parts is worth it. */
const CHANGED_PARTS_LIMIT = 0.7;
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, closeSync, constants, copyFileSync, createReadStream, createWriteStream, existsSync, openSync, readSync, renameSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, join } from 'node:path';
import type { LauncherUpdate } from '@shared/types';
import { tm } from './i18n';
import { findLocalBlocks, missingRanges, parseIndex } from '../../scripts/block-delta.mjs';

export const UPDATE_REPO = 'Elias966/cool-games-launcher';
// CGL_UPDATE_TEST_ORIGIN points the updater at a local stand-in for GitHub (tests only).
const TEST_ORIGIN = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.CGL_UPDATE_TEST_ORIGIN ?? '') ? process.env.CGL_UPDATE_TEST_ORIGIN! : null;
const LATEST = `${TEST_ORIGIN ?? 'https://api.github.com'}/repos/${UPDATE_REPO}/releases/latest`;
// Release files are served from GitHub and its download hosts only.
const GITHUB_HOST = /^https:\/\/(?:github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//;
const assetHost = (url: string) => GITHUB_HOST.test(url) || (TEST_ORIGIN !== null && url.startsWith(`${TEST_ORIGIN}/`));

/** <0 when a is older than b, 0 when equal, >0 when newer ("v0.2.10" > "0.2.9"). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export interface ReleaseInfo {
  version: string;
  notes: string | null;
  pageUrl: string;
  asset: { name: string; url: string; size: number };
  sumsUrl: string | null;
  /** The block index of the AppImage, for downloading only what changed. */
  blocksUrl: string | null;
}

interface GithubRelease {
  tag_name?: string;
  body?: string | null;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
}

/** The AppImage and checksum file of a GitHub release, or null when it has no AppImage for this computer. */
export function readRelease(r: GithubRelease): ReleaseInfo | null {
  if (!r.tag_name || r.draft || r.prerelease) return null;
  const assets = (r.assets ?? []).filter((a) => a.name && a.browser_download_url && assetHost(a.browser_download_url));
  const image = assets.find((a) => /x86_64\.AppImage$/i.test(a.name!)) ?? assets.find((a) => /\.AppImage$/i.test(a.name!));
  if (!image) return null;
  const sums = assets.find((a) => a.name === 'SHA256SUMS');
  const blocks = assets.find((a) => a.name === `${image.name}.blocks`);
  return {
    version: r.tag_name.replace(/^v/i, ''),
    notes: r.body?.trim() || null,
    pageUrl: r.html_url ?? `https://github.com/${UPDATE_REPO}/releases`,
    asset: { name: image.name!, url: image.browser_download_url!, size: image.size ?? 0 },
    sumsUrl: sums?.browser_download_url ?? null,
    blocksUrl: blocks?.browser_download_url ?? null,
  };
}

/** The SHA-256 that SHA256SUMS lists for a file name. */
export function expectedSum(sums: string, fileName: string): string | null {
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m && m[2] === fileName) return m[1].toLowerCase();
  }
  return null;
}

/** An ELF file with the AppImage type-2 marker ("AI\x02" at offset 8). */
export function looksLikeAppImage(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const b = Buffer.alloc(11);
    if (readSync(fd, b, 0, 11, 0) < 11) return false;
    return b[0] === 0x7f && b.toString('latin1', 1, 4) === 'ELF' && b[8] === 0x41 && b[9] === 0x49 && b[10] === 0x02;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface SelfUpdateDeps {
  version: string;
  /** Path of the running AppImage ($APPIMAGE); null when not running from one. */
  appImage: string | null;
  fetch: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  publish: (s: LauncherUpdate) => void;
  /** Tells the person once per version that an update exists. */
  announce: (version: string) => void;
  /** Starts the given AppImage and quits this instance. */
  restart: (appImage: string) => void;
}

export class SelfUpdater {
  private state: LauncherUpdate;
  private release: ReleaseInfo | null = null;
  private abort: AbortController | null = null;
  private announced = new Set<string>();

  constructor(private readonly deps: SelfUpdateDeps) {
    this.state = {
      current: deps.version, state: 'idle', latest: null, notes: null, pageUrl: `https://github.com/${UPDATE_REPO}/releases`,
      size: null, received: 0, error: null, checkedAt: null, canInstall: this.canInstall(), phase: null, fullSize: null,
    };
    this.cleanup();
  }

  status(): LauncherUpdate {
    return { ...this.state };
  }

  private set(patch: Partial<LauncherUpdate>) {
    this.state = { ...this.state, ...patch };
    this.deps.publish(this.status());
  }

  /** The AppImage can be replaced in place: running from one, in a folder this user can write. */
  private canInstall(): boolean {
    const p = this.deps.appImage;
    if (!p || !existsSync(p)) return false;
    try { accessSync(dirname(p), constants.W_OK); accessSync(p, constants.W_OK); return true; } catch { return false; }
  }

  private get partPath(): string | null {
    return this.deps.appImage ? join(dirname(this.deps.appImage), `.${basename(this.deps.appImage)}.update`) : null;
  }

  /** Removes a half-downloaded update left by an earlier run. */
  private cleanup() {
    const part = this.partPath;
    if (part && existsSync(part)) rmSync(part, { force: true });
  }

  async check(manual = false): Promise<LauncherUpdate> {
    if (['checking', 'downloading', 'ready'].includes(this.state.state)) return this.status();
    this.set({ state: 'checking', error: null });
    try {
      const res = await this.deps.fetch(LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `CoolGamesLauncher/${this.deps.version}` } });
      if (res.status === 404) throw new Error(tm('No release has been published yet.'));
      if (!res.ok) throw new Error(tm('GitHub answered with HTTP {code}.', { code: res.status }));
      const release = readRelease((await res.json()) as GithubRelease);
      const checkedAt = new Date().toISOString();
      if (!release || compareVersions(release.version, this.deps.version) <= 0) {
        this.release = null;
        this.set({ state: 'up-to-date', latest: release?.version ?? this.deps.version, notes: null, checkedAt });
        return this.status();
      }
      this.release = release;
      this.set({ state: 'available', latest: release.version, notes: release.notes, pageUrl: release.pageUrl, size: release.asset.size || null, received: 0, checkedAt, canInstall: this.canInstall() });
      if (!manual && !this.announced.has(release.version)) {
        this.announced.add(release.version);
        this.deps.announce(release.version);
      }
    } catch (e) {
      this.set({ state: 'error', error: (e as Error).message, checkedAt: new Date().toISOString() });
    }
    return this.status();
  }

  /** Downloads the new AppImage next to the running one and verifies it. */
  async download(): Promise<LauncherUpdate> {
    const release = this.release;
    const part = this.partPath;
    if (!release || this.state.state !== 'available' && this.state.state !== 'error') return this.status();
    if (!part || !this.canInstall()) { this.set({ state: 'error', error: tm('This copy cannot replace itself. Download the new version from the release page.') }); return this.status(); }
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.set({ state: 'downloading', received: 0, size: release.asset.size || null, error: null, phase: null, fullSize: null });
    try {
      if (!release.sumsUrl) throw new Error(tm('The release has no SHA256SUMS file, so the download cannot be verified.'));
      const sumsRes = await this.deps.fetch(release.sumsUrl, { signal });
      if (!sumsRes.ok) throw new Error(tm('Could not read SHA256SUMS (HTTP {code}).', { code: sumsRes.status }));
      const want = expectedSum(await sumsRes.text(), release.asset.name);
      if (!want) throw new Error(tm('SHA256SUMS does not list {file}.', { file: release.asset.name }));

      let ok = false;
      if (release.blocksUrl) {
        try {
          ok = await this.downloadChanged(release, want, part, signal);
        } catch (e) {
          if (signal.aborted) throw e;
          // Anything unexpected: the whole file instead.
          rmSync(part, { force: true });
        }
      }
      if (!ok) await this.downloadWhole(release, want, part, signal);
      chmodSync(part, 0o755);
      if (!looksLikeAppImage(part)) throw new Error(tm('The downloaded file is not an AppImage. Nothing was changed.'));
      this.set({ state: 'ready' });
    } catch (e) {
      rmSync(part, { force: true });
      this.set({ state: signal.aborted ? 'available' : 'error', error: signal.aborted ? null : (e as Error).message, received: 0, phase: null, fullSize: null });
    } finally {
      this.abort = null;
    }
    return this.status();
  }

  private async downloadWhole(release: ReleaseInfo, want: string, part: string, signal: AbortSignal) {
    const res = await this.deps.fetch(release.asset.url, { signal });
    if (!res.ok || !res.body) throw new Error(tm('The download failed (HTTP {code}).', { code: res.status }));
    const size = Number(res.headers.get('content-length')) || release.asset.size || null;
    this.set({ phase: 'whole', size, received: 0, fullSize: null });
    const hash = createHash('sha256');
    const out = createWriteStream(part, { mode: 0o755 });
    let received = 0;
    let last = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        const now = Date.now();
        if (now - last > 250) { last = now; this.set({ received, size }); }
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    }
    this.set({ received, size: size ?? received });
    if (hash.digest('hex') !== want) throw new Error(tm('The downloaded file does not match its checksum. Nothing was changed.'));
  }

  /**
   * Builds the new AppImage from the parts the installed one already has plus
   * the changed parts, downloaded with range requests. False when that would
   * not save much; throws when anything does not add up (the caller then
   * downloads the whole file).
   */
  private async downloadChanged(release: ReleaseInfo, want: string, part: string, signal: AbortSignal): Promise<boolean> {
    const current = this.deps.appImage!;
    const res = await this.deps.fetch(release.blocksUrl!, { signal });
    if (!res.ok) return false;
    const index = parseIndex(Buffer.from(await res.arrayBuffer()));
    if (release.asset.size && index.size !== release.asset.size) return false;

    this.set({ phase: 'scanning', received: 0, size: index.size, fullSize: index.size });
    let lastScan = 0;
    const found = await findLocalBlocks(current, index, (f) => {
      if (signal.aborted) throw new Error('aborted');
      const now = Date.now();
      if (now - lastScan > 250) { lastScan = now; this.set({ received: Math.round(f * index.size) }); }
    });
    const ranges = missingRanges(found, index);
    const needed = ranges.reduce((n, [a, b]) => n + b - a, 0);
    if (needed > index.size * CHANGED_PARTS_LIMIT) return false;

    const out = await open(part, 'w', 0o755);
    try {
      await out.truncate(index.size);
      // The parts this copy already has.
      const old = await open(current, 'r');
      try {
        const buf = Buffer.allocUnsafe(index.blockSize);
        for (let i = 0; i < index.count; i++) {
          if (found[i] < 0) continue;
          if (signal.aborted) throw new Error('aborted');
          const len = Math.min(index.blockSize, index.size - i * index.blockSize);
          const { bytesRead } = await old.read(buf, 0, len, found[i]);
          if (bytesRead !== len) throw new Error('short read');
          await out.write(buf, 0, len, i * index.blockSize);
        }
      } finally {
        await old.close();
      }
      // The changed parts, a few ranges at a time.
      this.set({ phase: 'changed', received: 0, size: needed, fullSize: index.size });
      let received = 0;
      let last = 0;
      const queue = [...ranges];
      const worker = async () => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          const [start, end] = r;
          const got = await this.deps.fetch(release.asset.url, { signal, headers: { Range: `bytes=${start}-${end - 1}` } });
          if (got.status !== 206 || !got.body) throw new Error(`range request answered ${got.status}`);
          let pos = start;
          const reader = got.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (pos + value.length > end) throw new Error('range longer than asked');
            await out.write(value, 0, value.length, pos);
            pos += value.length;
            received += value.length;
            const now = Date.now();
            if (now - last > 250) { last = now; this.set({ received }); }
          }
          if (pos !== end) throw new Error('range shorter than asked');
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      this.set({ received: needed });
    } finally {
      await out.close();
    }
    const hash = createHash('sha256');
    await pipeline(createReadStream(part), hash);
    if (hash.digest('hex') !== want) throw new Error('rebuilt file does not match its checksum');
    return true;
  }

  cancel() {
    this.abort?.abort();
  }

  /** Swaps the verified download in and restarts into it. */
  install() {
    const part = this.partPath;
    if (this.state.state !== 'ready' || !part || !this.deps.appImage || !existsSync(part)) throw new Error(tm('No verified update is ready.'));
    renameSync(part, this.deps.appImage);
    this.deps.restart(this.deps.appImage);
  }

  /** Replaces the launcher with an AppImage the person chose, then restarts into it. */
  installFile(file: string) {
    const target = this.deps.appImage;
    const part = this.partPath;
    if (!target || !part || !this.canInstall()) throw new Error(tm('This copy cannot replace itself. Run the new AppImage directly instead.'));
    if (!looksLikeAppImage(file)) throw new Error(tm('That file is not an AppImage.'));
    copyFileSync(file, part);
    chmodSync(part, 0o755);
    renameSync(part, target);
    this.deps.restart(target);
  }
}
