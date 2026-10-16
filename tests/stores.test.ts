import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/main/db';
import { GamesRepo } from '../src/main/repos';
import { StoreService, epicImages, epicLaunchArgs, epicLoginCode, gogImages, gogLoginCode, gogPrimaryTask, parseProgress, type RunTool } from '../src/main/stores';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

describe('store helpers', () => {
  it('reads the login codes from GOG\'s redirect and Epic\'s JSON page', () => {
    expect(gogLoginCode('https://embed.gog.com/on_login_success?origin=client&code=abc123')).toBe('abc123');
    expect(gogLoginCode('https://evil.test/on_login_success?code=abc')).toBeNull();
    expect(epicLoginCode('{"redirectUrl":"x","authorizationCode":"e1f2","exchangeCode":null,"sid":null}')).toBe('e1f2');
    expect(epicLoginCode('{"authorizationCode":null}')).toBeNull();
    expect(epicLoginCode('<html>login</html>')).toBeNull();
  });

  it('reads progress from both tools', () => {
    expect(parseProgress('[cli] INFO: = Progress: 12.34% (123/456), Running for 00:00:10, ETA: 00:01:20')).toBeCloseTo(0.1234);
    expect(parseProgress('[PROGRESS] INFO: = Progress: 50.00 1/2, Running for: 00:00:01')).toBeCloseTo(0.5);
    expect(parseProgress('Downloading manifest…')).toBeNull();
  });

  it('turns store images and launch data into what the Library needs', () => {
    expect(gogImages('//images-1.gog-statics.com/abc')).toEqual({ cover: 'https://images-1.gog-statics.com/abc_392.jpg', hero: 'https://images-1.gog-statics.com/abc.jpg' });
    expect(epicImages([{ type: 'Thumbnail', url: 't' }, { type: 'DieselGameBox', url: 'wide' }])).toEqual({ cover: 'wide', hero: 'wide' });
    expect(gogPrimaryTask({ playTasks: [{ type: 'URLTask', path: 'x' }, { isPrimary: true, type: 'FileTask', path: 'bin\\Game.exe', arguments: '-skip' }] })).toEqual({ path: 'bin/Game.exe', args: '-skip' });
    expect(epicLaunchArgs({ game_parameters: ['-a'], egl_parameters: ['-AUTH_PASSWORD=x', '-epicapp=Fortune'], user_parameters: [] })).toEqual(['-a', '-AUTH_PASSWORD=x', '-epicapp=Fortune']);
  });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cgl-stores-'));
  const db = openDb(join(dir, 'db.sqlite'));
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const games = new GamesRepo(db);
  const gamesDir = join(dir, 'Games');
  const calls: string[] = [];
  const state = { gogBuild: 'b2', epicVersion: '1.1', epicInstalled: [] as Array<Record<string, string>> };
  const run: RunTool = async (cmd, args, opts = {}) => {
    const tool = cmd.endsWith('gogdl') ? 'gogdl' : 'legendary';
    const a = tool === 'gogdl' ? args.slice(2) : args.filter((x) => x !== '-y');
    calls.push(`${tool} ${a.join(' ')}`);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (tool === 'gogdl') {
      if (a[0] === 'auth') return a.includes('--code') ? ok('{}') : ok(JSON.stringify({ access_token: 'tok' }));
      if (a[0] === 'download' || a[0] === 'update') {
        const base = a[a.indexOf('--path') + 1];
        const folder = join(base, 'The Witcher');
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'goggame-1207658924.info'), JSON.stringify({ playTasks: [{ isPrimary: true, type: 'FileTask', path: 'witcher.exe' }] }));
        opts.onLine?.('[PROGRESS] INFO: = Progress: 50.00 1/2');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (a[0] === 'import') return ok(JSON.stringify({ appName: '1207658924', buildId: state.gogBuild }));
      if (a[0] === 'info') return ok(JSON.stringify({ buildId: state.gogBuild }));
    } else {
      if (a[0] === 'status') return ok(JSON.stringify({ account: 'EpicPlayer', games_available: 1 }));
      if (a[0] === 'list') return ok(JSON.stringify([{ app_name: 'Fortune', app_title: 'Fortnite-like', metadata: { keyImages: [{ type: 'DieselGameBox', url: 'https://cdn.epic/wide.jpg' }] }, asset_infos: { Windows: { build_version: state.epicVersion } } }]));
      if (a[0] === 'install' || a[0] === 'import') {
        opts.onLine?.('[cli] INFO: = Progress: 100.00% (1/1)');
        const path = a[0] === 'import' ? a[2] : join(a[a.indexOf('--base-path') + 1], 'Fortune');
        state.epicInstalled = [{ app_name: 'Fortune', install_path: path, executable: 'Bin\\Game.exe', version: '1.0' }];
        return ok('');
      }
      if (a[0] === 'list-installed') return ok(JSON.stringify(state.epicInstalled));
      if (a[0] === 'launch') return ok(JSON.stringify({ game_parameters: [], egl_parameters: ['-AUTH_PASSWORD=x'], user_parameters: [] }));
      if (a[0] === 'uninstall' || a[0] === 'auth') return ok('');
    }
    return { code: 1, stdout: '', stderr: `unexpected ${a.join(' ')}` };
  };
  const fetchFake = (async (url: string) => {
    if (url.includes('userData.json')) return new Response(JSON.stringify({ username: 'gogger' }));
    return new Response(JSON.stringify({ totalPages: 1, products: [{ id: 1207658924, title: 'The Witcher', image: '//images.gog.com/w', isGame: true }] }));
  }) as typeof fetch;
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'stores'), { recursive: true });
  writeFileSync(join(dataDir, 'stores', 'gog-auth.json'), '{}');
  const published: unknown[] = [];
  const stores = new StoreService({
    tools: { legendary: '/v/legendary', gogdl: '/v/gogdl' }, dataDir, gamesDir: () => gamesDir, games, run, fetch: fetchFake,
    login: async () => 'code', prepareGame: () => undefined, changed: () => undefined, publish: (s) => published.push(s),
  });
  return { dir, games, stores, calls, state, gamesDir };
}

describe('GOG and Epic accounts', () => {
  it('lists owned games from both stores, without installed ones', async () => {
    const t = setup();
    const s = await t.stores.refresh();
    expect(s.accounts.gog).toMatchObject({ loggedIn: true, user: 'gogger' });
    expect(s.accounts.epic).toMatchObject({ loggedIn: true, user: 'EpicPlayer' });
    expect(s.owned.map((o) => `${o.store}:${o.id}:${o.title}`).sort()).toEqual(['epic:Fortune:Fortnite-like', 'gog:1207658924:The Witcher']);
    expect(s.owned.every((o) => o.gameId === null)).toBe(true);
  });

  it('installs a GOG game into the games folder as a Library game, with its build', async () => {
    const t = setup();
    await t.stores.refresh();
    const id = await t.stores.install('gog', '1207658924');
    expect(t.games.get(id)).toMatchObject({ title: 'The Witcher', store: 'gog', storeId: '1207658924', storeBuild: 'b2', managed: true, kind: 'windows', executable: join(t.gamesDir, 'GOG', 'The Witcher', 'witcher.exe') });
    expect(t.stores.state().owned.find((o) => o.store === 'gog')?.gameId).toBe(id);
  });

  it('installs an Epic game and gives it Epic\'s login tokens at each start', async () => {
    const t = setup();
    await t.stores.refresh();
    const id = await t.stores.install('epic', 'Fortune');
    const g = t.games.get(id)!;
    expect(g).toMatchObject({ store: 'epic', storeId: 'Fortune', storeBuild: '1.0', executable: join(t.gamesDir, 'Epic', 'Fortune', 'Bin/Game.exe') });
    expect(await t.stores.launchArgs(g)).toEqual(['-AUTH_PASSWORD=x']);
    expect(await t.stores.launchArgs({ ...g, store: 'gog' })).toBeNull();
  });

  it('links a copy already on disk instead of adding the game twice', async () => {
    const t = setup();
    await t.stores.refresh();
    const folder = join(t.dir, 'old', 'The Witcher');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'goggame-1207658924.info'), JSON.stringify({ playTasks: [{ isPrimary: true, type: 'FileTask', path: 'witcher.exe' }] }));
    const local = t.games.create({ catalogId: null, downloadId: null, title: 'witcher', kind: 'windows', installDir: folder, executable: join(folder, 'witcher.exe'), args: '', runner: 'proton', prefixDir: null, managed: false, artworkFile: null, sourceHost: null, status: 'installed', candidates: [] });
    const id = await t.stores.adopt('gog', '1207658924', folder);
    expect(id).toBe(local.id);
    expect(t.games.list()).toHaveLength(1);
    expect(t.games.get(id)).toMatchObject({ store: 'gog', storeId: '1207658924', title: 'The Witcher', managed: false });
    await expect(t.stores.adopt('gog', '1207658924', join(t.dir, 'empty'))).rejects.toThrow(/does not hold/);
  });

  it('finds updates when the store has a newer build, and updates in place', async () => {
    const t = setup();
    await t.stores.refresh();
    const gog = await t.stores.install('gog', '1207658924');
    const epic = await t.stores.install('epic', 'Fortune');
    t.state.gogBuild = 'b3';
    await t.stores.checkUpdates();
    expect(t.stores.hasUpdate(t.games.get(gog)!)).toBe(true);
    expect(t.stores.hasUpdate(t.games.get(epic)!)).toBe(true);
    await t.stores.update(gog);
    expect(t.games.get(gog)!.storeBuild).toBe('b3');
    expect(t.stores.hasUpdate(t.games.get(gog)!)).toBe(false);
    expect(t.calls.some((c) => c.startsWith('gogdl update 1207658924'))).toBe(true);
  });

  it('logging out removes that store\'s games from the list', async () => {
    const t = setup();
    await t.stores.refresh();
    const s = await t.stores.logout('gog');
    expect(s.accounts.gog.loggedIn).toBe(false);
    expect(s.owned.map((o) => o.store)).toEqual(['epic']);
  });

  it('keeps the owned games when a store cannot be reached', async () => {
    const t = setup();
    await t.stores.refresh();
    const before = t.stores.state().owned.length;
    const offline = new StoreService({
      tools: { legendary: '/v/legendary', gogdl: '/v/gogdl' }, dataDir: join(t.dir, 'data'), gamesDir: () => t.gamesDir, games: t.games,
      run: async () => ({ code: 1, stdout: '', stderr: 'network unreachable' }), fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
      login: async () => null, prepareGame: () => undefined, changed: () => undefined, publish: () => undefined,
    });
    const s = await offline.refresh();
    expect(s.owned).toHaveLength(before);
    expect(s.accounts.gog.error).toMatch(/network unreachable/);
  });
});
