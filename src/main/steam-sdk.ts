// Valve's Proton starts every game through its steam.exe bridge, whose
// lsteamclient loads Steam's library from one fixed place,
// ~/.steam/sdk64/steamclient.so (sdk32 for 32-bit), and stops with "Assertion
// failed … steamclient_main.c … !status" when it is not there. A native Steam
// install makes those links itself; the Flatpak Steam keeps them inside its
// sandbox (~/.var/app/com.valvesoftware.Steam/.steam). The launcher makes the
// same links to the Steam that is installed. GE-Proton does not need them.
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ARCH_DIRS = [['sdk64', 'linux64'], ['sdk32', 'linux32']] as const;

/** Steam installations that hold steamclient.so, the one the Proton comes from first. */
export function steamRoots(protonPath: string, home = homedir()): string[] {
  const own = /^(.*)\/steamapps\/common\//.exec(protonPath)?.[1];
  return [own, join(home, '.var/app/com.valvesoftware.Steam/.local/share/Steam'), join(home, '.local/share/Steam'), join(home, 'snap/steam/common/.local/share/Steam')]
    .filter((p, i, all): p is string => !!p && all.indexOf(p) === i && existsSync(join(p, 'linux64', 'steamclient.so')));
}

/**
 * Makes ~/.steam/sdk64 and sdk32 point at an installed Steam's steamclient.so when they do not
 * already lead to one. Returns whether Proton's Steam bridge will find the library.
 */
export function ensureSteamSdk(protonPath: string, home = homedir()): boolean {
  const root = steamRoots(protonPath, home)[0];
  let ok = true;
  for (const [sdk, lib] of ARCH_DIRS) {
    const link = join(home, '.steam', sdk, 'steamclient.so');
    if (existsSync(link)) continue; // already leads to a library (native Steam, or made before)
    const target = root && join(root, lib, 'steamclient.so');
    if (!target || !existsSync(target)) { if (sdk === 'sdk64') ok = false; continue; }
    mkdirSync(join(home, '.steam', sdk), { recursive: true });
    // A link left pointing nowhere (Steam moved or removed) is replaced; real files never are.
    try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link); } catch { /* nothing there */ }
    symlinkSync(realpathSync(target), link);
  }
  return ok;
}
