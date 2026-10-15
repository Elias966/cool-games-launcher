// Game runtimes shipped next to Windows games (_CommonRedist, Redist,
// DirectX, vcredist, Unreal prerequisites): which installers there are and
// how each runs silently. .NET Framework is skipped on purpose — Proton's
// wine-mono provides .NET, and the real framework often breaks prefixes.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Redist { path: string; rel: string; label: string; args: string[] }

const FOLDER = /(?:^|[\\/_ -])(?:_?common_?redist|redist(?:ributables?)?|directx|vcredist|prereq(?:uisites)?|support)(?:$|[\\/_ -])/i;

/** The silent install switches for a runtime installer, or null when it should not be run. */
export function redistFor(fileName: string): { label: string; args: string[] } | null {
  const n = fileName.toLowerCase();
  if (/dotnet|ndp\d|netfx|dotnetfx|windowsdesktop-runtime/.test(n)) return null;
  if (/visualcppredist_aio/.test(n)) return { label: 'Visual C++ runtimes', args: ['/ai'] };
  if (/^vc_?redist[._-]?(x64|x86|arm64)?.*\.exe$/.test(n) && /vc_redist/.test(n)) return { label: 'Visual C++ runtime', args: ['/install', '/quiet', '/norestart'] };
  if (/^vcredist.*\.exe$/.test(n)) return { label: 'Visual C++ runtime', args: ['/q', '/norestart'] };
  if (n === 'dxsetup.exe') return { label: 'DirectX', args: ['/silent'] };
  if (n === 'dxwebsetup.exe') return { label: 'DirectX', args: ['/Q'] };
  if (n === 'oalinst.exe') return { label: 'OpenAL', args: ['/s'] };
  if (/^ue\d?prereqsetup.*\.exe$/.test(n)) return { label: 'Unreal Engine prerequisites', args: ['/quiet', '/norestart'] };
  if (n.endsWith('.msi') && /xna|physx|openal|vcredist|directx/.test(n)) return { label: /xna/.test(n) ? 'XNA Framework' : /physx/.test(n) ? 'PhysX' : 'Runtime', args: ['/qn'] };
  return null;
}

/** Runtime installers inside a game folder (up to 4 levels deep), at most 12. */
export function findRedists(root: string): Redist[] {
  const out: Redist[] = [];
  const walk = (dir: string, depth: number, inRedist: boolean) => {
    if (depth > 4 || out.length >= 12) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1, inRedist || FOLDER.test(name) || /engine[\\/]extras[\\/]redist/i.test(full));
      else if (inRedist && st.isFile()) {
        const r = redistFor(name);
        if (r) out.push({ path: full, rel: relative(root, full), ...r });
      }
    }
  };
  walk(root, 0, false);
  // Visual C++ before the rest: other installers can depend on it.
  return out.sort((a, b) => Number(/visual c/i.test(b.label)) - Number(/visual c/i.test(a.label)));
}
