// Imported games have no download-time fingerprint. Use local, game-specific
// metadata, never today's remote page or the Unreal/Unity engine version.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { findVersion, makeFingerprint, type InstalledVersion } from '@shared/game-version';
import type { DownloadRecord, GameRecord } from './repos';

/** Importing an Unreal executable from Binaries/Win64 must also track the
 * project's sibling Saved folder. Expand only this recognised game layout. */
export function installedGameRoot(g: Pick<GameRecord, 'installDir' | 'executable'>): string | null {
  const root = g.installDir;
  if (!root) return null;
  const bin = /^(?:win64|win32|linux)$/i.test(basename(root)) ? dirname(root) : root;
  if (/^binaries$/i.test(basename(bin))) {
    const project = dirname(bin);
    if (existsSync(join(project, 'Content')) || existsSync(join(project, 'Saved')) || existsSync(join(project, 'Config'))) return project;
  }
  return root;
}

export function localInstalledVersion(g: GameRecord, d: DownloadRecord | null): InstalledVersion {
  const titles = [g.title, d?.title, d?.fileName, basename(g.installDir ?? ''), basename(dirname(g.installDir ?? ''))];
  let version = findVersion({ titles, files: [d?.fileName] });
  const gameRoot = installedGameRoot(g);
  const roots = [...new Set([gameRoot, g.executable && dirname(g.executable), gameRoot && join(gameRoot, 'Config')].filter((p): p is string => !!p))];
  for (const root of roots) {
    if (version) break;
    let files: string[] = [];
    try { files = readdirSync(root).filter(n => /^(?:version(?:\.txt|\.json)?|buildid(?:\.txt)?|DefaultGame\.ini|steam_emu\.ini|OnlineFix\.ini)$/i.test(n)); } catch { continue; }
    for (const file of files) {
      try {
        const path = join(root, file);
        if (!existsSync(path) || statSync(path).size > 64 * 1024) continue;
        const text = readFileSync(path, 'utf8');
        const build = /\bBuildId\s*=\s*(\d{3,})\b/i.exec(text)?.[1];
        const project = /\bProjectVersion\s*=\s*(\d+(?:\.\d+){1,3})\b/i.exec(text)?.[1];
        const simple = /^\s*(?:v\s*)?(\d+(?:\.\d+){1,3})\s*$/i.exec(text)?.[1];
        version = build ? `build ${build}` : project ?? simple ?? findVersion({ text });
        if (version) break;
      } catch { /* Missing metadata does not establish a version. */ }
    }
  }
  const base = makeFingerprint({ titles: [], candidates: d?.fileName ? [{ fileName: d.fileName, label: d.fileName, sizeText: null }] : [], at: g.addedAt });
  return { ...base, version, file: d ? { url: d.url, name: d.fileName, bytes: d.totalBytes, etag: d.etag, lastModified: d.lastModified } : null };
}
