import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/src/app' } }));

describe('desktop shortcuts', () => {
  it('quotes the launcher command for Desktop Entry files', async () => {
    const { desktopExec, gameFromArgs } = await import('../src/main/shortcuts');
    expect(desktopExec(['/home/me/My Games/Cool Games Launcher.AppImage', '--launch-game=12'])).toBe('"/home/me/My Games/Cool Games Launcher.AppImage" "--launch-game=12"');
    expect(desktopExec(['/x/$weird"name'])).toBe('"/x/\\\\$weird\\\\"name"');
    expect(gameFromArgs(['/x/app', '--no-sandbox', '--launch-game=7'])).toBe(7);
    expect(gameFromArgs(['/x/app'])).toBeNull();
  });
});

describe('the launcher\'s own menu entry', () => {
  it('names the AppImage and icon so the taskbar can find them, and follows the AppImage when it moves', async () => {
    const { ensureLauncherEntry } = await import('../src/main/shortcuts');
    const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const d = mkdtempSync(join(tmpdir(), 'cgl-entry-'));
    try {
      const icon = join(d, 'icon.png');
      writeFileSync(icon, 'png bytes');
      const path = ensureLauncherEntry({ appImage: '/apps/Cool Games.AppImage', icon, dataDir: d })!;
      const text = readFileSync(path, 'utf8');
      expect(path).toBe(join(d, 'applications', 'cool-games-launcher.desktop'));
      expect(text).toContain('Exec="/apps/Cool Games.AppImage" %U');
      expect(text).toContain('StartupWMClass=cool-games-launcher');
      expect(text).toContain(`Icon=${join(d, 'icons', 'hicolor', '256x256', 'apps', 'cool-games-launcher.png')}`);
      expect(readFileSync(join(d, 'icons', 'hicolor', '256x256', 'apps', 'cool-games-launcher.png'), 'utf8')).toBe('png bytes');
      ensureLauncherEntry({ appImage: '/elsewhere/Cool.AppImage', icon, dataDir: d });
      expect(readFileSync(path, 'utf8')).toContain('Exec="/elsewhere/Cool.AppImage" %U');
      // Not an AppImage (development): nothing is written.
      rmSync(path);
      expect(ensureLauncherEntry({ appImage: undefined, icon, dataDir: d })).toBeNull();
      expect(existsSync(path)).toBe(false);
      // AppImageLauncher already integrated it: leave that entry alone.
      writeFileSync(join(d, 'applications', 'appimagekit_0123abcd-Cool_Games_Launcher.desktop'), '[Desktop Entry]\n');
      expect(ensureLauncherEntry({ appImage: '/apps/Cool.AppImage', icon, dataDir: d })).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
