import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Steam's extra libraries and both Flatpak layouts are authoritative paths. */
export function detectProton(home = homedir()): string[] {
  const steam = ['.steam/root', '.steam/steam', '.local/share/Steam', '.var/app/com.valvesoftware.Steam/data/Steam', '.var/app/com.valvesoftware.Steam/.local/share/Steam'].map(p => join(home, p));
  steam.push('/usr/share/steam');
  const libraries = new Set(steam);
  for (const root of steam) {
    try {
      const vdf = readFileSync(join(root, 'steamapps/libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"(?:path|\d+)"\s*"([^"\r\n]+)"/g)) {
        const path = m[1].replace(/\\\\/g, '\\');
        if (path.startsWith('/')) libraries.add(path);
      }
    } catch { /* Steam may not be installed in this layout. */ }
  }
  const roots = [...libraries].flatMap(p => [join(p, 'steamapps/common'), join(p, 'compatibilitytools.d')]);
  roots.push(join(home, '.local/share/umu/compatibilitytools'));
  const found = new Set<string>();
  for (const root of roots) {
    try {
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        if (/proton/i.test(name) && existsSync(join(dir, 'proton')) && statSync(join(dir, 'proton')).isFile()) found.add(realpathSync(dir));
      }
    } catch { /* Disconnected Steam libraries must not prevent launching. */ }
  }
  return [...found].sort().reverse();
}
