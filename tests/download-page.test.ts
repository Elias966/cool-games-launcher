import { describe, expect, it } from 'vitest';
import { isGameBookmark, isSiteBrowseUrl,withoutChallengeTokens } from '../src/shared/download-page';
const game='https://games.test/games/orbit';
describe('indexed game-page navigation',()=>{
 it.each(['/','/search','/?s=Orbit','/games?q=Orbit','/category/puzzle','/games/another','/blog/news','/page/2'])('does not treat %s as the saved game page',path=>{
  const url='https://games.test'+path;expect(isSiteBrowseUrl(url,game)).toBe(true);expect(isGameBookmark(url,game)).toBe(false);
 });
 it.each([game+'/',game+'#downloads',game+'/downloads',game+'?language=en'])('retains game URL variants and download subpages: %s',url=>{
  expect(isSiteBrowseUrl(url,game)).toBe(false);expect(isGameBookmark(url,game)).toBe(true);
 });
 it('does not use a file host as the game-page return bookmark',()=>expect(isGameBookmark('https://host.test/file/token',game)).toBe(false));
});

it('ignores changing Cloudflare challenge tokens while retaining real file IDs',async()=>{
 const {downloadPageKey}=await import('../src/shared/download-page');
 expect(downloadPageKey('https://host.test/file?id=123&__cf_chl_rt_tk=old')).toBe(downloadPageKey('https://host.test/file?id=123&__cf_chl_rt_tk=new'));
 expect(downloadPageKey('https://host.test/file?id=124')).not.toBe(downloadPageKey('https://host.test/file?id=123'));
 expect(withoutChallengeTokens('https://www.host.test/file?id=123&token=keep&__cf_chl_rt_tk=expired#downloads')).toBe('https://www.host.test/file?id=123&token=keep#downloads');
});
