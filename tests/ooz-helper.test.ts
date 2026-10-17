import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const helper = resolve('vendor/ooz/cgl-ooz');
const MAX = 256 * 1024;
const decode = (expected: string, input: Buffer) => spawnSync(helper, [expected], {
  input, timeout: 2000, maxBuffer: MAX,
});

describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('isolated Oodle metadata helper', () => {
  beforeAll(() => {
    const build = spawnSync(process.execPath, ['scripts/build-ooz.mjs'], { timeout: 120_000, encoding: 'utf8' });
    if (build.error || build.status !== 0) throw new Error(build.stderr || build.error?.message || 'Oodle helper build failed');
  }, 120_000);

  it('decodes an independently constructed Oodle uncompressed block exactly', () => {
    const ini = Buffer.from('[/Script/EngineSettings.GeneralProjectSettings]\nProjectVersion=1.2.3.456\n');
    const result = decode(String(ini.length), Buffer.concat([Buffer.from([0xcc, 6]), ini]));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(ini);
  });

  it('decodes a compressed fill quantum up to the exact output limit', () => {
    // 0x7ffff encodes a fill quantum; its last byte is the repeated value.
    const result = decode(String(MAX), Buffer.from([0x8c, 6, 7, 255, 255, 65]));
    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(Buffer.alloc(MAX, 65));
  });

  it.each(['0', '-1', '262145', '999999999999999999999', '12junk', '', '3.5'])('rejects invalid declared size %j', expected => {
    const result = decode(expected, Buffer.from([0xcc, 6, 1, 2, 3]));
    expect(result.status).not.toBe(0);
    expect(result.stdout.length).toBe(0);
  });

  it('rejects excessive input rather than decoding a truncated prefix', () => {
    const result = decode('3', Buffer.alloc(MAX + 1, 65));
    expect(result.status).not.toBe(0);
    expect(result.stdout.length).toBe(0);
  });

  it.each([Buffer.alloc(0), Buffer.from([0xcc]), Buffer.from([0xcc, 6, 65]), Buffer.from([0x8c, 6, 0, 0])])('rejects incomplete blocks without partial output', input => {
    const result = decode('64', input);
    expect(result.status).not.toBe(0);
    expect(result.stdout.length).toBe(0);
  });

  it('rejects trailing data after a complete stream', () => {
    const result = decode('3', Buffer.from([0xcc, 6, 65, 66, 67, 99]));
    expect(result.status).not.toBe(0);
    expect(result.stdout.length).toBe(0);
  });
});
