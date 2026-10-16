import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/main/db';
import { AiCacheRepo, CatalogRepo, GamesRepo } from '../src/main/repos';
import { GameImagesService, allowedImageUrl } from '../src/main/game-images';
import type { SteamMedia } from '../src/shared/types';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cgl-images-'));
  const db = openDb(join(dir, 'db.sqlite'));
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const games = new GamesRepo(db);
  const catalog = new CatalogRepo(db);
  const cache = new AiCacheRepo(db);
  const game = games.create({ catalogId: null, downloadId: null, title: 'Amnesia', kind: 'windows', installDir: '/g', executable: '/g/a.exe', args: '', runner: 'proton', prefixDir: null, managed: false, artworkFile: 'own.jpg', sourceHost: null, status: 'installed', candidates: [] });
  games.update(game.id, { art: { appid: 57300, hero: 'https://cdn.test/hero.jpg', logo: null, capsule: 'https://cdn.test/capsule.jpg' } });
  const media = { appid: 57300, hero: 'https://cdn.test/hero.jpg', logo: null, capsule: 'https://cdn.test/capsule.jpg', header: 'https://cdn.test/header.jpg', background: 'https://cdn.test/bg.jpg', reviews: null, released: null, screenshots: ['https://cdn.test/s1.jpg', 'https://cdn.test/s2.jpg'], trailers: [] } as SteamMedia;
  let steamCalls = 0;
  const service = new GameImagesService({ games, catalog, policy: () => ({ showNsfw: true, revision: 1 }), cache, steamMedia: async () => { steamCalls++; return media; }, artworkDir: join(dir, 'artwork') });
  return { dir, games, catalog, service, id: game.id, calls: () => steamCalls };
}

describe('choosing a game\'s images', () => {
  it('offers Steam artwork and screenshots, and its own artwork, for cover and background', async () => {
    const t = setup();
    const o = await t.service.options(t.id);
    expect(o.covers.slice(0, 2)).toEqual(['https://cdn.test/capsule.jpg', 'https://cdn.test/header.jpg']);
    expect(o.covers).toContain('https://cdn.test/s1.jpg');
    expect(o.covers).toContain('cgl-media://artwork/own.jpg');
    expect(o.heroes[0]).toBe('https://cdn.test/hero.jpg');
    expect(o.heroes).toContain('https://cdn.test/bg.jpg');
    // Steam is asked once a week, not on every opening.
    await t.service.options(t.id);
    expect(t.calls()).toBe(1);
  });

  it('remembers the choice, and goes back to the default', () => {
    const t = setup();
    t.service.set(t.id, 'cover', 'https://cdn.test/s2.jpg');
    expect(t.games.get(t.id)!.images).toEqual({ cover: 'https://cdn.test/s2.jpg', hero: null });
    t.service.set(t.id, 'cover', null);
    expect(t.games.get(t.id)!.images.cover).toBeNull();
  });

  it('refuses addresses that are not images on the web or in the launcher', () => {
    const t = setup();
    for (const bad of ['http://plain.test/x.jpg', 'file:///etc/passwd', 'javascript:alert(1)', 'cgl-media://snapshot/1']) {
      expect(allowedImageUrl(bad)).toBe(false);
      expect(() => t.service.set(t.id, 'hero', bad)).toThrow();
    }
  });

  it('copies an image file of the person\'s own, and the launcher may show it', () => {
    const t = setup();
    const file = join(t.dir, 'my cover.png');
    writeFileSync(file, 'png');
    const images = t.service.fromFile(t.id, 'cover', file);
    const name = decodeURIComponent(images.cover!.replace('cgl-media://artwork/', ''));
    expect(existsSync(join(t.dir, 'artwork', name))).toBe(true);
    expect(t.catalog.artworkVisible(name, { showNsfw: false, revision: 1 })).toBe(true);
    expect(t.catalog.artworkVisible('someone-else.png', { showNsfw: false, revision: 1 })).toBe(false);
    expect(() => t.service.fromFile(t.id, 'hero', join(t.dir, 'notes.txt'))).toThrow(/image file/);
  });
});
