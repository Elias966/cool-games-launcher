import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/main/db';
import { GamesRepo } from '../src/main/repos';
import { StoreService, epicImages, epicLaunchArgs, epicLoginCode, gogImages, gogLoginCode, gogPrimaryTask, parseProgress, parseStoreTelemetry, runTool, type StoreDeps, type RunTool } from '../src/main/stores';

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
  const state = { gogBuild: 'b2', gogNoop: false, epicNoop: false, epicVersion: '1.1', epicInstalled: [] as Array<{ app_name: string; install_path: string; executable: string; version: string; needs_verification: boolean }> };
  const run: RunTool = async (cmd, args, opts = {}) => {
    const tool = cmd.endsWith('gogdl') ? 'gogdl' : 'legendary';
    const a = tool === 'gogdl' ? args.slice(2) : args.filter((x) => x !== '-y');
    calls.push(`${tool} ${a.join(' ')}`);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (tool === 'gogdl') {
      if (a[0] === 'auth') return a.includes('--code') ? ok('{}') : ok(JSON.stringify({ access_token: 'tok' }));
      if (['download', 'update', 'repair'].includes(a[0])) {
        if (state.gogNoop) return ok('');
        const base = a[a.indexOf('--path') + 1];
        const folder = a[0] === 'download' ? join(base, 'The Witcher') : base;
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'goggame-1207658924.info'), JSON.stringify({ rootGameId: '1207658924', buildId: state.gogBuild, playTasks: [{ isPrimary: true, type: 'FileTask', path: 'witcher.exe' }] }));
        writeFileSync(join(folder, 'witcher.exe'), state.gogBuild);
        const manifestDir = join(opts.env!.GOGDL_CONFIG_PATH, 'heroic_gogdl', 'manifests');
        mkdirSync(manifestDir, { recursive: true });
        writeFileSync(join(manifestDir, '1207658924'), JSON.stringify({ version: 2, baseProductId: '1207658924', buildId: state.gogBuild }));
        opts.onLine?.('[PROGRESS] INFO: = Progress: 50.00 1/2');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (a[0] === 'import') return ok(JSON.stringify({ appName: '1207658924', buildId: state.gogBuild }));
      if (a[0] === 'info') return ok(JSON.stringify({ buildId: state.gogBuild, builds: { items: [{ build_id: state.gogBuild, generation: 2, link: 'https://manifest.gog.test/' + state.gogBuild }] } }));
    } else {
      if (a[0] === 'status') return ok(JSON.stringify({ account: 'EpicPlayer', games_available: 1 }));
      if (a[0] === 'list') return ok(JSON.stringify([{ app_name: 'Fortune', app_title: 'Fortnite-like', metadata: { keyImages: [{ type: 'DieselGameBox', url: 'https://cdn.epic/wide.jpg' }] }, asset_infos: { Windows: { build_version: state.epicVersion } } }]));
      if (a[0] === 'install' || a[0] === 'import') {
        if (state.epicNoop && a.includes('--update-only')) return ok('');
        opts.onLine?.('[cli] INFO: = Progress: 100.00% (1/1)');
        const path = a[0] === 'import' ? a[2] : a.includes('--update-only') ? state.epicInstalled[0].install_path : join(a[a.indexOf('--base-path') + 1], 'Fortune');
        state.epicInstalled = [{ app_name: 'Fortune', install_path: path, executable: 'Bin\\Game.exe', version: a.includes('--repair-and-update') ? state.epicVersion : '1.0', needs_verification: a[0] === 'import' }];
        mkdirSync(join(path, 'Bin'), { recursive: true }); writeFileSync(join(path, 'Bin/Game.exe'), 'program');
        return ok('');
      }
      if (a[0] === 'list-installed') return ok(JSON.stringify(state.epicInstalled));
      if (a[0] === 'launch') return ok(JSON.stringify({ game_parameters: [], egl_parameters: ['-AUTH_PASSWORD=x'], user_parameters: [] }));
      if (a[0] === 'uninstall' || a[0] === 'auth') return ok('');
    }
    return { code: 1, stdout: '', stderr: `unexpected ${a.join(' ')}` };
  };
  const fetchFake = (async (url: string) => {
    if (url.includes('manifest.gog.test')) return new Response(JSON.stringify({ version: 2, baseProductId: '1207658924', buildId: state.gogBuild, depots: [] }));
    if (url.includes('userData.json')) return new Response(JSON.stringify({ username: 'gogger' }));
    return new Response(JSON.stringify({ totalPages: 1, products: [{ id: 1207658924, title: 'The Witcher', image: '//images.gog.com/w', isGame: true }] }));
  }) as typeof fetch;
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'stores'), { recursive: true });
  writeFileSync(join(dataDir, 'stores', 'gog-auth.json'), '{}');
  const published: unknown[] = [];
  const deps: StoreDeps = {
    tools: { legendary: '/v/legendary', gogdl: '/v/gogdl' }, dataDir, gamesDir: () => gamesDir, games, run, fetch: fetchFake,
    login: async () => 'code', prepareGame: () => undefined, changed: () => undefined, publish: (s) => published.push(s),
  };
  const stores = new StoreService(deps);
  return { dir, games, stores, calls, state, gamesDir, deps };
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
    writeFileSync(join(folder, 'goggame-1207658924.info'), JSON.stringify({ rootGameId: '1207658924', buildId: t.state.gogBuild, playTasks: [{ isPrimary: true, type: 'FileTask', path: 'witcher.exe' }] }));
    const local = t.games.create({ catalogId: null, downloadId: null, title: 'witcher', kind: 'windows', installDir: folder, executable: join(folder, 'witcher.exe'), args: '', runner: 'proton', prefixDir: null, managed: false, artworkFile: null, sourceHost: null, status: 'installed', candidates: [] });
    writeFileSync(join(folder, 'witcher.exe'), 'old');
    const id = await t.stores.adopt('gog', '1207658924', folder);
    expect(id).toBe(local.id);
    expect(t.games.list()).toHaveLength(1);
    expect(t.games.get(id)).toMatchObject({ store: 'gog', storeId: '1207658924', title: 'The Witcher', managed: false });
    await expect(t.stores.adopt('gog', '1207658924', join(t.dir, 'empty'))).rejects.toThrow(/does not hold/);
    // Picked where the .exe sits, below the folder that holds GOG's info file.
    mkdirSync(join(folder, 'Binaries'), { recursive: true });
    expect(await t.stores.adopt('gog', '1207658924', join(folder, 'Binaries'))).toBe(local.id);
  });

  it('merges an executable imported from a subfolder without losing its settings or play time', async () => {
    const t = setup(); await t.stores.refresh();
    const folder = join(t.dir, 'old/The Witcher'); mkdirSync(join(folder, 'Bin'), { recursive: true });
    writeFileSync(join(folder, 'goggame-1207658924.info'), JSON.stringify({ rootGameId: '1207658924', buildId: 'b1', playTasks: [{ isPrimary: true, path: 'Bin/witcher.exe' }] }));
    const executable = join(folder, 'Bin/witcher.exe'); writeFileSync(executable, 'old');
    const local = t.games.create({ catalogId: null, downloadId: null, title: 'My Witcher', kind: 'windows', installDir: join(folder, 'Bin'), executable, args: '-custom', runner: 'wine', prefixDir: '/custom/prefix', managed: false, artworkFile: null, sourceHost: null, status: 'installed', candidates: [] });
    t.games.update(local.id, { namedByUser: true, favorite: true }); t.games.recordPlay(local.id, 123);
    expect(await t.stores.adopt('gog', '1207658924', join(folder, 'Bin'))).toBe(local.id);
    expect(t.games.list()).toHaveLength(1);
    expect(t.games.get(local.id)).toMatchObject({ title: 'My Witcher', args: '-custom', runner: 'wine', prefixDir: '/custom/prefix', playtimeSeconds: 123, favorite: true, installDir: folder, storeBuild: 'b1' });
  });

  it('rejects updating a running game and reports a removed resumed game as failed', async () => {
    const t = setup(); await t.stores.refresh(); const game = await t.stores.install('gog', '1207658924');
    const running = new StoreService({ ...t.deps, isRunning: () => true });
    await expect(running.update(game)).rejects.toThrow(/Stop the game/);
    const file = join(t.deps.dataDir, 'stores/jobs.json');
    const jobs = JSON.parse(readFileSync(file, 'utf8')); jobs[0].state = 'queued'; jobs[0].kind = 'update'; writeFileSync(file, JSON.stringify(jobs));
    t.games.remove(game);
    const restarted = new StoreService(t.deps); restarted.recover();
    await vi.waitFor(() => expect(restarted.state().jobs[0]).toMatchObject({ state: 'failed', detail: expect.stringContaining('not from') }));
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

  it('interrupts account queries when the launcher closes', async () => {
    const t = setup(); const signals: AbortSignal[] = [];
    const service = new StoreService({ ...t.deps, run: async (_cmd, _args, opts) => {
      signals.push(opts!.signal!);
      return new Promise((_resolve, reject) => opts!.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true }));
    } });
    const refresh = service.refresh(); await vi.waitFor(() => expect(signals).toHaveLength(2));
    await service.shutdown(); await refresh; expect(signals.every(s => s.aborted)).toBe(true);
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


describe('durable store transfers and artwork', () => {
  it('parses the exact telemetry emitted by both bundled clients', () => {
    expect(parseStoreTelemetry('[DLManager] INFO:  + Download\t- 12.50 MiB/s (raw) / 18.00 MiB/s (decompressed)')).toEqual({ speedBps: 12.5 * 1024 ** 2 });
    expect(parseStoreTelemetry('= Downloaded: 120.25 MiB, Written: 250.00 MiB')).toEqual({ receivedBytes: 120.25 * 1024 ** 2 });
    expect(parseStoreTelemetry('Download speed: 2.5 MB/s')).toEqual({ speedBps: 2500000 });
    expect(parseStoreTelemetry(' + Disk - 99.00 MiB/s (write)')).toEqual({});
  });

  it.each(['gog', 'epic'] as const)('resumes a %s update after full service restart, retaining partial files', async (store) => {
    const t = setup(); await t.stores.refresh();
    const id = store === 'gog' ? '1207658924' : 'Fortune';
    const gameId = await t.stores.install(store, id);
    const partial = join(t.games.get(gameId)!.installDir!, '.resume-test');
    mkdirSync(t.games.get(gameId)!.installDir!, { recursive: true });
    const run: RunTool = async (cmd, args, opts) => {
      if (args.includes('info') || args.includes('list') || args.includes('list-installed')) return t.deps.run!(cmd, args, opts);
      writeFileSync(partial, 'verified chunks');
      opts?.onLine?.('= Progress: 25.00% (1/4)');
      opts?.onLine?.(' + Download\t- 4.00 MiB/s (raw) / 6.00 MiB/s (decompressed)');
      return new Promise((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('interrupted'), { name: 'AbortError' })), { once: true }));
    };
    const first = new StoreService({ ...t.deps, run, downloadConnections: () => 12 });
    const interrupted = first.update(gameId).catch((e) => e);
    await vi.waitFor(() => expect(first.state().jobs.find((j) => j.id === id)).toMatchObject({ kind: 'update', state: 'active', progress: 0.25, speedBps: 4 * 1024 ** 2, gameId, workers: 12 }));
    await first.shutdown(); expect((await interrupted).name).toBe('AbortError');
    expect(existsSync(partial)).toBe(true);
    const saved = JSON.parse(readFileSync(join(t.deps.dataDir, 'stores/jobs.json'), 'utf8'));
    expect(saved.find((j: { id: string }) => j.id === id)).toMatchObject({ state: 'queued', gameId, progress: 0.25, speedBps: 0 });
    const reopened = new StoreService({ ...t.deps, gamesDir: () => join(t.dir, 'different-folder') });
    reopened.recover();
    await vi.waitFor(() => expect(reopened.state().jobs.find((j) => j.id === id)?.state).toBe('completed'));
    expect(t.games.get(gameId)?.installDir).not.toContain('different-folder');
    expect(t.calls.some((c) => c.includes('--max-workers 12'))).toBe(true);
    expect(existsSync(partial)).toBe(true);
  });

  it('keeps an intentional pause across restarts and displays a failed retry', async () => {
    const t = setup(); await t.stores.refresh();
    const run: RunTool = async (_cmd, _args, opts) => new Promise((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('paused')), { once: true }));
    const first = new StoreService({ ...t.deps, run });
    const work = first.install('epic', 'Fortune').catch(() => undefined);
    first.pause('epic', 'Fortune'); await work; await first.shutdown();
    const retry = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'offline' }));
    const reopened = new StoreService({ ...t.deps, run: retry }); reopened.recover();
    expect(retry).not.toHaveBeenCalled();
    expect(reopened.state().jobs.find((j) => j.id === 'Fortune')?.state).toBe('paused');
    reopened.resume('epic', 'Fortune');
    await vi.waitFor(() => expect(reopened.state().jobs.find((j) => j.id === 'Fortune')).toMatchObject({ state: 'failed', detail: 'offline' }));
  });

  it('caches account and installed images once and restores them before publishing refreshes', async () => {
    const t = setup(); await t.stores.refresh();
    const gameId = await t.stores.install('gog', '1207658924');
    const images = new Map<string, string>();
    const cacheImage = vi.fn(async (url: string) => {
      const local = `cgl-media://artwork/${images.size.toString(16).padStart(40, '0')}.jpg`;
      images.set(url, local); return local;
    });
    const deps = { ...t.deps, cacheImage, cachedImage: (url: string) => images.get(url) ?? null };
    const first = new StoreService(deps); await first.cacheImages();
    const count = cacheImage.mock.calls.length;
    expect(first.state().owned.every((o) => o.cover?.startsWith('cgl-media:'))).toBe(true);
    expect(t.games.get(gameId)?.images.cover).toMatch(/^cgl-media:/);
    await first.refresh(); await first.cacheImages();
    expect(cacheImage).toHaveBeenCalledTimes(count);
    const publish = vi.fn(); const reopened = new StoreService({ ...deps, publish });
    await reopened.refresh(); await reopened.cacheImages();
    expect(cacheImage).toHaveBeenCalledTimes(count);
    for (const [state] of publish.mock.calls) expect(state.owned.every((o: { cover: string }) => o.cover.startsWith('cgl-media:'))).toBe(true);
  });
});


it('gives store processes time to flush their checkpoint on SIGINT', async () => {
  const t = setup(); const marker = join(t.dir, 'checkpoint.json');
  const controller = new AbortController();
  const code = `process.on('SIGINT', () => { require('fs').writeFileSync(process.argv[1], 'flushed'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);`;
  await expect(runTool(process.execPath, ['-e', code, marker], { signal: controller.signal, onLine: (line) => { if (line === 'ready') controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
  expect(readFileSync(marker, 'utf8')).toBe('flushed');
});


describe('verified update destinations', () => {
  it('passes the exact GOG folder and refuses a zero-exit no-op with the wrong build', async () => {
    const t = setup(); await t.stores.refresh(); const id = await t.stores.install('gog', '1207658924');
    const folder = t.games.get(id)!.installDir!; t.state.gogBuild = 'b3'; t.state.gogNoop = true;
    await expect(t.stores.update(id)).rejects.toThrow('without installing build b3');
    expect(t.stores.state().jobs.find(j => j.id === '1207658924')?.state).toBe('failed');
    expect(t.games.get(id)!.storeBuild).toBe('b2');
    expect(t.calls.some(c => c.includes(`--path ${folder} --support`))).toBe(true);
    expect(existsSync(join(folder, 'The Witcher'))).toBe(false);
  });

  it('repairs a merged GOG copy before trusting its build and preserves its Library ID', async () => {
    const t = setup(); await t.stores.refresh(); const installed = await t.stores.install('gog', '1207658924');
    const folder = t.games.get(installed)!.installDir!;
    rmSync(join(t.deps.dataDir, 'stores/gog-verified.json'));
    t.state.gogBuild = 'b3'; await t.stores.update(installed);
    expect(t.calls.some(c => c.startsWith('gogdl repair 1207658924'))).toBe(true);
    expect(t.games.list()).toHaveLength(1); expect(t.games.get(installed)!.storeBuild).toBe('b3');
  });

  it('uses Epic repair-and-update for imported copies and refuses a false success', async () => {
    const t = setup(); await t.stores.refresh(); const id = await t.stores.install('epic', 'Fortune');
    t.state.epicNoop = true;
    await expect(t.stores.update(id)).rejects.toThrow('did not finish updating');
    expect(t.stores.state().jobs.find(j => j.id === 'Fortune')?.state).toBe('failed');
    t.state.epicNoop = false; await t.stores.update(id);
    expect(t.games.get(id)!.storeBuild).toBe(t.state.epicVersion);
    expect(t.calls.some(c => c.includes('--repair-and-update'))).toBe(true);
    expect(t.games.list()).toHaveLength(1);
  });
});
