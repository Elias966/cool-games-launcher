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


/** Record only identifiers actually found in this installation. Competing values
 * within a build system stay unresolved instead of choosing the first file. */
export function inspectedInstalledVersion(g: GameRecord, d: DownloadRecord | null, result: import('../workers/version-evidence').VersionEvidenceResult, newlyInstalled = false): InstalledVersion {
  const checkedAt = new Date().toISOString();
  const identifiers: NonNullable<InstalledVersion['identifiers']> = [];
  for (const scheme of ['semantic', 'steam-build', 'gog-build', 'epic-build', 'developer-build'] as const) {
    const found = result.evidence.filter(e => e.scheme === scheme);
    const values = [...new Set(found.map(e => e.version))];
    if (values.length === 1) identifiers.push({ scheme, version: scheme.endsWith('-build') ? `build ${values[0]}` : values[0], source: found.map(e => e.path).join('; ') });
  }
  let executableIdentity: InstalledVersion['executableIdentity'];
  try { const stat = statSync(g.executable!); executableIdentity = { path: g.executable!, bytes: stat.size, modified: stat.mtimeMs }; } catch { /* vanished installation */ }
  // A download-time receipt is separate evidence. A fresh website page is never
  // used as a substitute for the bytes that were installed.
  const previous = g.installedVersion;
  const receipt = d?.resolution?.buildVersion;
  const evidenceIdentity: NonNullable<InstalledVersion['evidenceIdentity']> = [];
  for (const path of [...new Set([...result.evidence.filter(e => e.kind !== 'game-log').map(e => e.path.split('::')[0]), ...result.inspectedPaths.filter(p => /\.(?:exe|pak)$/i.test(p))])].sort()) {
    try { const stat = statSync(path); evidenceIdentity.push({ path, bytes: stat.size, modified: stat.mtimeMs }); } catch { /* missing evidence invalidates receipts */ }
  }
  const unchanged = !!previous?.evidenceIdentity?.length && JSON.stringify(previous.evidenceIdentity) === JSON.stringify(evidenceIdentity) && JSON.stringify(previous.executableIdentity) === JSON.stringify(executableIdentity);
  const linkedDownload = !!d && g.managed && d.gameId === g.id && d.state === 'completed' && d.installState === 'installed' && d.preparation?.installDir === g.installDir;
  const trusted = linkedDownload && (newlyInstalled || unchanged) ? receipt ?? previous : null;
  if (trusted?.version) {
    const scheme = trusted.scheme ?? (/^build /.test(trusted.version) ? (/^(?:www\.)?steamrip\.com$/i.test(g.sourceHost ?? '') ? 'steam-build' : 'site-build') : 'semantic');
    if (!result.evidence.some(e => e.scheme === scheme) && !identifiers.some(e => e.scheme === scheme)) identifiers.push({ scheme, version: trusted.version, source: 'download-time receipt' });
  }
  const preferred = identifiers.find(e => e.scheme === 'semantic') ?? identifiers.find(e => e.scheme === 'steam-build') ?? identifiers[0];
  const conflict = result.evidence.some(e => !identifiers.some(i => i.scheme === e.scheme));
  return {
    ...(trusted ?? { updated: null, files: [], sizes: [], at: checkedAt }),
    version: preferred?.version ?? null, scheme: preferred?.scheme,
    file: trusted ? previous?.file ?? (d ? { url: d.url, name: d.fileName, bytes: d.totalBytes, etag: d.etag, lastModified: d.lastModified } : null) : null,
    identifiers, executableIdentity, evidenceIdentity,
    inspection: {
      state: preferred ? 'identified' : 'unresolved', checkedAt,
      detail: preferred ? `Installed version identified from ${preferred.source}.` : conflict ? 'Local files report conflicting game versions. No update was offered.' : `No reliable game version was found in the executable, manifests, configuration or logs.${result.limitations.length ? ' ' + result.limitations.join(' ') : ''}`,
    },
  };
}
