import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MangoHud } from '../src/main/mangohud';
import { applyExtras } from '../src/workers/launch-wrap';

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'cgl-mh-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A release laid out like MangoHud's: a tarball holding MangoHud-package.tar with /usr inside. */
function release(version: string) {
  const src = temp();
  const pkg = join(src, 'pkg');
  for (const lib of ['lib64', 'lib32']) { mkdirSync(join(pkg, 'usr/lib/mangohud', lib), { recursive: true }); writeFileSync(join(pkg, 'usr/lib/mangohud', lib, 'libMangoHud.so'), `${lib} ${version}`); }
  mkdirSync(join(pkg, 'usr/share/vulkan/implicit_layer.d'), { recursive: true });
  for (const [json, lib] of [['MangoHud.x86_64.json', 'lib64'], ['MangoHud.x86.json', 'lib32']]) {
    writeFileSync(join(pkg, 'usr/share/vulkan/implicit_layer.d', json), JSON.stringify({ file_format_version: '1.0.0', layer: { name: `VK_LAYER_MANGOHUD_overlay_${lib}`, library_path: `/usr/lib/mangohud/${lib}/libMangoHud.so`, enable_environment: { MANGOHUD: '1' } } }));
  }
  mkdirSync(join(src, 'MangoHud'));
  execFileSync('tar', ['-cf', join(src, 'MangoHud', 'MangoHud-package.tar'), '-C', pkg, '.']);
  const name = `MangoHud-${version}.r0.g992103e.tar.gz`;
  execFileSync('tar', ['-czf', join(src, name), '-C', src, 'MangoHud']);
  const body = readFileSync(join(src, name));
  return { name, body, sha: createHash('sha256').update(body).digest('hex') };
}

function manager(r: ReturnType<typeof release>, version: string) {
  const data = temp(), home = temp();
  const extract = async (a: string, d: string) => { mkdirSync(d, { recursive: true }); execFileSync('tar', ['-xf', a, '-C', d]); };
  const fetch = async (url: string) => url.includes('/releases/latest')
    ? Response.json({ tag_name: `v${version}`, assets: [{ name: r.name, browser_download_url: `https://example.invalid/${r.name}`, digest: `sha256:${r.sha}` }] })
    : new Response(r.body);
  return { mh: new MangoHud({ dataDir: data, dataHome: home, fetch, extract }), home, data };
}

describe('MangoHud for this user', () => {
  it('installs the release and points Vulkan at the launcher\'s copy', async () => {
    const { mh, home, data } = manager(release('0.8.4'), '0.8.4');
    const st = await mh.ensure();
    expect(st).toMatchObject({ version: '0.8.4', ours: true });
    const m = JSON.parse(readFileSync(join(home, 'vulkan/implicit_layer.d/MangoHud.x86_64.json'), 'utf8'));
    expect(m.layer.library_path).toBe(join(data, 'mangohud', '0.8.4', 'lib64', 'libMangoHud.so'));
    expect(readFileSync(m.layer.library_path, 'utf8')).toBe('lib64 0.8.4');
    expect(m.layer.enable_environment).toEqual({ MANGOHUD: '1' });
    mh.remove();
    expect(existsSync(join(home, 'vulkan/implicit_layer.d/MangoHud.x86_64.json'))).toBe(false);
    expect(mh.state().ours).toBe(false);
  });

  it('leaves a MangoHud the person installed in ~/.local alone', async () => {
    const { mh, home } = manager(release('0.8.4'), '0.8.4');
    mkdirSync(join(home, 'vulkan/implicit_layer.d'), { recursive: true });
    writeFileSync(join(home, 'vulkan/implicit_layer.d/MangoHud.x86_64.json'), '{"layer":{"library_path":"/home/me/mangohud/libMangoHud.so"}}');
    expect(await mh.ensure()).toMatchObject({ ours: false });
    expect(readFileSync(join(home, 'vulkan/implicit_layer.d/MangoHud.x86_64.json'), 'utf8')).toContain('/home/me/');
  });

  it('starts a stalled download again', async () => {
    const r = release('0.8.4');
    const data = temp(), home = temp();
    let calls = 0;
    const fetch = async (url: string, init?: { signal?: AbortSignal }) => {
      if (url.includes('/releases/latest')) return Response.json({ tag_name: 'v0.8.4', assets: [{ name: r.name, browser_download_url: `https://example.invalid/${r.name}`, digest: `sha256:${r.sha}` }] });
      if (++calls > 1) return new Response(r.body);
      // The first attempt sends a little, then nothing.
      const body = new ReadableStream({ start(c) { c.enqueue(r.body.subarray(0, 100)); init?.signal?.addEventListener('abort', () => c.error(new Error('aborted'))); } });
      return new Response(body);
    };
    const mh = new MangoHud({ dataDir: data, dataHome: home, fetch, stallMs: 200, extract: async (a, d) => { mkdirSync(d, { recursive: true }); execFileSync('tar', ['-xf', a, '-C', d]); } });
    expect(await mh.ensure()).toMatchObject({ version: '0.8.4', ours: true });
    expect(calls).toBe(2);
  });

  it('refuses a download that does not match its checksum', async () => {
    const r = release('0.8.4');
    const { mh, home } = manager({ ...r, sha: 'a'.repeat(64) }, '0.8.4');
    await expect(mh.ensure()).rejects.toThrow(/SHA-256/);
    expect(existsSync(join(home, 'vulkan/implicit_layer.d/MangoHud.x86_64.json'))).toBe(false);
  });
});

describe('MangoHud in the launch command', () => {
  const base = { cmd: 'umu-run', args: ['game.exe'], env: {} };
  const o = { gamescope: false, resolution: null, upscale: 'off' as const, fpsLimit: null, mangohud: true, gamemode: false, nvapi: false, wined3d: false, env: '' };
  it('uses the launcher\'s layer for Proton games, without the old wrapper', () => {
    const r = applyExtras(base, { ...o, tools: { gamescope: null, mangohud: '/usr/bin/mangohud', gamemode: null, mangohudLayer: true } }, true);
    expect(r.cmd).toBe('umu-run');
    expect(r.env.MANGOHUD).toBe('1');
  });
  it('keeps the system wrapper otherwise', () => {
    const r = applyExtras(base, { ...o, tools: { gamescope: null, mangohud: '/usr/bin/mangohud', gamemode: null, mangohudLayer: false } }, true);
    expect(r.cmd).toBe('/usr/bin/mangohud');
  });
});
