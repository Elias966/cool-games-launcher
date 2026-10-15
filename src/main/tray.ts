// System tray: closing the window keeps the launcher running (downloads, AI
// preparation and update checks continue); the tray brings it back, opens
// couch mode, starts recent games or quits.
import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron';
import type { Game } from '@shared/types';

export class LauncherTray {
  private tray: Tray | null = null;
  private games: Game[] = [];

  constructor(private deps: { icon: string; window: () => BrowserWindow | null; couch: () => void; launch: (id: number) => void; quit: () => void }) {}

  start(): boolean {
    try {
      this.tray = new Tray(nativeImage.createFromPath(this.deps.icon).resize({ width: 22, height: 22 }));
      this.tray.setToolTip('Cool Games Launcher');
      this.tray.on('click', () => this.show());
      this.render();
      return true;
    } catch (e) {
      console.warn('[tray] not available:', (e as Error).message);
      this.tray = null;
      return false;
    }
  }

  get active() {
    return this.tray !== null;
  }

  setGames(games: Game[]) {
    this.games = games.filter((g) => g.status === 'installed').sort((a, b) => (b.lastPlayedAt ?? b.addedAt).localeCompare(a.lastPlayedAt ?? a.addedAt)).slice(0, 6);
    this.render();
  }

  show() {
    const w = this.deps.window();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }

  private render() {
    if (!this.tray) return;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Cool Games Launcher', click: () => this.show() },
      { label: 'Couch mode', click: () => { this.show(); this.deps.couch(); } },
      { type: 'separator' },
      ...(this.games.length ? this.games.map((g) => ({ label: `Play ${g.title}`, click: () => this.deps.launch(g.id) })) : [{ label: 'No games installed yet', enabled: false }]),
      { type: 'separator' },
      { label: 'Quit', click: () => this.deps.quit() },
    ]));
  }

  destroy() {
    this.tray?.destroy();
    this.tray = null;
  }
}
