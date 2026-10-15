import { describe, expect, it } from 'vitest';
import { canonicalUrl, fileNameFromUrl, hostOf, looksLikeFileUrl, titleKey } from '@shared/urls';

describe('canonicalUrl', () => {
  it('normalises host, trailing slashes, fragments and tracking parameters', () => {
    expect(canonicalUrl('https://WWW.Example.com/games/Foo/?utm_source=x&b=2&a=1#top')).toBe('https://example.com/games/Foo?a=1&b=2');
  });

  it('resolves relative links against the page', () => {
    expect(canonicalUrl('../game/42', 'https://site.test/list/page/2')).toBe('https://site.test/list/game/42');
  });

  it('rejects non-http schemes', () => {
    expect(canonicalUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('duplicate detection keys', () => {
  it('ignores version suffixes and punctuation', () => {
    expect(titleKey('SITE BURIAL (v1.8)')).toBe(titleKey('Site Burial'));
    expect(titleKey('Café — Story v2.1.0')).toBe('cafe story');
  });
});

describe('file URLs', () => {
  it('recognises downloadable files', () => {
    expect(looksLikeFileUrl('https://cdn.test/files/game-linux.tar.gz?token=1')).toBe(true);
    expect(looksLikeFileUrl('https://cdn.test/Game.AppImage')).toBe(true);
    expect(looksLikeFileUrl('https://site.test/game/download')).toBe(false);
    expect(fileNameFromUrl('https://cdn.test/a/My%20Game.zip')).toBe('My Game.zip');
    expect(hostOf('https://www.itch.io/x')).toBe('itch.io');
  });
});
