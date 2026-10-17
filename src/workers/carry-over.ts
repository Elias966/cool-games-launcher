// Save carry-over between builds of a game. Right after a build is prepared
// (before it is ever launched) its file list is recorded; anything the game
// later creates or changes inside its folder — saves, settings, mods — is then
// copied into the next build when the game is updated, and back when an update
// is rolled back.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { rebaser } from '@shared/game-version';

type Manifest = Record<string, [size: number, mtimeMs: number]>;

const MAX_FILES = 200_000;
const MAX_FILE_BYTES = 2 * 1024 ** 3;
// Never let the old build's programs overwrite the new build's.
const PROGRAM = /\.(exe|dll|so(\.\d+)*|msi|x86_64|x86|appimage|pck|pak|bat|sh)$/i;
// Imported saves often predate the day the folder was added to the launcher.
// Their identity, rather than import time, establishes that they are user data.
const SAVE = /(?:^|\/)(?:saves?|savegames?|saved|savedata|userdata|user_data|profiles?|settings|config)(?:\/|$)|(?:^|\/)(?:save|progress|profile|slot|autosave|quicksave|game_state)[^/]*\.(?:dat|bin|json|db|sqlite)$|\.(?:sav|save|sgd|cfg|ini|prefs)$/i;
const isPlayerFile = (rel: string, size: number, mtime: number, manifest: Manifest | null, since?: number | null) => {
  if (!PROGRAM.test(rel) && SAVE.test(rel)) return true;
  const known = manifest?.[rel];
  return manifest ? !known || known[0] !== size || Math.abs(known[1] - mtime) > 2000 : !!since && mtime > since + 2000;
};

export function walk(root: string, onFile: (rel: string, size: number, mtimeMs: number) => void) {
  const stack = [''];
  let n = 0;
  while (stack.length) {
    const rel = stack.pop()!;
    let names: string[];
    try { names = readdirSync(join(root, rel)); } catch { continue; }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = lstatSync(join(root, r)); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(r);
      else if (st.isFile()) { onFile(r, st.size, Math.round(st.mtimeMs)); if (++n >= MAX_FILES) return; }
    }
  }
}

/** Records the pristine file list of a freshly prepared build. */
export function snapshotBuild(p: { root: string; out: string }): { files: number } {
  const m: Manifest = {};
  walk(p.root, (rel, size, mtime) => { m[rel] = [size, mtime]; });
  mkdirSync(dirname(p.out), { recursive: true });
  writeFileSync(p.out, JSON.stringify(m));
  return { files: Object.keys(m).length };
}

const within = (root: string, p: string) => resolve(p).startsWith(resolve(root) + sep);

export interface CarryParams {
  fromRoot: string;
  fromExe: string;
  toRoot: string;
  toExe: string;
  /** Pristine file list of the old build, when one was recorded. */
  manifest?: string | null;
  /** Without a manifest: files modified after this time (ms) count as the player's. */
  since?: number | null;
}

/** Files in a build that the player created or changed (relative paths), using its pristine file list or a time. */
export function playerFiles(root: string, manifestPath: string | null | undefined, since: number | null | undefined): Array<{ rel: string; size: number }> {
  let manifest: Manifest | null = null;
  if (manifestPath && existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest; } catch { manifest = null; }
  }
  const out: Array<{ rel: string; size: number }> = [];
  walk(root, (rel, size, mtime) => {
    const players = isPlayerFile(rel, size, mtime, manifest, since);
    if (players && !PROGRAM.test(rel)) out.push({ rel, size });
  });
  return out;
}

/** Copies the player's files from one build into another; returns what was copied. */
export function carryOver(p: CarryParams): { copied: string[]; skipped: string[] } {
  let manifest: Manifest | null = null;
  if (p.manifest && existsSync(p.manifest)) {
    try { manifest = JSON.parse(readFileSync(p.manifest, 'utf8')) as Manifest; } catch { manifest = null; }
  }
  const map = rebaser(relative(p.fromRoot, p.fromExe).split(sep).join('/'), relative(p.toRoot, p.toExe).split(sep).join('/'));
  const copied: string[] = [];
  const skipped: string[] = [];
  walk(p.fromRoot, (rel, size, mtime) => {
    const players = isPlayerFile(rel, size, mtime, manifest, p.since);
    if (!players) return;
    const target = join(p.toRoot, map(rel));
    if (!within(p.toRoot, target) || size > MAX_FILE_BYTES || (PROGRAM.test(rel) && existsSync(target))) { skipped.push(rel); return; }
    try {
      // An archive may have planted a symlink in a save's destination path.
      // Never follow it outside the staged build or overwrite unrelated files.
      for (let path = target; within(p.toRoot, path); path = dirname(path)) {
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Symbolic link in save destination');
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(p.fromRoot, rel), target);
      copied.push(map(rel));
    } catch (e) {
      // Keep the original installation selected. A silently skipped save is
      // worse than a failed update that can be retried.
      throw new Error(`Could not preserve ${rel}: ${(e as Error).message}`);
    }
  });
  return { copied, skipped };
}
