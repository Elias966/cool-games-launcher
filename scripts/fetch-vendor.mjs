#!/usr/bin/env node
// Downloads and verifies the pinned third-party components listed in
// vendor-manifest.json into ./vendor. Re-running is cheap: verified files are
// skipped, interrupted downloads resume with HTTP Range requests.
//
//   node scripts/fetch-vendor.mjs            # everything
//   node scripts/fetch-vendor.mjs firefox    # selected component ids

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile, readFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'vendor');
const cacheDir = join(vendorDir, '.cache');
const manifest = JSON.parse(await readFile(join(root, 'scripts/vendor-manifest.json'), 'utf8'));

const wanted = new Set(process.argv.slice(2));
// Build tools are fetched like components but never bundled into the app.
const components = [...manifest.components, ...(manifest.buildTools ?? [])].filter((c) => wanted.size === 0 || wanted.has(c.id));

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function download(url, target) {
  const part = `${target}.part`;
  let offset = existsSync(part) ? (await stat(part)).size : 0;
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (res.status === 416) {
    // Already complete.
    await rename(part, target);
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (offset > 0 && res.status !== 206) offset = 0; // server ignored Range
  const total = Number(res.headers.get('content-length') ?? 0) + offset;
  let done = offset;
  let lastLog = 0;
  const progress = new TransformStream({
    transform(chunk, controller) {
      done += chunk.byteLength;
      const now = Date.now();
      if (now - lastLog > 2000) {
        lastLog = now;
        const pct = total ? ((done / total) * 100).toFixed(1) : '?';
        process.stdout.write(`  ${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB (${pct}%)\n`);
      }
      controller.enqueue(chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body.pipeThrough(progress)),
    createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }),
  );
  await rename(part, target);
}

const state = existsSync(join(vendorDir, 'state.json'))
  ? JSON.parse(await readFile(join(vendorDir, 'state.json'), 'utf8'))
  : {};

await mkdir(cacheDir, { recursive: true });
for (const c of components) {
  const fileName = `${c.id}-${c.sha256.slice(0, 12)}${c.url.match(/\.(tar\.(gz|xz)|tar|xpi|gguf|onnx|zip|deb)$/)?.[0] ?? ''}`;
  const cached = join(cacheDir, fileName);
  const dest = join(vendorDir, c.dest);

  if (state[c.id] === c.sha256 && existsSync(dest)) {
    console.log(`✓ ${c.name} ${c.version} (installed)`);
    continue;
  }
  if (!existsSync(cached) || (await sha256(cached)) !== c.sha256) {
    console.log(`↓ ${c.name} ${c.version}`);
    await download(c.url, cached);
    const actual = await sha256(cached);
    if (actual !== c.sha256) {
      await rm(cached, { force: true });
      throw new Error(`Checksum mismatch for ${c.id}: expected ${c.sha256}, got ${actual}`);
    }
  }

  await rm(dest, { recursive: true, force: true });
  if (c.extract === 'tar') {
    await mkdir(dest, { recursive: true });
    const args = ['-xf', cached, '-C', dest, '--no-same-owner'];
    if (c.stripComponents) args.push(`--strip-components=${c.stripComponents}`);
    const r = spawnSync('tar', args, { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`tar failed for ${c.id}`);
  } else if (c.extract === 'deb') {
    await mkdir(dest, { recursive: true });
    const r = spawnSync('dpkg-deb', ['-x', cached, dest], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`dpkg-deb failed for ${c.id}`);
  } else {
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(createReadStream(cached), createWriteStream(dest));
  }
  state[c.id] = c.sha256;
  await writeFile(join(vendorDir, 'state.json'), JSON.stringify(state, null, 2));
  console.log(`✓ ${c.name} ${c.version}`);
}

// Post-install layout fixes.
const umuInner = join(vendorDir, 'umu');
if (existsSync(join(umuInner, 'umu', 'umu-run'))) {
  // The zipapp tarball contains a top-level umu/ directory.
  await rename(join(umuInner, 'umu', 'umu-run'), join(umuInner, 'umu-run')).catch(() => {});
}
for (const exe of ['geckodriver/geckodriver', 'umu/umu-run', 'tools/runtime-x86_64', '7zip/7zzs', 'stores/legendary', 'stores/gogdl']) {
  const p = join(vendorDir, exe);
  if (existsSync(p)) await chmod(p, 0o755);
}

// Firefox enterprise policies: allow the bundled extensions and disable
// updates, telemetry and first-run pages. XPIs are copied per profile at runtime.
if (existsSync(join(vendorDir, 'firefox'))) {
  await mkdir(join(vendorDir, 'firefox/distribution'), { recursive: true });
  const { firefoxPolicies } = await import('./firefox-policies.mjs');
  await writeFile(
    join(vendorDir, 'firefox/distribution/policies.json'),
    JSON.stringify(firefoxPolicies(), null, 2),
  );
}
console.log('Vendor components ready in', vendorDir);
await import('./stage-firefox-bridge.mjs');
