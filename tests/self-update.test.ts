import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SelfUpdater, compareVersions, expectedSum, looksLikeAppImage, readRelease } from '../src/main/self-update';
import type { LauncherUpdate } from '../src/shared/types';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

function dir() {
  const d = mkdtempSync(join(tmpdir(), 'cgl-selfupdate-'));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A minimal file that passes the AppImage check: ELF magic plus the type-2 marker. */
function fakeAppImage(tag: string): Buffer {
  const head = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02, 0, 0, 0, 0, 0]);
  return Buffer.concat([head, Buffer.from(`appimage ${tag} `.repeat(4000))]);
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const NAME = 'Cool-Games-Launcher-0.2.7-x86_64.AppImage';

function github(release: object, files: Record<string, Buffer | string>) {
  const requested: string[] = [];
  const fetch = async (url: string) => {
    requested.push(url);
    if (url.includes('/releases/latest')) return new Response(JSON.stringify(release), { status: 200 });
    const name = url.split('/').pop()!;
    const body = files[name];
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } });
  };
  return { fetch, requested };
}

const release = (version = 'v0.2.7') => ({
  tag_name: version,
  html_url: `https://github.com/Elias966/cool-games-launcher/releases/tag/${version}`,
  body: 'Arabic interface, self-updates.',
  assets: [
    { name: NAME, browser_download_url: `https://github.com/Elias966/cool-games-launcher/releases/download/${version}/${NAME}`, size: 1 },
    { name: 'SHA256SUMS', browser_download_url: `https://github.com/Elias966/cool-games-launcher/releases/download/${version}/SHA256SUMS`, size: 1 },
  ],
});

function updater(appImage: string | null, fetch: (url: string) => Promise<Response>) {
  const states: LauncherUpdate[] = [];
  const announced: string[] = [];
  const restarts: string[] = [];
  const u = new SelfUpdater({ version: '0.2.6', appImage, fetch, publish: (s) => states.push(s), announce: (v) => announced.push(v), restart: (p) => restarts.push(p) });
  return { u, states, announced, restarts };
}

describe('launcher self-update', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.2.7', '0.2.7')).toBe(0);
    expect(compareVersions('0.2.6', '0.3.0')).toBeLessThan(0);
  });

  it('reads the AppImage and checksums of a release, and ignores other hosts and pre-releases', () => {
    const r = readRelease(release());
    expect(r?.version).toBe('0.2.7');
    expect(r?.asset.name).toBe(NAME);
    expect(readRelease({ ...release(), prerelease: true })).toBeNull();
    expect(readRelease({ ...release(), assets: [{ name: NAME, browser_download_url: `https://evil.example/${NAME}` }] })).toBeNull();
    expect(expectedSum(`${'a'.repeat(64)}  other.AppImage\n${'b'.repeat(64)}  ${NAME}\n`, NAME)).toBe('b'.repeat(64));
  });

  it('downloads, verifies and swaps in a new version, then restarts into it', async () => {
    const d = dir();
    const current = join(d, 'Cool-Games-Launcher.AppImage');
    writeFileSync(current, fakeAppImage('old'), { mode: 0o755 });
    const next = fakeAppImage('new');
    const gh = github(release(), { [NAME]: next, SHA256SUMS: `${sha(next)}  ${NAME}\n` });
    const { u, announced, restarts } = updater(current, gh.fetch);

    const checked = await u.check();
    expect(checked.state).toBe('available');
    expect(checked.latest).toBe('0.2.7');
    expect(checked.canInstall).toBe(true);
    expect(announced).toEqual(['0.2.7']);
    await u.check();
    expect(announced).toEqual(['0.2.7']);

    const done = await u.download();
    expect(done.state).toBe('ready');
    expect(readFileSync(current).equals(fakeAppImage('old'))).toBe(true); // nothing replaced before restart

    u.install();
    expect(readFileSync(current).equals(next)).toBe(true);
    expect(statSync(current).mode & 0o111).toBeTruthy();
    expect(restarts).toEqual([current]);
    expect(existsSync(join(d, '.Cool-Games-Launcher.AppImage.update'))).toBe(false);
  });

  it('refuses a download that does not match its checksum and leaves the launcher untouched', async () => {
    const d = dir();
    const current = join(d, 'cgl.AppImage');
    writeFileSync(current, fakeAppImage('old'), { mode: 0o755 });
    const gh = github(release(), { [NAME]: fakeAppImage('tampered'), SHA256SUMS: `${sha(fakeAppImage('new'))}  ${NAME}\n` });
    const { u, restarts } = updater(current, gh.fetch);
    await u.check();
    const r = await u.download();
    expect(r.state).toBe('error');
    expect(r.error).toMatch(/checksum/);
    expect(() => u.install()).toThrow();
    expect(readFileSync(current).equals(fakeAppImage('old'))).toBe(true);
    expect(restarts).toEqual([]);
    expect(existsSync(join(d, '.cgl.AppImage.update'))).toBe(false);
  });

  it('says it is up to date when the release is not newer', async () => {
    const gh = github(release('v0.2.6'), {});
    const { u, announced } = updater(null, gh.fetch);
    const r = await u.check();
    expect(r.state).toBe('up-to-date');
    expect(r.canInstall).toBe(false);
    expect(announced).toEqual([]);
  });

  it('cannot replace itself when not running from an AppImage', async () => {
    const next = fakeAppImage('new');
    const gh = github(release(), { [NAME]: next, SHA256SUMS: `${sha(next)}  ${NAME}\n` });
    const { u } = updater(null, gh.fetch);
    await u.check();
    const r = await u.download();
    expect(r.state).toBe('error');
    expect(gh.requested.some((x) => x.endsWith(NAME))).toBe(false);
  });

  it('installs a chosen AppImage file, and rejects anything else', () => {
    const d = dir();
    const current = join(d, 'cgl.AppImage');
    writeFileSync(current, fakeAppImage('old'), { mode: 0o755 });
    const chosen = join(d, 'downloaded.AppImage');
    writeFileSync(chosen, fakeAppImage('manual'));
    const text = join(d, 'notes.txt');
    writeFileSync(text, 'not an appimage');
    const { u, restarts } = updater(current, async () => new Response('', { status: 500 }));
    expect(looksLikeAppImage(text)).toBe(false);
    expect(() => u.installFile(text)).toThrow(/not an AppImage/);
    u.installFile(chosen);
    expect(readFileSync(current).equals(fakeAppImage('manual'))).toBe(true);
    expect(restarts).toEqual([current]);
  });
});
