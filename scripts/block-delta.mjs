#!/usr/bin/env node
// Block index for small launcher updates (the idea of zsync/rsync). The release
// carries, next to each AppImage, a "<name>.blocks" file: the new file cut into
// fixed blocks, each with a cheap rolling checksum and an MD5. The installed
// launcher slides over its own AppImage, finds every block it already has (at
// any offset, since files move inside the image between versions), and
// downloads only the missing blocks with HTTP range requests. The rebuilt file
// is still checked against SHA256SUMS before it is used.
//
//   node scripts/block-delta.mjs index <file> [out]   writes <file>.blocks
//   node scripts/block-delta.mjs plan <old file> <new .blocks>   how much would be downloaded
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BLOCK_SIZE = 64 * 1024;
const MAGIC = 'CGLBLK01';
const CHUNK = 8 * 1024 * 1024;

/** rsync's weak checksum of buf[start, start+len). */
function weakOf(buf, start, len) {
  let a = 0, b = 0;
  for (let i = 0; i < len; i++) {
    a = (a + buf[start + i]) & 0xffff;
    b = (b + a) & 0xffff;
  }
  return { a, b };
}

const strongOf = (buf) => createHash('md5').update(buf).digest();

/** Reads [pos, pos+len) of an open file. */
function readAt(fd, pos, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

/** The block index of a file, as the bytes of a .blocks file. */
export function makeIndex(path, blockSize = BLOCK_SIZE) {
  const size = statSync(path).size;
  const count = Math.ceil(size / blockSize);
  const out = Buffer.alloc(8 + 4 + 8 + 4 + count * 4 + count * 16);
  out.write(MAGIC, 0, 'latin1');
  out.writeUInt32LE(blockSize, 8);
  out.writeDoubleLE(size, 12);
  out.writeUInt32LE(count, 20);
  const fd = openSync(path, 'r');
  try {
    for (let i = 0; i < count; i++) {
      const block = readAt(fd, i * blockSize, Math.min(blockSize, size - i * blockSize));
      const { a, b } = weakOf(block, 0, block.length);
      out.writeUInt32LE(((b << 16) | a) >>> 0, 24 + i * 4);
      strongOf(block).copy(out, 24 + count * 4 + i * 16);
    }
  } finally {
    closeSync(fd);
  }
  return out;
}

/** Parses a .blocks file; throws on anything malformed. */
export function parseIndex(buf) {
  if (buf.length < 24 || buf.toString('latin1', 0, 8) !== MAGIC) throw new Error('Not a block index');
  const blockSize = buf.readUInt32LE(8);
  const size = buf.readDoubleLE(12);
  const count = buf.readUInt32LE(20);
  if (blockSize < 1024 || blockSize > 16 * 1024 * 1024 || !Number.isSafeInteger(size) || count !== Math.ceil(size / blockSize) || buf.length !== 24 + count * 20) throw new Error('Malformed block index');
  const weak = new Uint32Array(count);
  for (let i = 0; i < count; i++) weak[i] = buf.readUInt32LE(24 + i * 4);
  const strong = buf.subarray(24 + count * 4);
  return { blockSize, size, count, weak, strong };
}

/**
 * Where each block of the new file can be found in `oldPath`: an offset, or
 * -1 when it has to be downloaded. Yields to the event loop between chunks so
 * a long scan does not freeze the caller.
 */
export async function findLocalBlocks(oldPath, index, onProgress = () => {}) {
  const { blockSize: L, count, weak, strong } = index;
  const found = new Float64Array(count).fill(-1);
  // Only whole blocks are matched; a short last block is always downloaded.
  const whole = index.size % L === 0 ? count : count - 1;
  const byWeak = new Map();
  const bits = new Uint8Array(1 << 21); // 2^24-bit prefilter on the weak checksum
  for (let i = 0; i < whole; i++) {
    const w = weak[i];
    const list = byWeak.get(w);
    if (list) list.push(i); else byWeak.set(w, [i]);
    const k = (w ^ (w >>> 8)) & 0xffffff;
    bits[k >>> 3] |= 1 << (k & 7);
  }
  let remaining = whole;
  const size = statSync(oldPath).size;
  if (size < L || !whole) return found;
  const fd = openSync(oldPath, 'r');
  try {
    // A window of the old file, refilled chunk by chunk; `base` is its file offset.
    let base = 0;
    let buf = readAt(fd, 0, Math.min(size, CHUNK + L));
    let pos = 0; // window start, relative to base
    let { a, b } = weakOf(buf, 0, L);
    for (;;) {
      if (pos + L > buf.length) {
        if (base + buf.length >= size) break;
        base += pos;
        buf = readAt(fd, base, Math.min(size - base, CHUNK + L));
        pos = 0;
        if (buf.length < L) break;
        onProgress(base / size);
        await new Promise((r) => setImmediate(r));
        ({ a, b } = weakOf(buf, 0, L));
      }
      const w = ((b << 16) | a) >>> 0;
      const k = (w ^ (w >>> 8)) & 0xffffff;
      let matched = false;
      if (bits[k >>> 3] & (1 << (k & 7))) {
        const list = byWeak.get(w);
        if (list) {
          let digest = null;
          for (const i of list) {
            if (found[i] >= 0) continue;
            digest ??= strongOf(buf.subarray(pos, pos + L));
            if (digest.equals(strong.subarray(i * 16, i * 16 + 16))) {
              found[i] = base + pos;
              remaining--;
              matched = true;
              // Identical blocks share the same old bytes.
              for (const j of list) if (found[j] < 0 && strong.subarray(j * 16, j * 16 + 16).equals(digest)) { found[j] = base + pos; remaining--; }
              break;
            }
          }
        }
      }
      if (!remaining) break;
      if (matched) {
        // Jump past the matched block and start a fresh window (a refill recomputes it).
        pos += L;
        if (pos + L <= buf.length) ({ a, b } = weakOf(buf, pos, L));
        continue;
      }
      if (pos + L >= buf.length) { pos++; continue; }
      const out = buf[pos], inn = buf[pos + L];
      a = (a - out + inn) & 0xffff;
      b = (b - L * out + a) & 0xffff;
      pos++;
    }
  } finally {
    closeSync(fd);
  }
  onProgress(1);
  return found;
}

/** Missing blocks merged into byte ranges [start, end), joining gaps of up to `gap` blocks. */
export function missingRanges(found, index, gap = 4) {
  const ranges = [];
  for (let i = 0; i < index.count; i++) {
    if (found[i] >= 0) continue;
    const start = i * index.blockSize;
    const end = Math.min(index.size, (i + 1) * index.blockSize);
    const last = ranges.at(-1);
    if (last && start - last[1] <= gap * index.blockSize) last[1] = end;
    else ranges.push([start, end]);
  }
  return ranges;
}

// Run as a command (the launcher bundles this module too, where import.meta.url is absent).
const self = typeof import.meta.url === 'string' ? fileURLToPath(import.meta.url) : null;
if (self && process.argv[1] && resolve(process.argv[1]) === self) void (async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === 'index') {
    writeFileSync(a2 ?? `${a1}.blocks`, makeIndex(a1));
  } else if (cmd === 'plan') {
    const index = parseIndex(readFileSync(a2));
    const t0 = Date.now();
    const found = await findLocalBlocks(a1, index);
    const ranges = missingRanges(found, index);
    const bytes = ranges.reduce((s, [x, y]) => s + y - x, 0);
    const have = found.filter((f) => f >= 0).length;
    console.log(`${have}/${index.count} blocks found locally in ${((Date.now() - t0) / 1000).toFixed(1)} s; download ${(bytes / 1e6).toFixed(1)} MB of ${(index.size / 1e6).toFixed(1)} MB in ${ranges.length} ranges`);
  } else {
    console.error('usage: block-delta.mjs index <file> [out] | plan <old> <new.blocks>');
    process.exit(2);
  }
})();
