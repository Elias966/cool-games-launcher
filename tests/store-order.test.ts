import {afterEach,describe,expect,it} from 'vitest';
import {JSDOM} from 'jsdom';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseSiteDate} from '@shared/site-date';
import {extractPage,type PageExtract} from '@shared/page-extract';
import {recipeCards,catalogLinks} from '@shared/site-recipe';
import {openDb} from '../src/main/db';
import {CatalogRepo,SourcesRepo} from '../src/main/repos';
const cleanup:Array<()=>void>=[];afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
const observed='2026-10-17T12:00:00.000Z';
function page(html:string){const dom=new JSDOM(html,{url:'https://games.test/',runScripts:'outside-only'});cleanup.push(()=>dom.window.close());return dom.window.eval(`(${extractPage.toString()})({})`) as PageExtract;}
describe('website dates',()=>{
 it.each([['2h','2026-10-17T10:00:00.000Z'],['2 hours','2026-10-17T10:00:00.000Z'],['2 hours ago','2026-10-17T10:00:00.000Z'],['an hour ago','2026-10-17T11:00:00.000Z'],['3 days ago','2026-10-14T12:00:00.000Z'],['yesterday','2026-10-16T12:00:00.000Z'],['just now',observed],['Posted on October 16, 2026','2026-10-16T00:00:00.000Z'],['17.10.2026','2026-10-17T00:00:00.000Z'],['2026-10-17T13:00:00+03:00','2026-10-17T10:00:00.000Z']])('normalizes %s',(raw,iso)=>expect(parseSiteDate(raw,observed)?.iso).toBe(iso));
 it.each(['Version 1.2.3','Updated 2 hours ago','Release date: October 17, 2026','2026-02-30','2027-01-01','04/05/2026','broken date','16 hours played'])('does not invent a posting time for %s',raw=>expect(parseSiteDate(raw,observed)).toBeNull());
 it('prioritizes game pages from the Recently Added section, independent of a larger popular grid',()=>{
  const ex=page(`<main><section><h2>Recently Added</h2><ul><li><a href="/games/alpha">Alpha</a><span>2 hours ago</span></li><li><a href="/games/bravo">Bravo</a><time datetime="2026-10-16T12:00:00Z">Yesterday</time></li><li><a href="/games/charlie">Charlie</a></li></ul></section><section><h2>Popular</h2>${Array.from({length:8},(_,i)=>`<article><a href="/games/pop${i}"><img src="/p.png"><h3>Popular ${i}</h3></a></article>`).join('')}</section></main>`);
  expect(ex.recentGameLinks).toEqual(['https://games.test/games/alpha','https://games.test/games/bravo','https://games.test/games/charlie']);
 });
 it('prefers the article publication date and excludes modified and sidebar dates',()=>{
  const ex=page('<main><article><h1>Orbit</h1><time class="updated" datetime="2026-10-17">Updated today</time><time class="published" datetime="2026-10-10">October 10</time><aside><time datetime="2026-10-16">Related</time></aside></article></main>');
  expect(ex.published).toBe('2026-10-10');expect(ex.observedAt).toBeTruthy();
 });
 it('uses posting metadata rather than a relative time in the game story',()=>{
  expect(page('<article><h1>Orbit</h1><p>The story began 2 years ago on another planet.</p></article>').published).toBeNull();
  expect(page('<article><h1>Orbit</h1><div class="post-meta"><span>Author</span><span>2 hours ago</span></div></article>').published).toBe('2 hours ago');
 });
 it('reads explicitly labelled publication dates without time markup',()=>expect(page('<article><h1>Orbit</h1><p>Added: October 16, 2026</p></article>').published).toBe('October 16, 2026'));
});
function repo(){const dir=mkdtempSync(join(tmpdir(),'cgl-store-order-'));const db=openDb(join(dir,'db'));cleanup.push(()=>{db.close();rmSync(dir,{recursive:true,force:true})});const catalog=new CatalogRepo(db),sources=new SourcesRepo(db),source=sources.add('https://games.test/');const add=(title:string,published?:string)=>{const id=catalog.upsertListing(source.id,{pageUrl:`https://games.test/${title}`,title,titleKey:title,published,observedAt:observed}).id;catalog.markListed([id]);catalog.setRating(id,'safe',0,[],'test');return id};const policy={showNsfw:true,hideWomenCovers:false,revision:1} as any;return{db,catalog,source,add,policy};}
describe('Store order',()=>{
 it('sorts by website added time regardless of indexing order or a missing cover',()=>{
  const {db,catalog,add,policy}=repo();const newest=add('Alpha','1 hour ago'),old=add('Charlie','2026-01-01'),middle=add('Bravo','2 days ago'),unknown=add('Unknown');
  catalog.setArtwork(old,'old.png');db.prepare("UPDATE catalog SET discovered_at='2026-10-17T12:01:00Z' WHERE id=?").run(unknown);
  expect(catalog.query(policy,{sort:'new'}).entries.map(e=>e.id)).toEqual([newest,middle,old,unknown]);
 });
 it('refreshes dates on already verified entries without changing saved game links or treating Steam releases as site additions',()=>{
  const {catalog,source,add,policy}=repo();const id=add('Alpha');catalog.setDetail(id,{candidates:[{url:'https://games.test/file.zip',label:'Download',fileName:'file.zip',platform:null,sizeText:null}]});
  catalog.upsertListing(source.id,{pageUrl:'https://games.test/Alpha',title:'Alpha',titleKey:'Alpha',published:'2 hours ago',observedAt:observed});
  const before=catalog.get(id,policy)!.siteAddedAt;catalog.setSteamInfo(id,{recommendations:100,metacritic:null,released:'2026-10-17'});
  expect(before).toBe('2026-10-17T10:00:00.000Z');expect(catalog.get(id,policy)!.siteAddedAt).toBe(before);expect(catalog.raw(id)!.pageUrl).toBe('https://games.test/Alpha');
  catalog.upsertListing(source.id,{pageUrl:'https://games.test/Alpha',title:'Alpha',titleKey:'Alpha',published:'2 hours ago',observedAt:'2026-10-17T12:30:00Z'});
  expect(catalog.get(id,policy)!.siteAddedAt).toBe(before);
 });
 it('reverses the whole alphabetic catalog with consistent pagination',()=>{
  const {catalog,add,policy}=repo();add('Bravo');add('alpha');add('Charlie');add('ALPHA');
  const ascending=catalog.query(policy,{sort:'title'}).entries.map(e=>e.id),descending=catalog.query(policy,{sort:'title-desc'}).entries.map(e=>e.id);
  expect(descending).toEqual(ascending.reverse());
  expect(catalog.query(policy,{sort:'title-desc',offset:1,limit:2}).entries.map(e=>e.id)).toEqual(descending.slice(1,3));
 });
 it('repairs only existing undated listings and avoids repeatedly reading sites with no publication date',()=>{
  const {catalog,add}=repo(); const dated=add('Dated','2 hours ago'),unknown=add('Unknown');
  for(const id of [dated,unknown])catalog.setDetail(id,{candidates:[{url:'https://games.test/file.zip',label:'Download',fileName:'file.zip',platform:null,sizeText:null}]});
  expect(catalog.datesNeedingCheck([dated,unknown])).toEqual([unknown]);
  catalog.recordSiteDate(unknown,null,observed);expect(catalog.datesNeedingCheck([unknown])).toEqual([]);
 });
 it('does not turn invalid detail dates into today',()=>{const{catalog,add,policy}=repo();const id=add('Alpha');catalog.setDetail(id,{published:'not a date',candidates:[{url:'https://games.test/f.zip',label:'Download',fileName:'f.zip',platform:null,sizeText:null}]});expect(catalog.get(id,policy)!.siteAddedAt).toBeNull()});
});
