// Read VERSIONINFO without loading or running the executable. Limit both file
// reads and resource traversal: an imported EXE is untrusted input.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';

export interface PeVersionResource {
  language: number | null;
  fixedFileVersion: string | null;
  fixedProductVersion: string | null;
  /** String tables can contain several translations in one resource. */
  stringTables: Array<{ translation: string; values: Record<string, string> }>;
}

export interface PeVersionMetadata {
  resources: PeVersionResource[];
  gameVersion: string | null;
  rejectionReason: string | null;
}

const MAX_READ = 2 * 1024 * 1024;
const MAX_VERSION_RESOURCE = 1024 * 1024;
const align4 = (n: number) => Math.ceil(n / 4) * 4;

interface Block { key: string; type: number; value: number; valueBytes: number; children: number; end: number }

function blockAt(data: Buffer, start: number, limit: number): Block {
  if (start + 6 > limit) throw new Error('Truncated version block');
  const end = start + data.readUInt16LE(start);
  if (end <= start + 6 || end > limit) throw new Error('Invalid version block length');
  const valueLength = data.readUInt16LE(start + 2), type = data.readUInt16LE(start + 4);
  if (type > 1) throw new Error('Invalid version value type');
  let keyEnd = start + 6;
  while (keyEnd + 2 <= end && keyEnd - start <= 1024 && data.readUInt16LE(keyEnd) !== 0) keyEnd += 2;
  if (keyEnd + 2 > end || keyEnd - start > 1024) throw new Error('Unterminated version key');
  const value = align4(keyEnd + 2), valueBytes = valueLength * (type === 1 ? 2 : 1);
  if (valueBytes && value + valueBytes > end) throw new Error('Invalid version value length');
  return { key: data.toString('utf16le', start + 6, keyEnd), type, value, valueBytes, children: align4(value + valueBytes), end };
}

function children(data: Buffer, parent: Block): Block[] {
  const result: Block[] = [];
  let offset = parent.children;
  while (offset + 6 <= parent.end) {
    if (result.length >= 256) throw new Error('Too many version blocks');
    const child = blockAt(data, offset, parent.end);
    result.push(child);
    offset = align4(child.end);
  }
  return result;
}

function resourceVersion(data: Buffer, language: number | null): PeVersionResource {
  const root = blockAt(data, 0, data.length);
  if (root.key !== 'VS_VERSION_INFO' || root.type !== 0) throw new Error('Not VERSIONINFO');
  let fixedFileVersion: string | null = null, fixedProductVersion: string | null = null;
  if (root.valueBytes) {
    if (root.valueBytes < 52 || data.readUInt32LE(root.value) !== 0xfeef04bd) throw new Error('Invalid fixed version');
    const version = (offset: number) => {
      const hi = data.readUInt32LE(root.value + offset), lo = data.readUInt32LE(root.value + offset + 4);
      return `${hi >>> 16}.${hi & 0xffff}.${lo >>> 16}.${lo & 0xffff}`;
    };
    fixedFileVersion = version(8);
    fixedProductVersion = version(16);
  }
  const stringTables: PeVersionResource['stringTables'] = [];
  for (const child of children(data, root)) {
    if (child.key !== 'StringFileInfo') continue;
    for (const table of children(data, child)) {
      if (!/^[\da-f]{8}$/i.test(table.key)) continue;
      const values: Record<string, string> = Object.create(null);
      for (const field of children(data, table)) {
        if (field.type !== 1 || field.valueBytes > 16 * 1024) continue;
        values[field.key] = data.toString('utf16le', field.value, field.value + field.valueBytes).replace(/\0+$/, '').trim();
      }
      stringTables.push({ translation: table.key, values });
    }
  }
  return { language, fixedFileVersion, fixedProductVersion, stringTables };
}

// A packaged Unreal game's EXE often reports the *engine* build (Bodycam, for
// example, reports 5.5.4.0 and ++UE5+Release-5.5). That is not the game version.
const ENGINE = /\+\+UE\d|\bUE[45]-CL-|unreal\s*engine|unrealengine|bootstrap\s*packaged\s*game|\bUE[45]Game\b|\bUnityPlayer\b|Unity Technologies/i;
const HELPER = /(?:^|[\\/ _.-])(?:unitycrashhandler\d*|crashreportclient|crashpad_handler|unins\d*|uninstall|setup|installer|vc_redist[^\\/]*|dxsetup|ue[45]prereq[^\\/]*|easyanticheat[^\\/]*|battleye[^\\/]*|eosoverlayrenderer[^\\/]*|steamwebhelper|steamservice|cefsharp[^\\/]*|libcef)(?:[\\/ _.-]|$)|visual c\+\+|directx setup|anti.?cheat|chromium embedded/i;

function numericVersion(value: string | null | undefined): string | null {
  const match = /^\s*v?(\d+(?:[.,]\s*\d+){1,3}[a-z]?)\s*$/i.exec(value ?? '');
  if (!match) return null;
  const version = match[1].replace(/,\s*/g, '.').toLowerCase();
  if (/^0(?:\.0)+$/.test(version) || /^1(?:\.0){1,3}$/.test(version)) return null;
  return version;
}

function sameVersion(a: string, b: string): boolean {
  const normal = (v: string) => v.replace(/(?:\.0)+$/, '');
  return normal(a) === normal(b);
}

function selectGameVersion(resources: PeVersionResource[], fileName: string): Pick<PeVersionMetadata, 'gameVersion' | 'rejectionReason'> {
  const tables = resources.flatMap(r => r.stringTables.map(t => t.values));
  const provenance = [fileName, ...tables.flatMap(t => Object.values(t))].join('\n');
  if (ENGINE.test(provenance) || tables.some(t => Object.keys(t).some(k => /^unity[ _-]*version$/i.test(k)))) return { gameVersion: null, rejectionReason: 'Executable reports engine metadata, not the game version' };
  if (HELPER.test(provenance) || /\.(?:dll|sys|ocx)$/i.test(fileName) || tables.some(t => /\.(?:dll|sys|ocx)$/i.test(t.OriginalFilename ?? ''))) {
    return { gameVersion: null, rejectionReason: 'Executable is a helper, installer, or runtime component' };
  }
  const versions: string[] = [];
  for (const resource of resources) {
    const strings = resource.stringTables.map(t => t.values);
    const candidates = strings.map(t => numericVersion(t.ProductVersion) ?? numericVersion(t.FileVersion)).filter((v): v is string => !!v);
    // Fixed metadata alone needs game/product provenance. Otherwise a compiler
    // or runtime's default header can masquerade as an installed game build.
    if (!candidates.length && strings.some(t => (t.ProductName || t.FileDescription)?.trim())) {
      const fixed = numericVersion(resource.fixedProductVersion) ?? numericVersion(resource.fixedFileVersion);
      if (fixed) candidates.push(fixed);
    }
    versions.push(...candidates);
  }
  if (!versions.length) return { gameVersion: null, rejectionReason: 'No trustworthy game version in executable metadata' };
  if (versions.some(v => !sameVersion(v, versions[0]))) return { gameVersion: null, rejectionReason: 'Conflicting executable version translations' };
  return { gameVersion: versions[0], rejectionReason: null };
}

/** Returns null for missing/non-PE/malformed files. Reads at most 2 MiB even
 * when the executable itself is hundreds of megabytes. Never executes it. */
export function readPeVersion(path: string): PeVersionMetadata | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    let readBytes = 0;
    const read = (offset: number, length: number) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > stat.size || readBytes + length > MAX_READ) throw new Error('PE read outside bounds');
      readBytes += length;
      const data = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fd!, data, got, length - got, offset + got);
        if (!n) throw new Error('Truncated PE');
        got += n;
      }
      return data;
    };
    const dos = read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) return null;
    const peOffset = dos.readUInt32LE(60), pe = read(peOffset, 24);
    if (pe.readUInt32LE(0) !== 0x00004550) return null;
    const count = pe.readUInt16LE(6), optionalSize = pe.readUInt16LE(20);
    if (!count || count > 96 || optionalSize < 96 || optionalSize > 4096) return null;
    const optional = read(peOffset + 24, optionalSize), magic = optional.readUInt16LE(0);
    const directories = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
    if (!directories || optionalSize < directories + 24 || optional.readUInt32LE(directories - 4) < 3) return null;
    const resourceRva = optional.readUInt32LE(directories + 16), resourceSize = optional.readUInt32LE(directories + 20);
    if (!resourceRva || resourceSize < 16) return null;
    const sections = read(peOffset + 24 + optionalSize, count * 40);
    const map = (rva: number, length: number) => {
      for (let n = 0; n < count; n++) {
        const at = n * 40, va = sections.readUInt32LE(at + 12), rawSize = sections.readUInt32LE(at + 16), raw = sections.readUInt32LE(at + 20);
        if (rva >= va && rva - va + length <= rawSize) return raw + rva - va;
      }
      throw new Error('Unmapped PE resource RVA');
    };
    const resourceRead = (offset: number, length: number) => {
      if (offset < 0 || offset + length > resourceSize) throw new Error('Resource outside directory');
      return read(map(resourceRva + offset, length), length);
    };
    let entryCount = 0;
    const entries = (offset: number): Array<{ id: number; target: number }> => {
      const header = resourceRead(offset, 16), count = header.readUInt16LE(12) + header.readUInt16LE(14);
      entryCount += count;
      if (count > 1024 || entryCount > 4096) throw new Error('Too many resource entries');
      const data = resourceRead(offset + 16, count * 8);
      return Array.from({ length: count }, (_, n) => ({ id: data.readUInt32LE(n * 8), target: data.readUInt32LE(n * 8 + 4) }));
    };
    const resources: PeVersionResource[] = [];
    for (const type of entries(0)) {
      if (type.id !== 16 || !(type.target & 0x80000000)) continue;
      for (const name of entries(type.target & 0x7fffffff)) {
        if (!(name.target & 0x80000000)) continue;
        for (const language of entries(name.target & 0x7fffffff)) {
          if (language.target & 0x80000000) throw new Error('Unexpected nested resource directory');
          if (resources.length >= 32) throw new Error('Too many version resources');
          const entry = resourceRead(language.target, 16), rva = entry.readUInt32LE(0), size = entry.readUInt32LE(4);
          if (size < 6 || size > MAX_VERSION_RESOURCE) throw new Error('Invalid VERSIONINFO size');
          resources.push(resourceVersion(read(map(rva, size), size), language.id & 0x80000000 ? null : language.id));
        }
      }
    }
    return resources.length ? { resources, ...selectGameVersion(resources, basename(path)) } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
