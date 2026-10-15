import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runTransfer, partialBytes, removePartial, type TransferSpec, type TransferProgress } from '../src/workers/transfer';
import { settingsPatch } from '../src/shared/ipc';

const DATA = Buffer.alloc(8 * 1024 * 1024 + 123);
for (let i = 0; i < DATA.length; i++) DATA[i] = (i * 17 + Math.floor(i / 1003)) % 251;
const DATA2 = Buffer.from(DATA).fill(42, 0, 1024 * 1024);
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let base: string, root: string;
let body = DATA, etag = '"v1"', active = 0, peak = 0;
let mode: 'normal' | 'ignore' | 'reject-chunks' | 'bad-range' | 'changed' | 'no-validator' | 'tiny' | 'disconnect' | 'last-modified' = 'normal';
let bounded: Array<{ start: number; end: number }> = [];
let fullRequests = 0;
const server = createServer((req, res) => {
  if (req.url === '/redirect.zip') {
    res.writeHead(302, { Location: '/file.zip' }); res.end(); return;
  }
  if (req.headers.cookie !== 'session=local-test' || req.headers.referer !== `${base}/game`) {
    res.writeHead(403); res.end(); return;
  }
  let start = 0, end = body.length - 1;
  const m = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const isChunk = !!m && m[2] !== '' && m[2] !== '0';
  if (mode === 'changed' && isChunk) { body = DATA2; etag = '"v2"'; }
  if (mode === 'reject-chunks' && isChunk) { res.writeHead(429); res.end(); return; }
  const headers: Record<string, string> = { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="Parallel Game.zip"', 'Accept-Ranges': 'bytes' };
  if (mode === 'last-modified') headers['Last-Modified'] = 'Mon, 12 Oct 2026 12:00:00 GMT';
  else if (mode !== 'no-validator') headers.ETag = etag;
  const useRange = m && mode !== 'ignore' && (!req.headers['if-range'] || req.headers['if-range'] === etag || req.headers['if-range'] === headers['Last-Modified']);
  if (useRange) {
    start = Number(m[1]); end = m[2] ? Number(m[2]) : end;
    if (isChunk) bounded.push({ start, end });
    headers['Content-Range'] = `bytes ${mode === 'bad-range' && isChunk ? start + 1 : start}-${end}/${body.length}`;
  } else if (!isChunk) fullRequests++;
  if (mode === 'tiny') { end = Math.min(end, 256 * 1024 - 1); headers['Content-Range'] = `bytes ${start}-${end}/262144`; }
  headers['Content-Length'] = String(end - start + 1);
  res.writeHead(useRange ? 206 : 200, headers);
  active++; peak = Math.max(peak, active);
  let at = start;
  const data = body;
  const timer = setInterval(() => {
    if (mode === 'disconnect' && isChunk && at > start + 64 * 1024) { res.destroy(); return; }
    const until = Math.min(end + 1, at + 32 * 1024);
    res.write(data.subarray(at, until)); at = until;
    if (at > end) { res.end(); }
  }, 4);
  res.once('close', () => { clearInterval(timer); active--; });
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cgl-parallel-'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { body = DATA; etag = '"v1"'; mode = 'normal'; bounded = []; fullRequests = 0; peak = 0; });
function spec(name: string, over: Partial<TransferSpec> = {}): TransferSpec {
  return { url: `${base}/file.zip`, headers: { Cookie: 'session=local-test', Referer: `${base}/game` }, partPath: join(root, name + '.part'), finalDir: join(root, name), fileNameHint: 'game.zip', etag: null, lastModified: null, expectedTotal: null, connections: 4, ...over };
}
const transfer = (s: TransferSpec, onProgress: (p: TransferProgress) => void = () => {}) => runTransfer(s, new AbortController().signal, () => {}, onProgress);

describe('parallel HTTP downloads', () => {
  it('uses simultaneous bounded ranges, aggregates progress and produces exact bytes through redirects', async () => {
    let progress: TransferProgress | null = null;
    const s = spec('parallel', { url: `${base}/redirect.zip` });
    const r = await transfer(s, (p) => { progress = p; });
    expect(peak).toBeGreaterThanOrEqual(4);
    expect(bounded).toHaveLength(4);
    expect(fullRequests).toBe(0);
    expect(hash(readFileSync(r.path))).toBe(hash(DATA));
    expect(r.connections).toBe(4);
    expect(progress).toMatchObject({ receivedBytes: DATA.length, totalBytes: DATA.length, connections: 4 });
    expect(existsSync(s.partPath + '.segments.json')).toBe(false);
  });

  it('pauses with accurate sparse progress, then resumes saved ranges with a lower connection limit', async () => {
    const s = spec('resume'); const ac = new AbortController();
    await expect(runTransfer(s, ac.signal, () => {}, (p) => { if (p.receivedBytes > 512 * 1024) ac.abort(); })).rejects.toMatchObject({ code: 'cancelled' });
    const saved = JSON.parse(readFileSync(s.partPath + '.segments.json', 'utf8'));
    const actual = saved.segments.reduce((n: number, p: { received: number }) => n + p.received, 0);
    expect(partialBytes(s.partPath)).toBe(actual);
    expect(actual).toBeGreaterThan(0);
    expect(actual).toBeLessThan(DATA.length);
    expect(statSync(s.partPath).size).toBeGreaterThan(actual);
    bounded = []; peak = 0;
    const r = await transfer({ ...s, connections: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    for (const request of bounded) {
      const segment = saved.segments.find((s: { end: number }) => s.end === request.end);
      expect(request.start).toBe(segment.start + segment.received);
    }
    expect(hash(readFileSync(r.path))).toBe(hash(DATA));
  });

  it('rejects a changed checkpoint and downloads a single consistent new version', async () => {
    const s = spec('changed-resume'); const ac = new AbortController();
    await expect(runTransfer(s, ac.signal, () => {}, (p) => { if (p.receivedBytes > 512 * 1024) ac.abort(); })).rejects.toMatchObject({ code: 'cancelled' });
    body = DATA2; etag = '"v2"';
    const r = await transfer(s);
    expect(hash(readFileSync(r.path))).toBe(hash(DATA2));
  });

  it.each(['ignore', 'reject-chunks', 'bad-range', 'changed', 'no-validator'] as const)('falls back safely when the host uses %s behavior', async (behavior) => {
    mode = behavior;
    const r = await transfer(spec('fallback-' + behavior));
    expect(r.connections).toBe(1);
    expect(fullRequests).toBe(1);
    expect(hash(readFileSync(r.path))).toBe(hash(behavior === 'changed' ? DATA2 : DATA));
  });

  it('keeps verified ranges after a dropped connection and retries them without corrupting the file', async () => {
    const s = spec('network'); mode = 'disconnect';
    await expect(transfer(s)).rejects.toMatchObject({ code: 'network', retryable: true });
    expect(partialBytes(s.partPath)).toBeGreaterThan(0);
    mode = 'normal';
    expect(hash(readFileSync((await transfer(s)).path))).toBe(hash(DATA));
  });

  it('migrates a contiguous prefix with a matching validator into ranges', async () => {
    const s = spec('prefix', { etag, expectedTotal: DATA.length });
    writeFileSync(s.partPath, DATA.subarray(0, 123456));
    const r = await transfer(s);
    expect(bounded[0].start).toBe(123456);
    expect(hash(readFileSync(r.path))).toBe(hash(DATA));
  });

  it('cleans all partial state on cancellation and refuses invalid checkpoint offsets', async () => {
    const s = spec('cleanup');
    writeFileSync(s.partPath, DATA.subarray(0, 100));
    writeFileSync(s.partPath + '.segments.json', JSON.stringify({ version: 1, total: DATA.length, validator: etag, segments: [{ start: 0, end: DATA.length - 1, received: DATA.length }] }));
    expect(partialBytes(s.partPath)).toBe(0);
    const r = await transfer(s);
    expect(hash(readFileSync(r.path))).toBe(hash(DATA));
    writeFileSync(s.partPath, 'leftover'); writeFileSync(s.partPath + '.segments.json', '{}'); writeFileSync(s.partPath + '.segments.json.tmp', '{}');
    removePartial(s.partPath);
    for (const suffix of ['', '.segments.json', '.segments.json.tmp']) expect(existsSync(s.partPath + suffix)).toBe(false);
  });

  it('supports Last-Modified validators when ETag is unavailable', async () => {
    mode = 'last-modified';
    const r = await transfer(spec('last-modified'));
    expect(r.connections).toBe(4);
    expect(hash(readFileSync(r.path))).toBe(hash(DATA));
  });

  it('uses one connection for small files', async () => {
    mode = 'tiny';
    const r = await transfer(spec('tiny'));
    expect(r.connections).toBe(1);
    expect(hash(readFileSync(r.path))).toBe(hash(DATA.subarray(0, 256 * 1024)));
  });

  it('discards sparse holes when a resumed host stops supporting ranges', async () => {
    const s = spec('lost-ranges'); const ac = new AbortController();
    await expect(runTransfer(s, ac.signal, () => {}, (p) => { if (p.receivedBytes > 512 * 1024) ac.abort(); })).rejects.toMatchObject({ code: 'cancelled' });
    mode = 'ignore';
    const r = await transfer(s);
    expect(r.connections).toBe(1);
    expect(hash(readFileSync(r.path))).toBe(hash(DATA));
    expect(existsSync(s.partPath + '.segments.json')).toBe(false);
  });

  it('measures acceleration against a host with a per-connection speed limit', async () => {
    const before = performance.now();
    const single = await transfer(spec('benchmark-single', { connections: 1 }));
    const singleMs = performance.now() - before;
    const parallelStart = performance.now();
    const parallel = await transfer(spec('benchmark-parallel', { connections: 8 }));
    const parallelMs = performance.now() - parallelStart;
    expect(hash(readFileSync(single.path))).toBe(hash(readFileSync(parallel.path)));
    expect(peak).toBeGreaterThanOrEqual(8);
    console.log('LOCAL_TRANSFER_BENCHMARK', JSON.stringify({ bytes: DATA.length, singleMs: Math.round(singleMs), parallelMs: Math.round(parallelMs), connections: 8, speedup: Number((singleMs / parallelMs).toFixed(2)) }));
  });

  it('validates the connection setting at the IPC boundary', () => {
    expect(settingsPatch.parse({ downloadConnections: 8 })).toEqual({ downloadConnections: 8 });
    for (const value of [0, 17, 1.5, '8']) expect(settingsPatch.safeParse({ downloadConnections: value }).success).toBe(false);
  });
});
