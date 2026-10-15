// Save backups: copies of what a game wrote — the user folders of its own
// Proton/Wine prefix (AppData, Documents, Saved Games …) and the files it
// created or changed inside its install folder — kept as plain folders the
// player can browse, and restorable with one click.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { playerFiles, walk } from './carry-over';

const MAX_FILE = 512 * 1024 ** 2;
const MAX_TOTAL = 8 * 1024 ** 3;
// Caches and runtime folders Windows games and Proton create; never saves.
const SKIP = /(?:^|\/)(?:Temp|Microsoft|D3DSCache|NVIDIA(?: Corporation)?|AMD|Intel|ShaderCache|shadercache|GPUCache|Code Cache|CrashDumps|CrashReports|Crashes|logs?|Logs|cache|Cache|Caches|webcache|INetCache|Packages|dxvk-cache|vkd3d-proton\.cache)(?:\/|$)|\.(?:log|dmp|tmp|dxvk-cache)$/;

/** User data folders of a Wine/Proton prefix (umu uses the prefix itself; Steam's layout nests it in pfx/). */
export function prefixUserRoots(prefix: string | null | undefined): string[] {
  if (!prefix) return [];
  const roots: string[] = [];
  for (const base of [join(prefix, 'drive_c', 'users'), join(prefix, 'pfx', 'drive_c', 'users')]) {
    if (!existsSync(base)) continue;
    for (const user of readdirSync(base)) if (user !== 'Public' && !user.startsWith('.')) roots.push(join(base, user));
  }
  return roots;
}

const within = (root: string, p: string) => resolve(p).startsWith(resolve(root) + sep);

export interface BackupParams {
  out: string;
  gameRoot: string | null;
  manifest?: string | null;
  since?: number | null;
  prefix?: string | null;
  meta: Record<string, unknown>;
}

/** Copies the game's saves into `out`; returns what was saved (nothing → no folder). */
export function backupSaves(p: BackupParams): { files: number; bytes: number } {
  const plan: Array<{ from: string; to: string; size: number }> = [];
  let total = 0;
  const add = (from: string, to: string, size: number) => {
    if (size > MAX_FILE || total + size > MAX_TOTAL) return;
    total += size;
    plan.push({ from, to, size });
  };
  if (p.gameRoot && existsSync(p.gameRoot)) {
    for (const f of playerFiles(p.gameRoot, p.manifest, p.since)) if (!SKIP.test(f.rel)) add(join(p.gameRoot, f.rel), join(p.out, 'game', f.rel), f.size);
  }
  for (const root of prefixUserRoots(p.prefix)) {
    const user = root.split(sep).pop()!;
    walk(root, (rel, size) => { if (!SKIP.test(rel)) add(join(root, rel), join(p.out, 'prefix', user, rel), size); });
  }
  if (!plan.length) return { files: 0, bytes: 0 };
  for (const f of plan) {
    mkdirSync(dirname(f.to), { recursive: true });
    copyFileSync(f.from, f.to);
  }
  writeFileSync(join(p.out, 'backup.json'), JSON.stringify({ ...p.meta, files: plan.length, bytes: total }, null, 2));
  return { files: plan.length, bytes: total };
}

/** Puts a backup's files back where they came from. */
export function restoreSaves(p: { from: string; gameRoot: string | null; prefix: string | null }): { files: number } {
  let files = 0;
  const copyTree = (src: string, dest: string) => {
    if (!existsSync(src)) return;
    walk(src, (rel) => {
      const target = join(dest, rel);
      if (!within(dest, target)) return;
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(src, rel), target);
      files++;
    });
  };
  if (p.gameRoot) copyTree(join(p.from, 'game'), p.gameRoot);
  const users = prefixUserRoots(p.prefix);
  const saved = join(p.from, 'prefix');
  if (existsSync(saved)) {
    for (const user of readdirSync(saved)) {
      // A backup from another user name (Wine vs Proton) goes to the prefix's current user folder.
      const dest = users.find((u) => u.endsWith(`${sep}${user}`)) ?? users[0];
      if (dest) copyTree(join(saved, user), dest);
    }
  }
  return { files };
}

/** Keeps the newest `keep` backups of a game. */
export function pruneBackups(dir: string, keep: number): void {
  if (!existsSync(dir)) return;
  const all = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, old), { recursive: true, force: true });
}

