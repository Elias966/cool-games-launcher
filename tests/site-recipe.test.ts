import { describe, expect, it } from 'vitest';
import { catalogLinks, isListingRoute, inducePatterns, matchesAny, moreFromExamples, paginationLinks, recipeCards, recipeRoutes, type SiteRecipe } from '@shared/site-recipe';
import type { PageExtract } from '@shared/page-extract';

const recipe = (game: string[], more: string[] = []): SiteRecipe => ({
  version: 1, game: inducePatterns(game), more: moreFromExamples(more), listingMode: 'http', detailMode: 'http', learnedAt: '', origin: 'ai',
});

describe('site recipes', () => {
  it('generalises per-author subdomains and slugs', () => {
    const p = inducePatterns(['https://kazehita.itch.io/heartfall', 'https://surrtasm.itch.io/the-art-shop', 'https://a-b.itch.io/x']);
    expect(matchesAny('https://someone.itch.io/new-game', p)).toBe(true);
    expect(matchesAny('https://someone.itch.io/new-game/', p)).toBe(true);
    expect(matchesAny('https://itch.io/games/free', p)).toBe(false);
    expect(matchesAny('https://itch.io/jams', p)).toBe(false);
    expect(matchesAny('https://someone.itch.io/new-game/devlog/1', p)).toBe(false);
    expect(matchesAny('https://evil.example/new-game', p)).toBe(false);
  });

  it('keeps shared slug suffixes literal', () => {
    const p = inducePatterns(['https://site.test/orbit-free-download/', 'https://site.test/space-trader-free-download/']);
    expect(matchesAny('https://site.test/new-thing-free-download/', p)).toBe(true);
    expect(matchesAny('https://site.test/about/', p)).toBe(false);
  });

  it('keeps fixed path prefixes and numeric ids', () => {
    const p = inducePatterns(['https://g.test/games/12/orbit', 'https://g.test/games/987/space']);
    expect(matchesAny('https://g.test/games/5/new', p)).toBe(true);
    expect(matchesAny('https://g.test/news/5/new', p)).toBe(false);
  });
  it('does not let a stray category example turn every two-segment page into a game',()=>{
    const patterns=inducePatterns(['https://g.test/game/orbit','https://g.test/game/space','https://g.test/genre/action']);
    expect(matchesAny('https://g.test/game/new-game',patterns)).toBe(true);
    expect(matchesAny('https://g.test/genre/adventure',patterns)).toBe(false);
    expect(matchesAny('https://g.test/account/settings',patterns)).toBe(false);
  });
  it('keeps catalog links out of game cards even with an older broad recipe',()=>{
    const ex={url:'https://g.test/',cards:[],links:[{href:'https://g.test/game/orbit',text:'Orbit',inContent:true},{href:'https://g.test/genre/action',text:'Action',inContent:true}]} as unknown as PageExtract;
    expect(recipeCards(ex,recipe(['https://g.test/game/orbit','https://g.test/game/space','https://g.test/genre/action'])) .map(c=>c.href)).toEqual(['https://g.test/game/orbit']);
  });

  it('induces pagination from a single example', () => {
    const more = moreFromExamples(['https://itch.io/games/free?page=2', 'https://site.test/page/2/']);
    expect(matchesAny('https://itch.io/games/free?page=9', more)).toBe(true);
    expect(matchesAny('https://site.test/page/14/', more)).toBe(true);
    expect(matchesAny('https://site.test/orbit/', more)).toBe(false);
  });

  it('builds cards and routes from a page', () => {
    const r = recipe(['https://g.test/game/orbit', 'https://g.test/game/space'], ['https://g.test/list?page=2']);
    const link = (i: number, href: string, text: string, img: string | null = null, inContent = true) => ({ i, href, text, img, rect: { x: 0, y: 0, w: 0, h: 0 }, download: false, inContent });
    const ex = {
      url: 'https://g.test/list?page=2', cards: [], nextPage: null,
      links: [
        link(1, 'https://g.test/game/new-one', '', 'https://img/1.png'),
        link(2, 'https://g.test/game/new-one', 'New One'),
        link(3, 'https://g.test/game/other', 'Download'),
        link(4, 'https://g.test/list?page=3', '3'),
        link(5, 'https://g.test/about', 'About'),
      ],
    } as unknown as PageExtract;
    const cards = recipeCards(ex, r);
    expect(cards).toEqual([expect.objectContaining({ href: 'https://g.test/game/new-one', title: 'New One', img: 'https://img/1.png' })]);
    expect(recipeRoutes(ex, r)).toEqual(['https://g.test/list?page=3']);
  });

  it('finds pagination on any layout without the AI', () => {
    const link = (i: number, href: string, text: string) => ({ i, href, text, img: null, rect: { x: 0, y: 0, w: 0, h: 0 }, download: false, inContent: true });
    const ex = { url: 'https://s.test/', links: [
      link(1, 'https://s.test/page/2/', '2'), link(2, 'https://s.test/page/3/', '3'), link(3, 'https://s.test/?paged=2', ''),
      link(4, 'https://s.test/games?page=2', 'Next »'), link(5, 'https://s.test/older', 'Older posts'),
      link(6, 'https://s.test/game-2', '2'), link(7, 'https://s.test/about', 'About'), link(8, 'https://other.test/page/2/', '2'),
    ] } as unknown as PageExtract;
    expect(paginationLinks(ex).sort()).toEqual(['https://s.test/?paged=2', 'https://s.test/games?page=2', 'https://s.test/older', 'https://s.test/page/2/', 'https://s.test/page/3/']);
  });

  it('excludes random-post actions even when they look like next pages or match a learned route',()=>{
    const action='https://s.test/category/action/page/4?random-post=1';
    const ex={url:'https://s.test/category/action/',links:[{href:action,text:'Next 4',inContent:true},{href:'https://s.test/category/action/page/4',text:'4',inContent:true}],nextPage:action} as PageExtract;
    expect(isListingRoute(action)).toBe(false);expect(isListingRoute('https://s.test/?page=4')).toBe(true);
    expect(paginationLinks(ex)).toEqual(['https://s.test/category/action/page/4']);
    expect(recipeRoutes(ex,recipe([], [action]))).toEqual(['https://s.test/category/action/page/4']);
    expect(catalogLinks({...ex,links:[{href:action,text:'All games'}]} as PageExtract)).toEqual([]);
  });

  it('finds catalog links (all games, A–Z, categories) in menus', () => {
    const link = (i: number, href: string, text: string, inContent = false) => ({ i, href, text, img: null, rect: { x: 0, y: 0, w: 0, h: 0 }, download: false, inContent });
    const ex = { url: 'https://s.test/', links: [
      link(1, 'https://s.test/games/', 'All games'), link(2, 'https://s.test/category/action/', 'Action'), link(3, 'https://s.test/games-list-page/', 'Games List'),
      link(4, 'https://s.test/news/', 'News'), link(5, 'https://s.test/about/', 'About'), link(6, 'https://other.test/category/x/', 'X'),
    ] } as unknown as PageExtract;
    expect(catalogLinks(ex).sort()).toEqual(['https://s.test/category/action/', 'https://s.test/games-list-page/', 'https://s.test/games/']);
  });
});

it('excludes RSS and data feeds from HTML listing routes',()=>{
  for(const url of ['https://games.test/rss/3-new-games.xml/','https://games.test/feed/','https://games.test/updates.atom','https://games.test/games.json'])expect(isListingRoute(url)).toBe(false);
  expect(isListingRoute('https://games.test/all-games/?page=2')).toBe(true);
});
