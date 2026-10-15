// Real Firefox + utility-process integration, isolated from user profiles.
import { spawnSync } from 'node:child_process';
import { portableRar } from '../tests/helpers/portable-rar';
import { Library } from '../src/main/library';
import { app } from 'electron';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { WorkerHost } from '../src/main/worker-host';
import { BrowserClient } from '../src/main/browser-client';
import { BrowserView } from '../src/main/browser-view';
import { browserPoint } from '../src/shared/browser-input';
import { partialBytes } from '../src/workers/transfer';
import { DownloadManager } from '../src/main/downloads';
import { Resolver } from '../src/main/resolver';
import { StoreSession } from '../src/main/store-session';
import { PolicyService } from '../src/main/policy-service';
import { openDb } from '../src/main/db';
import { CatalogRepo, ConsentRepo, DownloadsRepo, SettingsRepo, SourcesRepo, GamesRepo, defaultSettings } from '../src/main/repos';
const root = process.env.CGL_TEST_ROOT!; const dir = process.env.CGL_TEST_DIR!;
mkdirSync(dir, { recursive: true });
const workers: WorkerHost[] = [];
let server: ReturnType<typeof createServer>;
async function until(fn: () => boolean | Promise<boolean>) { const t = Date.now(); while (!await fn()) { if (Date.now() - t > 30000) throw new Error('Timed out'); await new Promise((r) => setTimeout(r, 100)); } }
app.whenReady().then(async () => {
  const payload = Buffer.alloc(32768, 0x73); let port = 0;
  const parallelPayload = Buffer.alloc(8 * 1024 * 1024 + 123);
  for (let i = 0; i < parallelPayload.length; i++) parallelPayload[i] = (i * 17 + Math.floor(i / 1003)) % 251;
  let rangeActive = 0, rangePeak = 0;
  const zipResult = spawnSync('python3', ['-I', '-c', `import zipfile
with zipfile.ZipFile('native-orbit.zip','w') as z:
 z.writestr('NativeOrbit/start.sh', '#!/bin/sh\\ncat data/level.txt > played-marker.txt\\n')
 z.writestr('NativeOrbit/data/level.txt', 'native game data')`], { cwd: dir, encoding: 'utf8' });
  assert.equal(zipResult.status, 0, zipResult.stderr);
  const zipPayload = readFileSync(join(dir, 'native-orbit.zip'));
  const rarExe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 33)]);
  const rarPayload = portableRar({ 'WinOrbit/WinOrbit.exe': rarExe, 'WinOrbit/data/level.dat': Buffer.from('portable rar game data'), 'WinOrbit/UnityCrashHandler64.exe': Buffer.from('MZhelper') });
  server = createServer((req, res) => {
    const url = req.url!;
    if (url === '/shadowed-dom-method') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<form data-cgl-i="9"><input type="hidden" name="getAttribute"><button style="width:200px;height:60px">Download</button></form>');return;
    }
    if (url === '/htmx-gate') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<main><a hx-get="/protected-transfer">Download File</a></main><script>document.querySelector('a').addEventListener('click', e => e.currentTarget.dispatchEvent(new CustomEvent('htmx:afterRequest', {bubbles:true,detail:{xhr:{status:403,responseText:'<title>Just a moment</title>challenge-platform'}}})))</script>`); return;
    }
    if (url === '/protected-transfer') {
      res.setHeader('Content-Type', 'text/html'); res.end('<title>Just a moment</title><form id="challenge-form">Human verification required</form>'); return;
    }
    if (url === '/slow-popup-game') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<main><a href="http://127.0.0.2:${port}/shortlink" target="_blank">Download</a></main>`); return;
    }
    if (url === '/shortlink') {
      res.writeHead(302, { Location: `http://127.0.0.3:${port}/slow-host` }); res.end(); return;
    }
    if (url === '/slow-host') {
      setTimeout(() => { res.setHeader('Content-Type', 'text/html'); res.end('<main><a href="/native-orbit.zip">Download Linux build</a></main>'); }, 2500); return;
    }
    if (url === '/native-game' || url === '/rar-game' || url === '/rar-host') {
      res.setHeader('Content-Type', 'text/html');
      res.end(url === '/native-game' ? '<main><h1>NativeOrbit</h1><a href="/native-orbit.zip">Download Linux build</a></main>' : url === '/rar-game' ? '<main><h1>WinOrbit</h1><button onclick="location.href=\'/rar-host\'">Download</button></main>' : '<main><h1>File host</h1><button onclick="location.href=\'/win-orbit.rar\'">Download</button></main>');
      return;
    }
    if (url === '/native-orbit.zip' || url === '/win-orbit.rar') {
      const data = url === '/native-orbit.zip' ? zipPayload : rarPayload;
      res.writeHead(200, { 'Content-Type': url.endsWith('.zip') ? 'application/zip' : 'application/vnd.rar', 'Content-Length': data.length, 'Content-Disposition': `attachment; filename="${url.slice(1)}"` });
      res.end(data); return;
    }
    if (url === '/parallel.zip') {
      assert.equal(req.headers.cookie, 'parallel_session=fixture');
      const m = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = m ? Number(m[1]) : 0;
      const end = m?.[2] ? Number(m[2]) : parallelPayload.length - 1;
      res.writeHead(m ? 206 : 200, { 'Content-Type': 'application/zip', ETag: '"parallel-v1"', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(m ? { 'Content-Range': `bytes ${start}-${end}/${parallelPayload.length}` } : {}) });
      rangeActive++; rangePeak = Math.max(rangePeak, rangeActive);
      let at = start;
      const timer = setInterval(() => {
        const until = Math.min(end + 1, at + 16 * 1024);
        res.write(parallelPayload.subarray(at, until)); at = until;
        if (at > end) res.end();
      }, 10);
      res.once('close', () => { clearInterval(timer); rangeActive--; });
      return;
    }
    if (url === '/set-cookie') { res.setHeader('Set-Cookie', ['host_session=secret; Path=/files', 'wrong_path=hidden; Path=/private']); res.end('cookies set'); return; }
    if (url === '/human-check') {
      res.setHeader('Content-Type', 'text/html');
      res.end(req.headers.cookie?.includes('human_verified=yes') ? '<title>Verified session retained</title><p>Verified</p>' : `<title>Human handoff fixture</title><form onsubmit="event.preventDefault();document.cookie='human_verified=yes;Path=/;Max-Age=3600';document.title='Verified '+this.elements.code.value"><button type="button" onclick="this.nextElementSibling.focus()">Enter verification code</button><input name="code"><button>Continue</button></form><div style="height:2400px">Scroll test</div>`);
      return;
    }
    if (url === '/game') { res.setHeader('Content-Type', 'text/html'); res.end(`<main><h1>Orbit</h1><a href="http://127.0.0.2:${port}/landing.zip">Download Linux build</a></main>`); return; }
    if (url === '/landing.zip') { res.setHeader('Content-Type', 'text/html'); res.end('<main><h1>Host landing page</h1><a href="/files/orbit.zip" target="_blank">Download</a></main>'); return; }
    if (url === '/files/orbit.zip' || url === '/post-download' && req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': payload.length, 'Content-Disposition': `attachment; filename="${url === '/post-download' ? 'post-only.zip' : 'orbit.zip'}"` }); res.end(req.method === 'HEAD' ? undefined : payload); return; }
    if (url === '/post-page') { res.setHeader('Content-Type', 'text/html'); res.end('<main><form action="/post-download" method="POST"><button type="submit">Download</button></form></main>'); return; }
    res.writeHead(403); res.end('Not replayable');
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve)); port = (server.address() as any).port;
  const bw = new WorkerHost('browser', join(root, 'out/workers/browser.js'), 'test browser'); workers.push(bw);
  await bw.init('init', { firefoxPath: join(root, 'vendor/firefox/firefox'), geckodriverPath: join(root, 'vendor/geckodriver/geckodriver'), profileDir: join(dir, 'profile'), ublockXpi: join(root, 'vendor/extensions/uBlock0@raymondhill.net.xpi'), stagingDir: join(dir, 'staging'), doNotTrack: true, width: 1280, height: 800 });
  const browser = new BrowserClient(bw);
  await browser.navigate('interactive', `http://127.0.0.1:${port}/shadowed-dom-method`);
  assert.equal((await browser.inspectPoint('interactive',100,30)).index,9);
  await browser.navigate('interactive', `http://127.0.0.1:${port}/htmx-gate`);
  const htmx = await browser.extract('interactive');
  await browser.clickElement('interactive', htmx.controls.find((c) => c.text === 'Download File')!.i);
  const xhrGate = await browser.extract('interactive');
  assert.equal(xhrGate.url, `http://127.0.0.1:${port}/protected-transfer`);
  assert.equal(xhrGate.gates.captcha, true);
  // Fara uses pointer input, which must observe the same hidden XHR gate as
  // Holo's clickElement tool. Click inside the actual rendered control.
  await browser.navigate('interactive', `http://127.0.0.1:${port}/htmx-gate`);
  const pointerGate = await browser.extract('interactive');
  const gateRect = pointerGate.controls.find(c => c.text === 'Download File')!.rect;
  await browser.pointer('interactive', gateRect.x + gateRect.w / 2, gateRect.y + gateRect.h / 2);
  const pointerResult = await browser.extract('interactive');
  assert.equal(pointerResult.url, `http://127.0.0.1:${port}/protected-transfer`);
  assert.equal(pointerResult.gates.captcha, true);
  await browser.navigate('interactive', `http://127.0.0.2:${port}/set-cookie`);
  await browser.navigate('interactive', `http://127.0.0.1:${port}/game`);
  assert.equal((await browser.cookieHeader('interactive', `http://127.0.0.2:${port}/files/orbit.zip`)).cookie, 'host_session=secret');
  await browser.navigate('interactive', `http://127.0.0.2:${port}/landing.zip`);
  const extract = await browser.extract('interactive');
  await browser.clickElement('interactive', extract.controls.find((c) => c.text === 'Download')!.i);
  await until(async () => (await browser.takeDownloads(false)).some((d) => d.succeeded));
  const popupDl = (await browser.takeDownloads(false)).find((d) => d.succeeded)!;
  assert.deepEqual(readFileSync(popupDl.target), payload); await browser.takeDownloads(true, popupDl.target);
  const db = openDb(join(dir, 'test.db'));
  const settings = new SettingsRepo(db, defaultSettings({ games: join(dir, 'games'), downloads: join(dir, 'downloads') }));
  const catalog = new CatalogRepo(db); const repo = new DownloadsRepo(db); const policy = new PolicyService(settings, new ConsentRepo(db));
  const sources = new SourcesRepo(db); const source = sources.add(`http://127.0.0.1:${port}/game`);
  const game = catalog.upsertListing(source.id, { pageUrl: source.url, title: 'Orbit', titleKey: 'orbit' }).id; catalog.setRating(game, 'safe', 0, [], 'test');
  const dw = new WorkerHost('downloads', join(root, 'out/workers/downloads.js'), 'test downloads'); workers.push(dw);
  const downloads = new DownloadManager(dw, repo, catalog, settings, policy, browser); const session = new StoreSession(); session.enter();
  const resolver = new Resolver({ agent: { verify: async (ex: any) => ex, transfer: async (ex: any, _t: any, _title: string, _history: any, files: any[]) => files.length ? ({kind:'download',index:0}) : ({kind:'click',index:ex.controls.find((c: any)=>/download/i.test(c.text)).i}) } as never, session, browser, downloads, downloadsRepo: repo, catalog, downloadWorker: dw, policy, openDrawer: () => {}, ai: { setStatus: () => {}, chatJson: async () => { throw new Error('Unexpected AI fallback'); } } as never });
  const d = downloads.create(game, 'Orbit', '127.0.0.1'); resolver.enqueue(d.id);
  await until(() => repo.get(d.id)?.state === 'completed'); assert.deepEqual(readFileSync(repo.get(d.id)!.finalPath!), payload);
  await browser.navigate('interactive', `http://127.0.0.1:${port}/post-page`); const form = await browser.extract('interactive');
  await browser.clickElement('interactive', form.controls.find((c) => c.text === 'Download')!.i);
  await until(async () => (await browser.takeDownloads(false)).some((x) => x.succeeded && x.target.endsWith('post-only.zip')));
  const post = (await browser.takeDownloads(false)).find((x) => x.target.endsWith('post-only.zip'))!;
  const record = repo.create({ catalogId: game, title: 'POST fixture', sourceHost: '127.0.0.1', state: 'resolving' }); downloads.adoptBrowserDownload(record.id, post);
  await until(() => repo.get(record.id)?.state === 'completed'); assert.deepEqual(readFileSync(repo.get(record.id)!.finalPath!), payload);
  // One Download action resolves, downloads, extracts and registers both
  // portable formats. No installer or game is executed during preparation.
  const iw = new WorkerHost('install', join(root, 'out/workers/install.js'), 'test install'); workers.push(iw);
  const library = new Library(iw, new GamesRepo(db), repo, downloads, catalog, settings, policy, () => null, { ensureProton: async () => '/fixture/proton', notifyRuntime: () => {} } as never, {session,agent:{prepare:async()=>{},executable:async(_token,_title,candidates)=>candidates.find(c=>!c.installerLike&&c.kind!=='msi')!}});
  const nativeId = catalog.upsertListing(source.id, { pageUrl: `http://127.0.0.1:${port}/native-game`, title: 'NativeOrbit', titleKey: 'nativeorbit' }).id;
  catalog.setRating(nativeId, 'safe', 0, [], 'test');
  const nativeDownload = downloads.create(nativeId, 'NativeOrbit', '127.0.0.1'); resolver.enqueue(nativeDownload.id);
  await until(() => !!repo.get(nativeDownload.id)?.gameId);
  const nativeGame = library.list().find((g) => g.catalogId === nativeId)!;
  assert.equal(nativeGame.status, 'installed'); assert.equal(nativeGame.runner, 'native');
  assert.equal(existsSync(join(nativeGame.installDir!, 'NativeOrbit/played-marker.txt')), false);
  assert.equal(readFileSync(join(nativeGame.installDir!, 'NativeOrbit/data/level.txt'), 'utf8'), 'native game data');
  await library.launch(nativeGame.id);
  await until(() => existsSync(join(nativeGame.installDir!, 'NativeOrbit/played-marker.txt')) && !library.isRunning(nativeGame.id));
  assert.equal(readFileSync(join(nativeGame.installDir!, 'NativeOrbit/played-marker.txt'), 'utf8'), 'native game data');
  const rarId = catalog.upsertListing(source.id, { pageUrl: `http://127.0.0.1:${port}/rar-game`, title: 'WinOrbit', titleKey: 'winorbit' }).id;
  catalog.setRating(rarId, 'safe', 0, [], 'test');
  const rarDownload = downloads.create(rarId, 'WinOrbit', '127.0.0.1'); resolver.enqueue(rarDownload.id);
  await until(() => !!repo.get(rarDownload.id)?.gameId);
  const rarGame = library.list().find((g) => g.catalogId === rarId)!;
  assert.equal(rarGame.status, 'installed'); assert.equal(rarGame.runner, 'proton');
  assert.deepEqual(readFileSync(rarGame.executable!), rarExe);
  assert.equal(readFileSync(join(rarGame.installDir!, 'WinOrbit/data/level.dat'), 'utf8'), 'portable rar game data');
  const slowId = catalog.upsertListing(source.id, { pageUrl: `http://127.0.0.1:${port}/slow-popup-game`, title: 'SlowPopupOrbit', titleKey: 'slowpopuporbit' }).id;
  catalog.setRating(slowId, 'safe', 0, [], 'test');
  const slowDownload = downloads.create(slowId, 'SlowPopupOrbit', '127.0.0.1'); resolver.enqueue(slowDownload.id);
  await until(() => !!repo.get(slowDownload.id)?.gameId);
  assert.equal(library.list().find((g) => g.catalogId === slowId)?.status, 'installed');
  // Recover an archive completed just before the application stopped.
  // Earlier unrelated raw-transfer fixtures were intentionally not game ZIPs.
  repo.update(d.id, { catalogId: null }); repo.update(record.id, { catalogId: null });
  const recoverId = catalog.upsertListing(source.id, { pageUrl: `http://127.0.0.1:${port}/recovered-game`, title: 'RecoveredOrbit', titleKey: 'recoveredorbit' }).id;
  catalog.setRating(recoverId, 'safe', 0, [], 'test');
  const recovery = repo.create({ catalogId: recoverId, title: 'RecoveredOrbit', sourceHost: '127.0.0.1', state: 'completed' });
  repo.update(recovery.id, { finalPath: join(dir, 'native-orbit.zip'), installState: 'installing' });
  library.recover();
  await until(() => !!repo.get(recovery.id)?.gameId);
  assert.equal(library.list().find((g) => g.catalogId === recoverId)?.status, 'installed');
  const count = library.list().length;
  library.recover(); await new Promise((r) => setTimeout(r, 150));
  assert.equal(library.list().length, count);
  // Exercise the real utility worker and SQLite queue, including worker death.
  session.leave();
  assert.equal(settings.get().downloadConnections, 8);
  let observedBytes = 0;
  dw.on('event:progress', (e: { receivedBytes: number }) => { observedBytes = e.receivedBytes; });
  const parallelRecord = repo.create({ catalogId: null, title: 'Parallel queue fixture', sourceHost: '127.0.0.1', state: 'resolving' });
  downloads.handoff(parallelRecord.id, `http://127.0.0.1:${port}/parallel.zip`, { Cookie: 'parallel_session=fixture' }, 'parallel.zip', parallelPayload.length);
  await until(() => observedBytes > 512 * 1024);
  assert.equal(downloads.items().find((x) => x.id === parallelRecord.id)?.connections, 8);
  await downloads.pause(parallelRecord.id);
  const paused = repo.get(parallelRecord.id)!;
  assert.equal(paused.state, 'paused');
  assert.equal(paused.receivedBytes, partialBytes(paused.partPath));
  assert.ok(paused.receivedBytes > 0 && paused.receivedBytes < parallelPayload.length);
  settings.update({ downloadConnections: 2 });
  downloads.resume(parallelRecord.id);
  await until(() => repo.get(parallelRecord.id)?.state === 'completed');
  assert.deepEqual(readFileSync(repo.get(parallelRecord.id)!.finalPath!), parallelPayload);
  assert.ok(rangePeak >= 8);
  settings.update({ downloadConnections: 8 }); observedBytes = 0;
  const crashRecord = repo.create({ catalogId: null, title: 'Worker recovery fixture', sourceHost: '127.0.0.1', state: 'resolving' });
  downloads.handoff(crashRecord.id, `http://127.0.0.1:${port}/parallel.zip`, { Cookie: 'parallel_session=fixture' }, 'recovered.zip', parallelPayload.length);
  await until(() => observedBytes > 512 * 1024);
  (dw as unknown as { proc: { kill(): boolean } }).proc.kill();
  await until(() => repo.get(crashRecord.id)?.state === 'completed');
  assert.deepEqual(readFileSync(repo.get(crashRecord.id)!.finalPath!), parallelPayload);
  observedBytes = 0;
  const cancelRecord = repo.create({ catalogId: null, title: 'Cancellation fixture', sourceHost: '127.0.0.1', state: 'resolving' });
  downloads.handoff(cancelRecord.id, `http://127.0.0.1:${port}/parallel.zip`, { Cookie: 'parallel_session=fixture' }, 'cancelled.zip', parallelPayload.length);
  await until(() => observedBytes > 512 * 1024);
  await downloads.cancel(cancelRecord.id);
  const cancelled = repo.get(cancelRecord.id)!;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(existsSync(cancelled.partPath!), false);
  assert.equal(existsSync(cancelled.partPath! + '.segments.json'), false);
  session.enter();
  // A human takes over the exact discovery window; clicks map to the image,
  // typing/Enter reach the field, scrolling works and the cookie survives.
  await browser.navigate('discovery', `http://127.0.0.1:${port}/human-check`);
  let captured = false;
  const drawer = new BrowserView(browser, { classify: async () => { captured = true; return [0]; } } as never, policy, catalog, session);
  drawer.show('discovery');
  await until(() => captured);
  const human = await browser.extract('discovery');
  const shot = await browser.snapshot('discovery', false);
  const control = human.controls.find((c) => c.text === 'Enter verification code')!;
  const box = { left: 100, top: 50, width: 640, height: 700 };
  const scale = Math.min(box.width / shot.w, box.height / shot.h);
  const point = browserPoint(box.left + (box.width - shot.w * scale) / 2 + (control.rect.x + control.rect.w / 2) * scale, box.top + (control.rect.y + control.rect.h / 2) * scale, box, { width: shot.w, height: shot.h })!;
  await drawer.click(point.x, point.y, 'left');
  await drawer.type('human input'); await drawer.key('Enter');
  assert.equal((await browser.extract('discovery')).title, 'Verified human input');
  await drawer.scroll(0.5, 0.5, 0, 350);
  await until(async () => (await browser.extract('discovery')).viewport.scrollY > 0);
  await drawer.history('reload');
  assert.equal((await browser.extract('discovery')).title, 'Verified session retained');
  drawer.releaseDiscovery();
  // Ordinary Firefox can own the same profile, then return persistent website
  // verification cookies to automation without concurrent profile access.
  session.leave();
  await browser.beginHuman('discovery');
  await assert.rejects(browser.extract('discovery'), /direct human control/);
  await browser.endHuman();
  assert.equal((await browser.extract('discovery')).title, 'Verified session retained');
  session.leave(); await bw.call('shutdown'); db.close();
  const result = { htmxXhrVerificationVisible: true, crossHostCookies: true, downloadPopup: true, delayedRedirectPopup: true, htmlInterstitial: true, externalDownloadBytes: payload.length, postDownloadPreserved: true, humanBrowserClickTypeScroll: true, verificationSessionRetained: true, directFirefoxProfileHandoff: true, parallelConnections: rangePeak, parallelQueuePauseResume: true, workerCrashRecovery: true, parallelCancellationCleanup: true, zipDownloadExtractLibrary: true, rarDownloadExtractLibrary: true, nativePlay: true, noAutomaticExecution: true, interruptedPreparationRecovery: true };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2)); console.log('LIVE_BROWSER_PASS', result);
}).catch((e) => { console.error('LIVE_BROWSER_FAIL', e); process.exitCode = 1; }).finally(() => { workers.forEach((w) => w.stop()); server?.close(); setTimeout(() => process.kill(process.pid, 'SIGKILL'), 250); });
