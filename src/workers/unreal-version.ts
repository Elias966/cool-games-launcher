// Inspect tiny game version/config members of modern Unreal paks without
// executing the game, unpacking its assets, or shipping game-specific keys.
// Pak v10/v11 field layout: FPakInfo/FPakEntry, independently cross-checked
// against https://github.com/trumank/repak (footer.rs and entry.rs).
import { createDecipheriv, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';

export interface UnrealVersionEvidence {
  version: string;
  namespace: 'semantic' | 'developer-build';
  source: string;
  /** Container/index/member consistency, not publisher authenticity. */
  verified: true;
  attributes?: { branch?: string; changelist?: string; type?: string };
}

export interface UnrealVersionResult {
  evidence: UnrealVersionEvidence[];
  limitations: string[];
}

const MAX_EXE_READ = 256 * 1024 * 1024;
const MAX_PAK_READ = 32 * 1024 * 1024;
const MAX_INDEX = 8 * 1024 * 1024;
const MAX_CONFIG = 256 * 1024;
const MAX_CANDIDATES = 4096;
const align16 = (value: number) => Math.ceil(value / 16) * 16;
const sha1 = (data: Buffer) => createHash('sha1').update(data).digest();

class Cursor {
  constructor(readonly data: Buffer, public offset = 0) {}
  bytes(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.data.length) throw new Error('Truncated pak metadata');
    const result = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  u32(): number { return this.bytes(4).readUInt32LE(); }
  i32(): number { return this.bytes(4).readInt32LE(); }
  u64(): number {
    const value = this.bytes(8).readBigUInt64LE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Pak offset exceeds safe bounds');
    return Number(value);
  }
  string(): string {
    const length = this.i32();
    if (!length) return '';
    if (Math.abs(length) > 2048) throw new Error('Oversized pak string');
    const value = this.bytes(Math.abs(length) * (length < 0 ? 2 : 1));
    if (length < 0 ? value.readUInt16LE(value.length - 2) !== 0 : value[value.length - 1] !== 0) throw new Error('Unterminated pak string');
    return value.toString(length < 0 ? 'utf16le' : 'utf8').replace(/\0$/, '');
  }
  bool(): boolean {
    const value = this.u32();
    if (value > 1) throw new Error('Invalid pak flag');
    return !!value;
  }
}

interface Budget { remaining: number }
class BoundedFile {
  private constructor(readonly handle: FileHandle, readonly size: number, readonly budget: Budget) {}
  static async open(path: string, budget: Budget): Promise<BoundedFile> {
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error('Not a bounded regular file');
      return new BoundedFile(handle, stat.size, budget);
    } catch (error) { await handle.close(); throw error; }
  }
  async read(offset: number, size: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > this.size || size > this.budget.remaining) throw new Error('Pak read outside budget/bounds');
    this.budget.remaining -= size;
    const data = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const result = await this.handle.read(data, got, size - got, offset + got);
      if (!result.bytesRead) throw new Error('Truncated file');
      got += result.bytesRead;
    }
    return data;
  }
  close(): Promise<void> { return this.handle.close(); }
}

function decrypt(data: Buffer, key: Buffer): Buffer {
  if (data.length % 16) throw new Error('Unaligned encrypted pak data');
  const cipher = createDecipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

interface Store { base: number; displacement: number; value: Buffer; end: number }
// x64 `mov dword ptr [register + displacement], immediate32`. Eight nearby
// stores to consecutive addresses are a candidate, never proof of a key.
function immediateStore(data: Buffer, at: number): Store | null {
  if (data[at] !== 0xc7 || at + 8 > data.length) return null;
  const modrm = data[at + 1], mode = modrm >>> 6;
  if (((modrm >>> 3) & 7) !== 0 || (mode !== 1 && mode !== 2)) return null;
  let next = at + 2;
  const rm = modrm & 7;
  let base = rm;
  if (rm === 4) {
    const sib = data[next++];
    if (sib !== 0x24) return null; // [rsp+disp], no indexed addressing.
    base = 8;
  }
  const displacementSize = mode === 1 ? 1 : 4;
  if (next + displacementSize + 4 > data.length) return null;
  const displacement = mode === 1 ? data.readInt8(next) : data.readInt32LE(next);
  next += displacementSize;
  return { base, displacement, value: data.subarray(next, next + 4), end: next + 4 };
}

async function localKeyCandidates(executable: string, limitations: Set<string>): Promise<Buffer[]> {
  const file = await BoundedFile.open(executable, { remaining: MAX_EXE_READ });
  const keys: Buffer[] = [], seen = new Set<string>();
  try {
    const dos = await file.read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) return [];
    const peOffset = dos.readUInt32LE(60), header = await file.read(peOffset, 24);
    if (header.readUInt32LE(0) !== 0x4550 || header.readUInt16LE(4) !== 0x8664) return [];
    const sections = header.readUInt16LE(6), optionalSize = header.readUInt16LE(20);
    if (!sections || sections > 96 || optionalSize < 112 || optionalSize > 4096) return [];
    if ((await file.read(peOffset + 24, 2)).readUInt16LE() !== 0x20b) return [];
    const table = await file.read(peOffset + 24 + optionalSize, sections * 40);
    for (let section = 0; section < sections; section++) {
      const row = section * 40, flags = table.readUInt32LE(row + 36);
      if (!(flags & 0x20000000)) continue; // Only executable sections.
      const offset = table.readUInt32LE(row + 20), size = table.readUInt32LE(row + 16);
      if (offset + size > file.size) throw new Error('Executable section exceeds file');
      for (let scan = 0; scan < size; scan += 1024 * 1024) {
        const data = await file.read(offset + scan, Math.min(1024 * 1024 + 192, size - scan));
        for (let at = data.indexOf(0xc7); at !== -1 && at < 1024 * 1024; at = data.indexOf(0xc7, at + 1)) {
          const first = immediateStore(data, at);
          if (!first) continue;
          const words = [first.value];
          let end = first.end;
          for (let n = 1; n < 8; n++) {
            let next: Store | null = null;
            for (let p = data.indexOf(0xc7, end); p !== -1 && p <= end + 16; p = data.indexOf(0xc7, p + 1)) {
              const instruction = immediateStore(data, p);
              if (instruction?.base === first.base && instruction.displacement === first.displacement + n * 4) { next = instruction; break; }
            }
            if (!next) break;
            words.push(next.value);
            end = next.end;
          }
          if (words.length !== 8) continue;
          const key = Buffer.concat(words), identity = key.toString('hex');
          if (seen.has(identity)) { key.fill(0); continue; }
          seen.add(identity);
          keys.push(key);
          if (keys.length >= MAX_CANDIDATES) {
            limitations.add('Executable key-candidate limit reached');
            return keys;
          }
        }
      }
    }
  } catch {
    limitations.add('Executable could not be fully inspected within read bounds');
  } finally { await file.close(); }
  return keys;
}

interface Footer { encrypted: boolean; offset: number; size: number; hash: Buffer; methods: string[]; end: number }
async function footer(file: BoundedFile): Promise<Footer> {
  const end = file.size - 221, data = await file.read(end, 221);
  if (data.readUInt32LE(17) !== 0x5a6f12e1 || ![10, 11].includes(data.readUInt32LE(21)) || data[16] > 1) throw new Error('Unsupported pak footer/version');
  const reader = new Cursor(data, 25), offset = reader.u64(), size = reader.u64(), hash = reader.bytes(20);
  if (!size || size > MAX_INDEX || offset + size > end || (data[16] && size % 16)) throw new Error('Invalid pak index bounds');
  const methods = Array.from({ length: 5 }, () => reader.bytes(32).toString('ascii').split('\0')[0].toLowerCase());
  return { encrypted: !!data[16], offset, size, hash, methods, end };
}

function plausibleMount(data: Buffer): boolean {
  try {
    const mount = new Cursor(data).string();
    return mount.length > 0 && mount.length < 64 && /\/$/.test(mount) && !/[\x00-\x1f]/.test(mount);
  } catch { return false; }
}

interface IndexReference { offset: number; size: number; hash: Buffer }
interface Entry { offset: number; size: number; compressed: number; method: number; encrypted: boolean; blocks: number; blockSize: number; blockSizes: number[] }

function parseEncoded(data: Buffer, at: number): Entry {
  const reader = new Cursor(data, at), bits = reader.u32();
  const method = (bits >>> 23) & 63, encrypted = !!(bits & (1 << 22)), blocks = (bits >>> 6) & 65535;
  let blockSize = bits & 63;
  blockSize = blockSize === 63 ? reader.u32() : blockSize * 2048;
  const variable = (bit: number) => bits & (1 << bit) ? reader.u32() : reader.u64();
  const offset = variable(31), size = variable(30), compressed = method ? variable(29) : size;
  if (blocks > 64 || (!method && blocks)) throw new Error('Invalid small-config block count');
  const blockSizes = method && (blocks > 1 || encrypted) ? Array.from({ length: blocks }, () => reader.u32()) : method ? [compressed] : [];
  return { offset, size, compressed, method, encrypted, blocks, blockSize, blockSizes };
}

function namedGameConfig(path: string): boolean {
  if (path.length > 2048 || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.') || /^(?:Engine|Plugins)\//i.test(path) || /\/Plugins\//i.test(path)) return false;
  return /^[^/]+\/Config\/(?:BuildSettings|DefaultGame|Version|BuildVersion)\.ini$/i.test(path)
    || /^[^/]+\/(?:Build\.version|version\.(?:txt|json))$/i.test(path);
}

async function member(file: BoundedFile, info: Footer, entry: Entry, key: Buffer | null, outputBudget: Budget): Promise<Buffer> {
  if (!entry.size || entry.size > MAX_CONFIG || entry.size > outputBudget.remaining || !entry.compressed || entry.compressed > MAX_CONFIG || entry.offset + 53 > info.offset || (entry.encrypted && !key)) throw new Error('Config member exceeds bounds or lacks a verified key');
  outputBudget.remaining -= entry.size;
  const headerSize = 53 + (entry.method ? 4 + entry.blocks * 16 : 0);
  const header = new Cursor(await file.read(entry.offset, headerSize));
  if (header.u64() !== 0 || header.u64() !== entry.compressed || header.u64() !== entry.size || header.u32() !== entry.method) throw new Error('Config header contradicts verified index');
  const hash = header.bytes(20);
  const ranges: Array<{ start: number; end: number }> = [];
  if (entry.method) {
    if (header.u32() !== entry.blocks || !entry.blocks) throw new Error('Config block count mismatch');
    for (let i = 0; i < entry.blocks; i++) ranges.push({ start: header.u64(), end: header.u64() });
  }
  const flags = header.bytes(1)[0], blockSize = header.u32();
  const expectedBlockSize = entry.blocks === 1 && entry.blockSize === 0 ? entry.size : entry.blockSize;
  if (flags !== Number(entry.encrypted) || blockSize !== expectedBlockSize) throw new Error('Config flags contradict verified index');
  let storageSize = entry.encrypted ? align16(entry.compressed) : entry.compressed;
  if (entry.method) {
    let next = headerSize, sum = 0;
    ranges.forEach((range, i) => {
      const size = range.end - range.start;
      if (range.start !== next || size <= 0 || size !== entry.blockSizes[i]) throw new Error('Config block bounds contradict index');
      sum += size;
      next = range.start + (entry.encrypted ? align16(size) : size);
    });
    storageSize = next - headerSize;
    if ((entry.encrypted ? storageSize : sum) !== entry.compressed) throw new Error('Config compressed sizes disagree');
  }
  if (storageSize > MAX_CONFIG + 1024 || entry.offset + headerSize + storageSize > info.offset) throw new Error('Config data outside member bounds');
  const stored = await file.read(entry.offset + headerSize, storageSize);
  // FPakEntry hashes stored bytes before decryption (excluding final AES pad).
  if (!sha1(stored.subarray(0, entry.compressed)).equals(hash)) throw new Error('Config member hash mismatch');
  if (!entry.method) return entry.encrypted ? decrypt(stored, key!).subarray(0, entry.size) : stored;
  const method = info.methods[entry.method - 1];
  if (method !== 'zlib' && method !== 'gzip' && method !== 'oodle') throw new Error(`Unsupported config compression: ${method || 'unknown'}`);
  const output: Buffer[] = [];
  let outputSize = 0;
  for (const range of ranges) {
    const start = range.start - headerSize, size = range.end - range.start;
    const block = entry.encrypted ? decrypt(stored.subarray(start, start + align16(size)), key!).subarray(0, size) : stored.subarray(start, start + size);
    const remaining = entry.size - outputSize;
    if (remaining <= 0) throw new Error('Config exceeds decompression bounds');
    const expected = entry.blocks === 1 ? remaining : Math.min(entry.blockSize, remaining);
    const data = method === 'oodle' ? await decompressOodle(block, expected)
      : method === 'zlib' ? inflateSync(block, { maxOutputLength: remaining }) : gunzipSync(block, { maxOutputLength: remaining });
    outputSize += data.length;
    output.push(data);
  }
  if (outputSize !== entry.size) throw new Error('Config decompressed size mismatch');
  return Buffer.concat(output, outputSize);
}

async function decompressOodle(data: Buffer, expected: number): Promise<Buffer> {
  if (!Number.isInteger(expected) || expected < 1 || expected > MAX_CONFIG || data.length > MAX_CONFIG) throw new Error('Oodle config exceeds decompression bounds');
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const binary = [resources && join(resources, 'vendor/ooz/cgl-ooz'), resolve(__dirname, '../../vendor/ooz/cgl-ooz')].find((candidate): candidate is string => !!candidate && existsSync(candidate));
  if (!binary) throw new Error('Unsupported config compression: oodle decoder unavailable');
  return new Promise((resolveOutput, reject) => {
    const child = execFile(binary, [String(expected)], { encoding: 'buffer', timeout: 2000, maxBuffer: MAX_CONFIG, killSignal: 'SIGKILL', windowsHide: true }, (error, stdout) => {
      if (error || stdout.length !== expected) reject(new Error('Oodle config decompression failed within bounds'));
      else resolveOutput(stdout);
    });
    child.stdin?.on('error', () => { /* Exit is handled by execFile's callback. */ });
    child.stdin?.end(data);
  });
}

function versionEvidence(data: Buffer, source: string): UnrealVersionEvidence[] {
  const text = data[0] === 0xff && data[1] === 0xfe ? data.subarray(2).toString('utf16le') : data.toString('utf8').replace(/^\uFEFF/, '');
  const lines = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(ProjectVersion|GameVersion|BuildVersion|PrimarySteamworksBranch|ClId|ClType)\s*=\s*([^;\r\n]+)\s*$/i.exec(line);
    if (match) lines.set(match[1].toLowerCase(), match[2].trim().replace(/^"(.*)"$/, '$1'));
  }
  const result: UnrealVersionEvidence[] = [];
  const semantic = lines.get('projectversion') ?? lines.get('gameversion');
  if (semantic && /^v?\d+(?:\.\d+){1,5}[a-z]?$/i.test(semantic) && !/^v?(?:0(?:\.0)+|1\.0\.0(?:\.0)?)$/i.test(semantic)) result.push({ version: semantic.replace(/^v/i, '').toLowerCase(), namespace: 'semantic', source, verified: true });
  const build = lines.get('buildversion');
  if (build && /^\d{1,15}$/.test(build) && BigInt(build) > 0n) {
    const attributes = { branch: lines.get('primarysteamworksbranch'), changelist: lines.get('clid'), type: lines.get('cltype') };
    result.push({ version: build, namespace: 'developer-build', source, verified: true, attributes });
  }
  return result;
}

/** Only supplied installed files are read. A local EXE-derived candidate is
 * accepted exclusively when the complete decrypted primary index SHA1 matches
 * its actual footer. Directory and tiny config hashes are checked separately. */
export async function readUnrealVersion(input: { executable: string; pakFiles: string[] }): Promise<UnrealVersionResult> {
  const evidence: UnrealVersionEvidence[] = [], limitations = new Set<string>(), budget = { remaining: MAX_PAK_READ };
  const outputBudget = { remaining: 2 * 1024 * 1024 };
  let keys: Buffer[] | null = null;
  try {
    if (input.pakFiles.length > 16) limitations.add('Pak file limit reached');
    for (const path of [...new Set(input.pakFiles)].slice(0, 16)) {
      let file: BoundedFile | undefined;
      try {
        file = await BoundedFile.open(path, budget);
        const info = await footer(file), storedIndex = await file.read(info.offset, info.size);
        let index = storedIndex, key: Buffer | null = null;
        if (info.encrypted) {
          keys ??= await localKeyCandidates(input.executable, limitations);
          for (const candidate of keys) {
            if (!plausibleMount(decrypt(storedIndex.subarray(0, Math.min(64, storedIndex.length)), candidate))) continue;
            const decrypted = decrypt(storedIndex, candidate);
            if (!sha1(decrypted).equals(info.hash)) continue;
            index = decrypted;
            key = candidate;
            break;
          }
          if (!key) throw new Error('No local executable key verified against pak index');
        } else if (!sha1(index).equals(info.hash)) throw new Error('Pak primary index hash mismatch');
        const reader = new Cursor(index);
        reader.string();
        if (reader.u32() > 500_000) throw new Error('Too many pak members');
        reader.u64(); // Path hash seed, not a version or timestamp.
        const reference = (): IndexReference | null => {
          if (!reader.bool()) return null;
          const ref = { offset: reader.u64(), size: reader.u64(), hash: reader.bytes(20) };
          if (!ref.size || ref.size > MAX_INDEX || ref.offset + ref.size > info.end || (info.encrypted && ref.size % 16)) throw new Error('Invalid directory/index reference');
          return ref;
        };
        reference(); // Path-hash index is not used; no file paths read from it.
        const directory = reference();
        const encodedSize = reader.u32();
        if (encodedSize > MAX_INDEX) throw new Error('Encoded entry budget exceeded');
        const encoded = reader.bytes(encodedSize);
        if (reader.u32()) limitations.add('Non-encoded pak entries are not inspected');
        if (!directory) throw new Error('Pak has no inspectable full directory index');
        let directoryData = await file.read(directory.offset, directory.size);
        if (info.encrypted) directoryData = decrypt(directoryData, key!);
        if (!sha1(directoryData).equals(directory.hash)) throw new Error('Pak directory index hash mismatch');
        const directories = new Cursor(directoryData), count = directories.u32();
        if (count > 100_000) throw new Error('Directory count exceeded');
        let members = 0, selected = 0;
        for (let d = 0; d < count; d++) {
          const folder = directories.string(), files = directories.u32();
          members += files;
          if (members > 500_000) throw new Error('Directory member count exceeded');
          for (let n = 0; n < files; n++) {
            const name = folder + directories.string(), offset = directories.i32();
            if (!namedGameConfig(name) || offset < 0) continue;
            if (++selected > 16) throw new Error('Config selection limit reached');
            try {
              const data = await member(file, info, parseEncoded(encoded, offset), key, outputBudget);
              evidence.push(...versionEvidence(data, `${path}::${name}`));
            } catch (error) {
              limitations.add(`${basename(path)}::${name}: ${error instanceof Error ? error.message : 'Config could not be inspected'}`);
            }
          }
        }
      } catch (error) {
        limitations.add(`${basename(path)}: ${error instanceof Error ? error.message : 'Pak could not be inspected'}`);
      } finally { await file?.close(); }
    }
  } finally { for (const key of keys ?? []) key.fill(0); }
  return { evidence, limitations: [...limitations] };
}
