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
