import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractPage, type PageExtract } from '@shared/page-extract';
import { rankCandidates } from '../src/main/resolver';

let dom: JSDOM;
function load(html: string, url: string) {
  dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url, runScripts: 'outside-only' });
}
/** Runs the extractor serialised into the page, exactly as the browser worker does. */
function extract(): PageExtract {
  return dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;
}

describe('itch.io adapter', () => {
  it('reads listing cells', () => {
    load(
      `<div class="game_cell"><a class="thumb_link game_link" href="https://dev.itch.io/a"><div class="game_thumb"><img data-lazy_src="https://img.itch.zone/a.png"></div></a>
         <div class="game_cell_data"><div class="game_title"><a class="title game_link" href="https://dev.itch.io/a">Alpha Quest</a></div>
         <div class="game_text">A small adventure</div><div class="game_author"><a>dev</a></div><div class="game_genre">Adventure</div>
         <div class="game_platform"><span title="Download for Linux"></span><span title="Download for Windows"></span></div></div></div>
       <div class="game_cell"><div class="game_title"><a class="title game_link" href="https://dev.itch.io/b">Beta</a></div></div>`,
      'https://itch.io/games/free?page=1',
    );
    const ex = extract();
    expect(ex.site).toBe('itch.io');
    expect(ex.cards.map((c) => c.title)).toEqual(['Alpha Quest', 'Beta']);
    expect(ex.cards[0].img).toBe('https://img.itch.zone/a.png');
    expect(ex.cards[0].platforms).toEqual(['linux', 'windows']);
    expect(ex.nextPage).toBe('https://itch.io/games/free?page=2');
  });
});

describe('itch.io download page', () => {
  it('lists uploads with clickable buttons even when recommendation cells are present', () => {
    load(
      `<h2 class="object_title">Download Site Burial</h2>
       <div class="upload"><a data-upload_id="1" class="button download_btn" href="javascript:void(0);">Download</a>
         <div class="upload_name"><strong class="name" title="Game-mac.zip">Game-mac.zip</strong><span class="file_size"><span>272 MB</span></span>
         <span class="download_platforms"><span class="icon icon-apple" title="Download for macOS"></span></span></div></div>
       <div class="upload"><a data-upload_id="2" class="button download_btn" href="javascript:void(0);">Download</a>
         <div class="upload_name"><strong class="name" title="Game-pc.zip">Game-pc.zip</strong><span class="file_size"><span>278 MB</span></span>
         <span class="download_platforms"><span class="icon icon-tux" title="Download for Linux"></span><span class="icon icon-windows8" title="Download for Windows"></span></span></div></div>
       <div class="game_cell"><div class="game_title"><a class="title" href="https://other.itch.io/x">Other game</a></div></div>`,
      'https://dev.itch.io/game/download/abc',
    );
    const ex = extract();
    expect(ex.game?.uploads.map((u) => [u.name, u.platforms, u.href, typeof u.i])).toEqual([
      ['Game-mac.zip', ['macos'], null, 'number'],
      ['Game-pc.zip', ['linux', 'windows'], null, 'number'],
    ]);
  });
});

describe('generic extraction', () => {
  it('finds repeated game cards and the next page', () => {
    const cards = Array.from(
      { length: 6 },
      (_, i) => `<article class="tile"><a href="/game/${i}"><img src="/art/${i}.jpg" alt=""><h3 class="tile-title">Game ${i}</h3></a><span>Linux · Windows</span></article>`,
    ).join('');
    load(`<nav><a href="/about">About</a></nav><main>${cards}</main><a rel="next" href="/browse?p=2">Next</a>`, 'https://games.test/browse');
    const ex = extract();
    expect(ex.cards).toHaveLength(6);
    expect(ex.cards[0]).toMatchObject({ title: 'Game 0', href: 'https://games.test/game/0', img: 'https://games.test/art/0.jpg' });
    expect(ex.cardConfidence).toBeGreaterThanOrEqual(0.6);
    expect(ex.nextPage).toBe('https://games.test/browse?p=2');
  });

  it('reads JSON-LD game data and adult content ratings', () => {
    load(
      `<script type="application/ld+json">{"@type":"VideoGame","name":"Night Run","description":"Run","image":"https://g.test/c.jpg","operatingSystem":"Linux","contentRating":"Adults Only"}</script>`,
      'https://g.test/night-run',
    );
    const ex = extract();
    expect(ex.game?.title).toBe('Night Run');
    expect(ex.game?.platforms).toEqual(['linux']);
    expect(ex.adultSignals.some((s) => s.startsWith('ld-rating'))).toBe(true);
  });

  it('recognises a game download Article with external mirrors without inference', () => {
    load(`<script type="application/ld+json">{"@type":"Article","headline":"Orbit Free Download (v2)","description":"A space game","articleSection":["Adventure","Puzzle"],"keywords":"space, exploration"}</script>
      <h1>Orbit Free Download (v2)</h1><p>A space game for Windows.</p><a href="https://gofile.io/d/build">DOWNLOAD HERE</a>`, 'https://games.test/orbit');
    expect(extract().game).toMatchObject({ title: 'Orbit', categories: ['Adventure', 'Puzzle'], tags: ['space', 'exploration'], platforms: ['windows'] });
  });

  it('keeps articles without game downloads and reviews out of the fast game path', () => {
    for (const heading of ['Orbit Free Download', 'Orbit Review Free Download']) {
      load(`<script type="application/ld+json">{"@type":"Article","description":"A space game"}</script><h1>${heading}</h1><p>A space game</p><a href="/other-game-free-download">Other Game Free Download</a><a href="/wallpaper.zip">Download wallpaper</a>`, 'https://games.test/orbit');
      expect(extract().game).toBeNull();
    }
  });

  it('detects RTA labels' , () => {
    load(`<meta name="RATING" content="RTA-5042-1996-1400-1577-RTA"><p>hi</p>`, 'https://x.test/');
    expect(extract().adultSignals).toContain('rta-label');
  });

  it('detects login, CAPTCHA and payment gates', () => {
    load(`<form><input type="password"></form>`, 'https://x.test/login');
    expect(extract().gates.login).toBe(true);
    load(`<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>`, 'https://x.test/');
    expect(extract().gates.captcha).toBe(true);
    load(`<form action="/checkout"><input autocomplete="cc-number"></form>`, 'https://x.test/buy');
    expect(extract().gates.payment).toBe(true);
  });

  it('lists direct file links and tags controls for clicking', () => {
    load(`<a href="/dl/game-linux.tar.gz">Linux build</a><button>Download now</button>`, 'https://x.test/game');
    const ex = extract();
    expect(ex.fileLinks.map((l) => l.href)).toEqual(['https://x.test/dl/game-linux.tar.gz']);
    expect(ex.controls.find((c) => c.text === 'Download now')).toBeTruthy();
    expect(dom.window.document.querySelector('[data-cgl-i]')).not.toBeNull();
  });
});

describe('download candidate ranking', () => {
  const c = (url: string, platform: 'linux' | 'windows' | 'macos' | null) => ({ url, label: url, fileName: url, platform, sizeText: null });
  it('prefers a single Linux build', () => {
    expect(rankCandidates([c('a-win.zip', 'windows'), c('a-linux.tar.gz', 'linux'), c('a-mac.zip', 'macos')]).best?.url).toBe('a-linux.tar.gz');
  });
  it('asks when several builds for the preferred platform exist', () => {
    const r = rankCandidates([c('a-linux-x64.tar.gz', 'linux'), c('a-linux-arm.tar.gz', 'linux')]);
    expect(r.best).toBeNull();
    expect(r.ambiguous).toHaveLength(2);
  });
  it('falls back to Windows builds and ignores macOS', () => {
    expect(rankCandidates([c('a.exe', 'windows'), c('a.dmg', 'macos')]).best?.url).toBe('a.exe');
    expect(rankCandidates([c('a.dmg', 'macos')]).best).toBeNull();
  });
});

describe('current browser control identities', () => {
  it('keeps inputs distinct from controls beyond the returned control limit', () => {
    load('<main>'+Array.from({length:100},(_,i)=>`<a href="/file-${i}">Download ${i}</a>`).join('')+'<input placeholder="Search"><input type="submit" value="Download"></main>', 'https://host.test/');
    const ex=extract();
    const marked=[...dom.window.document.querySelectorAll('[data-cgl-i]')].map(el=>el.getAttribute('data-cgl-i'));
    expect(new Set(marked).size).toBe(marked.length);
    for(const c of ex.controls)expect(dom.window.document.querySelector(`[data-cgl-i="${c.i}"]`)?.textContent||dom.window.document.querySelector<HTMLInputElement>(`[data-cgl-i="${c.i}"]`)?.value).toBe(c.text);
  });
  it('clears an old identity when a previously visible control becomes hidden', () => {
    load('<main><button>Old</button><button>Current</button></main>', 'https://host.test/');
    extract();const old=dom.window.document.querySelector('button')!;old.style.display='none';
    const ex=extract();
    expect(old.hasAttribute('data-cgl-i')).toBe(false);
    expect(dom.window.document.querySelector(`[data-cgl-i="${ex.controls[0].i}"]`)?.textContent).toBe('Current');
  });
});

describe('listing titles without artwork', () => {
  it('keeps each game title instead of inheriting a Recently Added heading', () => {
    load('<main><h2>Recently Added</h2>'+['Alpha','Bravo','Charlie'].map(title=>`<article><a href="/game/${title}"><h3>${title}</h3></a></article>`).join('')+'</main>','https://games.test/');
    expect(extract().cards.map(c=>c.title)).toEqual(['Alpha','Bravo','Charlie']);
    load('<main><h2>Recently Added</h2>'+['Alpha','Bravo','Charlie'].map(title=>`<article><a href="/game/${title}">${title}</a></article>`).join('')+'</main>','https://games.test/');
    expect(extract().cards.map(c=>c.title)).toEqual(['Alpha','Bravo','Charlie']);
  });
});
