// Microsoft's Visual C++ runtime for games run with a Proton that has no game
// fixes of its own (Valve's Proton). On Steam, Steam installs the runtime into
// every game's prefix before the first start; GE-Proton and CachyOS Proton do
// it through protonfixes. Without either, Wine's own stand-ins are all a game
// gets, and many stop with a "Microsoft Visual C++ Runtime" error.
//
// Microsoft's installer hangs under Proton outside Steam, so nothing is run:
// its packages are downloaded (and checked against the SHA-256 Microsoft puts
// in the download address), the DLLs are unpacked with the bundled 7-Zip, and
// copied into the prefix, 64-bit into system32 and 32-bit into syswow64. The
// game is then told to prefer them (WINEDLLOVERRIDES ...=n,b).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPeVersion } from './pe-version';

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export const VC_PACKAGES = {
  x64: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
  x86: 'https://aka.ms/vs/17/release/vc_redist.x86.exe',
} as const;
type Arch = keyof typeof VC_PACKAGES;
/** The minimum runtime's DLLs (what Steam's install script puts in place). */
export const VC_DLLS = ['concrt140', 'msvcp140', 'msvcp140_1', 'msvcp140_2', 'msvcp140_atomic_wait', 'msvcp140_codecvt_ids', 'vccorlib140', 'vcomp140', 'vcruntime140', 'vcruntime140_1', 'vcruntime140_threads', 'vcamp140'];
const CAB_SUFFIX: Record<Arch, string> = { x64: 'amd64', x86: 'x86' };
const DEST: Record<Arch, string> = { x64: 'system32', x86: 'syswow64' };

/** The overrides that make Wine load Microsoft's DLLs before its own. */
export const VC_OVERRIDES = `${VC_DLLS.join(',')}=n,b`;

/** A Proton without protonfixes (Valve's) does not set up the runtime itself. */
export function needsVcRuntime(protonPath: string): boolean {
  return !!protonPath && !existsSync(join(protonPath, 'protonfixes'));
}

/** Wine's own DLLs carry this mark right after the DOS header. */
export function isWineDll(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(0x80);
    readSync(fd, buf, 0, buf.length, 0);
    return /Wine (?:builtin|placeholder) DLL/.test(buf.toString('latin1'));
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}

/** The CAB archives inside a WiX bundle (vc_redist.exe), as separate buffers. */
export function cabsIn(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const sig = Buffer.from('MSCF\0\0\0\0', 'latin1');
  for (let i = data.indexOf(sig); i >= 0; i = data.indexOf(sig, i)) {
    const size = data.readUInt32LE(i + 8);
    if (size > 0 && i + size <= data.length) { out.push(data.subarray(i, i + size)); i += size; } else i += 4;
  }
  return out;
}

export interface VcDeps {
  dataDir: string;
  fetch: Fetch;
  /** The bundled 7-Zip (7zzs), which opens CAB archives. */
  sevenZip: string;
}

export class VcRuntime {
  private root: string;
  private preparing: Promise<{ version: string; dir: string }> | null = null;

  constructor(private deps: VcDeps) {
    this.root = join(deps.dataDir, 'vc-runtime');
  }

  /** Microsoft's DLLs, unpacked once into the launcher's folder (looked for again monthly). */
  files(): Promise<{ version: string; dir: string }> {
    this.preparing ??= this.prepare().finally(() => { this.preparing = null; });
    return this.preparing;
  }

  private current(): { version: string; dir: string; at: number } | null {
    try { return JSON.parse(readFileSync(join(this.root, 'current.json'), 'utf8')); } catch { return null; }
  }

  private async prepare(): Promise<{ version: string; dir: string }> {
    const cur = this.current();
    if (cur && existsSync(join(cur.dir, 'x64', 'msvcp140.dll')) && Date.now() - cur.at < 30 * 24 * 3600_000) return cur;
    const work = join(this.root, 'work');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      const staged = join(work, 'out');
      for (const arch of Object.keys(VC_PACKAGES) as Arch[]) {
        const res = await this.deps.fetch(VC_PACKAGES[arch], { signal: AbortSignal.timeout(10 * 60_000) });
        if (!res.ok) throw new Error(`Microsoft's Visual C++ download failed (HTTP ${res.status}).`);
        const body = Buffer.from(await res.arrayBuffer());
        // Microsoft's download address carries the file's SHA-256.
        const expected = /\/([0-9A-F]{64})\/[^/]+$/i.exec(new URL(res.url).pathname)?.[1]?.toLowerCase();
        const actual = createHash('sha256').update(body).digest('hex');
        if (!expected || expected !== actual) throw new Error('Microsoft\'s Visual C++ download does not match the SHA-256 in its address.');
        // The bundle's attached container is a CAB holding further CABs; one of them has the DLLs.
        const cabs = cabsIn(body);
        let n = 0;
        const open = async (cab: Buffer, depth: number) => {
          const file = join(work, `${arch}-${n++}.cab`);
          writeFileSync(file, cab);
          const out = `${file}.d`;
          await sevenZip(this.deps.sevenZip, file, out);
          for (const name of readdirSync(out)) {
            const p = join(out, name);
            if (depth < 1 && readFileSync(p).subarray(0, 4).toString('latin1') === 'MSCF') await open(readFileSync(p), depth + 1);
            const m = /^(.+)\.dll_(amd64|x86)$/i.exec(name);
            if (m && m[2].toLowerCase() === CAB_SUFFIX[arch] && VC_DLLS.includes(m[1].toLowerCase())) {
              mkdirSync(join(staged, arch), { recursive: true });
              copyFileSync(p, join(staged, arch, `${m[1].toLowerCase()}.dll`));
            }
          }
        };
        for (const cab of cabs) await open(cab, 0);
        if (!existsSync(join(staged, arch, 'msvcp140.dll')) || !existsSync(join(staged, arch, 'vcruntime140.dll'))) throw new Error(`Microsoft's ${arch} Visual C++ package has no runtime DLLs.`);
      }
      const version = readPeVersion(join(staged, 'x64', 'msvcp140.dll'))?.resources.find((r) => r.fixedFileVersion)?.fixedFileVersion ?? 'unknown';
      const dir = join(this.root, version);
      rmSync(dir, { recursive: true, force: true });
      renameSync(staged, dir);
      const rec = { version, dir, at: Date.now() };
      writeFileSync(join(this.root, 'current.json'), JSON.stringify(rec));
      for (const old of readdirSync(this.root)) if (/^\d+\./.test(old) && old !== version) rmSync(join(this.root, old), { recursive: true, force: true });
      return rec;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * Puts Microsoft's DLLs into a game's prefix where Wine's stand-ins (or nothing) are,
   * creating the prefix first when it does not exist. Returns how many files were placed.
   */
  async ensure(prefixDir: string, createPrefix: () => Promise<unknown>): Promise<number> {
    const { dir } = await this.files();
    const windows = join(prefixDir, 'pfx', 'drive_c', 'windows');
    // A new prefix is made first (Proton's own setup), without starting the game.
    if (!existsSync(join(windows, 'system32'))) await createPrefix();
    if (!existsSync(join(windows, 'system32'))) throw new Error('The game\'s Windows environment could not be prepared.');
    let placed = 0;
    for (const arch of Object.keys(DEST) as Arch[]) {
      const to = join(windows, DEST[arch]);
      if (!existsSync(to)) continue;
      for (const f of readdirSync(join(dir, arch))) {
        const target = join(to, f);
        // A real Microsoft DLL already there (a newer one, or the game's own setup) is kept.
        if (existsSync(target) && !isWineDll(target)) continue;
        copyFileSync(join(dir, arch, f), target);
        placed++;
      }
    }
    return placed;
  }
}

function sevenZip(bin: string, archive: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['x', '-y', '-bd', '-p-', `-o${out}`, '--', archive], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err) => (err ? reject(new Error(`Could not unpack Microsoft's package: ${err.message}`)) : resolve()));
  });
}
