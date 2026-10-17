import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync, gzipSync } from 'node:zlib';
import { readUnrealVersion } from '../src/workers/unreal-version';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const align16 = (n: number) => Math.ceil(n / 16) * 16;
const sha = (data: Buffer) => createHash('sha1').update(data).digest();
const u32 = (n: number) => { const data = Buffer.alloc(4); data.writeUInt32LE(n >>> 0); return data; };
const u64 = (n: number) => { const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(n)); return data; };
const string = (value: string) => Buffer.concat([u32(Buffer.byteLength(value) + 1), Buffer.from(`${value}\0`)]);
function padded(data: Buffer): Buffer { const result = Buffer.alloc(align16(data.length)); data.copy(result); return result; }
function encrypted(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-ecb', key, null); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded(data)), cipher.final()]);
}

function exe(keys: Buffer[], options: { writableOnly?: boolean; displacement32?: boolean; boundary?: boolean } = {}): Buffer {
  const offset = options.boundary ? 0x400 + 1024 * 1024 - 24 : 0x440;
  const data = Buffer.alloc(offset + keys.length * 160 + 0x100);
  data.writeUInt16LE(0x5a4d); data.writeUInt32LE(0x80, 60);
  data.writeUInt32LE(0x4550, 0x80); data.writeUInt16LE(0x8664, 0x84); data.writeUInt16LE(1, 0x86); data.writeUInt16LE(240, 0x94);
  data.writeUInt16LE(0x20b, 0x98);
  const section = 0x98 + 240;
  data.writeUInt32LE(data.length - 0x400, section + 16); data.writeUInt32LE(0x400, section + 20);
  data.writeUInt32LE(options.writableOnly ? 0x80000000 : 0x20000000, section + 36);
  keys.forEach((key, k) => {
    let at = offset + k * 160;
    for (let n = 0; n < 8; n++) {
      data[at++] = 0xc7; data[at++] = options.displacement32 ? 0x85 : 0x45;
      if (options.displacement32) { data.writeInt32LE(-48 + 4 * n, at); at += 4; }
      else data.writeInt8(-48 + 4 * n, at++);
      key.copy(data, at, n * 4, n * 4 + 4); at += 4;
      data[at++] = 0x90; data[at++] = 0x90; // Legal intervening instructions.
    }
  });
  return data;
}

interface Config { path?: string; text: string; compression?: 'zlib' | 'gzip' | 'oodle'; validOodle?: boolean; headerSizeLie?: number }
function fixture(options: { encrypted?: boolean; key?: Buffer; configs?: Config[]; indexCount?: number; directoryCount?: number; encodedOffset?: number } = {}) {
  const key = options.key ?? randomBytes(32), encrypt = options.encrypted ?? true;
  const configs = options.configs ?? [{ path: 'Adventure/Config/BuildSettings.ini', text: '[Build]\nBuildVersion=1234\nPrimarySteamworksBranch=release\nClId=7777\nClType=public\nClSubmissionTime=1765468972\n' }];
  const chunks: Buffer[] = [], entries: Buffer[] = [], paths: Array<{ path: string; encodedOffset: number }> = [];
  let offset = 0, encodedOffset = 0;
  configs.forEach(config => {
    const raw = Buffer.from(config.text), method = config.compression ? 1 : 0;
    const compressed = config.compression === 'zlib' ? deflateSync(raw) : config.compression === 'gzip' ? gzipSync(raw)
      : config.compression === 'oodle' ? config.validOodle ? Buffer.concat([Buffer.from([0xcc, 6]), raw]) : Buffer.from('not a valid oodle stream') : raw;
    const stored = encrypt ? encrypted(compressed, key) : compressed;
    const compressedSize = encrypt && method ? stored.length : compressed.length;
    const size = config.headerSizeLie ?? raw.length, blocks = method ? 1 : 0, headerSize = method ? 73 : 53;
    const header = Buffer.concat([u64(0), u64(compressedSize), u64(size), u32(method), sha(stored.subarray(0, compressedSize)),
      ...(method ? [u32(1), u64(headerSize), u64(headerSize + compressed.length)] : []),
      Buffer.from([Number(encrypt)]), u32(method ? raw.length : 0)]);
    chunks.push(header, stored);
    const bits = (0xe0000000 | (method << 23) | (Number(encrypt) << 22) | (blocks << 6)) >>> 0;
    const entry = Buffer.concat([u32(bits), u32(offset), u32(size), ...(method ? [u32(compressedSize), ...(encrypt ? [u32(compressed.length)] : [])] : [])]);
    paths.push({ path: config.path ?? 'Adventure/Config/DefaultGame.ini', encodedOffset });
    entries.push(entry); encodedOffset += entry.length; offset += header.length + stored.length;
  });
  const folders = new Map<string, Array<{ name: string; at: number }>>();
  for (const entry of paths) {
    const slash = entry.path.lastIndexOf('/'), folder = entry.path.slice(0, slash + 1), values = folders.get(folder) ?? [];
    values.push({ name: entry.path.slice(slash + 1), at: entry.encodedOffset }); folders.set(folder, values);
  }
  const directoryPlain = Buffer.concat([u32(options.directoryCount ?? folders.size), ...[...folders].flatMap(([folder, files]) => [string(folder), u32(files.length), ...files.flatMap(file => [string(file.name), u32(options.encodedOffset ?? file.at)])])]);
  const directoryPadded = encrypt ? padded(directoryPlain) : directoryPlain;
  const directoryStored = encrypt ? encrypted(directoryPadded, key) : directoryPadded;
  const directoryOffset = offset; chunks.push(directoryStored); offset += directoryStored.length;
  const encoded = Buffer.concat(entries);
  const indexPlain = Buffer.concat([string('../../../'), u32(options.indexCount ?? configs.length), u64(0), u32(0), u32(1), u64(directoryOffset), u64(directoryStored.length), sha(directoryPadded), u32(encoded.length), encoded, u32(0)]);
  const indexPadded = encrypt ? padded(indexPlain) : indexPlain;
  const indexStored = encrypt ? encrypted(indexPadded, key) : indexPadded;
  const indexOffset = offset; chunks.push(indexStored); offset += indexStored.length;
  const methods = Buffer.alloc(160), method = configs.find(c => c.compression)?.compression;
  if (method) methods.write(method === 'zlib' ? 'Zlib' : method === 'gzip' ? 'Gzip' : 'Oodle');
  const footer = Buffer.concat([Buffer.alloc(16), Buffer.from([Number(encrypt)]), u32(0x5a6f12e1), u32(11), u64(indexOffset), u64(indexStored.length), sha(indexPadded), methods]);
  chunks.push(footer);
  return { key, data: Buffer.concat(chunks), directoryOffset, indexOffset, footerOffset: offset };
}

function installed(options: Parameters<typeof fixture>[0] = {}, executableOptions: Parameters<typeof exe>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cgl-unreal-version-')); temporary.push(root);
  const pak = fixture(options), executable = join(root, 'Adventure-Win64-Shipping.exe'), pakFile = join(root, 'pakchunk0-Windows.pak');
  writeFileSync(executable, exe([randomBytes(32), pak.key], executableOptions));
  writeFileSync(pakFile, pak.data);
  return { ...pak, executable, pakFile, read: () => readUnrealVersion({ executable, pakFiles: [pakFile] }) };
}

describe('verified installed Unreal version evidence', () => {
  beforeAll(() => {
    if (process.platform !== 'linux' || process.arch !== 'x64' || existsSync('vendor/ooz/cgl-ooz')) return;
    const result = spawnSync(process.execPath, ['scripts/build-ooz.mjs'], { encoding: 'utf8', timeout: 120_000 });
    if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Oodle helper build failed');
  }, 120_000);

  it('derives a local key, verifies every used container layer, and extracts only the developer build', async () => {
    const game = installed();
    const result = await game.read();
    expect(result.limitations).toEqual([]);
    expect(result.evidence).toEqual([{ version: '1234', namespace: 'developer-build', verified: true, source: `${game.pakFile}::Adventure/Config/BuildSettings.ini`, attributes: { branch: 'release', changelist: '7777', type: 'public' } }]);
    expect(JSON.stringify(result)).not.toContain(game.key.toString('hex'));
  });

  it('reads unencrypted paks without requiring a usable executable', async () => {
    const game = installed({ encrypted: false });
    rmSync(game.executable);
    expect((await game.read()).evidence[0].version).toBe('1234');
  });

  it.each([true, false])('reads verified Zlib tiny config (encrypted=%s)', async encrypted => {
    const game = installed({ encrypted, configs: [{ text: '[Project]\nProjectVersion=V0.1.4.0.999\n', compression: 'zlib' }] });
    const result = await game.read();
    expect(result.limitations).toEqual([]);
    expect(result.evidence[0]).toMatchObject({ version: '0.1.4.0.999', namespace: 'semantic', verified: true });
  });

  it('reads a verified Gzip config', async () => {
    const game = installed({ configs: [{ text: 'GameVersion=2.3.4\n', compression: 'gzip' }] });
    expect((await game.read()).evidence[0].version).toBe('2.3.4');
  });

  it.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('decodes a verified, independently constructed Oodle config through the isolated helper', async () => {
    const game = installed({ configs: [{ text: 'ProjectVersion=V2.3.4.567\n', compression: 'oodle', validOodle: true }] });
    const result = await game.read();
    expect(result.limitations).toEqual([]);
    expect(result.evidence[0]).toMatchObject({ version: '2.3.4.567', namespace: 'semantic', verified: true });
  });

  it('keeps build and semantic versions in separate namespaces', async () => {
    const game = installed({ configs: [{ text: 'ProjectVersion=2.3.4\nBuildVersion=99\n' }] });
    expect((await game.read()).evidence.map(e => [e.namespace, e.version])).toEqual([['semantic', '2.3.4'], ['developer-build', '99']]);
  });

  it('does not turn timestamps, changelists, or archive dates into a build', async () => {
    const game = installed({ configs: [{ text: 'ClId=7777\nClSubmissionTime=1765468972\nBuildDate=2026-10-17\nProjectVersion=1.0.0.0\n' }] });
    expect((await game.read()).evidence).toEqual([]);
  });

  it('ignores engine, plugin, unrelated asset, and traversal paths', async () => {
    const game = installed({ configs: ['Engine/Config/DefaultGame.ini', 'Plugins/Thing/Config/DefaultGame.ini', 'Adventure/Plugins/Thing/Config/DefaultGame.ini', '../Adventure/Config/DefaultGame.ini', 'Adventure/Content/Config/DefaultGame.ini', 'Adventure/Config/Asset.uasset'].map(path => ({ path, text: 'ProjectVersion=9.9.9\n' })) });
    expect((await game.read()).evidence).toEqual([]);
  });

  it('accepts bounded x64 immediate stores using a 32-bit displacement', async () => {
    expect((await installed({}, { displacement32: true }).read()).evidence[0].version).toBe('1234');
  });

  it('finds a complete candidate spanning a scan-chunk boundary', async () => {
    expect((await installed({}, { boundary: true }).read()).evidence[0].version).toBe('1234');
  });

  it('does not search writable data sections for keys', async () => {
    const result = await installed({}, { writableOnly: true }).read();
    expect(result.evidence).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/No local executable key verified/);
  });

  it('rejects wrong keys rather than treating plausible garbage as metadata', async () => {
    const game = installed(); writeFileSync(game.executable, exe([randomBytes(32)]));
    const result = await game.read();
    expect(result.evidence).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/No local executable key verified/);
  });

  it('requires the full primary index hash even when mount decryption succeeds', async () => {
    const game = installed(); game.data[game.footerOffset + 41] ^= 1; writeFileSync(game.pakFile, game.data);
    expect((await game.read()).evidence).toEqual([]);
  });

  it('rejects corrupt directory data after valid primary index/key verification', async () => {
    const game = installed(); game.data[game.directoryOffset + 17] ^= 1; writeFileSync(game.pakFile, game.data);
    const result = await game.read();
    expect(result.evidence).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/directory index hash mismatch/);
  });

  it('requires the stored config member hash', async () => {
    const game = installed(); game.data[53] ^= 1; writeFileSync(game.pakFile, game.data);
    const result = await game.read();
    expect(result.evidence).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/member hash mismatch/);
  });

  it('rejects a member header that disagrees with verified encoded metadata', async () => {
    const game = installed(); game.data.writeUInt32LE(9000, 16); writeFileSync(game.pakFile, game.data);
    expect((await game.read()).limitations.join(' ')).toMatch(/header contradicts verified index/);
  });

  it('rejects compressed configs whose claimed output hides a decompression bomb', async () => {
    const game = installed({ configs: [{ text: 'ProjectVersion=2.3.4\n' + 'a'.repeat(10000), compression: 'zlib', headerSizeLie: 1 }] });
    const result = await game.read();
    expect(result.evidence).toEqual([]);
    expect(result.limitations.length).toBeGreaterThan(0);
  });

  it('reports unsupported or invalid Oodle without manufacturing a version', async () => {
    const game = installed({ configs: [{ text: 'ProjectVersion=2.3.4\n', compression: 'oodle' }] });
    const result = await game.read();
    expect(result.evidence).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/oodle|Oodle/);
  });

  it('bounds malformed directory and primary member counts', async () => {
    expect((await installed({ indexCount: 0xffffffff }).read()).evidence).toEqual([]);
    expect((await installed({ directoryCount: 0xffffffff }).read()).limitations.join(' ')).toMatch(/Directory count/);
  });

  it('rejects out-of-bounds encoded entry references', async () => {
    const result = await installed({ encodedOffset: 0x7fffffff }).read();
    expect(result.evidence).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/Truncated pak metadata/);
  });

  it('rejects footer offsets beyond safe integer or file bounds', async () => {
    const game = installed(); game.data.writeBigUInt64LE(0xffffffffffffffffn, game.footerOffset + 25); writeFileSync(game.pakFile, game.data);
    expect((await game.read()).limitations.join(' ')).toMatch(/safe bounds/);
  });

  it('rejects an oversized index before allocating/reading it', async () => {
    const game = installed(); game.data.writeBigUInt64LE(1_000_000_000n, game.footerOffset + 33); writeFileSync(game.pakFile, game.data);
    expect((await game.read()).limitations.join(' ')).toMatch(/index bounds/);
  });

  it('bounds tiny selected config size', async () => {
    const result = await installed({ configs: [{ text: 'ProjectVersion=2.3.4\n', headerSizeLie: 300000 }] }).read();
    expect(result.evidence).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/bounds/);
  });

  it('returns limitations for missing/truncated paks without throwing', async () => {
    const game = installed(); writeFileSync(game.pakFile, readFileSync(game.pakFile).subarray(0, 20));
    expect((await game.read()).evidence).toEqual([]);
    expect((await readUnrealVersion({ executable: game.executable, pakFiles: [join(tmpdir(), 'missing-version-test.pak')] })).limitations.length).toBe(1);
  });

  it('does not alter an executable or archive during inspection', async () => {
    const game = installed(), beforeExe = readFileSync(game.executable), beforePak = readFileSync(game.pakFile);
    await game.read();
    expect(readFileSync(game.executable)).toEqual(beforeExe);
    expect(readFileSync(game.pakFile)).toEqual(beforePak);
  });
});
