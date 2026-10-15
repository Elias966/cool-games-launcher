import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseReleases, ProtonReleases, RELEASE_REFRESH_MS } from '../src/main/proton-releases';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
function cache() { const d = mkdtempSync(join(tmpdir(), 'cgl-proton-')); dirs.push(d); return join(d, 'cache.json'); }
function release(repo = 'GloriousEggroll/proton-ge-custom', name = 'GE-Proton11-7-x86_64.tar.gz') {
  return { tag_name: 'v1', name: 'Proton v1', assets: [{ name, size: 100, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: `https://github.com/${repo}/releases/download/v1/${name}` }] };
}

describe('published Proton builds', () => {
  it('lists official release information without inventing binary downloads', () => {
    expect(parseReleases('valve', [{ tag_name: 'proton-11.0', assets: [] }])[0]).toMatchObject({ provider: 'valve', url: null, sha256: null });
    expect(parseReleases('valve', [{ tag_name: 'proton-11.0', assets: [] }])[0].unavailableReason).toContain('Steam');
  });
  it('only picks the baseline x86_64 CachyOS build', () => {
    const r = release('CachyOS/proton-cachyos', 'proton-cachyos-slr-x86_64.tar.xz');
    r.assets.unshift(...['aarch64', 'x86_64_v3', 'x86_64_v4'].map((arch) => ({ ...r.assets[0], name: `proton-cachyos-slr-${arch}.tar.xz`, browser_download_url: `https://github.com/CachyOS/proton-cachyos/releases/download/v1/${arch}.tar.xz` })));
    expect(parseReleases('cachyos', [r])[0].url).toContain('slr-x86_64.tar.xz');
  });
  it('rejects unverified and foreign-repository assets', () => {
    const r = release();
    r.assets[0].digest = '';
    expect(parseReleases('ge', [r])[0]).toMatchObject({ sha256: null, unavailableReason: expect.stringContaining('SHA-256') });
    r.assets[0].browser_download_url = 'https://attacker.test/evil.tar.gz';
    expect(parseReleases('ge', [r])[0].url).toBeNull();
  });
  it('excludes drafts and source or ARM archives', () => {
    expect(parseReleases('ge', [{ ...release(), draft: true }])).toEqual([]);
    expect(parseReleases('ge', [release(undefined, 'GE-Proton-aarch64.tar.gz')])[0].url).toBeNull();
    expect(parseReleases('ge', [release(undefined, 'source.tar.gz')])[0].url).toBeNull();
  });
});

describe('release refresh and offline cache', () => {
  it('refreshes every 15 minutes, deduplicates concurrent calls, and revalidates with ETags', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    const request = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify([release()]), { headers: { etag: '"release-v1"' } }));
    const releases = new ProtonReleases(cache(), request as never);
    await Promise.all([releases.refresh(), releases.refresh()]);
    expect(request).toHaveBeenCalledTimes(3);
    await releases.refresh();
    expect(request).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(RELEASE_REFRESH_MS);
    request.mockImplementation(async () => new Response(null, { status: 304 }));
    await releases.refresh();
    expect(request).toHaveBeenCalledTimes(6);
    expect((request.mock.calls[3][1]!.headers as Record<string, string>)['If-None-Match']).toBe('"release-v1"');
    expect(releases.find('ge:v1')?.url).toContain('GE-Proton');
  });
  it('keeps verified cached entries when offline and throttles manual refresh', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    const path = cache();
    const first = new ProtonReleases(path, vi.fn(async () => new Response(JSON.stringify([release()]))) as never);
    await first.refresh();
    const request = vi.fn(async () => { throw new Error('offline'); });
    const again = new ProtonReleases(path, request as never);
    vi.advanceTimersByTime(RELEASE_REFRESH_MS);
    const snapshot = await again.refresh();
    expect(snapshot.releases.some((r) => r.id === 'ge:v1')).toBe(true);
    expect(snapshot.providers[1].error).toContain('offline');
    await again.refresh(true);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('recovers from a malformed cache file', async () => {
    const path = cache(); writeFileSync(path, 'null');
    const releases = new ProtonReleases(path, vi.fn(async () => new Response('[]')) as never);
    await expect(releases.refresh()).resolves.toMatchObject({ releases: [] });
  });
});
