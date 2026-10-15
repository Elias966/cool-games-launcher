import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractPage, type PageExtract } from '@shared/page-extract';
import { isBoilerplate, parseCount, pickDescription, popularitySignals, popularScore, rankLinks, trendingScore, usefulTag } from '@shared/popularity';
import { baseTitle, sameGame, steamDate } from '../src/main/descriptions';
import { openDb } from '../src/main/db';
import { CatalogRepo, SourcesRepo } from '../src/main/repos';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
function page(html: string, url = 'https://s.test/game/'): PageExtract {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const ex = dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;
  dom.window.close();
  return ex;
}

describe('counters', () => {
  it('parses compact and separated numbers', () => {
    expect(parseCount('12,345')).toBe(12345);
    expect(parseCount('12.3K')).toBe(12300);
    expect(parseCount('1.2M')).toBe(1_200_000);
    expect(parseCount('4 523')).toBe(4523);
    expect(parseCount('abc')).toBeNull();
  });
  it('reads downloads, views and ratings from structured data and the article', () => {
    const s = popularitySignals({ jsonLd: [{ '@type': 'VideoGame', aggregateRating: { ratingValue: 9, bestRating: 10, ratingCount: '1,204' } }], text: '', mainText: 'Genre: Action Downloads: 48.2K Views 120,000' });
    expect(s).toEqual({ downloads: 48200, views: 120000, ratings: 1204, rating: 4.5 });
  });
});

describe('ranking', () => {
  it('finds the site’s Popular and Trending pages in menus and links', () => {
    const r = rankLinks({ url: 'https://s.test/', links: [{ href: 'https://s.test/games?sort=popular', text: 'Sort' } as never], menuLinks: [{ href: 'https://s.test/trending/', text: 'Trending' }, { href: 'https://other.test/popular/', text: 'Popular' }] });
    expect(r).toEqual({ trending: 'https://s.test/trending/', popular: 'https://s.test/games?sort=popular' });
  });
  it('ranks site lists above counters and decays trending with age', () => {
    const now = Date.parse('2026-10-15T00:00:00Z');
    const listed = popularScore({ signals: null, rank: 40, tags: [] });
    const counted = popularScore({ signals: { downloads: 5_000_000, views: null, ratings: null, rating: null }, rank: null, tags: [] });
    expect(listed).toBeGreaterThan(counted);
    expect(popularScore({ signals: null, rank: 1, tags: [] })).toBeGreaterThan(listed);
    const fresh = trendingScore({ signals: { downloads: 20_000, views: null, ratings: null, rating: null }, rank: null, popularRank: null, tags: [], published: '2026-10-10T00:00:00Z', discovered: '2026-10-14T00:00:00Z', now });
    const old = trendingScore({ signals: { downloads: 50_000, views: null, ratings: null, rating: null }, rank: null, popularRank: null, tags: [], published: '2019-01-01T00:00:00Z', discovered: '2026-10-14T00:00:00Z', now });
    expect(fresh).toBeGreaterThan(old);
  });
  it('reads "Popular games" blocks on a front page', () => {
    const ex = page('<main><h2>Latest</h2><a href="/a/">A</a></main><aside class="widget"><h3 class="widget-title">Most Popular Games</h3><ul><li><a href="/p1/">P1</a></li><li><a href="/p2/">P2</a></li><li><a href="/p3/">P3</a></li></ul></aside>', 'https://s.test/');
    expect(ex.rankedSections).toEqual([{ kind: 'popular', heading: 'Most Popular Games', links: ['https://s.test/p1/', 'https://s.test/p2/', 'https://s.test/p3/'] }]);
  });
});

describe('descriptions', () => {
  it('recognises SEO blurbs', () => {
    expect(isBoilerplate("Happy's Humble Burger Cult Free Download GameVault.example Get Happy's Humble Burger Cult PC game for free instantly and play pre-installed on GameVault", 'gamevault.example')).toBe(true);
    expect(isBoilerplate('Run a burger restaurant that is secretly a cult. Serve customers, recruit followers and keep the health inspector away in this cozy management game.')).toBe(false);
  });
  it('finds the text under an "Overview" heading and skips the blurb', () => {
    const ex = page('<head><meta name="description" content="Orbit Free Download Get Orbit PC game for free instantly"></head><article><p>Orbit Free Download direct link pre-installed.</p><h2>Game Overview</h2><p>Orbit is a physics puzzle game about slingshotting satellites around planets to deliver mail across the solar system.</p><p>Plan each launch, ride gravity wells and unlock forty hand-made levels.</p><h2>System Requirements</h2><p>OS: Windows 10</p></article>');
    expect(ex.about).toBe('Orbit is a physics puzzle game about slingshotting satellites around planets to deliver mail across the solar system. Plan each launch, ride gravity wells and unlock forty hand-made levels.');
    expect(pickDescription([ex.meta['description'], ex.about], 's.test')).toBe(ex.about);
  });
  it('falls back to the first real paragraph', () => {
    const ex = page('<main><p>Download now!</p><p>Star Miner is a cozy asteroid-mining game. Dig through rock, sell ore and upgrade your ship between runs.</p></main>');
    expect(ex.about).toMatch(/^Star Miner is a cozy asteroid-mining game/);
  });
  it('matches Steam results only for the same game', () => {
    expect(sameGame('DRAGON QUEST® XI S: Echoes of an Elusive Age™ - Definitive Edition', 'Dragon Quest XI S Echoes of an Elusive Age')).toBe(true);
    expect(sameGame('Potionomics', 'The Royal Writ')).toBe(false);
  });
});

describe('Steam matching', () => {
  it('matches editions of the same game but never a sequel', () => {
    expect(sameGame('Black Myth: Wukong', 'Black Myth: Wukong Digital Deluxe Edition')).toBe(true);
    expect(sameGame('ELDEN RING', 'Elden Ring Deluxe Edition')).toBe(true);
    expect(sameGame('Portal 2', 'Portal')).toBe(false);
    expect(baseTitle('X4: Foundations (v7.60) + 5 DLCs')).toBe('X4: Foundations');
  });
  it('reads Steam release dates', () => {
    expect(steamDate('24 Feb, 2022')).toBe(new Date(Date.parse('24 Feb 2022')).toISOString());
    expect(steamDate('Coming soon')).toBeNull();
  });
  it('orders Popular by players and Trending by recent popularity', () => {
    const now = Date.parse('2026-10-15T00:00:00Z');
    const games = [
      { name: 'classic', ratings: 830_000, published: '2022-02-24T00:00:00Z' },
      { name: 'new hit', ratings: 6_000, published: '2026-10-05T00:00:00Z' },
      { name: 'old indie', ratings: 200, published: '2018-01-01T00:00:00Z' },
      { name: 'unknown', ratings: null, published: null },
    ];
    const sig = (r: number | null) => (r ? { downloads: null, views: null, ratings: r, rating: null } : null);
    const popular = [...games].sort((a, b) => popularScore({ signals: sig(b.ratings), rank: null, tags: [] }) - popularScore({ signals: sig(a.ratings), rank: null, tags: [] })).map((g) => g.name);
    const trending = [...games].sort((a, b) => trendingScore({ signals: sig(b.ratings), rank: null, popularRank: null, tags: [], published: b.published, discovered: '2026-10-14T00:00:00Z', now }) - trendingScore({ signals: sig(a.ratings), rank: null, popularRank: null, tags: [], published: a.published, discovered: '2026-10-14T00:00:00Z', now })).map((g) => g.name);
    expect(popular).toEqual(['classic', 'new hit', 'old indie', 'unknown']);
    expect(trending).toEqual(['new hit', 'classic', 'old indie', 'unknown']);
  });
});

describe('tags and sorting', () => {
  it('drops noise tags', () => {
    expect(['updated', 'ltd', 'inc.', 'top', 'open world', 'square enix', '2026', 'Free Download PC'].filter(usefulTag)).toEqual(['open world', 'square enix']);
  });
  it('sorts by the site lists and counts facets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-pop-'));
    const db = openDb(join(dir, 'db'));
    cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    const catalog = new CatalogRepo(db), src = new SourcesRepo(db).add('https://s.test/');
    const ids = ['a', 'b', 'c'].map((n) => {
      const id = catalog.upsertListing(src.id, { pageUrl: `https://s.test/${n}`, title: n.toUpperCase(), titleKey: n }).id;
      catalog.setDetail(id, { candidates: [{ url: 'https://s.test/f.zip', label: 'Download', fileName: 'f.zip', platform: 'linux', sizeText: null }], tags: ['action', 'updated'] });
      catalog.setRating(id, 'safe', 0, [], 'v');
      return id;
    });
    catalog.setDetail(ids[0], { candidates: [{ url: 'https://s.test/f.zip', label: 'Download', fileName: 'f.zip', platform: 'linux', sizeText: null }], popularity: { downloads: 900, views: null, ratings: null, rating: null } });
    catalog.setRanks(src.id, 'popular', [ids[2], ids[1]]);
    const policy = { showNsfw: false, revision: 1 };
    expect(catalog.query(policy, { sort: 'popular' }).entries.map((e) => e.title)).toEqual(['C', 'B', 'A']);
    expect(catalog.query(policy, { sort: 'title' }).entries.map((e) => e.title)).toEqual(['A', 'B', 'C']);
    expect(catalog.query(policy, { sort: 'popular' }).entries[0].rankPopular).toBe(1);
    const f = catalog.facets(policy);
    expect(f.tags).toEqual([{ name: 'action', count: 3 }]);
    expect(f.ranked).toBe(3);
  });
});

describe('Steam store media', () => {
  it('builds artwork, review, release, screenshot and trailer URLs (all-ages only)', async () => {
    const { steamItem } = await import('../src/main/descriptions');
    const item = steamItem({
      appid: 2828710,
      assets: { asset_url_format: 'steam/apps/2828710/${FILENAME}?t=1', main_capsule: 'aa/capsule_616x353.jpg', library_hero: 'bb/library_hero.jpg', header: 'cc/header.jpg' },
      release: { steam_release_date: 1791910322 },
      reviews: { summary_filtered: { review_count: 643, percent_positive: 76, review_score_label: 'Mostly Positive' } },
      basic_info: { short_description: 'Valor Mortis is a first-person action soulslike from the creators of Ghostrunner.' },
      screenshots: { all_ages_screenshots: [{ filename: 'steam/apps/2828710/x/ss_2.jpg', ordinal: 2 }, { filename: 'steam/apps/2828710/x/ss_1.jpg', ordinal: 1 }] },
      trailers: { highlights: [
        { trailer_name: 'Launch', all_ages: true, trailer_url_format: 'steam/apps/${FILENAME}?t=1', screenshot_medium: '25/abc/movie_600x337.jpg', microtrailer: [{ filename: '2828710/1/m/microtrailer.mp4', type: 'video/mp4' }], adaptive_trailers: [{ cdn_path: '2828710/1/m/hls_264_master.m3u8', encoding: 'hls_h264' }] },
        { trailer_name: 'Gore cut', all_ages: false },
      ] },
    })!;
    expect(item.media.capsule).toBe('https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2828710/aa/capsule_616x353.jpg?t=1');
    expect(item.media.hero).toContain('/bb/library_hero.jpg');
    expect(item.media.reviews).toEqual({ label: 'Mostly Positive', percent: 76, count: 643 });
    expect(item.media.released?.slice(0, 4)).toBe('2026');
    expect(item.media.screenshots.map((s) => s.split('/').pop())).toEqual(['ss_1.jpg', 'ss_2.jpg']);
    expect(item.media.trailers).toEqual([{ name: 'Launch', hls: 'https://video.akamai.steamstatic.com/store_trailers/2828710/1/m/hls_264_master.m3u8', preview: 'https://video.akamai.steamstatic.com/store_trailers/2828710/1/m/microtrailer.mp4', poster: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/25/abc/movie_600x337.jpg?t=1' }]);
    expect(item.description).toMatch(/^Valor Mortis/);
  });
});

describe('typo-tolerant search and wanted titles', () => {
  it('finds titles despite typos, but numbers must match', async () => {
    const { titleSimilarity } = await import('@shared/fuzzy');
    expect(titleSimilarity('witcer 3', 'The Witcher 3: Wild Hunt')).toBeGreaterThanOrEqual(0.7);
    expect(titleSimilarity('eldn ring', 'ELDEN RING')).toBeGreaterThanOrEqual(0.7);
    expect(titleSimilarity('silksong', 'Hollow Knight: Silksong')).toBe(1);
    expect(titleSimilarity('portal 3', 'Portal 2')).toBeLessThan(0.7);
    expect(titleSimilarity('zzzz', 'Elden Ring')).toBeLessThan(0.7);
  });
  it('matches a wanted title to its game, not to a sequel', async () => {
    const { wantedMatch } = await import('../src/main/wishlist');
    expect(wantedMatch('Hollow Knight Silksong', 'Hollow Knight: Silksong')).toBe(true);
    expect(wantedMatch('Elden Ring', 'ELDEN RING Deluxe Edition')).toBe(true);
    expect(wantedMatch('Eldn Ring', 'ELDEN RING')).toBe(true);
    expect(wantedMatch('Portal', 'Portal 2')).toBe(false);
    expect(wantedMatch('Hades', 'Hades II')).toBe(false);
  });
});

describe('typo search numbers', () => {
  it('does not let "3" match "360"', async () => {
    const { titleSimilarity } = await import('@shared/fuzzy');
    expect(titleSimilarity('witcer 3', 'Orbital Bullet – The 360° Rogue-lite')).toBeLessThan(0.7);
    expect(titleSimilarity('witcer 3', 'The Witcher 3: Wild Hunt Remastered')).toBeGreaterThanOrEqual(0.7);
  });
});
