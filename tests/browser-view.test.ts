import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BrowserView } from '../src/main/browser-view';
import { StoreSession } from '../src/main/store-session';

function view(url: string) {
  const session = new StoreSession();
  session.enter();
  const policy = Object.assign(new EventEmitter(), { policy: () => ({ revision: 1, showNsfw: false }) });
  const browser = { pointer: vi.fn(async () => undefined), scroll: vi.fn(async () => undefined), type: vi.fn(async () => undefined), history: vi.fn(async () => undefined), snapshot: vi.fn(async () => ({ url })), navigate: vi.fn(async () => undefined) };
  const drawer = new BrowserView(browser as never, {} as never, policy as never, {} as never, session);
  drawer.setWindowVisible(false);
  return { drawer, browser, session };
}

describe('Store browser initial navigation', () => {
  it('opens the enabled source instead of leaving a new Firefox window blank', async () => {
    const { drawer, browser, session } = view('about:blank');
    try {
      await drawer.showDefault('https://games.test/');
      expect(browser.navigate).toHaveBeenCalledWith('interactive', 'https://games.test/');
      expect(drawer.isOpen).toBe(true);
    } finally { session.leave(); }
  });

  it('preserves an existing interactive download or manually opened page', async () => {
    const { drawer, browser, session } = view('https://files.test/download');
    try {
      await drawer.showDefault('https://games.test/');
      expect(browser.navigate).not.toHaveBeenCalled();
      expect(drawer.isOpen).toBe(true);
    } finally { session.leave(); }
  });

  it('gives user input to the exact discovery window awaiting verification', async () => {
    const { drawer, browser, session } = view('https://games.test/challenge');
    try {
      drawer.show('discovery');
      await drawer.click(0.25, 0.5, 'left');
      await drawer.scroll(0.25, 0.5, 0, 100);
      await drawer.type('human input');
      await drawer.key('Enter');
      expect(browser.pointer).toHaveBeenCalledWith('discovery', 320, 400, 'left');
      expect(browser.scroll).toHaveBeenCalledWith('discovery', 320, 400, 0, 100);
      expect(browser.type).toHaveBeenCalledWith('discovery', { text: 'human input' });
      expect(browser.type).toHaveBeenCalledWith('discovery', { key: 'Enter' });
      expect(browser.navigate).not.toHaveBeenCalled();
    } finally { session.leave(); }
  });

  it('does not navigate after the user leaves the Store during browser startup', async () => {
    const { drawer, browser, session } = view('about:blank');
    browser.snapshot.mockImplementation(async () => { session.leave(); return { url: 'about:blank' }; });
    await drawer.showDefault('https://games.test/');
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(drawer.isOpen).toBe(false);
  });
});
