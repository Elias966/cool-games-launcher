import { describe, expect, it } from 'vitest';
import { GameIdentifier, cleanName, guessName, type IdentifyDeps } from '../src/main/game-identify';
import type { SteamMedia } from '../src/shared/types';

describe('names from imported files', () => {
  it('drops download-site noise and keeps the name', () => {
    expect(cleanName('downloadgame-amensia-game.exe')).toBe('Amensia');
    expect(cleanName('Hollow_Knight_v1.5.78-GOG.exe')).toBe('Hollow Knight');
    expect(cleanName('FitGirl-Repack.Celeste.x64.exe')).toBe('Celeste');
    expect(cleanName('Game Dev Tycoon.exe')).toBe('Game Dev Tycoon');
    expect(cleanName('AmnesiaTheDarkDescent.exe')).toBe('Amnesia The Dark Descent');
  });

  it('uses the folder when the executable has a generic name', () => {
    expect(guessName('/games/Amnesia The Dark Descent/Launcher.exe')).toBe('Amnesia The Dark Descent');
    expect(guessName('/games/Stardew Valley [GOG]/game/start.sh')).toBe('Stardew Valley');
    expect(guessName('/games/x/Celeste.exe')).toBe('Celeste');
  });
});

function fakes(opts: { steam: Record<string, Array<{ appid: number; name: string }>>; ai?: (system: string, user: string) => unknown; aiDown?: boolean }) {
  const games = new Map<number, { id: number; title: string; executable: string; installDir: string; catalogId: null; art: unknown; artworkFile: string | null; namedByUser: boolean }>();
  games.set(1, { id: 1, title: 'downloadgame amensia game', executable: '/games/dl/downloadgame-amensia-game.exe', installDir: '/games/dl', catalogId: null, art: null, artworkFile: null, namedByUser: false });
  const cache = new Map<string, unknown>();
  const asked: string[] = [];
  const users: string[] = [];
  const searched: string[] = [];
  const media = (appid: number): SteamMedia => ({ appid, hero: `hero-${appid}`, logo: `logo-${appid}`, capsule: `capsule-${appid}` } as unknown as SteamMedia);
  const deps: IdentifyDeps = {
    games: {
      get: (id: number) => games.get(id) as never,
      list: () => [...games.values()] as never,
      update: (id: number, patch: object) => { Object.assign(games.get(id)!, patch); },
    },
    cache: { get: (k: string) => (cache.get(k) ?? null) as never, set: (k: string, v: unknown) => { cache.set(k, v); } },
    steam: {
      search: async (term) => { searched.push(term); return (opts.steam[term.toLowerCase()] ?? []).map((r) => ({ ...r, image: null })); },
      media: async (appid) => media(appid),
    },
    ask: async <T,>(req: { system: string; user: unknown }) => {
      if (opts.aiDown) throw Object.assign(new Error('AI paused'), { code: 'cancelled' });
      asked.push(req.system.slice(0, 20));
      users.push(String(req.user));
      return opts.ai!(req.system, String(req.user)) as T;
    },
    saveArtwork: async (url) => `file-for-${url}.jpg`,
    clues: (g) => ({ executable: g.executable!, folders: ['dl', 'games'], files: ['downloadgame-amensia-game.exe', 'redist'] }),
    changed: () => undefined,
  };
  return { deps, games, cache, asked, searched, users };
}

describe('finding an imported game\'s cover', () => {
  it('takes an exact Steam match from the cleaned name without the AI', async () => {
    const f = fakes({ steam: { celeste: [{ appid: 504230, name: 'Celeste' }] } });
    f.games.get(1)!.executable = '/games/Celeste/Celeste.exe';
    await new GameIdentifier(f.deps).imported(1);
    expect(f.games.get(1)).toMatchObject({ title: 'Celeste', artworkFile: 'file-for-capsule-504230.jpg', art: { appid: 504230, capsule: 'capsule-504230' } });
    expect(f.asked).toEqual([]);
  });

  it('asks the AI for a misspelled name and lets it pick among Steam results', async () => {
    const f = fakes({
      steam: { amnesia: [{ appid: 57300, name: 'Amnesia: The Dark Descent' }, { appid: 999220, name: 'Amnesia: Rebirth' }] },
      ai: (system) => (system.startsWith('You identify') ? { title: 'Amnesia', others: [] } : { appid: 57300 }),
    });
    const id = new GameIdentifier(f.deps);
    await id.imported(1);
    await id.pump();
    expect(f.searched).toEqual(['Amensia', 'Amnesia']);
    expect(f.games.get(1)).toMatchObject({ title: 'Amnesia: The Dark Descent', art: { appid: 57300 } });
  });

  it('keeps the AI\'s name when Steam has no matching game', async () => {
    const f = fakes({ steam: {}, ai: () => ({ title: 'Amnesia', others: [] }) });
    const id = new GameIdentifier(f.deps);
    await id.imported(1);
    await id.pump();
    expect(f.games.get(1)).toMatchObject({ title: 'Amnesia', art: null });
  });

  it('waits for the AI while the Store is closed, and tries again later', async () => {
    const f = fakes({ steam: {}, aiDown: true });
    const id = new GameIdentifier(f.deps);
    await id.imported(1);
    await id.pump();
    expect(f.cache.has('identify:1')).toBe(false);
    f.deps.ask = (async () => ({ title: 'Amnesia', others: [] })) as IdentifyDeps['ask'];
    await id.pump();
    expect(f.games.get(1)!.title).toBe('Amnesia');
  });

  it('applies the game the person picked', async () => {
    const f = fakes({ steam: {} });
    await new GameIdentifier(f.deps).choose(1, 57300, 'Amnesia: The Dark Descent');
    expect(f.games.get(1)).toMatchObject({ title: 'Amnesia: The Dark Descent', art: { appid: 57300 }, artworkFile: 'file-for-capsule-57300.jpg' });
  });

  it('shows the AI the name the game has in the Library', async () => {
    const f = fakes({ steam: {}, ai: () => ({ title: 'Amnesia', others: [] }) });
    const id = new GameIdentifier(f.deps);
    await id.imported(1);
    expect(f.users[0]).toContain('Name in the Library: Amensia');
  });

  it('never renames a game the person named, and keeps that name when a cover is picked', async () => {
    const f = fakes({ steam: { amnesia: [{ appid: 57300, name: 'Amnesia: The Dark Descent' }] }, ai: () => ({ title: 'Amnesia', others: [] }) });
    const id = new GameIdentifier(f.deps);
    id.rename(1, '  My Scary Game  ');
    expect(f.games.get(1)).toMatchObject({ title: 'My Scary Game', namedByUser: true });
    await id.imported(1);
    id.resume();
    await id.pump();
    expect(f.asked).toEqual([]);
    expect(f.games.get(1)!.title).toBe('My Scary Game');
    await id.choose(1, 57300, 'Amnesia: The Dark Descent');
    expect(f.games.get(1)).toMatchObject({ title: 'My Scary Game', art: { appid: 57300 } });
    expect(() => id.rename(1, '   ')).toThrow();
  });

  it('does not replace a meaningful name with an unrelated AI guess when Steam has no match', async () => {
    const f = fakes({ steam: {}, ai: () => ({ title: 'Some Other Game', others: [] }) });
    f.games.get(1)!.title = 'Hollow Knight';
    f.games.get(1)!.executable = '/nowhere/x/game.exe';
    const id = new GameIdentifier(f.deps);
    id.resume();
    await id.pump();
    expect(f.games.get(1)!.title).toBe('Hollow Knight');
  });
});
