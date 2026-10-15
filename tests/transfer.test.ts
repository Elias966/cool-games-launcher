// Resumable transfers against a local HTTP server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { runTransfer, probeUrl, parseContentDisposition, sanitizeFileName, TransferError, type TransferSpec } from '../src/workers/transfer';

const DATA = randomBytes(3 * 1024 * 1024 + 123);
const DATA_V2 = randomBytes(DATA.length);
let etag = '"v1"';
let body = DATA;
let honourRange = true;
let throttle = false;
let server: Server;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cgl-transfer-'));
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/gone') {
      res.statusCode = 410;
      return res.end();
    }
    if (url.pathname === '/login') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html><form><input type=password></form></html>');
    }
    if (url.pathname !== '/file.zip') {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('etag', etag);
    res.setHeader('accept-ranges', honourRange ? 'bytes' : 'none');
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', 'attachment; filename="Great Game.zip"');
    const range = req.headers.range?.match(/bytes=(\d+)-/);
    const ifRange = req.headers['if-range'];
    let start = 0;
    if (honourRange && range && (!ifRange || ifRange === etag)) {
      start = Number(range[1]);
      if (start >= body.length) {
        res.statusCode = 416;
        res.setHeader('content-range', `bytes */${body.length}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${body.length - 1}/${body.length}`);
    }
    const slice = body.subarray(start);
    res.setHeader('content-length', slice.length);
    if (!throttle) return res.end(slice);
    // Slow stream so the client can be interrupted midway.
    let off = 0;
    const tick = setInterval(() => {
      if (off >= slice.length) {
        clearInterval(tick);
        return res.end();
      }
      res.write(slice.subarray(off, off + 16 * 1024));
      off += 16 * 1024;
    }, 8);
    req.on('close', () => clearInterval(tick));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function spec(name: string, over: Partial<TransferSpec> = {}): TransferSpec {
  return { url: `${base}/file.zip`, headers: {}, partPath: join(dir, `${name}.part`), finalDir: join(dir, name), fileNameHint: null, etag: null, lastModified: null, expectedTotal: null, ...over };
}

describe('runTransfer', () => {
  it('downloads a file and names it from Content-Disposition', async () => {
    etag = '"v1"';
    body = DATA;
    honourRange = true;
    throttle = false;
    const r = await runTransfer(spec('plain'), new AbortController().signal, () => {}, () => {});
    expect(r.path.endsWith('Great Game.zip')).toBe(true);
    expect(sha(readFileSync(r.path))).toBe(sha(DATA));
  });

  it('resumes an interrupted transfer with a Range request', async () => {
    etag = '"v1"';
    body = DATA;
    honourRange = true;
    throttle = true;
    const s = spec('resume');
    const ac = new AbortController();
    let meta: { etag: string | null } | null = null;
    const first = runTransfer(s, ac.signal, (m) => (meta = m), (p) => {
      if (p.receivedBytes > 512 * 1024) ac.abort();
    });
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    const partial = statSync(s.partPath).size;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(DATA.length);
    throttle = false;
    let firstProgress = -1;
    const r = await runTransfer({ ...s, etag: meta!.etag }, new AbortController().signal, () => {}, (p) => {
      if (firstProgress < 0) firstProgress = p.receivedBytes;
    });
    expect(r.resumable).toBe(true);
    expect(sha(readFileSync(r.path))).toBe(sha(DATA));
  });

  it('restarts from zero when the file changed on the server (If-Range)', async () => {
    etag = '"v1"';
    body = DATA;
    honourRange = true;
    const s = spec('changed');
    writeFileSync(s.partPath, DATA.subarray(0, 1000)); // partial copy of v1
    etag = '"v2"';
    body = DATA_V2;
    const r = await runTransfer({ ...s, etag: '"v1"' }, new AbortController().signal, () => {}, () => {});
    expect(sha(readFileSync(r.path))).toBe(sha(DATA_V2));
  });

  it('restarts cleanly when the server ignores ranges', async () => {
    etag = '"v1"';
    body = DATA;
    honourRange = false;
    const s = spec('norange');
    writeFileSync(s.partPath, DATA.subarray(0, 4096));
    const r = await runTransfer(s, new AbortController().signal, () => {}, () => {});
    expect(sha(readFileSync(r.path))).toBe(sha(DATA));
    honourRange = true;
  });

  it('reports expired links', async () => {
    await expect(runTransfer(spec('gone', { url: `${base}/gone` }), new AbortController().signal, () => {}, () => {})).rejects.toMatchObject({ code: 'link-expired' });
    await expect(runTransfer(spec('login', { url: `${base}/login` }), new AbortController().signal, () => {}, () => {})).rejects.toMatchObject({ code: 'link-expired' });
  });

  it('reports a full disk', async () => {
    if (!existsSync('/dev/full')) return;
    etag = '"v1"';
    body = DATA;
    const err = await runTransfer(spec('full', { partPath: '/dev/full' }), new AbortController().signal, () => {}, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(TransferError);
    expect(err.code).toBe('disk-full');
  });

  it('reports network failures as retryable', async () => {
    const err = await runTransfer(spec('refused', { url: 'http://127.0.0.1:1/x.zip' }), new AbortController().signal, () => {}, () => {}).catch((e) => e);
    expect(err.code).toBe('network');
    expect(err.retryable).toBe(true);
  });
});

describe('probe and naming', () => {
  it('distinguishes files from web pages', async () => {
    expect((await probeUrl(`${base}/file.zip`, {}, new AbortController().signal)).isFile).toBe(true);
    expect((await probeUrl(`${base}/login`, {}, new AbortController().signal)).isFile).toBe(false);
  });

  it('parses and sanitises file names', () => {
    expect(parseContentDisposition(`attachment; filename*=UTF-8''Caf%C3%A9.zip`)).toBe('Café.zip');
    expect(parseContentDisposition('attachment; filename="a b.tar.gz"')).toBe('a b.tar.gz');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('.hidden')).toBe('hidden');
    expect(sanitizeFileName('')).toBe('download');
  });
});
