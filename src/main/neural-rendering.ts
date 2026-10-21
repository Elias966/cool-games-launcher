// DLSS 5 Neural Rendering for Windows games under Proton, the way the Linux
// community tools do it (dlss5-linux, DLSS5oneclick): an OptiScaler build with
// Neural Rendering (GPL-3, y4my4my4m's fork of Dagherbou's) goes into the game
// folder as a proxy DLL, loaded through WINEDLLOVERRIDES, and runs NVIDIA's
// neural-rendering runtime (nvngx_dlssnr.dll) on the game's DLSS output.
//
// The runtime is NVIDIA's and is never downloaded: it comes from the person's
// own games that ship DLSS 5 (found by a scan, so newer models arrive with game
// updates) or from a file they import. NVIDIA builds it for RTX 50 cards; for
// RTX 20/30/40 the open-source dlssnr-patcher (GPL-2) rebuilds its GPU code for
// the card, here on the person's machine, with their CUDA Toolkit.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, chmodSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { NrStatus, Settings } from '@shared/types';
import { readPeVersion } from './pe-version';

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/** Where the person can download NVIDIA's DLSS files, including Neural Rendering, in their browser. */
export const DLSS_FILES_PAGE = 'https://www.techspot.com/downloads/7544-nvidia-dlss-files.html';
export const OPTISCALER_REPO = 'y4my4my4m/OptiScaler_DLSSNR_Multipass_MFG';
/** The original OptiScaler + DLSS Neural Rendering; y4my4my4m's builds add Proton fixes and multipass on top. */
export const DAGHERBOU_REPO = 'Dagherbou/OptiScaler_DLSSNR';
/** Pre-upscale multipass Neural Rendering with Proton fixes and an RTX 20/30 frame generation unlocker (GPL-3). */
export const SHYVORTEX_REPO = 'ShyVortex/OptiScaler-DLSSNR-PreSR-Multipass';
export const isShyVortex = (name: string) => /^OptiScaler-NR-v/.test(name);
export const PATCHER_REPO = 'dev-camo/dlssnr-patcher';
/** The reviewed patcher (2026-09-03); moving it means reading the new commit first. */
export const PATCHER_COMMIT = '98dac112990e5cea30ab03d74625fc848bce5c92';
export const PATCHER_SHA256 = '6dabddd81214130b8a9daebbbc0dde3f6592f9806f42b0bd6bda355a2f46be10';
/** The CUDA release the patcher is written for; NVIDIA lists each part with its SHA-256. */
export const CUDA_REDIST = 'https://developer.download.nvidia.com/compute/cuda/redist';
export const CUDA_RELEASE = '13.3.1';
/** The parts that hold the patcher's three tools, and the tools taken from them. */
const CUDA_PARTS: Record<string, string[]> = { cuda_nvcc: ['ptxas', 'fatbinary'], cuda_cuobjdump: ['cuobjdump'] };
/** The nightly dlss5-linux tested on FF7 Rebirth, 007 First Light and Horizon under Proton. */
export const TESTED_OPTISCALER = 'OptiScaler_v10.0.0-pre1_20260906.7z';
const RUNTIME = 'nvngx_dlssnr.dll';
/** Proxy names OptiScaler answers to, in the order dlss5-linux tries them. */
export const PROXY_NAMES = ['dxgi.dll', 'winmm.dll', 'version.dll', 'dbghelp.dll', 'wininet.dll', 'winhttp.dll'];

/** What a runtime is, from its SHA-256 (dlss5-linux's FINDINGS.md lists the circulating builds). */
export function identifyBuild(sha256: string): NrStatus['runtimes'][number]['build'] {
  if (sha256.startsWith('e67dee209320cdaf')) return 'cross-generation';
  if (sha256.startsWith('8270b350cd82de5c')) return 'patched';
  return 'nvidia';
}

/** GPU generation from nvidia-smi's compute capability ("8.6" → ampere). */
export function archFor(computeCap: string | null): NrStatus['gpu']['arch'] {
  const m = /^(\d+)\.(\d+)/.exec(computeCap ?? '');
  if (!m) return null;
  const v = Number(m[1]) * 10 + Number(m[2]);
  if (v === 75) return 'turing';
  if (v >= 80 && v <= 87) return 'ampere';
  if (v === 89) return 'ada';
  if (v >= 100) return 'blackwell';
  return null;
}

/** NVIDIA's DLSS files by name. */
const DLSS_KIND: Record<string, NrStatus['downloads'][number]['files'][number]['kind']> = {
  'nvngx_dlss.dll': 'super-resolution', 'nvngx_dlssd.dll': 'ray-reconstruction', 'nvngx_dlssg.dll': 'frame-generation',
};

const ARCH_FLAG = { turing: '--turing', ampere: '--ampere', ada: '--ada', blackwell: '--blackwell' } as const;

/**
 * Frame generation next to Neural Rendering. 'dlssg': the game's own DLSS Frame Generation,
 * unlocked on RTX 20/30 by ShyVortex's sdli1995 SM86/SM75 unlocker (AmpereMfgUnlock, which hands
 * the multiplier to the game's menu) and on RTX 40 by the Ada MFG unlock. 'optifg': OptiScaler's
 * FSR 3 frame generation for games without DLSS FG. The unlockers must never run together.
 */
export function frameGenIni(text: string, mode: 'off' | 'dlssg' | 'optifg', arch: NrStatus['gpu']['arch']): string {
  const older = arch === 'turing' || arch === 'ampere';
  let t = setIniKey(text, 'DLSSG', 'AmpereMfgUnlock', mode === 'dlssg' && older ? 'true' : 'false');
  t = setIniKey(t, 'DLSSG', 'AdaMfgUnlock', mode === 'dlssg' && arch === 'ada' ? 'true' : 'false');
  t = setIniKey(t, 'FrameGen', 'Enabled', mode === 'optifg' ? 'true' : 'auto');
  t = setIniKey(t, 'FrameGen', 'FGInput', mode === 'optifg' ? 'upscaler' : 'auto');
  return setIniKey(t, 'FrameGen', 'FGOutput', mode === 'optifg' ? 'fsrfg' : 'auto');
}

/** Games whose loaders want a particular proxy name (ShyVortex's tested table). */
const KNOWN_PROXY: Array<[RegExp, string]> = [[/^cyberpunk2077\.exe$/i, 'dbghelp.dll']];

/** The proxy name OptiScaler takes in this folder: a known one for the game, else the first free name. */
export function proxyFor(folder: string): string {
  const exes = safeList(folder);
  const known = KNOWN_PROXY.find(([re, n]) => exes.some((e) => re.test(e)) && !existsSync(join(folder, n)));
  return known?.[1] ?? PROXY_NAMES.find((n) => !existsSync(join(folder, n))) ?? 'dxgi.dll';
}

/** Compares dotted versions; missing parts count as 0. */
export function compareVersions(a: string | null, b: string | null): number {
  const x = (a ?? '').split('.').map(Number), y = (b ?? '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** Sets one key in one [section] of an ini text, adding either when missing. */
export function setIniKey(text: string, section: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  const head = lines.findIndex((l) => l.trim().toLowerCase() === `[${section.toLowerCase()}]`);
  if (head < 0) return `${text.replace(/\s*$/, '')}\n\n[${section}]\n${key}=${value}\n`;
  let end = lines.findIndex((l, i) => i > head && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > head && i < end && new RegExp(`^\\s*${key}\\s*=`, 'i').test(l));
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.splice(head + 1, 0, `${key}=${value}`);
  return lines.join('\n');
}

/** OptiScaler nightly archives, newest first; the copies bundled with NVIDIA's DLSS files are left out. */
type GhRelease = { tag_name?: string; published_at?: string; prerelease?: boolean; assets?: Array<{ name?: string; browser_download_url?: string; digest?: string | null }> };

/** Dagherbou's OptiScaler_DLSSNR releases (the original Neural Rendering build), newest first. */
export function dagherbouAssets(releases: GhRelease[]) {
  return releaseAssets(releases, /^OptiScaler-DLSSNR-v[\w.-]+\.zip$/);
}

/** ShyVortex's OptiScaler-DLSSNR-PreSR-Multipass releases (also inside DLSS Unlocked), newest first. */
export function shyVortexAssets(releases: GhRelease[]) {
  return releaseAssets(releases, /^OptiScaler-NR-v[\d.]+(?:-pre\d+)?\.zip$/);
}

function releaseAssets(releases: GhRelease[], pattern: RegExp) {
  return releases.flatMap((r) => (r.assets ?? [])
    .filter((a) => pattern.test(a.name ?? '') && a.browser_download_url && /^sha256:[a-f0-9]{64}$/.test(a.digest ?? ''))
    .map((a) => ({
      name: a.name!, url: a.browser_download_url!, sha256: a.digest!.slice(7),
      date: (r.published_at ?? '').slice(0, 10).replace(/-/g, ''),
      version: /-v([\w.-]+?)\.zip$/.exec(a.name!)![1], prerelease: !!r.prerelease,
    })))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function nightlyAssets(assets: Array<{ name?: string; browser_download_url?: string; digest?: string | null; size?: number }>) {
  return assets
    .filter((a) => /^OptiScaler_[\w.-]+_(\d{8})\.7z$/.test(a.name ?? '') && a.browser_download_url && /^sha256:[a-f0-9]{64}$/.test(a.digest ?? ''))
    .map((a) => ({ name: a.name!, url: a.browser_download_url!, sha256: a.digest!.slice(7), date: /_(\d{8})\.7z$/.exec(a.name!)![1] }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * The folder holding the game's rendering executable: the Unreal shipping
 * build in Binaries/Win64 rather than the small launcher at the top, a folder
 * that already holds the game's DLSS above all.
 */
export function renderFolder(installDir: string | null, executable: string): string {
  if (!installDir) return dirname(executable);
  let best = { score: -1, dir: dirname(executable) };
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    for (const e of entries) {
      if (e.isDirectory() && depth < 5 && !/^(engine|redist|_commonredist|directx|support)$/i.test(e.name)) walk(join(dir, e.name), depth + 1);
      if (!e.isFile() || !/\.exe$/i.test(e.name) || /unins|crash|setup|redist|launcher/i.test(e.name)) continue;
      const parts = relative(installDir, dir).toLowerCase().split('/');
      let score = 0;
      if (join(dir, e.name) === executable) score += 50;
      if (parts.slice(-2).join('/') === 'binaries/win64') score += 65;
      if (/shipping\.exe$/i.test(e.name)) score += 70;
      if (names.has('nvngx_dlss.dll')) score += 220;
      if (names.has('sl.interposer.dll')) score += 60;
      if (score > best.score) best = { score, dir };
    }
  };
  walk(installDir, 0);
  return best.dir;
}

/** Folders under the game that hold its own DLSS: NGX looks for the runtime there too. */
function dlssFolders(installDir: string | null): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'nvngx_dlss.dll')) out.push(dir);
    if (depth < 7) for (const e of entries) if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
  };
  if (installDir) walk(installDir, 0);
  return out;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 15_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, out: `${stdout}\n${stderr}`.trim() });
    });
  });
}

interface RuntimeMeta { sha256: string; version: string | null; source: string; addedAt: string }
/** 'nr': NVIDIA's Neural Rendering on the upscaled picture; 'fsr4': OptiScaler's FSR 4 for AMD cards. */
export type OptiMode = 'nr' | 'fsr4';
interface GameManifest { proxy: string; files: Array<{ path: string; backup: string | null }>; optiscaler: string; runtime: string }

export interface NrDeps {
  dataDir: string;
  fetch: Fetch;
  settings: () => Settings;
  /** Install folders of the person's games, scanned for DLSS 5 runtimes. */
  gameDirs: () => string[];
  /** Where the person's browser saves files; Downloads by default. */
  downloadsDir?: () => string;
  /** Extracts an archive (7z) into a folder, in the worker. */
  extract: (archive: string, dest: string) => Promise<void>;
  changed: () => void;
}

export class NeuralRendering {
  private root: string;
  private busy: NrStatus['busy'] = null;
  private lastError: string | null = null;
  private scanned = false;
  private gpu: NrStatus['gpu'] | null = null;
  private nightlies: ReturnType<typeof nightlyAssets> | null = null;
  private releaseCache = new Map<string, ReturnType<typeof dagherbouAssets>>();
  /** Archives in Downloads that held DLSS files other than Neural Rendering. */
  private downloadNotes: NrStatus['downloads'] = [];

  constructor(private deps: NrDeps) {
    this.root = join(deps.dataDir, 'neural-rendering');
  }

  private dir(...p: string[]) { return join(this.root, ...p); }

  /* ------------------------------------------------------------- runtimes */

  runtimes(): RuntimeMeta[] {
    const base = this.dir('runtimes');
    if (!existsSync(base)) return [];
    return readdirSync(base).flatMap((sha) => {
      try { return [JSON.parse(readFileSync(join(base, sha, 'meta.json'), 'utf8')) as RuntimeMeta]; } catch { return []; }
    }).sort((a, b) => compareVersions(b.version, a.version));
  }

  /** The runtime in use: the one chosen in Settings, or the newest. */
  selected(): RuntimeMeta | null {
    const all = this.runtimes();
    const pick = this.deps.settings().nrRuntime;
    return (pick !== 'latest' && all.find((r) => r.sha256 === pick)) || all[0] || null;
  }

  /** Copies a runtime into the launcher's store (each build once). */
  async add(path: string, source: string): Promise<RuntimeMeta> {
    const meta = readPeVersion(path);
    if (!meta) throw new Error('This file is not NVIDIA\'s DLSS Neural Rendering runtime (nvngx_dlssnr.dll).');
    const values = meta.resources.flatMap((r) => r.stringTables.map((t) => t.values));
    const text = values.map((v) => `${v.FileDescription ?? ''} ${v.ProductName ?? ''} ${v.InternalName ?? ''}`).join(' ');
    const internal = values.map((v) => (v.InternalName ?? '').trim()).find(Boolean) ?? '';
    // The runtime names itself DLSSNR; NVIDIA's other DLSS files (DLSS, DLSSD, DLSSG) do not run Neural Rendering.
    const isNr = /dlss\s*-?\s*nr|neural/i.test(text) || (/^nvngx_dlssnr/i.test(basename(path)) && !/^(dlss|dlssd|dlssg)$/i.test(internal));
    if (!isNr) {
      const version = meta.resources.find((r) => r.fixedFileVersion)?.fixedFileVersion;
      throw new Error(/dlss/i.test(text)
        ? `This is ${basename(path)}${version ? ` ${version}` : ''}, NVIDIA's regular DLSS file, not Neural Rendering (nvngx_dlssnr.dll).`
        : 'This file is not NVIDIA\'s DLSS Neural Rendering runtime (nvngx_dlssnr.dll).');
    }
    const sha256 = await sha256File(path);
    if (this.ownCopies().has(sha256)) throw new Error('This is a copy the launcher patched; import the original file.');
    const dest = this.dir('runtimes', sha256);
    const existing = this.runtimes().find((r) => r.sha256 === sha256);
    if (existing) return existing;
    mkdirSync(dest, { recursive: true });
    copyFileSync(path, join(dest, `${RUNTIME}.part`));
    renameSync(join(dest, `${RUNTIME}.part`), join(dest, RUNTIME));
    const version = meta.resources.find((r) => r.fixedFileVersion)?.fixedFileVersion ?? null;
    const rec: RuntimeMeta = { sha256, version, source, addedAt: new Date().toISOString() };
    writeFileSync(join(dest, 'meta.json'), JSON.stringify(rec));
    this.deps.changed();
    return rec;
  }

  remove(sha256: string) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Unknown runtime');
    rmSync(this.dir('runtimes', sha256), { recursive: true, force: true });
    this.deps.changed();
  }

  /** Hashes of the files the launcher wrote (patched runtimes), so a scan does not import them back. */
  private ownCopies(): Set<string> {
    const own = new Set<string>();
    for (const r of this.runtimes()) {
      for (const f of safeList(this.dir('runtimes', r.sha256))) { const m = /^patched-.+-([a-f0-9]{64})\.dll$/.exec(f); if (m) own.add(m[1]); }
    }
    return own;
  }

  /** Steam libraries on this computer, for games installed outside the launcher (NBA 2K27). */
  private steamLibraries(): string[] {
    const roots = [join(homedir(), '.local/share/Steam'), join(homedir(), '.steam/steam'), join(homedir(), '.var/app/com.valvesoftware.Steam/.local/share/Steam')];
    const libs = new Set<string>();
    for (const r of roots) {
      const vdf = join(r, 'steamapps/libraryfolders.vdf');
      if (existsSync(join(r, 'steamapps/common'))) libs.add(join(r, 'steamapps/common'));
      try { for (const m of readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) libs.add(join(m[1].replace(/\\\\/g, '\\'), 'steamapps/common')); } catch { /* no Steam here */ }
    }
    return [...libs].filter((p) => existsSync(p));
  }

  /** Finds DLSS 5 runtimes in the person's games and adds the new ones: newer models arrive with game updates. */
  async scan(): Promise<number> {
    const own = this.ownCopies();
    const installedByUs = new Set(this.manifests().flatMap((m) => m.files.map((f) => f.path)));
    let found = 0, visited = 0;
    const walk = async (dir: string, depth: number) => {
      if (++visited > 150_000) return;
      let entries: import('node:fs').Dirent[];
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory() && depth < 8 && !e.isSymbolicLink()) await walk(p, depth + 1);
        else if (e.isFile() && e.name.toLowerCase() === RUNTIME && !installedByUs.has(p)) {
          try {
            if (own.has(await sha256File(p))) continue;
            const before = this.runtimes().length;
            await this.add(p, p);
            if (this.runtimes().length > before) found++;
          } catch { /* not a runtime */ }
        }
      }
    };
    for (const d of new Set([...this.deps.gameDirs(), ...this.steamLibraries()])) await walk(d, 0);
    found += await this.fromDownloads();
    this.scanned = true;
    return found;
  }

  /** The person's Downloads folder (XDG user dirs), where a browser saves files. */
  downloadsDir(): string {
    const home = homedir();
    try {
      const m = /^XDG_DOWNLOAD_DIR="([^"]+)"/m.exec(readFileSync(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'user-dirs.dirs'), 'utf8'));
      if (m) return m[1].replace(/^\$HOME/, home);
    } catch { /* default below */ }
    return join(home, 'Downloads');
  }

  /**
   * Runtimes the person downloaded in their browser (TechSpot's DLSS files page
   * sits behind a browser check, so the launcher does not fetch it itself): a
   * loose nvngx_dlssnr.dll, or one inside a .zip/.7z with DLSS in its name.
   * Each archive is opened once.
   */
  async fromDownloads(): Promise<number> {
    const dir = this.deps.downloadsDir?.() ?? this.downloadsDir();
    const seenFile = this.dir('downloads-seen.json');
    let seen: string[] = [];
    let notes: NrStatus['downloads'] = [];
    try {
      const saved = JSON.parse(readFileSync(seenFile, 'utf8')) as { seen?: string[]; notes?: NrStatus['downloads'] };
      seen = saved.seen ?? [];
      notes = saved.notes ?? [];
    } catch { /* first look */ }
    let found = 0;
    for (const e of safeDirents(dir)) {
      if (!e.isFile()) continue;
      const p = join(dir, e.name);
      const isDll = /^nvngx_dlssnr.*\.dll$/i.test(e.name);
      const isArchive = /(dlss|nvngx|neural)/i.test(e.name) && /\.(zip|7z)$/i.test(e.name);
      if (!isDll && !isArchive) continue;
      let st: import('node:fs').Stats;
      try { st = statSync(p); } catch { continue; }
      const key = `${e.name}:${st.size}:${Math.round(st.mtimeMs)}`;
      if (seen.includes(key) || st.size > 2 * 1024 ** 3) continue;
      const before = this.runtimes().length;
      if (isDll) {
        try { await this.add(p, `Downloads/${e.name}`); } catch { /* not a runtime */ }
      } else {
        const work = this.dir('work-downloads');
        rmSync(work, { recursive: true, force: true });
        try {
          await this.deps.extract(p, work);
          const runtimes = findAll(work, (n) => n.toLowerCase() === RUNTIME);
          for (const dll of runtimes) {
            try { await this.add(dll, `Downloads/${e.name}`); } catch { /* not a runtime */ }
          }
          // TechSpot also offers NVIDIA's other DLSS files: say what the archive held instead.
          if (!runtimes.length) {
            const other = findAll(work, (n) => /^nvngx_dlss\w*\.dll$/i.test(n)).map((f) => {
              const v = readPeVersion(f)?.resources.find((r) => r.fixedFileVersion)?.fixedFileVersion ?? null;
              return { name: basename(f), version: v, kind: DLSS_KIND[basename(f).toLowerCase()] ?? 'other' as const };
            });
            notes = [{ file: e.name, files: other }, ...notes.filter((n) => n.file !== e.name)].slice(0, 5);
          }
        } catch { /* not an archive we can open */ } finally { rmSync(work, { recursive: true, force: true }); }
      }
      if (this.runtimes().length > before) found++;
      seen.push(key);
    }
    mkdirSync(this.root, { recursive: true });
    writeFileSync(seenFile, JSON.stringify({ seen: seen.slice(-200), notes }));
    this.downloadNotes = notes;
    return found;
  }

  /* ---------------------------------------------------------- GPU and CUDA */

  private async detectGpu(): Promise<NrStatus['gpu']> {
    if (this.gpu) return this.gpu;
    const r = await run('nvidia-smi', ['--query-gpu=name,compute_cap', '--format=csv,noheader']);
    const [name, cap] = r.code === 0 ? r.out.split('\n')[0].split(',').map((s) => s.trim()) : [null, null];
    this.gpu = { name: name || null, arch: archFor(cap ?? null) };
    return this.gpu;
  }

  /** The CUDA Toolkit's bin folder (ptxas, fatbinary, cuobjdump), newest first. */
  cudaBin(): string | null {
    const dirs = [this.dir('cuda', 'bin'), ...(process.env.PATH ?? '').split(':'), '/opt/cuda/bin', '/usr/local/cuda/bin',
      ...safeList('/usr/local').filter((n) => /^cuda-\d/.test(n)).sort((a, b) => compareVersions(b.slice(5), a.slice(5))).map((n) => `/usr/local/${n}/bin`)];
    return dirs.find((d) => d && ['ptxas', 'fatbinary', 'cuobjdump'].every((t) => existsSync(join(d, t)))) ?? null;
  }

  /** Downloads a file and checks it against its published SHA-256 before keeping it. */
  private async fetchVerified(url: string, sha256: string, dest: string) {
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const res = await this.deps.fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}): ${basename(url)}`);
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp));
    if ((await sha256File(tmp)) !== sha256) { rmSync(tmp, { force: true }); throw new Error(`${basename(url)} does not match NVIDIA's published SHA-256.`); }
    renameSync(tmp, dest);
  }

  /**
   * NVIDIA's ptxas, fatbinary and cuobjdump (CUDA 13.3.1) from its redistributable
   * archives, checked against NVIDIA's list and kept in the launcher's folder: no
   * system install, and the graphics driver is not touched.
   */
  async fetchCuda(): Promise<string> {
    const bin = this.dir('cuda', 'bin');
    if (['ptxas', 'fatbinary', 'cuobjdump'].every((t) => existsSync(join(bin, t)))) return bin;
    const was = this.busy;
    this.busy = 'cuda';
    this.deps.changed();
    const work = this.dir('cuda', 'work');
    try {
      const res = await this.deps.fetch(`${CUDA_REDIST}/redistrib_${CUDA_RELEASE}.json`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Could not read NVIDIA's CUDA ${CUDA_RELEASE} list (HTTP ${res.status}).`);
      const list = (await res.json()) as Record<string, { 'linux-x86_64'?: { relative_path?: string; sha256?: string } }>;
      rmSync(work, { recursive: true, force: true });
      mkdirSync(bin, { recursive: true });
      for (const [part, tools] of Object.entries(CUDA_PARTS)) {
        const entry = list[part]?.['linux-x86_64'];
        if (!entry?.relative_path || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') || !/^[\w./-]+\.tar\.xz$/.test(entry.relative_path) || entry.relative_path.includes('..')) throw new Error(`NVIDIA's CUDA list has no ${part} for Linux.`);
        const archive = join(work, basename(entry.relative_path));
        await this.fetchVerified(`${CUDA_REDIST}/${entry.relative_path}`, entry.sha256!, archive);
        const out = join(work, part);
        await this.deps.extract(archive, out);
        for (const tool of tools) {
          const found = findFile(out, tool);
          if (!found) throw new Error(`${tool} is missing from NVIDIA's ${part} archive.`);
          copyFileSync(found, join(bin, tool));
          chmodSync(join(bin, tool), 0o755);
        }
      }
      return bin;
    } finally {
      rmSync(work, { recursive: true, force: true });
      this.busy = was;
      this.deps.changed();
    }
  }

  /** Whether this card needs the runtime rebuilt: NVIDIA's own build runs on RTX 50 only. */
  private needsPatch(r: RuntimeMeta, arch: NrStatus['gpu']['arch']): boolean {
    return identifyBuild(r.sha256) === 'nvidia' && arch !== 'blackwell';
  }

  private patchedPath(r: RuntimeMeta, arch: string, patcherSha: string) {
    return this.dir('runtimes', r.sha256, `patched-${arch}-${patcherSha.slice(0, 12)}`);
  }

  /**
   * dlssnr-patcher at the reviewed commit, checked against its SHA-256 before
   * it runs: a later commit is never run unseen. It reads the DLL, calls the
   * CUDA tools and writes the result; it makes no network requests.
   */
  private async patcher(): Promise<{ sha: string; script: string }> {
    const script = this.dir('patcher', PATCHER_COMMIT, 'dlssnr_patcher.py');
    if (existsSync(script) && (await sha256File(script)) === PATCHER_SHA256) return { sha: PATCHER_COMMIT, script };
    const res = await this.deps.fetch(`https://raw.githubusercontent.com/${PATCHER_REPO}/${PATCHER_COMMIT}/dlssnr_patcher.py`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Could not download dlssnr-patcher (HTTP ${res.status}).`);
    const body = Buffer.from(await res.arrayBuffer());
    if (createHash('sha256').update(body).digest('hex') !== PATCHER_SHA256) throw new Error('The dlssnr-patcher download does not match the reviewed version; it was not run.');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, body);
    return { sha: PATCHER_COMMIT, script };
  }

  /** The runtime file for this card: the original, or one rebuilt for it. */
  async ready(r: RuntimeMeta): Promise<string> {
    const original = this.dir('runtimes', r.sha256, RUNTIME);
    const gpu = await this.detectGpu();
    if (!this.needsPatch(r, gpu.arch)) return original;
    const arch = gpu.arch ?? 'all';
    const done = safeList(this.dir('runtimes', r.sha256)).find((f) => f.startsWith(`patched-${arch}-`) && f.endsWith('.dll'));
    if (done) return this.dir('runtimes', r.sha256, done);
    return this.patch(r);
  }

  /** Rebuilds the runtime's GPU code for this card with dlssnr-patcher and the CUDA Toolkit. */
  async patch(r: RuntimeMeta): Promise<string> {
    if (this.busy) throw new Error('DLSS 5 is already being prepared; wait for it to finish.');
    this.busy = 'patching';
    this.lastError = null;
    this.deps.changed();
    try {
      // Without a CUDA Toolkit on the system, NVIDIA's own copies of the three tools are fetched.
      const cuda = this.cudaBin() ?? await this.fetchCuda();
      const gpu = await this.detectGpu();
      const { sha, script } = await this.patcher();
      const work = this.dir('work');
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      const out = join(work, RUNTIME);
      const flags = gpu.arch ? [ARCH_FLAG[gpu.arch]] : [];
      // -I: the patcher's folder and the working folder are not on Python's import path.
      const res = await run('python3', ['-I', script, ...flags, '--cuda-bin', cuda, '--output', out, this.dir('runtimes', r.sha256, RUNTIME)], { cwd: work, timeout: 60 * 60_000 });
      if (res.code !== 0 || !existsSync(out)) throw new Error(`dlssnr-patcher failed: ${res.out.split('\n').filter(Boolean).slice(-3).join(' ')}`);
      const outSha = await sha256File(out);
      const dest = `${this.patchedPath(r, gpu.arch ?? 'all', sha)}-${outSha}.dll`;
      renameSync(out, dest);
      return dest;
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    } finally {
      this.busy = null;
      this.deps.changed();
    }
  }

  /* ------------------------------------------------------------ OptiScaler */

  private async releasesOf(repo: string, parse: (r: GhRelease[]) => ReturnType<typeof dagherbouAssets>, refresh: boolean) {
    const cached = this.releaseCache.get(repo);
    if (cached && !refresh) return cached;
    try {
      const res = await this.deps.fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
      if (res.ok) this.releaseCache.set(repo, parse((await res.json()) as GhRelease[]));
    } catch { /* offline */ }
    return this.releaseCache.get(repo) ?? [];
  }
  private dagherbouList(refresh = false) { return this.releasesOf(DAGHERBOU_REPO, dagherbouAssets, refresh); }
  private shyVortexList(refresh = false) { return this.releasesOf(SHYVORTEX_REPO, shyVortexAssets, refresh); }

  private async optiscalerList(refresh = false) {
    if (this.nightlies && !refresh) return this.nightlies;
    try {
      const res = await this.deps.fetch(`https://api.github.com/repos/${OPTISCALER_REPO}/releases/tags/nightly`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        // The newest builds, and the one tested under Proton however old it gets.
        const all = nightlyAssets(((await res.json()) as { assets?: [] }).assets ?? []);
        this.nightlies = all.filter((a, i) => i < 20 || a.name === TESTED_OPTISCALER);
      }
    } catch { /* offline: downloaded builds stay usable */ }
    return this.nightlies ?? [];
  }

  /** The OptiScaler build's folder, downloaded and checked against GitHub's SHA-256 when needed. */
  private async optiscaler(): Promise<{ name: string; dir: string }> {
    const want = this.deps.settings().nrOptiscaler;
    const list = await this.optiscalerList();
    const others = [...await this.shyVortexList(), ...await this.dagherbouList()];
    const local = safeList(this.dir('optiscaler')).filter((n) => existsSync(join(this.dir('optiscaler', n), '.ok'))).sort().reverse();
    // Newest = ShyVortex's newest release (Neural Rendering + RTX 20/30 frame generation in one), else y4my4my4m's nightly.
    const asset = want === 'latest' ? (others.find((a) => isShyVortex(a.name) && !a.prerelease) ?? list[0]) : [...list, ...others].find((a) => a.name === want);
    const name = asset?.name ?? (want === 'latest' ? (local.find(isShyVortex) ?? local[0]) : local.find((n) => n === want));
    if (!name) throw new Error('Could not reach GitHub to download OptiScaler.');
    const dir = this.dir('optiscaler', name);
    if (existsSync(join(dir, '.ok'))) return { name, dir };
    if (!asset) throw new Error(`OptiScaler ${name} is no longer available; pick another build in Settings.`);
    this.busy = 'downloading';
    this.deps.changed();
    try {
      const tmp = this.dir('optiscaler', `${name}.part`);
      mkdirSync(dirname(tmp), { recursive: true });
      const res = await this.deps.fetch(asset.url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`OptiScaler download failed (HTTP ${res.status}).`);
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp));
      if ((await sha256File(tmp)) !== asset.sha256) { rmSync(tmp, { force: true }); throw new Error('The OptiScaler download does not match its published SHA-256.'); }
      rmSync(dir, { recursive: true, force: true });
      await this.deps.extract(tmp, dir);
      rmSync(tmp, { force: true });
      if (!existsSync(join(dir, 'OptiScaler.dll'))) throw new Error('The OptiScaler archive has no OptiScaler.dll.');
      writeFileSync(join(dir, '.ok'), asset.sha256);
      return { name, dir };
    } finally {
      this.busy = null;
      this.deps.changed();
    }
  }

  /* ------------------------------------------------------------- per game */

  private manifestPath(gameId: number) { return this.dir('games', `${gameId}.json`); }
  private manifests(): GameManifest[] {
    return safeList(this.dir('games')).flatMap((f) => { try { return [JSON.parse(readFileSync(this.dir('games', f), 'utf8')) as GameManifest]; } catch { return []; } });
  }
  installed(gameId: number): GameManifest | null {
    try { return JSON.parse(readFileSync(this.manifestPath(gameId), 'utf8')) as GameManifest; } catch { return null; }
  }

  /**
   * Puts OptiScaler (and, for Neural Rendering, the runtime) into the game,
   * again after a game update, and returns the environment lines for the launch.
   * On AMD cards ('fsr4') OptiScaler turns the game's DLSS, XeSS or FSR 2 into FSR 4.
   */
  async apply(game: { id: number; installDir: string | null; executable: string }, mode: OptiMode = 'nr'): Promise<string[]> {
    let dll: string | null = null;
    if (mode === 'nr') {
      const runtime = this.selected();
      if (!runtime) throw new Error('DLSS 5 needs nvngx_dlssnr.dll: open Settings → Graphics and import it, or scan your games for it.');
      dll = await this.ready(runtime);
    }
    const tag = dll ? basename(dll) : 'fsr4';
    const opti = await this.optiscaler();
    const prev = this.installed(game.id);
    const folder = renderFolder(game.installDir, game.executable);
    // Another install (a newer build, or the game moved) is taken out first.
    if (prev && (prev.optiscaler !== opti.name || prev.runtime !== tag || !prev.files.every((f) => existsSync(f.path)) || dirname(prev.files[0]?.path ?? folder) !== folder)) this.removeFrom(game.id);
    const current = this.installed(game.id);
    const proxy = current?.proxy ?? proxyFor(folder);
    const files: GameManifest['files'] = current?.files ?? [];
    const backups = this.dir('backups', String(game.id));
    const place = (from: string, to: string) => {
      const known = files.find((f) => f.path === to);
      let backup = known?.backup ?? null;
      if (!known && existsSync(to)) {
        backup = join(backups, createHash('sha1').update(to).digest('hex').slice(0, 12) + '-' + basename(to));
        mkdirSync(backups, { recursive: true });
        copyFileSync(to, backup);
      }
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      if (!known) files.push({ path: to, backup });
    };
    if (!current) {
      place(join(opti.dir, 'OptiScaler.dll'), join(folder, proxy));
      const tree = (rel: string) => {
        for (const e of readdirSync(join(opti.dir, rel), { withFileTypes: true })) {
          const r = rel ? join(rel, e.name) : e.name;
          // The game gets the program files only: no licences, docs, images or Windows setup scripts.
          if (e.isDirectory()) { if (!/^(Licenses|docs|images|redist)$/i.test(r)) tree(r); }
          else if (!/^(OptiScaler\.dll|OptiScaler\.ini|setup_\w+\.(sh|bat)|\.ok|!!.*|READ ?ME.*|LICENSE.*|[^/]*\.ps1)$|\.(pdb|lib|exp|md|html)$/i.test(r)) place(join(opti.dir, r), join(folder, r));
        }
      };
      tree('');
      // The ini keeps what the person tunes in OptiScaler's overlay; it is written once.
      if (!existsSync(join(folder, 'OptiScaler.ini'))) place(join(opti.dir, 'OptiScaler.ini'), join(folder, 'OptiScaler.ini'));
      if (dll) for (const d of new Set([folder, ...dlssFolders(game.installDir)])) place(dll, join(d, RUNTIME));
    }
    const ini = join(folder, 'OptiScaler.ini');
    if (existsSync(ini)) {
      const { nrQuality: q, nrPasses } = this.deps.settings();
      let text = readFileSync(ini, 'utf8');
      if (mode === 'fsr4') {
        // FSR 2.3/3.1/4 through AMD's FidelityFX loader; DirectX 11 games through OptiScaler's 11on12 bridge.
        text = setIniKey(setIniKey(setIniKey(text, 'Upscalers', 'Dx12Upscaler', 'ffx'), 'Upscalers', 'Dx11Upscaler', 'ffx_12'), 'DlssNr', 'Enabled', 'false');
        writeFileSync(ini, text);
        mkdirSync(this.dir('games'), { recursive: true });
        writeFileSync(this.manifestPath(game.id), JSON.stringify({ proxy, files, optiscaler: opti.name, runtime: tag } satisfies GameManifest));
        const v = this.deps.settings().fsr4Version;
        // GE-Proton fetches AMD's FSR 4 library (amdxcffx64.dll) that OptiScaler hands the game to.
        return [`WINEDLLOVERRIDES=${proxy.replace(/\.dll$/i, '')}=n,b`, `PROTON_FSR4_UPGRADE=${v === 'latest' ? '1' : v}`];
      }
      // DirectX 11 games reach Neural Rendering only through DLSS on the 11on12 bridge.
      text = setIniKey(setIniKey(setIniKey(text, 'Upscalers', 'Dx11Upscaler', 'dlss_12'), 'Upscalers', 'VulkanUpscaler', 'dlss'), 'DlssNr', 'Enabled', 'true');
      // Before the upscaler, the model works at render resolution: far cheaper on RTX 20/30 cards.
      // y4my4my4m's builds call it PreUpscale, ShyVortex's RunBeforeSR; each ignores the other's key.
      const pre = this.deps.settings().nrPreUpscale ? 'true' : 'auto';
      text = setIniKey(setIniKey(text, 'DlssNr', 'PreUpscale', pre), 'DlssNr', 'RunBeforeSR', pre);
      text = frameGenIni(text, this.deps.settings().nrFrameGen, (await this.detectGpu()).arch);
      text = setIniKey(text, 'DlssNr', 'WorkingScale', q === 'fast' ? '0.5' : q === 'balanced' ? '0.75' : q === 'full' ? '1.0' : 'auto');
      // Multipass: each pass sees the last one's picture. Later passes are eased so they refine
      // rather than re-amplify (OptiScaler's own advice for PassOverrides).
      const passes = Math.min(5, Math.max(1, Math.round(nrPasses || 1)));
      text = setIniKey(text, 'DlssNr', 'Passes', passes > 1 ? String(passes) : 'auto');
      text = setIniKey(text, 'DlssNr', 'PassOverrides', passes > 2 ? Array.from({ length: passes - 2 }, (_, i) => `${i + 3}:intensity=${Math.max(0.4, 0.8 - i * 0.15).toFixed(2)}`).join(';') : 'auto');
      writeFileSync(ini, text);
    }
    mkdirSync(this.dir('games'), { recursive: true });
    writeFileSync(this.manifestPath(game.id), JSON.stringify({ proxy, files, optiscaler: opti.name, runtime: tag } satisfies GameManifest));
    // ShyVortex's RTX 20/30 frame generation unlocker needs CUDA inside Proton.
    return [`WINEDLLOVERRIDES=${proxy.replace(/\.dll$/i, '')}=n,b`, 'PROTON_ENABLE_NVAPI=1', ...(isShyVortex(opti.name) ? ['PROTON_NVIDIA_NVCUDA=1'] : [])];
  }

  /** Takes OptiScaler and the runtime out of the game and puts back what was there before. */
  removeFrom(gameId: number) {
    const m = this.installed(gameId);
    if (!m) return;
    for (const f of [...m.files].reverse()) {
      try {
        if (f.backup && existsSync(f.backup)) copyFileSync(f.backup, f.path);
        else rmSync(f.path, { force: true });
      } catch { /* the game folder may be gone */ }
    }
    // OptiScaler's own folder goes too, once empty (it held only what was placed above).
    const proxyDir = dirname(m.files[0]?.path ?? '');
    pruneEmpty(join(proxyDir, 'OptiScaler'));
    rmSync(this.manifestPath(gameId), { force: true });
    rmSync(this.dir('backups', String(gameId)), { recursive: true, force: true });
  }

  /* --------------------------------------------------------------- status */

  async status(refresh = false): Promise<NrStatus> {
    if (refresh || !this.scanned) await this.scan().catch(() => 0);
    const gpu = await this.detectGpu();
    const list = await this.optiscalerList(refresh);
    const sel = this.selected();
    return {
      gpu,
      cuda: this.cudaBin(),
      busy: this.busy,
      error: this.lastError,
      selected: sel?.sha256 ?? null,
      runtimes: this.runtimes().map((r) => ({
        sha256: r.sha256, version: r.version, source: r.source, build: identifyBuild(r.sha256),
        needsPatch: this.needsPatch(r, gpu.arch),
        patched: safeList(this.dir('runtimes', r.sha256)).some((f) => f.startsWith(`patched-${gpu.arch ?? 'all'}-`)),
      })),
      optiscaler: [
        ...(await this.shyVortexList(refresh)).map((a) => ({ name: a.name, date: a.date, tested: false, source: 'shyvortex' as const, version: a.version })),
        ...list.map((a) => ({ name: a.name, date: a.date, tested: a.name === TESTED_OPTISCALER, source: 'y4my4my4m' as const, version: null })),
        ...(await this.dagherbouList(refresh)).map((a) => ({ name: a.name, date: a.date, tested: false, source: 'dagherbou' as const, version: a.version })),
      ],
      downloaded: safeList(this.dir('optiscaler')).filter((n) => existsSync(join(this.dir('optiscaler', n), '.ok'))),
      downloads: this.downloadNotes,
    };
  }
}

/** The first file with this name under a folder (an archive's bin/ folder sits one level down). */
function findFile(dir: string, name: string, depth = 0): string | null {
  for (const e of safeDirents(dir)) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name && basename(dir) === 'bin') return p;
    if (e.isDirectory() && depth < 3) { const f = findFile(p, name, depth + 1); if (f) return f; }
  }
  return null;
}

/** Removes a folder tree's empty folders, bottom up; anything holding a file stays. */
function pruneEmpty(dir: string, depth = 0) {
  if (depth > 8) return;
  for (const e of safeDirents(dir)) if (e.isDirectory() && !e.isSymbolicLink()) pruneEmpty(join(dir, e.name), depth + 1);
  try { rmdirSync(dir); } catch { /* not empty, or gone */ }
}

/** Every file under a folder whose name passes the test (a few levels deep). */
function findAll(dir: string, test: (name: string) => boolean, depth = 0): string[] {
  return safeDirents(dir).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isFile()) return test(e.name) ? [p] : [];
    return e.isDirectory() && depth < 5 ? findAll(p, test, depth + 1) : [];
  });
}

function safeDirents(dir: string) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
