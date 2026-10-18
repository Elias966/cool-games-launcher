import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractPage, type PageExtract } from '@shared/page-extract';
import { actionKey, downloadEvidence, isHostLanding, revealedMirrors } from '@shared/download-evidence';
import { openDb } from '../src/main/db';
import { CatalogRepo, SourcesRepo } from '../src/main/repos';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

function page(html: string, url = 'https://games.test/game'): PageExtract {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  cleanup.push(() => dom.window.close());
  return dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;
}

describe('observed game download evidence', () => {
  it('does not treat a modal-trigger button as an open dialog or hide the other mirrors',()=>{
    const ex=page('<main><button class="open-modal-button">Download</button><a href="https://files.test/orbit.zip">Download archive</a></main>');
    expect(downloadEvidence(ex)).toHaveLength(2);
  });
  it('keeps the direct option in a popup and excludes torrents, magnet links and torrent query endpoints',()=>{
    const ex=page('<main><button>Download</button><div role="dialog"><a href="https://files.test/orbit.zip">Direct Download</a><button>Download Torrent</button><a href="/download?format=torrent">Download</a><a href="/orbit.torrent">Download</a><a href="magnet:?xt=urn:btih:abc">Magnet</a></div></main>');
    expect(downloadEvidence(ex).map(c=>c.label)).toEqual(['Direct Download']);
  });
  it('compares all five host selector tabs without duplicating the current host anchor',()=>{
    const ex=page('<main><button>Datavaults 1</button><button>FileKeeper 1</button><button>FileQ 1</button><button>Vikingfile 1</button><button>Akirabox 1</button><a href="https://datavaults.co/file/one">Download</a><button>Copy link</button></main>');
    expect(revealedMirrors(ex).map(c=>c.label).sort()).toEqual(['Datavaults 1','FileKeeper 1','FileQ 1','Vikingfile 1','Akirabox 1'].sort());
  });
  it('excludes review/download filters instead of treating them as file hosts',()=>{
    const ex=page('<main><button>Verified players only Confirmed downloads Enable filter</button><button>Download</button><a href="https://buzzheavier.com/abc">Buzzheavier</a></main>');
    expect(downloadEvidence(ex).map(c=>c.label)).toEqual(['Download','Buzzheavier']);
  });
  it('excludes tutorial buttons even when their explanation mentions downloading files',()=>{
    expect(downloadEvidence(page('<button>Watch Guide Watch this short guide so you do not download an ad file by mistake.</button><button>Download</button>')).map(c=>c.label)).toEqual(['Download']);
  });
  it('excludes a review with download links in ads, navigation and recommendations', () => {
    const ex = page(`<main><article><h1>Game review</h1><p>We liked it!</p></article></main>
      <nav><a href="/launcher.exe">Download launcher</a></nav>
      <aside><a href="/ad.zip">Download game</a></aside>
      <div class="related-posts"><a href="/unrelated.zip">Download other game</a></div>
      <div class="advertisement"><a href="/sponsored.zip">Download</a></div>`);
    expect(downloadEvidence(ex)).toEqual([]);
  });

  it('accepts external host links even without a game file extension', () => {
    const ex = page(`<main><h1>Orbit</h1><a href="https://mediafire.com/file/xyz/orbit.zip/file">MediaFire</a>
      <a href="https://mega.nz/file/abc#key">MEGA download</a><button>Download Linux build</button></main>`);
    expect(downloadEvidence(ex)).toHaveLength(3);
    expect(isHostLanding('https://mediafire.com/file/xyz/orbit.zip/file')).toBe(true);
    expect(isHostLanding('https://cdn.mediafire.com/orbit.zip')).toBe(false);
  });

  it('recognises extensionless host buttons used by portable-game catalogs', () => {
    const ex = page('<main><a href="https://uploadhaven.com/download/abc">UploadHaven</a><a href="https://buzzheavier.com/abc">Server 2</a><a href="https://vikingfile.com/f/abc">VikingFile</a></main>');
    expect(downloadEvidence(ex)).toHaveLength(3);
    expect(isHostLanding('https://uploadhaven.com/download/abc')).toBe(true);
    expect(isHostLanding('https://buzzheavier.com/abc')).toBe(true);
  });

  it('does not treat a related game article as a download for this game', () => {
    expect(downloadEvidence(page('<a href="/other-game-free-download">Other Game Free Download</a>'))).toEqual([]);
  });

  it('does not mistake supplementary files for a game', () => {
    expect(downloadEvidence(page(`<main><a href="/code.zip">Source code</a><a href="/music.zip">Soundtrack</a><a href="/manual.zip">Manual</a></main>`))).toEqual([]);
  });

  it('extracts categories and tags separately from structured game metadata', () => {
    const ex = page(`<script type="application/ld+json">{"@type":"VideoGame","name":"Orbit","genre":["Adventure","Puzzle"],"keywords":"space, exploration"}</script>`);
    expect(ex.game?.categories).toEqual(['Adventure', 'Puzzle']);
    expect(ex.game?.tags).toEqual(['space', 'exploration']);
  });

  it('allows identically labelled controls on different host pages', () => {
    const a = page('<button>Download</button>', 'https://games.test/game').controls[0];
    const b = page('<button>Download</button>', 'https://host.test/file').controls[0];
    expect(actionKey('https://games.test/game', a)).not.toBe(actionKey('https://host.test/file', b));
  });
});

describe('downloadable catalog and facets', () => {
  function catalog() {
    const dir = mkdtempSync(join(tmpdir(), 'cgl-catalog-'));
    const db = openDb(join(dir, 'catalog.db'));
    cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    const repo = new CatalogRepo(db);
    const sources = new SourcesRepo(db);
    const source = sources.add('https://games.test/');
    const seed = (title: string, rating: 'safe' | 'adult' | 'unknown', categories: string[], tags: string[], available = true) => {
      const id = repo.upsertListing(source.id, { title, titleKey: title, pageUrl: `https://games.test/${title}`, categories, tags, platforms: ['linux'] }).id;
      repo.setRating(id, rating, rating === 'adult' ? 1 : 0, [], 'v1');
      if (available) repo.setDetail(id, { candidates: [{ url: `https://mediafire.com/file/${title}`, label: 'MediaFire', fileName: null, platform: 'linux', sizeText: null }] });
      return id;
    };
    return { repo, source, seed };
  }

  it('keeps provisional listings and articles out of queries and detail views', () => {
    const { repo, seed } = catalog();
    const pending = seed('Pending', 'safe', ['news'], [], false);
    const article = seed('Review', 'safe', ['news'], [], false);
    repo.setDetail(article, { candidates: [] });
    const game = seed('Orbit', 'safe', ['puzzle'], ['space']);
    const policy = { showNsfw: false, revision: 1 };
    expect(repo.query(policy, {}).entries.map((e) => e.id)).toEqual([game]);
    expect(repo.get(article, policy)).toBeNull();
    expect(repo.get(pending, policy)).toBeNull();
    expect(repo.facets(policy)).toMatchObject({ categories: [{ name: 'puzzle', count: 1 }], tags: [{ name: 'space', count: 1 }] });
  });

  it('filters before pagination and combines search, source, category and tag', () => {
    const { repo, seed, source } = catalog();
    const wanted = seed('Orbit', 'safe', [' Puzzle ', 'Puzzle'], ['Space']);
    for (let i = 0; i < 125; i++) seed(`Other-${i}`, 'safe', ['action'], ['combat']);
    expect(repo.query({ showNsfw: false, revision: 1 }, { search: 'Orbit', sourceIds: [source.id], platforms: ['linux'], categories: ['PUZZLE'], tags: ['space'], limit: 1 })).toMatchObject({ total: 1, entries: [{ id: wanted, categories: ['puzzle'], tags: ['space'] }] });
    expect(repo.query({ showNsfw: false, revision: 1 }, { categories: ['puzzle'], tags: ['combat'] }).total).toBe(0);
  });

  it('does not leak adult or unknown metadata through filter choices', () => {
    const { repo, seed } = catalog();
    seed('Safe', 'safe', ['adventure'], ['exploration']);
    seed('Adult', 'adult', ['adult-category'], ['adult-tag']);
    seed('Unknown', 'unknown', ['unknown-category'], ['unknown-tag']);
    expect(repo.facets({ showNsfw: false, revision: 1 })).toMatchObject({ categories: [{ name: 'adventure' }], tags: [{ name: 'exploration' }] });
    expect(repo.facets({ showNsfw: true, revision: 2 }).categories.map((c) => c.name).sort()).toEqual(['adult-category', 'adventure']);
    expect(repo.facets({ showNsfw: true, revision: 2 }).tags.map((t) => t.name).sort()).toEqual(['adult-tag', 'exploration']);
  });

  it('does not spend artwork checks on provisional listings before verifying their downloads', () => {
    const { repo, seed } = catalog();
    const pending = seed('Pending', 'unknown', [], [], false);
    const available = seed('Orbit', 'unknown', ['puzzle'], ['space']);
    expect(repo.needingClassification('v1', 50, true).map((e) => e.id)).toEqual([available]);
    expect(repo.needingClassification('v1').map((e) => e.id)).toContain(pending);
  });

  it('bounds failed detail retries and resets them on a requested recrawl', () => {
    const { repo, seed, source } = catalog();
    const id = seed('Pending', 'safe', [], [], false);
    for (let i = 0; i < 3; i++) repo.recordDetailFailure(id);
    expect(repo.needingDetail(source.id, { showNsfw: false, revision: 1 }, 10)).toEqual([]);
    repo.retryUnfinishedDetails(source.id);
    expect(repo.needingDetail(source.id, { showNsfw: false, revision: 1 }, 10).map((e) => e.id)).toEqual([id]);
  });

  it('withholds updated details until their content has been checked again', () => {
    const { repo, seed } = catalog();
    const id = seed('Orbit', 'safe', ['puzzle'], ['space']);
    repo.invalidateRating(id);
    expect(repo.get(id, { showNsfw: false, revision: 1 })).toBeNull();
    expect(repo.facets({ showNsfw: false, revision: 1 })).toMatchObject({ categories: [], tags: [] });
    expect(repo.needingClassification('v1').map((e) => e.id)).toEqual([id]);
    repo.setRating(id, 'safe', 0, [], 'v1');
    expect(repo.get(id, { showNsfw: false, revision: 1 })?.id).toBe(id);
  });
});
