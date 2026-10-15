// Finds launchable files inside an installed game folder and ranks them.
import { openSync, readSync, closeSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';

export type ExecKind = 'elf' | 'appimage' | 'script' | 'exe' | 'msi';

export interface ExecCandidate {
  path: string;
  relPath: string;
  kind: ExecKind;
  size: number;
  score: number;
  installerLike: boolean;
}

const IGNORE_NAME = /^(unins\d*|uninstall|unitycrashhandler(32|64)?|crashpad_handler|chrome-sandbox|notification_helper|vc_?redist.*|vcredist.*|dxsetup|dxwebsetup|directx.*|dotnet.*|oalinst|physx.*|ue4prereqsetup.*|ueprereqsetup.*|easyanticheat.*|crashreportclient|crashhandler|updater|unityinstaller|cefprocess|zsync.*|createdump|python\d*(\.\d+)?|pythonw|node|java|javaw|jjs|keytool|zenity|xdg-open)(\.[a-z0-9]+)?$/i;
const IGNORE_DIR = /^(__macosx|\.git|redist|_redist|_commonredist|directx|vcredist|dotnet|support|prereqs?|jre|jdk|python|lib|lib32|lib64|share|locale|licenses?|docs?|engine\/binaries\/thirdparty)$/i;
const LIB = /\.(so(\.\d+)*|dll|dylib|pak|bin|dat|assets|resource|ress)$/i;
const INSTALLER = /(setup|install(er)?|bootstrap)/i;

function head(path: string, n = 64): Buffer {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(n);
    const read = readSync(fd, b, 0, n, 0);
    return b.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export function detectKind(path: string, mode: number): ExecKind | null {
  const name = basename(path).toLowerCase();
  const ext = extname(name);
  if (ext === '.msi') return 'msi';
  if (LIB.test(name)) return null;
  let h: Buffer;
  try {
    h = head(path);
  } catch {
    return null;
  }
  if (h.length >= 4 && h[0] === 0x7f && h[1] === 0x45 && h[2] === 0x4c && h[3] === 0x46) {
    // ELF: only executables (ET_EXEC=2) and PIE (ET_DYN=3) with an exec bit or a launcher-like name.
    const type = h.length >= 18 ? h.readUInt16LE(16) : 0;
    if (type !== 2 && type !== 3) return null;
    if (ext === '.appimage') return 'appimage';
    if (type === 3 && !(mode & 0o111) && !/\.(x86_64|x86|bin)$/i.test(name)) return null;
    return 'elf';
  }
  if (h.length >= 2 && h[0] === 0x4d && h[1] === 0x5a && (ext === '.exe' || ext === '.com')) return 'exe';
  if (h.length >= 2 && h[0] === 0x23 && h[1] === 0x21 && (ext === '.sh' || ext === '' || ext === '.run')) return 'script';
  return null;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1);
}

export function scanExecutables(root: string, gameTitle: string, maxFiles = 20000, maxDepth = 6): ExecCandidate[] {
  const out: ExecCandidate[] = [];
  const titleTokens = new Set(tokens(gameTitle));
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || seen > maxFiles) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (++seen > maxFiles) return;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        const rel = relative(root, full).toLowerCase();
        if (!IGNORE_DIR.test(name) && !IGNORE_DIR.test(rel)) walk(full, depth + 1);
        continue;
      }
      if (!st.isFile() || IGNORE_NAME.test(name)) continue;
      const kind = detectKind(full, st.mode);
      if (!kind) continue;
      const rel = relative(root, full);
      const installerLike = (kind === 'exe' || kind === 'msi' || kind === 'script') && INSTALLER.test(name);
      let score = 0;
      score += Math.max(0, 40 - depth * 12);
      const nameTokens = tokens(name.replace(/\.[^.]+$/, ''));
      const overlap = nameTokens.filter((t) => titleTokens.has(t)).length;
      score += Math.min(40, overlap * 20);
      const stem = name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const title = gameTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (title && stem === title) score += 35;
      if (/-win64-shipping\.exe$/i.test(name)) score += 35;
      if (/\.(x86_64|appimage)$/i.test(name)) score += 25;
      if (/^(start|run|launch|play)(\.sh)?$/i.test(name) || /(^|[-_])(launcher|start)\.sh$/i.test(name)) score += 20;
      if (kind === 'elf' || kind === 'appimage') score += 15;
      if (kind === 'script') score += 5;
      if (/(^|[-_.])(x86|i386|32)([-_.]|$)/i.test(name)) score -= 10;
      if (/server|dedicated|editor|config|settings|benchmark|debug/i.test(name)) score -= 25;
      if (installerLike) score -= 30;
      score += Math.min(15, Math.log2(Math.max(1, st.size / 1024 / 1024)) * 2);
      out.push({ path: full, relPath: rel, kind, size: st.size, score: Math.round(score), installerLike });
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.score - a.score);
}

/** Returns the obvious choice, or null when the user should pick. */
export function pickExecutable(cands: ExecCandidate[]): ExecCandidate | null {
  const usable = cands.filter((c) => !c.installerLike && c.kind !== 'msi');
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];
  return usable[0].score - usable[1].score >= 20 ? usable[0] : null;
}
