import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error Build scripts deliberately remain standalone JavaScript.
import { repack, squashfsOffset } from '../scripts/repack-appimage.mjs';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function elf(offset: number) {
  const b = Buffer.alloc(offset);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  b.writeBigUInt64LE(BigInt(offset - 64), 0x28); b.writeUInt16LE(64, 0x3a); b.writeUInt16LE(1, 0x3c);
  return b;
}
describe('static AppImage repacking', () => {
  it('calculates the ELF section boundary and rejects invalid headers', () => {
    expect(squashfsOffset(elf(256))).toBe(256);
    expect(() => squashfsOffset(Buffer.alloc(64))).toThrow('ELF64');
    const bad = elf(256); bad.writeUInt16LE(0, 0x3c);
    expect(() => squashfsOffset(bad)).toThrow('section table');
  });
  it('preserves squashfs bytes exactly and makes the result executable', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cgl-repack-')); dirs.push(d);
    const file = join(d, 'test.AppImage'); const runtimeFile = join(d, 'runtime');
    const payload = Buffer.concat([Buffer.from('hsqs'), Buffer.alloc(100_000, 0xa5)]);
    const runtime = elf(512); writeFileSync(runtimeFile, runtime); writeFileSync(file, Buffer.concat([elf(256), payload]));
    await repack(file, runtimeFile, createHash('sha256').update(runtime).digest('hex'));
    expect(readFileSync(file)).toEqual(Buffer.concat([runtime, payload]));
    expect(statSync(file).mode & 0o777).toBe(0o755);
    await expect(repack(file, runtimeFile, '0'.repeat(64))).rejects.toThrow('checksum');
    expect(readFileSync(file).subarray(512)).toEqual(payload);
  });
  it('refuses a missing squashfs boundary', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cgl-repack-')); dirs.push(d);
    const file = join(d, 'bad.AppImage'); const runtimeFile = join(d, 'runtime');
    const runtime = elf(512); writeFileSync(runtimeFile, runtime); writeFileSync(file, Buffer.concat([elf(256), Buffer.from('junk')]));
    await expect(repack(file, runtimeFile, createHash('sha256').update(runtime).digest('hex'))).rejects.toThrow('Squashfs magic');
  });
});
