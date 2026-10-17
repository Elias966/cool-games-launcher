import { afterEach, describe, expect, it, vi } from 'vitest';
import { symlinkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/main/db';
import { CatalogRepo, DownloadsRepo, GamesRepo, SettingsRepo, SourcesRepo, defaultSettings } from '../src/main/repos';
import { UpdateService } from '../src/main/updates';
import { carryOver, snapshotBuild } from '../src/workers/carry-over';
import { installedGameRoot, localInstalledVersion } from '../src/main/installed-version';
import { matchExecutable } from '../src/main/library';
import type { VersionFingerprint } from '@shared/game-version';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));
function tmp() { const d = mkdtempSync(join(tmpdir(), 'cgl-upd-')); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; }
function put(root: string, rel: string, body = rel) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); }

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, dialog: {}, shell: {} }));

describe('save carry-over', () => {
  it('copies only what the player created or changed, into the renamed folder of the new build', () => {
    const dir = tmp(), oldB = join(dir, 'old'), newB = join(dir, 'new');
    put(oldB, 'Orbit v1.2/orbit.x86_64', 'old program');
    put(oldB, 'Orbit v1.2/data/level1.pak', 'old data');
    put(oldB, 'Orbit v1.2/config.ini', 'volume=5');
    snapshotBuild({ root: oldB, out: join(dir, 'm.json') });
    // The player plays: a new save and a changed setting.
    put(oldB, 'Orbit v1.2/saves/slot1.sav', 'progress');
    writeFileSync(join(oldB, 'Orbit v1.2/config.ini'), 'volume=9 fullscreen=1');
    put(newB, 'Orbit v1.3/orbit.x86_64', 'new program');
    put(newB, 'Orbit v1.3/data/level1.pak', 'new data');
    put(newB, 'Orbit v1.3/config.ini', 'volume=5');
    const r = carryOver({ fromRoot: oldB, fromExe: join(oldB, 'Orbit v1.2/orbit.x86_64'), toRoot: newB, toExe: join(newB, 'Orbit v1.3/orbit.x86_64'), manifest: join(dir, 'm.json') });
    expect(r.copied.sort()).toEqual(['Orbit v1.3/config.ini', 'Orbit v1.3/saves/slot1.sav']);
    expect(readFileSync(join(newB, 'Orbit v1.3/saves/slot1.sav'), 'utf8')).toBe('progress');
    expect(readFileSync(join(newB, 'Orbit v1.3/config.ini'), 'utf8')).toBe('volume=9 fullscreen=1');
    expect(readFileSync(join(newB, 'Orbit v1.3/data/level1.pak'), 'utf8')).toBe('new data');
    expect(existsSync(join(newB, 'Orbit v1.2'))).toBe(false);
  });

  it('preserves imported saves older than their import date, and rejects symlink destinations', () => {
    const dir=tmp(),oldB=join(dir,'old'),newB=join(dir,'new'),outside=join(dir,'outside');
    put(oldB,'game.exe');put(oldB,'Saved/SaveGames/slot.sav','irreplaceable progress');
    put(newB,'game.exe','new program');mkdirSync(outside);
    const ancient=new Date('2020-01-01');utimesSync(join(oldB,'Saved/SaveGames/slot.sav'),ancient,ancient);
    let result=carryOver({fromRoot:oldB,fromExe:join(oldB,'game.exe'),toRoot:newB,toExe:join(newB,'game.exe'),since:Date.now()});
    expect(result.copied).toContain('Saved/SaveGames/slot.sav');expect(readFileSync(join(newB,'Saved/SaveGames/slot.sav'),'utf8')).toBe('irreplaceable progress');
    rmSync(join(newB,'Saved'),{recursive:true});symlinkSync(outside,join(newB,'Saved'));
    expect(()=>carryOver({fromRoot:oldB,fromExe:join(oldB,'game.exe'),toRoot:newB,toExe:join(newB,'game.exe'),since:Date.now()})).toThrow(/Could not preserve/);
    expect(existsSync(join(outside,'SaveGames/slot.sav'))).toBe(false);
  });
  it('never lets an old program overwrite the new one', () => {
    const dir = tmp(), oldB = join(dir, 'old'), newB = join(dir, 'new');
    put(oldB, 'game.exe', 'v1');
    snapshotBuild({ root: oldB, out: join(dir, 'm.json') });
    writeFileSync(join(oldB, 'game.exe'), 'patched by a mod');
    put(newB, 'game.exe', 'v2');
    const r = carryOver({ fromRoot: oldB, fromExe: join(oldB, 'game.exe'), toRoot: newB, toExe: join(newB, 'game.exe'), manifest: join(dir, 'm.json') });
    expect(r.copied).toEqual([]);
    expect(readFileSync(join(newB, 'game.exe'), 'utf8')).toBe('v2');
  });

  it('uses modification times for games installed before file lists were recorded', () => {
    const dir = tmp(), oldB = join(dir, 'old'), newB = join(dir, 'new');
    put(oldB, 'game.x86_64'); put(oldB, 'readme.txt');
    const installed = new Date('2026-10-01T12:00:00Z');
    utimesSync(join(oldB, 'game.x86_64'), installed, new Date('2026-10-01T11:59:00Z'));
    utimesSync(join(oldB, 'readme.txt'), installed, new Date('2026-09-01T00:00:00Z'));
    put(oldB, 'save.dat', 'mine');
    put(newB, 'game.x86_64');
    const r = carryOver({ fromRoot: oldB, fromExe: join(oldB, 'game.x86_64'), toRoot: newB, toExe: join(newB, 'game.x86_64'), since: installed.getTime() });
    expect(r.copied).toEqual(['save.dat']);
  });
});

describe('matchExecutable', () => {
  const c = (relPath: string, kind = 'elf', installerLike = false) => ({ relPath, kind, installerLike }) as never;
  it('finds the same program in the new build', () => {
    expect(matchExecutable('Orbit v1.2/bin/orbit.x86_64', [c('Orbit v1.3/tools/crash.x86_64'), c('Orbit v1.3/bin/orbit.x86_64')])).toBe(1);
    expect(matchExecutable('Game_v1.2.exe', [c('setup.exe', 'exe', true), c('Game_v1.3.exe', 'exe')])).toBe(1);
  });
  it('leaves ambiguous or missing matches to the AI', () => {
    expect(matchExecutable('a/game.exe', [c('x/game.exe', 'exe'), c('y/game.exe', 'exe')])).toBeNull();
    expect(matchExecutable('orbit.exe', [c('launcher.exe', 'exe')])).toBeNull();
  });
});

function repos() {
  const dir = tmp();
  const db = openDb(join(dir, 'launcher.db'));
  cleanup.push(() => db.close());
  const settings = new SettingsRepo(db, defaultSettings({ games: dir, downloads: dir }));
  const sources = new SourcesRepo(db), catalog = new CatalogRepo(db), games = new GamesRepo(db), downloads = new DownloadsRepo(db);
  const src = sources.add('https://games.test/');
  return { db, settings, sources, catalog, games, downloads, src };
}
const fp = (p: Partial<VersionFingerprint>): VersionFingerprint => ({ version: null, updated: null, files: [], sizes: [], at: '2026-10-01T00:00:00Z', ...p });

describe('listing announcements', () => {
  it('re-verifies a game whose listing announces a newer build, also on a new page', () => {
    const { catalog, src } = repos();
    const id = catalog.upsertListing(src.id, { pageUrl: 'https://games.test/orbit', title: 'Orbit v1.2', titleKey: 'orbit' }).id;
    catalog.setDetail(id, { candidates: [{ url: 'https://games.test/f.zip', label: 'Download', fileName: 'f.zip', platform: 'linux', sizeText: null }] });
    expect(catalog.upsertListing(src.id, { pageUrl: 'https://games.test/orbit', title: 'Orbit v1.2', titleKey: 'orbit' })).toEqual({ id, created: false });
    expect(catalog.upsertListing(src.id, { pageUrl: 'https://games.test/orbit', title: 'Orbit v1.3', titleKey: 'orbit' })).toEqual({ id, created: false, changed: true });
    expect(catalog.raw(id)?.detailFetchedAt).toBeNull();
    catalog.setDetail(id, { candidates: [{ url: 'https://games.test/f.zip', label: 'Download', fileName: 'f.zip', platform: 'linux', sizeText: null }] });
    // The next build as a separate post: the entry follows it instead of being swallowed.
    expect(catalog.upsertListing(src.id, { pageUrl: 'https://games.test/orbit-v1-4', title: 'Orbit v1.4', titleKey: 'orbit' })).toEqual({ id, created: false, changed: true });
    expect(catalog.raw(id)?.pageUrl).toBe('https://games.test/orbit-v1-4');
    // An older repost does not move it back.
    catalog.setDetail(id, { candidates: [{ url: 'https://games.test/f.zip', label: 'Download', fileName: 'f.zip', platform: 'linux', sizeText: null }] });
    expect(catalog.upsertListing(src.id, { pageUrl: 'https://games.test/orbit-old', title: 'Orbit v1.1', titleKey: 'orbit' })).toEqual({ id, created: false });
  });
});

describe('UpdateService', () => {
  function service(mode: 'notify' | 'auto' = 'notify') {
    const r = repos();
    r.settings.update({ gameUpdates: mode });
    const entry = r.catalog.upsertListing(r.src.id, { pageUrl: 'https://games.test/orbit', title: 'Orbit', titleKey: 'orbit' }).id;
    const game = r.games.create({ catalogId: entry, downloadId: null, title: 'Orbit', kind: 'linux', installDir: '/tmp/x', executable: '/tmp/x/orbit', args: '', runner: 'native', prefixDir: null, managed: true, artworkFile: null, sourceHost: 'games.test', status: 'installed', candidates: [] });
    const startUpdate = vi.fn();
    const svc = new UpdateService({ games: r.games, catalog: r.catalog, sources: r.sources, downloads: r.downloads, settings: r.settings, limiter: { wait: async () => {} } as never, fetcher: null, startUpdate, isRunning: () => false, broadcast: vi.fn() });
    return { ...r, svc, game: game.id, startUpdate };
  }
  it('does not pretend the current website build is installed when local metadata is unknown', () => {
    const { svc, games, game } = service();
    svc.evaluate(game, fp({version:'1.2'}));
    expect(games.get(game)?.installedVersion?.version).toBeNull();
    expect(games.get(game)?.update).toMatchObject({state:'available',unverified:true});
  });
  it('announces a newer build once, and not again after it is skipped', () => {
    const { svc, games, game } = service();
    games.update(game, {installedVersion: fp({version:'1.2'})});
    svc.evaluate(game, fp({ version: '1.3' }));
    expect(games.get(game)?.update).toMatchObject({ state: 'available', from: 'v1.2', to: 'v1.3' });
    games.update(game, { update: { ...games.get(game)!.update!, state: 'ignored' } });
    svc.evaluate(game, fp({ version: '1.3' }));
    expect(games.get(game)?.update?.state).toBe('ignored');
    svc.evaluate(game, fp({ version: '1.4' }));
    expect(games.get(game)?.update).toMatchObject({ state: 'available', to: 'v1.4' });
  });
  it('detects a silently re-uploaded file through its HTTP validators', () => {
    const { svc, games, game } = service();
    games.update(game, { installedVersion: { ...fp({ files: ['orbit.zip'] }), file: { url: 'https://cdn.test/orbit.zip', name: 'orbit.zip', bytes: 100, etag: '"a"', lastModified: null } } });
    svc.evaluate(game, fp({ files: ['orbit.zip'] }), { status: 200, etag: '"a"', lastModified: null, bytes: 100 });
    expect(games.get(game)?.update).toBeNull();
    svc.evaluate(game, fp({ files: ['orbit.zip'] }), { status: 200, etag: '"b"', lastModified: null, bytes: 120 });
    expect(games.get(game)?.update).toMatchObject({ state: 'available', reason: 'the download file changed on the server' });
  });
  it('leaves store-linked copies out of website update checks and announcements', () => {
    const { svc, games, game, catalog } = service();
    games.update(game, {installedVersion: fp({version:'1.2'})});
    games.update(game, { store: 'gog', storeId: '123' });
    catalog.setVersion(games.get(game)!.catalogId!, fp({ version: '2.0' }));
    svc.afterDetail(games.get(game)!.catalogId!);
    expect(svc.checkNow()).toBe(0); expect(games.get(game)?.update).toBeNull();
  });
  it('links an imported game to its unique saved page and checks the rendered page without searching', async () => {
    const r = service();
    r.catalog.setDetail(r.games.get(r.game)!.catalogId!,{candidates:[{url:'https://gofile.io/d/abcdef',label:'Download',fileName:null,platform:null,sizeText:null}]});
    r.games.update(r.game, {managed:false,catalogId:null,installedVersion:fp({version:'1.0'})});
    const readPage = vi.fn(async (url:string) => ({url,title:'Orbit v2.0',meta:{},text:'',game:null,links:[],fileLinks:[],controls:[{i:0,text:'Download',href:'https://gofile.io/d/abcdef',inContent:true}],gates:{}}));
    const svc = new UpdateService({games:r.games,catalog:r.catalog,sources:r.sources,downloads:r.downloads,settings:r.settings,limiter:{wait:async()=>{}} as never,fetcher:null,readPage:readPage as never,startUpdate:r.startUpdate,isRunning:()=>false,broadcast:vi.fn()});
    const before = r.catalog.raw(r.games.get(r.game)!.catalogId ?? r.catalog.matchInstalled('Orbit')!)!;
    expect(svc.checkNow()).toBe(1); await svc.checkDue();
    expect(readPage).toHaveBeenCalledWith('https://games.test/orbit',expect.any(AbortSignal));
    expect(r.games.get(r.game)).toMatchObject({catalogId:expect.any(Number),managed:false,update:{state:'available',from:'v1.0',to:'v2.0',unverified:false}});
    expect(r.catalog.raw(r.games.get(r.game)!.catalogId!)?.pageUrl).toBe(before.pageUrl);
    expect(r.catalog.raw(r.games.get(r.game)!.catalogId!)?.detailFetchedAt).toBe(before.detailFetchedAt);
  });
  it('does not automatically replace an imported game with an unknown version', () => {
    const {svc,games,game,startUpdate}=service('auto');svc.evaluate(game,fp({version:'2.0'}));
    expect(games.get(game)?.update?.unverified).toBe(true);expect(startUpdate).not.toHaveBeenCalled();
  });
  it('starts the update by itself in automatic mode', () => {
    const { svc, games, game, startUpdate } = service('auto');
    games.update(game, {installedVersion: fp({version:'1.2'})});
    svc.evaluate(game, fp({ version: '2.0' }));
    expect(startUpdate).toHaveBeenCalledWith(game);
  });
});

it('finds the Saved folder and project version when an Unreal executable was imported from Binaries/Win64', () => {
 const dir=tmp();put(dir,'Bodycam/Binaries/Win64/game.exe');put(dir,'Bodycam/Saved/SaveGames/slot.sav','progress');put(dir,'Bodycam/Config/DefaultGame.ini','[ProjectSettings]\nProjectVersion=1.2.3');
 const game={title:'Bodycam',installDir:join(dir,'Bodycam/Binaries/Win64'),executable:join(dir,'Bodycam/Binaries/Win64/game.exe'),addedAt:new Date().toISOString()} as any;
 expect(installedGameRoot(game)).toBe(join(dir,'Bodycam'));expect(localInstalledVersion(game,null).version).toBe('1.2.3');
});
