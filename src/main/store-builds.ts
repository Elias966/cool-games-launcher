import { existsSync, mkdirSync, readFileSync, renameSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

export interface GogBuildInfo {
  buildId: string;
  builds?: { items: Array<{ build_id: string; legacy_build_id?: string; link: string; generation: number }> };
}

export function sameInstall(a: string, b: string): boolean {
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return canonical(a) === canonical(b);
}

export function installedExecutable(dir: string, executable: string): string {
  const full = resolve(dir, executable.replace(/\\/g, '/'));
  const rel = relative(resolve(dir), full);
  if (!rel || rel === '..' || rel.startsWith('../') || !existsSync(full) || !statSync(full).isFile()) throw new Error('The store game executable is missing or outside its install folder.');
  return full;
}

export function readGogInfo(dir: string, id: string): { buildId: string | null; playTasks?: Array<{ isPrimary?: boolean; type?: string; path?: string; arguments?: string; category?: string }> } {
  const info = JSON.parse(readFileSync(join(dir, `goggame-${id}.info`), 'utf8'));
  if (String(info.rootGameId ?? info.gameId) !== id) throw new Error('This GOG folder belongs to a different game.');
  let build = info.buildId;
  const pin = join(dir, `goggame-${id}.id`);
  if (!build && existsSync(pin)) build = JSON.parse(readFileSync(pin, 'utf8')).buildId;
  return { ...info, buildId: build == null ? null : String(build) };
}

export function readJsonFile(path: string): any | null {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** Seed the bundled client's repair manifest from the selected real GOG build.
 * An imported copy must be verified, rather than trusting another copy's cache. */
export async function seedGogRepairManifest(p: { file: string; legacyFile?: string; id: string; target: GogBuildInfo; http: typeof fetch; signal: AbortSignal }) {
  for (const file of [p.file, p.legacyFile].filter((v): v is string => !!v)) {
    const saved = readJsonFile(file);
    if (String(saved?.baseProductId ?? saved?.product?.rootGameID) === p.id && String(saved?.buildId) === p.target.buildId) {
      atomicJson(p.file, { ...saved, HGLInstallLanguage: 'en-US', HGLdlcs: [] });
      return;
    }
  }
  const build = p.target.builds?.items.find((b) => String(b.build_id) === p.target.buildId || String(b.legacy_build_id) === p.target.buildId);
  if (!build || !/^https:\/\//.test(build.link)) throw new Error('GOG did not provide a manifest for the requested build.');
  const response = await p.http(build.link, { signal: AbortSignal.any([p.signal, AbortSignal.timeout(30_000)]) });
  if (!response.ok) throw new Error(`GOG manifest HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  let text: string;
  try { text = inflateSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'); } catch { text = bytes.toString('utf8'); }
  const meta = JSON.parse(text);
  if (String(meta.baseProductId ?? meta.product?.rootGameID) !== p.id || (meta.buildId && String(meta.buildId) !== p.target.buildId)) throw new Error('GOG returned a manifest for a different game or build.');
  atomicJson(p.file, { ...meta, version: build.generation, buildId: p.target.buildId, HGLPlatform: 'windows', HGLInstallLanguage: 'en-US', HGLdlcs: [] });
}
