// Desktop shortcuts for games: an applications-menu entry or a desktop icon
// that starts the game through the launcher (`--launch-game=<id>`).
import { app } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

/** The command that starts this launcher: the AppImage when packaged. */
function launcherCommand(): string[] {
  if (process.env.APPIMAGE) return [process.env.APPIMAGE];
  return app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()];
}

/** Desktop Entry quoting: every argument in double quotes, with ", `, $ and \\ escaped. */
export function desktopExec(args: string[]): string {
  return args.map((a) => `"${a.replace(/[\\\\"`$]/g, (c) => `\\\\${c}`)}"`).join(' ');
}

function desktopDir(): string {
  try {
    const dir = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim();
    if (dir) return dir;
  } catch { /* fall back */ }
  return join(homedir(), 'Desktop');
}

const fileName = (id: number) => `cool-games-launcher-game-${id}.desktop`;
const menuPath = (id: number) => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications', fileName(id));

export function createShortcut(p: { id: number; title: string; where: 'menu' | 'desktop'; artwork: string | null; iconDir: string; fallbackIcon: string }): string {
  let icon = p.fallbackIcon;
  if (p.artwork && existsSync(p.artwork)) {
    mkdirSync(p.iconDir, { recursive: true });
    icon = join(p.iconDir, `game-${p.id}${extname(p.artwork) || '.png'}`);
    copyFileSync(p.artwork, icon);
  }
  const title = p.title.replace(/[\r\n]/g, ' ');
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${title}`,
    `Comment=Play ${title} with Cool Games Launcher`,
    `Exec=${desktopExec([...launcherCommand(), `--launch-game=${p.id}`])}`,
    `Icon=${icon}`,
    'Categories=Game;',
    'Terminal=false',
    'StartupNotify=true',
    '',
  ].join('\n');
  const target = p.where === 'menu' ? menuPath(p.id) : join(desktopDir(), fileName(p.id));
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, entry);
  chmodSync(target, 0o755);
  // GNOME only launches desktop icons that are marked trusted.
  if (p.where === 'desktop') execFile('gio', ['set', target, 'metadata::trusted', 'true'], () => undefined);
  return target;
}

export function removeShortcuts(id: number) {
  for (const f of [menuPath(id), join(desktopDir(), fileName(id))]) rmSync(f, { force: true });
}

/** `--launch-game=<id>` from a shortcut, if present. */
export function gameFromArgs(argv: string[]): number | null {
  const m = argv.map((a) => /^--launch-game=(\d+)$/.exec(a)).find(Boolean);
  return m ? Number(m[1]) : null;
}

/**
 * The launcher's own applications-menu entry, so the desktop (GNOME and
 * others) finds its name and icon for the taskbar instead of a generic one:
 * the window's class, cool-games-launcher, matches the entry's file name. Only
 * for the AppImage, kept up to date with where it lives, and skipped when
 * AppImageLauncher has already integrated it.
 */
export function ensureLauncherEntry(p: { appImage: string | undefined; icon: string; dataDir?: string }): string | null {
  if (!p.appImage || !existsSync(p.icon)) return null;
  const data = p.dataDir ?? (process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'));
  const apps = join(data, 'applications');
  try {
    if (readdirSync(apps).some((f) => /^appimagekit_.*cool[-_ ]?games[-_ ]?launcher.*\.desktop$/i.test(f))) return null;
  } catch { /* no applications folder yet */ }
  const iconDir = join(data, 'icons', 'hicolor', '256x256', 'apps');
  const icon = join(iconDir, 'cool-games-launcher.png');
  mkdirSync(iconDir, { recursive: true });
  const fresh = readFileSync(p.icon);
  if (!existsSync(icon) || !readFileSync(icon).equals(fresh)) writeFileSync(icon, fresh);
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Cool Games Launcher',
    'Comment=Discover, download and play games with a local AI',
    `Exec=${desktopExec([p.appImage])} %U`,
    `Icon=${icon}`,
    'StartupWMClass=cool-games-launcher',
    'Categories=Game;',
    'Terminal=false',
    'StartupNotify=true',
    '',
  ].join('\n');
  const target = join(apps, 'cool-games-launcher.desktop');
  mkdirSync(apps, { recursive: true });
  if (!existsSync(target) || readFileSync(target, 'utf8') !== entry) {
    writeFileSync(target, entry);
    chmodSync(target, 0o755);
  }
  return target;
}
