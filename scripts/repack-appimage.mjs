#!/usr/bin/env node
// Replace only the ELF launcher, streaming the multi-GB squashfs unchanged.
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, open, rename, chmod, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function squashfsOffset(header) {
  if (header.length < 64 || header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1) throw new Error('Expected a little-endian ELF64 AppImage');
  const count = header.readUInt16LE(0x3c);
  const size = header.readUInt16LE(0x3a);
  const end = header.readBigUInt64LE(0x28) + BigInt(size) * BigInt(count);
  if (!count || size < 64 || end < 64n || end > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid ELF section table');
  return Number(end);
}

export async function repack(file, runtimeFile, expectedHash) {
  const runtime = await readFile(runtimeFile);
  if (createHash('sha256').update(runtime).digest('hex') !== expectedHash) throw new Error('Static AppImage runtime checksum mismatch');
  if (runtime.includes(Buffer.from('libfuse.so.2'))) throw new Error('Replacement runtime still requires FUSE 2');
  const input = await open(file, 'r');
  let offset;
  try {
    const header = Buffer.alloc(64);
    await input.read(header, 0, 64, 0);
    offset = squashfsOffset(header);
    const magic = Buffer.alloc(4);
    await input.read(magic, 0, 4, offset);
    if (magic.toString() !== 'hsqs') throw new Error('Squashfs magic not found at the ELF boundary');
  } finally { await input.close(); }
  const temp = `${file}.repack-${process.pid}`;
  try {
    const out = createWriteStream(temp, { flags: 'wx', mode: 0o755 });
    async function* contents() { yield runtime; yield* createReadStream(file, { start: offset }); }
    await pipeline(contents(), out);
    await chmod(temp, 0o755);
    await rename(temp, file);
  } catch (e) { await rm(temp, { force: true }); throw e; }
  console.log(`Repacked ${file}: static runtime, original squashfs preserved`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'scripts/vendor-manifest.json'), 'utf8'));
  const pin = manifest.buildTools.find((c) => c.id === 'appimage-runtime');
  await repack(process.argv[2] ?? join(root, 'release', `Cool-Games-Launcher-${pkg.version}-x86_64.AppImage`), join(root, 'vendor', pin.dest), pin.sha256);
}
