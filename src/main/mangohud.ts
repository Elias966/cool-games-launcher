// MangoHud for the person's games, current. Distributions ship old builds
// (Ubuntu 24.04: 0.6.9) that silently ignore settings newer tools such as
// MangoJuice write (1% lows, the detailed frame graph). The official release
// is installed for this user only: its libraries in the launcher's folder and
// its Vulkan layer manifests in ~/.local/share/vulkan/implicit_layer.d, which
// the Vulkan loader (and Proton's container) reads before the system's
// /usr/share copy, so games load this MangoHud and nothing system-wide changes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export const MANGOHUD_REPO = 'flightlessmango/MangoHud';
const LAYERS = [
  { json: 'MangoHud.x86_64.json', lib: 'lib64' },
  { json: 'MangoHud.x86.json', lib: 'lib32' },
];

export interface MangoHudDeps {
  dataDir: string;
  fetch: Fetch;
  /** Extracts a .tar.gz or .tar into a folder (the install worker). */
  extract: (archive: string, dest: string) => Promise<void>;
  /** How long a download may send nothing before it is started again (30 s). */
  stallMs?: number;
  /** Where Vulkan looks for this user's layers; ~/.local/share by default. */
  dataHome?: string;
}

export interface MangoHudState { version: string | null; ours: boolean; layerDir: string }

export class MangoHud {
  private root: string;
  private layerDir: string;
  private checking: Promise<MangoHudState> | null = null;

  constructor(private deps: MangoHudDeps) {
    this.root = join(deps.dataDir, 'mangohud');
    this.layerDir = join(deps.dataHome ?? process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'vulkan', 'implicit_layer.d');
  }

  /** The version installed by the launcher, when its layer manifest is the one in place. */
  state(): MangoHudState {
    try {
      const meta = JSON.parse(readFileSync(join(this.root, 'current.json'), 'utf8')) as { version: string; dir: string };
      const manifest = readFileSync(join(this.layerDir, LAYERS[0].json), 'utf8');
      if (manifest.includes(meta.dir)) return { version: meta.version, ours: true, layerDir: this.layerDir };
    } catch { /* not installed by the launcher */ }
    return { version: null, ours: false, layerDir: this.layerDir };
  }

  /** A MangoHud the person put in ~/.local themselves is theirs: the launcher does not replace it. */
  private foreignManifest(): boolean {
    const p = join(this.layerDir, LAYERS[0].json);
    if (!existsSync(p)) return false;
    try { return !readFileSync(p, 'utf8').includes(this.root); } catch { return true; }
  }

  /** Installs the newest release when missing or older (checked at most once a day); returns what is in place. */
  ensure(): Promise<MangoHudState> {
    this.checking ??= this.install().finally(() => { this.checking = null; });
    return this.checking;
  }

  private async install(): Promise<MangoHudState> {
    const current = this.state();
    if (this.foreignManifest()) return current;
    const stamp = join(this.root, 'checked.json');
    try {
      const at = (JSON.parse(readFileSync(stamp, 'utf8')) as { at: number }).at;
      if (current.ours && Date.now() - at < 24 * 3600_000) return current;
    } catch { /* never checked */ }
    const res = await this.deps.fetch(`https://api.github.com/repos/${MANGOHUD_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) { if (current.ours) return current; throw new Error(`Could not reach MangoHud's releases (HTTP ${res.status}).`); }
    const rel = (await res.json()) as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string; digest?: string | null }> };
    const version = (rel.tag_name ?? '').replace(/^v/, '');
    const asset = rel.assets?.find((a) => /^MangoHud-[\d.]+\.r\d+\.g[0-9a-f]+\.tar\.gz$/.test(a.name ?? '') && a.browser_download_url && /^sha256:[a-f0-9]{64}$/.test(a.digest ?? ''));
    if (!/^\d+(\.\d+)+$/.test(version) || !asset) throw new Error('MangoHud\'s newest release has no Linux package.');
    mkdirSync(this.root, { recursive: true });
    writeFileSync(stamp, JSON.stringify({ at: Date.now() }));
    if (current.ours && current.version === version) return current;

    const work = join(this.root, 'work');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      const archive = join(work, asset.name!);
      // A download that stalls (GitHub's servers sometimes stop sending) is started again once.
      try { await this.download(asset.browser_download_url!, archive); } catch { await this.download(asset.browser_download_url!, archive); }
      const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
      if (sha !== asset.digest!.slice(7)) throw new Error('The MangoHud download does not match its published SHA-256.');
      // The release is a tarball holding MangoHud-package.tar, laid out like /usr.
      await this.deps.extract(archive, join(work, 'outer'));
      const inner = findFile(join(work, 'outer'), 'MangoHud-package.tar');
      if (!inner) throw new Error('The MangoHud package is not where it should be.');
      await this.deps.extract(inner, join(work, 'pkg'));
      const dir = join(this.root, version);
      rmSync(dir, { recursive: true, force: true });
      for (const { lib } of LAYERS) {
        const from = join(work, 'pkg', 'usr', 'lib', 'mangohud', lib);
        if (!existsSync(join(from, 'libMangoHud.so'))) throw new Error(`The MangoHud package has no ${lib} library.`);
        mkdirSync(join(dir, lib), { recursive: true });
        for (const f of readdirSync(from)) writeFileSync(join(dir, lib, f), readFileSync(join(from, f)));
      }
      // Its manifests, pointed at the launcher's copy of the libraries.
      mkdirSync(this.layerDir, { recursive: true });
      for (const { json, lib } of LAYERS) {
        const src = join(work, 'pkg', 'usr', 'share', 'vulkan', 'implicit_layer.d', json);
        const m = JSON.parse(readFileSync(src, 'utf8')) as { layer: { library_path: string } };
        m.layer.library_path = join(dir, lib, 'libMangoHud.so');
        writeFileSync(join(this.layerDir, json), `${JSON.stringify(m, null, 4)}\n`);
      }
      writeFileSync(join(this.root, 'current.json'), JSON.stringify({ version, dir }));
      // Older versions the launcher installed go.
      for (const old of readdirSync(this.root)) if (/^\d+(\.\d+)+$/.test(old) && old !== version) rmSync(join(this.root, old), { recursive: true, force: true });
      return this.state();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Downloads a file, giving up when nothing arrives for 30 seconds. */
  private async download(url: string, dest: string) {
    const ctl = new AbortController();
    const stall = this.deps.stallMs ?? 30_000;
    let timer = setTimeout(() => ctl.abort(), stall);
    try {
      const dl = await this.deps.fetch(url, { signal: ctl.signal });
      if (!dl.ok || !dl.body) throw new Error(`MangoHud download failed (HTTP ${dl.status}).`);
      const alive = new Transform({ transform(chunk, _e, done) { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), stall); done(null, chunk); } });
      await pipeline(Readable.fromWeb(dl.body as import('node:stream/web').ReadableStream), alive, createWriteStream(dest));
    } finally { clearTimeout(timer); }
  }

  /** Takes the launcher's MangoHud out again; games fall back to the system's. */
  remove() {
    if (!this.state().ours) return;
    for (const { json } of LAYERS) rmSync(join(this.layerDir, json), { force: true });
    rmSync(this.root, { recursive: true, force: true });
  }
}

function findFile(dir: string, name: string, depth = 0): string | null {
  let entries: import('node:fs').Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory() && depth < 3) { const f = findFile(p, name, depth + 1); if (f) return f; }
  }
  return null;
}
