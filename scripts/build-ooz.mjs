#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Offline, pinned build. The complete upstream sources and local modifications
// ship with the helper so the AppImage contains its corresponding source.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'vendor/ooz');
const manifest = JSON.parse(readFileSync(join(source, 'upstream.json'), 'utf8'));
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The Oodle metadata helper requires Linux x86_64');
for (const [name, digest] of Object.entries(manifest.sha256)) {
  const actual = createHash('sha256').update(readFileSync(join(source, name))).digest('hex');
  if (actual !== digest) throw new Error(`Pinned ooz source checksum mismatch: ${name}`);
}
const scratch = mkdtempSync(join(tmpdir(), 'cgl-ooz-build-'));
try {
  const upstream = readFileSync(join(source, 'kraken.cpp'), 'utf8');
  const boundary = '\n// The decompressor will write outside of the target buffer.';
  const cutoff = upstream.indexOf(boundary);
  if (cutoff < 0 || upstream.indexOf(boundary, cutoff + 1) >= 0) throw new Error('Unknown upstream CLI boundary');
  // Discard upstream's Windows command-line interface, DLL loader and file I/O.
  const decoder = join(scratch, 'decoder.cpp');
  writeFileSync(decoder, upstream.slice(0, cutoff) + '\n');
  const binary = join(scratch, 'cgl-ooz');
  const compiler = process.env.CGL_OOZ_CXX || 'g++';
  const result = spawnSync(compiler, [
    '-std=c++17', '-O2', '-DNDEBUG', '-msse4.1', '-fno-strict-aliasing',
    '-ffreestanding', '-fno-exceptions', '-fno-rtti', '-fno-stack-protector', '-U_FORTIFY_SOURCE',
    '-fno-pie', '-no-pie', '-nostdlib', '-nodefaultlibs', '-static',
    '-Wl,--build-id=none', '-Wl,-z,noexecstack', '-s', '-I', source,
    decoder, join(source, 'bitknit.cpp'), join(source, 'lzna.cpp'),
    join(source, 'main.cpp'), join(source, 'runtime.cpp'), '-o', binary,
  ], { stdio: 'inherit', timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ooz compiler exited ${result.status}`);
  // Write then atomically rename on the same filesystem as the destination.
  const staged = join(source, `cgl-ooz.${process.pid}.tmp`);
  writeFileSync(staged, readFileSync(binary), { mode: 0o755 });
  chmodSync(staged, 0o755);
  renameSync(staged, join(source, 'cgl-ooz'));
  console.log(`Built isolated ooz metadata helper (${manifest.commit.slice(0, 12)})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
