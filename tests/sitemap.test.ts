import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { sitemapUrls, titleFromUrl } from '../src/main/sitemap';
import { extractPage, type PageExtract } from '@shared/page-extract';
import { catalogLinks } from '@shared/site-recipe';

describe('sitemaps', () => {
  it('follows robots.txt and sitemap indexes to every same-site page', async () => {
    const files: Record<string, string> = {
      'https://s.test/robots.txt': 'User-agent: *\nSitemap: https://s.test/sitemap_index.xml\n',
      'https://s.test/sitemap_index.xml': '<sitemapindex><sitemap><loc>https://s.test/post-sitemap.xml</loc></sitemap><sitemap><loc>https://s.test/page-sitemap.xml.gz</loc></sitemap></sitemapindex>',
      'https://s.test/post-sitemap.xml': '<urlset><url><loc>https://s.test/orbit-run/</loc></url><url><loc><![CDATA[https://s.test/star-miner/]]></loc></url><url><loc>https://elsewhere.test/x/</loc></url></urlset>',
    };
    const urls = await sitemapUrls('https://s.test', async (u) => {
      if (u.endsWith('.gz')) return { status: 200, text: '<urlset><url><loc>https://s.test/about/</loc></url></urlset>' }; // the worker gunzips
      return files[u] ? { status: 200, text: files[u] } : { status: 404, text: null };
    });
    expect(urls.sort()).toEqual(['https://s.test/about/', 'https://s.test/orbit-run/', 'https://s.test/star-miner/']);
  });

  it('falls back to /sitemap.xml without robots.txt entries', async () => {
    const urls = await sitemapUrls('https://s.test', async (u) => (u === 'https://s.test/sitemap.xml' ? { status: 200, text: '<urlset><url><loc>https://s.test/g/</loc></url></urlset>' } : { status: 404, text: null }));
    expect(urls).toEqual(['https://s.test/g/']);
  });

  it('accepts www and http/https variants of the same site', async () => {
    const urls = await sitemapUrls('https://s.test', async (u) => (u === 'https://s.test/robots.txt' ? { status: 200, text: 'Sitemap: http://www.s.test/sitemap.xml' } : u === 'http://www.s.test/sitemap.xml' ? { status: 200, text: '<urlset><url><loc>https://www.s.test/g/</loc></url><url><loc>https://other.test/g/</loc></url></urlset>' } : { status: 404, text: null }));
    expect(urls).toEqual(['https://www.s.test/g/']);
  });

  it('makes readable placeholder titles from slugs', () => {
    expect(titleFromUrl('https://s.test/neon-kart_deluxe/')).toBe('Neon Kart Deluxe');
  });

  it('collects links from collapsed (hidden) menus for route learning', () => {
    const dom = new JSDOM('<header><nav><ul><li><a href="/">Home</a></li><li class="has-sub"><a href="#">Browse</a><ul class="sub-menu" style="display:none"><li><a href="/games-list/">All Games</a></li><li><a href="/category/action/">Action</a></li></ul></li></ul></nav></header><main><a href="/orbit/">Orbit</a></main>', { url: 'https://s.test/', runScripts: 'outside-only' });
    const ex = dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;
    dom.window.close();
    expect(ex.links.map((l) => l.href)).not.toContain('https://s.test/games-list/');
    expect(ex.menuLinks?.map((l) => l.href)).toEqual(expect.arrayContaining(['https://s.test/games-list/', 'https://s.test/category/action/']));
    expect(catalogLinks(ex)).toEqual(expect.arrayContaining(['https://s.test/games-list/', 'https://s.test/category/action/']));
  });
});
