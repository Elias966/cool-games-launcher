// Local evidence only. Never launch a game, infer a build from timestamps, or
// mistake a bundled engine/runtime's version for the installed game's version.
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type Dirent } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { readPeVersion } from '../main/pe-version';
import { readUnrealVersion } from './unreal-version';

export interface VersionEvidenceInput {
  installDir: string;
  executable: string;
  title: string;
  appid?: string;
  prefixDir?: string;
}
export type VersionEvidenceScheme = 'semantic' | 'steam-build' | 'gog-build' | 'epic-build' | 'developer-build';
export interface InstalledVersionEvidence {
  id: string;
  version: string;
  kind: 'exe' | 'game-config' | 'version-file' | 'steam-manifest' | 'gog-manifest' | 'epic-manifest' | 'game-log';
  /** Build numbers from different publishers or build systems are incomparable. */
  scheme: VersionEvidenceScheme;
  path: string;
  context: string;
}
export interface VersionEvidenceResult {
  evidence: InstalledVersionEvidence[];
  inspectedPaths: string[];
  rejectedResources: Array<{ path: string; reason: string }>;
  candidateSnippets: Array<{ path: string; text: string }>;
  limitsReached: boolean;
  limitations: string[];
}
const SKIP_DIR = /^(?:engine|plugins?|node_modules|\.git|\.egstore|redist|_commonredist|directx|dotnet|vcredist|cef|thirdparty|third-party|__installer|savegames|saves|screenshots|content|locales)$/i;
const HELPER = /^(?:crashreportclient|unitycrashhandler\d*|crashpad_handler|unins\d*|uninstall|setup|installer|vc_redist.*|dxsetup|ue[45]prereq.*|easyanticheat.*|battleye.*|eosoverlayrenderer.*|steamwebhelper|steamservice)(?:[._-]|$)/i;
const TEXT_NAME = /(?:^|[._ -])(?:version|build(?:id|settings|version|info)?|manifest)(?:[._ -]|$)|^(?:defaultgame|game|config|settings|onlinefix|steam_emu|steam_appid|goggame-\d+)\./i;
const cleanName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const inside = (root: string, file: string) => { const rel = relative(root, file); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

function valueVersion(raw: unknown, scheme: VersionEvidenceScheme): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw).trim().replace(/^["']|["']$/g, '').replace(/^v(?=\d)/i, '');
  if (!value || value.length > 100 || /\+\+UE\d|unreal|unity|unknown|default|placeholder/i.test(value)) return null;
  if (scheme === 'semantic') {
    if (!/^\d+(?:\.\d+){1,4}(?:[a-z]|[-+][a-z\d._-]+)?$/i.test(value)) return null;
    if (/^0(?:\.0)+$|^1\.0\.0(?:\.0)?$/.test(value)) return null;
  } else if (scheme === 'epic-build') {
    if (!/^[a-z\d][a-z\d._+-]{0,99}$/i.test(value) || !/\d/.test(value)) return null;
  } else if (!/^[1-9]\d{0,19}(?:[._-][\w.-]+)?$/.test(value)) return null;
  return value;
}

/** Scans at most 120 directories, 2,000 entries, 30 EXEs and 80 text files.
 * Every text file is at most 256 KiB, total text reads at most 4 MiB. */
export async function discoverVersionEvidence(input: VersionEvidenceInput): Promise<VersionEvidenceResult> {
  const result: VersionEvidenceResult = { evidence: [], inspectedPaths: [], rejectedResources: [], candidateSnippets: [], limitsReached: false, limitations: [] };
  const installDir = resolve(input.installDir), executable = resolve(installDir, input.executable);
  const roots = new Set([installDir]);
  // Imports can select a Shipping.exe rather than the top-level bootstrap.
  const exeDir = dirname(executable);
  const projectRoot = /^win(?:32|64)$/i.test(basename(exeDir)) && /^binaries$/i.test(basename(dirname(exeDir))) ? dirname(dirname(exeDir)) : exeDir;
  if (inside(installDir, projectRoot)) roots.add(projectRoot);
  const names = new Set([input.title, basename(installDir), basename(projectRoot), basename(executable, extname(executable)).replace(/-Win(?:32|64)-Shipping$/i, '')].map(cleanName).filter(n => n.length >= 3));
  const matchesName = (name: unknown) => typeof name === 'string' && names.has(cleanName(name));
  let directories = 0, entries = 0, exes = 0, textFiles = 0, textBytes = 0;
  const visited = new Set<string>(), exePaths = new Set<string>(), textPaths = new Set<string>();
  const reject = (path: string, reason: string) => result.rejectedResources.push({ path, reason });
  const add = (path: string, field: string, raw: unknown, scheme: VersionEvidenceScheme, kind: InstalledVersionEvidence['kind'], context: string) => {
    const version = valueVersion(raw, scheme);
    if (!version) { if (raw !== undefined && raw !== null && String(raw).trim()) reject(path, `Rejected ${field}: engine, placeholder, or unsupported version`); return; }
    if (!result.evidence.some(e => e.path === path && e.version === version && e.scheme === scheme)) result.evidence.push({ id: `${scheme}:${path}:${field}:${version}`, path, version, scheme, kind, context: context.slice(0, 400) });
  };
  const list = (path: string) => {
    if (++directories > 120) { result.limitsReached = true; return []; }
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
      const directory = opendirSync(path), items: Dirent[] = [];
      try {
        let item: Dirent | null;
        while ((item = directory.readSync()) !== null) {
          if (items.length >= 2048) { result.limitsReached = true; break; }
          items.push(item);
        }
      } finally { directory.closeSync(); }
      return items.sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  };
  const text = (path: string): string | null => {
    if (textPaths.has(path)) return null;
    textPaths.add(path);
    if (++textFiles > 80) { result.limitsReached = true; return null; }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) return null;
      if (stat.size > 256 * 1024 || textBytes + stat.size > 4 * 1024 * 1024) { result.limitsReached = true; reject(path, 'Text evidence exceeds read budget'); return null; }
      textBytes += stat.size; result.inspectedPaths.push(path);
      const data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) {
        const count = readSync(descriptor, data, offset, data.length - offset, offset);
        if (!count) return null;
        offset += count;
      }
      const s = (data[0] === 0xff && data[1] === 0xfe ? data.subarray(2).toString('utf16le') : data.toString('utf8')).replace(/^\ufeff/, '');
      if (s.includes('\0')) return null;
      return s;
    } catch { return null; } finally { if (descriptor !== undefined) closeSync(descriptor); }
  };
  const inspectExe = (path: string) => {
    if (exePaths.has(path)) return;
    exePaths.add(path);
    if (++exes > 30) { result.limitsReached = true; return; }
    if (HELPER.test(basename(path)) || /(?:^|[\\/])Engine(?:[\\/]|$)/i.test(path)) { reject(path, 'Engine, runtime, or helper executable'); return; }
    result.inspectedPaths.push(path);
    const metadata = readPeVersion(path);
    if (metadata?.gameVersion) add(path, 'ProductVersion', metadata.gameVersion, 'semantic', 'exe', 'Game executable VERSIONINFO');
    else reject(path, metadata?.rejectionReason ?? 'No readable game VERSIONINFO in executable');
  };
  if (/\.exe$/i.test(executable)) inspectExe(executable);
  const files: string[] = [];
  const walk = (path: string, depth: number) => {
    if (visited.has(path) || depth > 6 || entries >= 2000 || directories >= 120) { if (!visited.has(path)) result.limitsReached = true; return; }
    visited.add(path);
    for (const item of list(path)) {
      if (++entries > 2000) { result.limitsReached = true; break; }
      const child = join(path, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) { if (!SKIP_DIR.test(item.name)) walk(child, depth + 1); }
      else if (item.isFile()) {
        if (/\.exe$/i.test(item.name)) {
          if (child === executable || /-Win(?:32|64)-Shipping\.exe$/i.test(item.name)) inspectExe(child);
        }
        else if (/\.(?:ini|cfg|conf|json|info|item|acf|txt|log|version|dat)$/i.test(item.name) || /^(?:version|buildid)$/i.test(item.name)) {
          if (TEXT_NAME.test(item.name) || /\.(?:info|item|acf|log)$/i.test(item.name) || (/\.(?:ini|cfg|conf)$/i.test(item.name) && /(?:^|[\\/])Config(?:[\\/]|$)/i.test(path))) files.push(child);
        }
      }
    }
  };
  for (const root of roots) walk(root, 0);
  // Only the selected game's directories inside the supplied Wine prefix.
  if (input.prefixDir) {
    const users = join(resolve(input.prefixDir), 'drive_c/users');
    for (const user of list(users).slice(0, 20)) {
      if (!user.isDirectory() || user.isSymbolicLink()) continue;
      for (const area of ['Local', 'LocalLow', 'Roaming']) {
        const appData = join(users, user.name, 'AppData', area);
        for (const game of list(appData).slice(0, 64)) {
          if (game.isDirectory() && !game.isSymbolicLink() && matchesName(game.name)) walk(join(appData, game.name), 0);
        }
      }
    }
  }
  // Steam identity must come from the selected game, never a nearby random ACF.
  const appids = new Set<string>();
  if (/^[1-9]\d{0,11}$/.test(input.appid ?? '')) appids.add(input.appid!);
  for (const file of files) {
    if (/^steam_appid\.txt$/i.test(basename(file))) {
      const s = text(file)?.trim(); if (/^[1-9]\d{0,11}$/.test(s ?? '')) appids.add(s!);
    } else if (/^(?:onlinefix|steam_emu)\.ini$/i.test(basename(file))) {
      const s = text(file);
      if (s) for (const m of s.matchAll(/^\s*(?:RealAppId|AppId)\s*=\s*([1-9]\d{0,11})\s*(?:[;#].*)?$/gim)) appids.add(m[1]);
      // OnlineFix BuildId=0 (or an emulator override) is never install evidence.
    }
  }
  for (const root of roots) {
    let parent = root;
    for (let n = 0; n < 4; n++) {
      if (/^steamapps$/i.test(basename(parent))) for (const appid of appids) files.push(join(parent, `appmanifest_${appid}.acf`));
      const next = dirname(parent); if (next === parent) break; parent = next;
    }
  }
  const fields = /^(?:ProjectVersion|GameVersion|InstalledVersion|BuildVersion|BuildId|SteamBuildId|GameBuild|ProductVersion)$/i;
  for (const file of files) {
    if (/^(?:onlinefix|steam_emu|steam_appid)\./i.test(basename(file))) continue;
    const s = text(file); if (s === null) continue;
    const name = basename(file), log = /\.log$/i.test(name);
    if (/\.acf$/i.test(name)) {
      const id = /"appid"\s*"(\d+)"/i.exec(s)?.[1], build = /"buildid"\s*"([^"\r\n]+)"/i.exec(s)?.[1];
      if (id && appids.has(id)) add(file, 'buildid', build, 'steam-build', 'steam-manifest', `Steam appid ${id}`);
      else reject(file, 'Steam manifest identity does not match the game');
      continue;
    }
    if (/\.info$/i.test(name) || /\.item$/i.test(name)) {
      try {
        const data = JSON.parse(s) as Record<string, unknown>;
        if (/\.info$/i.test(name)) {
          const tasks = Array.isArray(data.playTasks) ? data.playTasks as Array<Record<string, unknown>> : [];
          const taskMatch = tasks.some(t => typeof t.path === 'string' && resolve(dirname(file), t.path.replace(/\\/g, '/')) === executable);
          if (matchesName(data.name) || taskMatch) add(file, 'buildId', data.buildId ?? data.buildid, 'gog-build', 'gog-manifest', 'Identity-matching GOG game info');
          else reject(file, 'GOG metadata identity does not match the game');
        } else {
          const location = typeof data.InstallLocation === 'string' ? resolve(data.InstallLocation) : null;
          if (matchesName(data.DisplayName) && location && roots.has(location)) add(file, 'AppVersionString', data.AppVersionString, 'epic-build', 'epic-manifest', 'Identity-matching Epic installation');
          else reject(file, 'Epic metadata identity does not match the game');
        }
      } catch { reject(file, 'Malformed store metadata'); }
      continue;
    }
    if (/^(?:version(?:\.txt|\.dat|\.version)?|buildid(?:\.txt)?)$/i.test(name)) {
      add(file, name, s.trim(), /^buildid/i.test(name) ? 'developer-build' : 'semantic', 'version-file', 'Game-local version file');
      continue;
    }
    // Dependency/package JSON is deliberately excluded. Version evidence must
    // explicitly describe the game/project or come from a version/build manifest.
    if (/\.json$/i.test(name)) {
      try {
        const data = JSON.parse(s) as Record<string, unknown>;
        if (data && typeof data === 'object' && !Array.isArray(data)) for (const [key, value] of Object.entries(data)) {
          if (fields.test(key) || (/^(?:version|build)$/i.test(key) && /(?:version|build|manifest)/i.test(name))) {
            const scheme = /steam/i.test(key) ? 'steam-build' : /build/i.test(key) ? 'developer-build' : 'semantic';
            add(file, key, value, scheme, 'game-config', `${key} in game-local metadata`);
          }
        }
      } catch { /* A candidate snippet can still help identify a nonstandard file. */ }
    } else {
      let section = '';
      for (const line of s.split(/\r?\n/)) {
        const header = /^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/.exec(line); if (header) { section = header[1]; continue; }
        const m = (log ? /(?:^|[:\] ])(ProjectVersion|GameVersion|InstalledVersion|BuildVersion|BuildId|SteamBuildId|GameBuild|ProductVersion)\s*[:=]\s*([^;#\r\n]+)/i : /^\s*([A-Za-z_]+)\s*[:=]\s*([^;#\r\n]+)/).exec(line);
        if (!m || !fields.test(m[1])) continue;
        if (/engine|renderer|plugin|runtime|unity/i.test(section) && !/generalprojectsettings/i.test(section)) { reject(file, `${m[1]} belongs to engine/runtime section`); continue; }
        const scheme = /steam/i.test(m[1]) ? 'steam-build' : /build/i.test(m[1]) ? 'developer-build' : 'semantic';
        add(file, m[1], m[2].trim(), scheme, log ? 'game-log' : 'game-config', `${section ? `[${section}] ` : ''}${m[1]}=${m[2].trim()}`);
      }
    }
    const lines = s.split(/\r?\n/).filter(line => /(?:game|project|installed|build).{0,12}version|version.{0,12}(?:game|project)|build.?id/i.test(line) && !/engine|unity|unreal|directx|cef|vcredist/i.test(line));
    if (lines.length && result.candidateSnippets.length < 20) result.candidateSnippets.push({ path: file, text: lines.slice(0, 8).join('\n').slice(0, 1600) });
  }
  // Inspect only game-local pak metadata, never bulk assets. The parser
  // independently validates the index and member hashes before trusting text.
  const allShipping = [...exePaths].filter(path => /-Win(?:32|64)-Shipping\.exe$/i.test(path) && inside(installDir, path));
  const shipping = allShipping.slice(0, 3);
  if (allShipping.length > shipping.length) result.limitsReached = true;
  for (const path of shipping) roots.add(dirname(dirname(dirname(path))));
  const pakFiles = new Set<string>();
  pakRoots: for (const root of roots) for (const entry of list(join(root, 'Content/Paks'))) {
    if (entry.isFile() && !entry.isSymbolicLink() && /\.pak$/i.test(entry.name)) pakFiles.add(join(root, 'Content/Paks', entry.name));
    if (pakFiles.size >= 8) { result.limitsReached = true; break pakRoots; }
  }
  if (pakFiles.size) {
    const candidates = shipping.length ? shipping : [...exePaths].filter(path => path === executable).slice(0, 1);
    for (const path of candidates) {
      const parsed = await readUnrealVersion({ executable: path, pakFiles: [...pakFiles].slice(0, 8) });
      result.inspectedPaths.push(...[...pakFiles].filter(file => !result.inspectedPaths.includes(file)));
      result.limitations.push(...parsed.limitations);
      for (const item of parsed.evidence) {
        if (item.verified) add(item.source, item.namespace === 'semantic' ? 'ProjectVersion' : 'BuildVersion', item.version, item.namespace, 'game-config', `Verified Unreal game configuration inside pak metadata${item.attributes?.branch ? `; branch=${item.attributes.branch}` : ''}${item.attributes?.changelist ? `; changelist=${item.attributes.changelist}` : ''}`);
      }
      if (parsed.evidence.length) break;
    }
  }
  return result;
}
