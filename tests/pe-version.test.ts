import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPeVersion } from '../src/main/pe-version';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const align = (n: number) => Math.ceil(n / 4) * 4;

// Build actual PE headers/resource directories and nested VS_VERSION_INFO,
// rather than placing matching version strings somewhere in an EXE-shaped file.
function block(key: string, value: Buffer = Buffer.alloc(0), children: Buffer[] = [], text = false): Buffer {
  const name = Buffer.from(`${key}\0`, 'utf16le'), valueAt = align(6 + name.length);
  let length = valueAt + value.length;
  for (const child of children) length = align(length) + child.length;
  const data = Buffer.alloc(length);
  data.writeUInt16LE(length, 0);
  data.writeUInt16LE(text ? value.length / 2 : value.length, 2);
  data.writeUInt16LE(text ? 1 : 0, 4);
  name.copy(data, 6);
  value.copy(data, valueAt);
  let at = valueAt + value.length;
  for (const child of children) { at = align(at); child.copy(data, at); at += child.length; }
  return data;
}

function version(input: { fixed?: number[] | null; productFixed?: number[]; strings?: Record<string, string>; tables?: Array<{ translation: string; strings: Record<string, string> }> } = {}): Buffer {
  const fixed = Buffer.alloc(input.fixed === null ? 0 : 52);
  if (fixed.length) {
    fixed.writeUInt32LE(0xfeef04bd, 0);
    fixed.writeUInt32LE(0x10000, 4);
    const words = (v: number[], offset: number) => {
      fixed.writeUInt32LE(v[0] * 65536 + v[1], offset);
      fixed.writeUInt32LE(v[2] * 65536 + v[3], offset + 4);
    };
    words(input.fixed ?? [1, 2, 3, 4], 8);
    words(input.productFixed ?? input.fixed ?? [1, 2, 3, 4], 16);
  }
  const tables = input.tables ?? [{ translation: '040904b0', strings: input.strings ?? { ProductName: 'Example Adventure', ProductVersion: '1.2.3.4', FileVersion: '1.2.3.4' } }];
  return block('VS_VERSION_INFO', fixed, [block('StringFileInfo', undefined, tables.map(table => block(table.translation, undefined,
    Object.entries(table.strings).map(([key, value]) => block(key, Buffer.from(`${value}\0`, 'utf16le'), [], true))))) ]);
}

function pe(resources: Buffer[] = [version()], plus = false): Buffer {
  const optionalSize = plus ? 240 : 224, directory = plus ? 112 : 96;
  const dataEntries = 64 + resources.length * 8;
  let payload = align(dataEntries + resources.length * 16);
  const positions = resources.map(resource => { const at = payload; payload = align(payload + resource.length); return at; });
  const data = Buffer.alloc(0x400 + payload);
  data.writeUInt16LE(0x5a4d, 0); data.writeUInt32LE(0x80, 60);
  data.writeUInt32LE(0x4550, 0x80); data.writeUInt16LE(1, 0x86); data.writeUInt16LE(optionalSize, 0x94);
  data.writeUInt16LE(plus ? 0x20b : 0x10b, 0x98);
  data.writeUInt32LE(16, 0x98 + directory - 4);
  data.writeUInt32LE(0x1000, 0x98 + directory + 16); data.writeUInt32LE(payload, 0x98 + directory + 20);
  const section = 0x98 + optionalSize;
  data.write('.rsrc', section); data.writeUInt32LE(payload, section + 8); data.writeUInt32LE(0x1000, section + 12);
  data.writeUInt32LE(payload, section + 16); data.writeUInt32LE(0x400, section + 20);
  const root = 0x400;
  data.writeUInt16LE(1, root + 14); data.writeUInt32LE(16, root + 16); data.writeUInt32LE(0x80000018, root + 20);
  data.writeUInt16LE(1, root + 24 + 14); data.writeUInt32LE(1, root + 40); data.writeUInt32LE(0x80000030, root + 44);
  data.writeUInt16LE(resources.length, root + 48 + 14);
  resources.forEach((resource, n) => {
    data.writeUInt32LE(n ? 0x407 + n : 0x409, root + 64 + n * 8);
    data.writeUInt32LE(dataEntries + n * 16, root + 68 + n * 8);
    data.writeUInt32LE(0x1000 + positions[n], root + dataEntries + n * 16);
    data.writeUInt32LE(resource.length, root + dataEntries + n * 16 + 4);
    resource.copy(data, root + positions[n]);
  });
  return data;
}

function read(data: Buffer, name = 'Adventure.exe') {
  const directory = mkdtempSync(join(tmpdir(), 'cgl-pe-version-'));
  temporary.push(directory);
  const path = join(directory, name);
  writeFileSync(path, data);
  return readPeVersion(path);
}

describe('bounded, read-only PE game version metadata', () => {
  it.each<Record<string, string>>([
    { ProductVersion: '5.0.4.13071451', 'Unity Version': '5.0.4f1_c7745b75bf55' },
    { ProductVersion: '2019.4.36.870', 'Unity Version': '2019.4.36f1_870' },
    { ProductName: 'REANIMAL', ProductVersion: 'UE5-CL-0' },
  ])('rejects engine headers found in real imported games: %j', strings => {
    const result = read(pe([version({ fixed: [5, 4, 4, 0], strings })]));
    expect(result?.gameVersion).toBeNull(); expect(result?.rejectionReason).toMatch(/engine/);
  });
  it.each([false, true])('reads mapped RT_VERSION from PE32+ = %s', plus => {
    const result = read(pe([version()], plus));
    expect(result?.gameVersion).toBe('1.2.3.4');
    expect(result?.resources[0]).toEqual({ language: 0x409, fixedFileVersion: '1.2.3.4', fixedProductVersion: '1.2.3.4', stringTables: [{ translation: '040904b0', values: { ProductName: 'Example Adventure', ProductVersion: '1.2.3.4', FileVersion: '1.2.3.4' } }] });
  });

  it('keeps metadata from every language and accepts equivalent translated versions', () => {
    const result = read(pe([version(), version({ strings: { ProductName: 'Abenteuer', ProductVersion: '1.2.3.4' } })]));
    expect(result?.resources.map(r => r.language)).toEqual([0x409, 0x408]);
    expect(result?.gameVersion).toBe('1.2.3.4');
  });

  it('does not choose an arbitrary language when their versions disagree', () => {
    const result = read(pe([version(), version({ strings: { ProductName: 'Adventure', ProductVersion: '2.0.0.1' } })]));
    expect(result?.gameVersion).toBeNull();
    expect(result?.rejectionReason).toMatch(/Conflicting/);
  });

  it('reads multiple StringFileInfo translations and rejects disagreement', () => {
    const result = read(pe([version({ tables: [{ translation: '040904b0', strings: { ProductVersion: '2.1.0' } }, { translation: '040704b0', strings: { ProductVersion: '2.2.0' } }] })]));
    expect(result?.resources[0].stringTables).toHaveLength(2);
    expect(result?.gameVersion).toBeNull();
  });

  it('uses meaningful fixed product metadata if strings omit version', () => {
    expect(read(pe([version({ fixed: [2, 3, 4, 5], strings: { ProductName: 'Adventure' } })]))?.gameVersion).toBe('2.3.4.5');
  });

  it('does not trust a bare fixed header without game/product provenance', () => {
    expect(read(pe([version({ strings: {} })]))?.gameVersion).toBeNull();
  });

  it('supports a string-only version resource', () => {
    expect(read(pe([version({ fixed: null, strings: { ProductVersion: 'v2.3.4', ProductName: 'Adventure' } })]))?.gameVersion).toBe('2.3.4');
  });

  it('uses FileVersion when ProductVersion is not a numeric game version', () => {
    expect(read(pe([version({ strings: { ProductName: 'Adventure', ProductVersion: 'release', FileVersion: '2, 4, 6, 8' } })]))?.gameVersion).toBe('2.4.6.8');
  });
  it('uses the actual Ghost of Tsushima file build instead of its generic 1.0 product version', () => {
    expect(read(pe([version({ fixed: [1053, 8, 1212, 1408], strings: { ProductName: "Ghost of Tsushima DIRECTOR'S CUT", ProductVersion: '1.0', FileVersion: '1053.8.1212.1408' } })]))?.gameVersion).toBe('1053.8.1212.1408');
  });

  it.each(['++UE5+Release-5.5-CL-40574608', 'UnrealEngine', 'Unreal Engine', 'Unity Technologies'])('rejects engine provenance %s, retaining metadata for diagnostics', provenance => {
    const result = read(pe([version({ fixed: [5, 5, 4, 0], strings: { CompanyName: 'Epic Games, Inc.', ProductName: provenance, ProductVersion: provenance, FileVersion: '5.5.4.0' } })]));
    expect(result?.resources[0].fixedFileVersion).toBe('5.5.4.0');
    expect(result?.gameVersion).toBeNull();
    expect(result?.rejectionReason).toMatch(/engine metadata/);
  });

  it.each(['0.0.0.0', '1.0.0.0', '1.0.0', '1.0'])('rejects default/dummy version %s', value => {
    expect(read(pe([version({ fixed: [0, 0, 0, 0], strings: { ProductName: 'Adventure', ProductVersion: value, FileVersion: value } })]))?.gameVersion).toBeNull();
  });

  it.each(['UnityCrashHandler64.exe', 'CrashReportClient.exe', 'setup.exe', 'vc_redist.x64.exe', 'EOSOverlayRenderer-Win64-Shipping.exe'])('rejects helper %s even with numeric version metadata', name => {
    expect(read(pe(), name)?.gameVersion).toBeNull();
  });

  it('retains library metadata but never treats its version as the game version', () => {
    expect(read(pe(), 'kernel32.dll')?.gameVersion).toBeNull();
    expect(read(pe([version({ strings: { ProductName: 'Runtime', ProductVersion: '3.4.5', OriginalFilename: 'steam_api64.dll' } })]))?.gameVersion).toBeNull();
  });

  it('does not search loose EXE strings or the file name for a version', () => {
    expect(read(Buffer.from('MZ Adventure version 9.2.3 ProductVersion 9.2.3'), 'Adventure-v9.2.3.exe')).toBeNull();
  });

  it('does not mistake another resource type for RT_VERSION', () => {
    const data = pe(); data.writeUInt32LE(10, 0x410);
    expect(read(data)).toBeNull();
  });

  it.each([
    ['out-of-file PE header', (data: Buffer) => data.writeUInt32LE(0xfffffff0, 60)],
    ['excessive sections', (data: Buffer) => data.writeUInt16LE(65535, 0x86)],
    ['oversized optional header', (data: Buffer) => data.writeUInt16LE(65535, 0x94)],
    ['absent directory count', (data: Buffer) => data.writeUInt32LE(2, 0x98 + 92)],
    ['resource directory outside section', (data: Buffer) => data.writeUInt32LE(0x70000000, 0x98 + 112)],
    ['cycle in language directory', (data: Buffer) => data.writeUInt32LE(0x80000030, 0x444)],
    ['oversized directory count', (data: Buffer) => data.writeUInt16LE(65535, 0x43e)],
    ['out-of-directory data entry', (data: Buffer) => data.writeUInt32LE(0x70000000, 0x444)],
    ['out-of-file resource data', (data: Buffer) => data.writeUInt32LE(0x70000000, 0x448)],
    ['oversized version resource', (data: Buffer) => data.writeUInt32LE(0x70000000, 0x44c)],
    ['resource in virtual zero-fill tail', (data: Buffer) => { data.writeUInt32LE(0x100000, 0x98 + 224 + 8); data.writeUInt32LE(0x2000, 0x448); }],
    ['root length exceeding resource', (data: Buffer) => data.writeUInt16LE(65535, 0x458)],
    ['root value exceeding block', (data: Buffer) => data.writeUInt16LE(65535, 0x45a)],
    ['incorrect fixed version signature', (data: Buffer) => data.writeUInt32LE(1234, 0x480)],
  ] as const)('rejects malformed bounds: %s', (_label, change) => {
    const data = pe(); change(data);
    expect(read(data)).toBeNull();
  });

  it('handles missing, truncated, and non-PE files without throwing', () => {
    expect(readPeVersion('/missing-cgl-game-version-file.exe')).toBeNull();
    expect(read(pe().subarray(0, 0x430))).toBeNull();
    expect(read(Buffer.alloc(4096))).toBeNull();
  });
});
