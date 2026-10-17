import { spawn } from 'node:child_process';
import { onLanguage, setMainLanguage, tm } from './i18n';
import { ForegroundWork } from './foreground';
import { StoreSearch } from './store-search';
import {MODEL_CATALOG} from '@shared/models';
import {ModelManager} from './models';
import { LocalGameAgent } from './game-agent';
// Composition root for the main process.
import { app, BrowserWindow, dialog, ipcMain, net, shell, session as electronSession, type IpcMainInvokeEvent, Notification } from 'electron';
import { basename, dirname, join } from 'node:path';
import { cpus, homedir, totalmem } from 'node:os';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { paths, ensureDirs, vendor, vendorStatus, modelPaths, workerPath } from './paths';
import { openDb } from './db';
import { AiCacheRepo, CatalogRepo, ConsentRepo, DownloadsRepo, GamesRepo, ImageClassRepo, SettingsRepo, SourcesRepo, defaultSettings, WishlistRepo } from './repos';
import { WorkerHost } from './worker-host';
import { StoreSession } from './store-session';
import { PolicyService } from './policy-service';
import { AiService } from './ai';
import { ArtworkCache, ClassificationService } from './classification';
import { ArtworkThumbnails } from './artwork-thumbnails';
import { HostRateLimiter } from './rate-limit';
import { BrowserClient } from './browser-client';
import { Discovery } from './discovery';
import { PageFetcher } from './page-fetcher';
import { startLogFile } from './logfile';
import { reapOrphans } from './orphans';
import { DownloadManager } from './downloads';
import { Resolver } from './resolver';
import { BrowserView } from './browser-view';
import { ProtonReleases, RELEASE_REFRESH_MS } from './proton-releases';
import { CompatManager } from './compat';
import manifest from '../../scripts/vendor-manifest.json';
import { Library, detectProton, detectWine, detectTools } from './library';
import { GameInfoService } from './descriptions';
import { WishlistService } from './wishlist';
import { LauncherTray } from './tray';
import { ensureLauncherEntry, gameFromArgs } from './shortcuts';
import { writeDiagnostics } from './diagnostics';
import { UpdateService } from './updates';
import { CustomSounds, SOUND_EXTENSIONS } from './custom-sounds';
import { GameIdentifier } from './game-identify';
import { GameImagesService, IMAGE_EXTENSIONS } from './game-images';
import { EPIC_LOGIN_URL, GOG_LOGIN_URL, StoreService, epicLoginCode, gogLoginCode } from './stores';
import type { StoreId } from '@shared/types';
import { handleMedia, registerMediaScheme } from './media';
import { registerIpc, type Handlers } from './ipc';
import { attach, publish, toast } from './bus';
import { SelfUpdater } from './self-update';
import { CoverCheckService } from './cover-check';
import { CoverModel } from './cover-model';
import { hostOf } from '@shared/urls';
import type { ProtonDbSummary, Settings } from '@shared/types';

app.setName('Cool Games Launcher');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
registerMediaScheme();

let mainWindow: BrowserWindow | null = null;
let appQuitting = false;
/** After a launcher update: the AppImage to start once this instance has exited. */
let relaunchInto: string | null = null;
/** The close button's sound plays until then (ms timestamp); quitting waits for it with the window already hidden. */
let closeSoundUntil = 0;

/** Starts `appImage` as soon as this process is gone (the launcher ends itself with SIGKILL, so app.relaunch never runs). */
function startAfterExit(appImage: string) {
  const env = { ...process.env };
  for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete env[k];
  // Close every descriptor inherited from this process first: Chromium's helper
  // processes stay alive while any end of their IPC channels is open.
  const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p));
  const script = `${bash ? 'for f in /proc/$$/fd/*; do n=\${f##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-" 2>/dev/null; done; ' : ''}while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"`;
  const child = spawn(bash ?? '/bin/sh', ['-c', script, 'cgl-restart', String(process.pid), appImage], { detached: true, stdio: 'ignore', env });
  child.unref();
}
/** The launcher's icon file (packaged: resources/icons). */
function appIcon(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icons', '256x256.png') : join(app.getAppPath(), 'build', 'icons', '256x256.png');
}
const rendererIndex = join(__dirname, '..', 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererIndex).toString();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    frame: false,
    show: false,
    backgroundColor: '#0a0c11',
    title: 'Cool Games Launcher',
    // The taskbar and window switcher show this (resources/icons in the AppImage).
    icon: appIcon(),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      webviewTag: false,
      // Interface sounds (synthesized locally) may play for background events.
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: true,
    },
  });
  win.once('ready-to-show', () => {
    console.log('[cgl] window ready');
    win.show();
  });
  void win.loadFile(rendererIndex);
  return win;
}

/** GOG/Epic login windows: they may move between the stores' own https pages. */
const storeLoginContents = new Set<number>();

function hardenWebContents() {
  app.on('web-contents-created', (_e, contents) => {
    // Store login pages may open their sign-in pop-ups (Google, Apple, Facebook…) in the same login session.
    contents.setWindowOpenHandler(({ url }) => storeLoginContents.has(contents.id) && url.startsWith('https://')
      ? { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { session: contents.session, sandbox: true, contextIsolation: true, nodeIntegration: false } } }
      : { action: 'deny' });
    contents.on('did-create-window', (child) => { if (storeLoginContents.has(contents.id)) storeLoginContents.add(child.webContents.id); });
    contents.on('will-navigate', (e, url) => {
      if (storeLoginContents.has(contents.id) && url.startsWith('https://')) return;
      if (url !== rendererUrl) e.preventDefault();
    });
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
}

async function main() {
  hardenWebContents();
  await app.whenReady();
  ensureDirs();
  startLogFile(paths.logs);
  reapOrphans({ runtimeDir: paths.runtime, browserProfile: paths.browserProfile });
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);

  const db = openDb(paths.db);
  const settingsRepo = new SettingsRepo(db, defaultSettings({ games: paths.games, downloads: paths.downloads }));
  const customSounds = new CustomSounds(join(paths.data, 'sounds'), settingsRepo);
  setMainLanguage(settingsRepo.get().language);
  const consentRepo = new ConsentRepo(db);
  const sourcesRepo = new SourcesRepo(db);
  const catalogRepo = new CatalogRepo(db);
  const downloadsRepo = new DownloadsRepo(db);
  const gamesRepo = new GamesRepo(db);
  const aiCache = new AiCacheRepo(db);
  const imageClass = new ImageClassRepo(db);

  const inferenceWorker = new WorkerHost('inference', workerPath('inference'), 'Cool Games Launcher AI');
  const browserWorker = new WorkerHost('browser', workerPath('browser'), 'Cool Games Launcher Browser');
  const downloadsWorker = new WorkerHost('downloads', workerPath('downloads'), 'Cool Games Launcher Downloads');
  const installWorker = new WorkerHost('install', workerPath('install'), 'Cool Games Launcher Installer');
  const artworkWorker = new WorkerHost('artwork', workerPath('artwork'), 'Cool Games Launcher Artwork');
  const fetcherWorkers = [1, 2, 3].map((n) => new WorkerHost('fetcher', workerPath('fetcher'), `Cool Games Launcher Indexer ${n}`));

  const v = vendor();
  const initInference = (s: Settings) =>
    inferenceWorker.init('init', {
      llamaDir: v.llamaDir,
      modelPath: modelPaths(s.aiModelId).model,
      mmprojPath: modelPaths(s.aiModelId).vision,
      thinking: MODEL_CATALOG.find(m=>m.id===s.aiModelId)?.variant==='Thinking',
      family: MODEL_CATALOG.find(m=>m.id===s.aiModelId)?.family,
      defaultModelId:s.aiAgents.analysis,
      models:Object.fromEntries(MODEL_CATALOG.map(m=>[m.id,{modelPath:modelPaths(m.id).model,mmprojPath:modelPaths(m.id).vision,thinking:m.variant==='Thinking',family:m.family}])),
      classifierPath: v.classifier,
      runtimeDir: paths.runtime,
      threads: s.aiThreads,
      // Three 1440×896 screenshots (~1260 tokens each) plus the 2k-token Fara prompt and history.
      contextSize: Math.max(s.aiContextSize, 16384),
      accel: s.aiAcceleration,
      imageTokens: s.aiImageTokens,
      classifierThreads: s.classifierThreads,
      idleUnloadMinutes: s.aiIdleUnloadMinutes,
    });
  const initBrowser = (s: Settings) =>
    browserWorker.init('init', {
      firefoxPath: v.firefox,
      geckodriverPath: v.geckodriver,
      profileDir: paths.browserProfile,
      ublockXpi: v.ublock,
      stagingDir: paths.browserStaging,
      doNotTrack: s.sendDoNotTrack,
      width: 1440,
      height: 1000,
    });
  const s0 = settingsRepo.get();
  inferenceWorker.start();
  browserWorker.start();
  downloadsWorker.start();
  installWorker.start();
  for (const w of fetcherWorkers) w.start();
  await Promise.all([initInference(s0), initBrowser(s0)]);

  const session = new StoreSession();
  const policy = new PolicyService(settingsRepo, consentRepo);
  const ai = new AiService(inferenceWorker, session, aiCache,()=>settingsRepo.get().aiAgents);
  const limiter = new HostRateLimiter();
  const artwork = new ArtworkCache(paths.artwork, limiter);
  const classification = new ClassificationService(ai, artwork, catalogRepo, imageClass);
  const coverModel = new CoverModel({ modelsDir: paths.models, fetch: (url, init) => net.fetch(url, init) });
  const coverCheck = new CoverCheckService({
    ai, artwork, catalog: catalogRepo, settings: settingsRepo, model: coverModel,
    changed: () => publish('catalog:changed', { policyRevision: settingsRepo.policy().revision, sourceId: null }),
  });
  const browser = new BrowserClient(browserWorker);
  const browserView = new BrowserView(browser, ai, policy, catalogRepo, session);
  const gameAgent = new LocalGameAgent(ai, browser, session);
  const fetcher = new PageFetcher(fetcherWorkers, browser);
  let updateService: UpdateService | null = null;
  let wishlistService: WishlistService | null = null;
  let libraryRef: Library | null = null;
  const discovery = new Discovery({ agent: gameAgent, fetcher, sources: sourcesRepo, catalog: catalogRepo, settings: settingsRepo, session, ai, classification, browser, limiter, policy,
    updates: { afterDetail: (id) => updateService?.afterDetail(id) },
    wishlist: { afterDetail: (id) => wishlistService?.afterDetail(id) },
    onVerificationRequired: (sourceId, message) => {
      browserView.show('discovery');
      publish('browser:attention', { downloadId: 0, sourceId, message, requiresUser:true });
    },
    isModelReady:()=>models.readyAgents(['analysis','browsing']),
    onVerificationResolved: (sourceId) => publish('browser:verificationResolved', { sourceId }),
  });
  const foreground = new ForegroundWork(session, discovery);
  const storeSearch = new StoreSearch({session,foreground,sources:sourcesRepo,catalog:catalogRepo,policy,browser,agent:gameAgent,discovery,ai,limiter,classification,isModelReady:()=>models.readyAgents(['analysis','browsing']),
    showBrowser:message=>{browserView.show('discovery');publish('browser:attention',{downloadId:0,message,requiresUser:true});},
  });
  const downloads = new DownloadManager(downloadsWorker, downloadsRepo, catalogRepo, settingsRepo, policy, browser);
  let storeRequestedActive = false;
  let syncSession: () => void = () => undefined;
  let shuttingDown = false;
  const WAITING_FOR_AI = new Set(['resolving', 'needs-resolution', 'needs-user', 'queued', 'active']);
  /** A game download still needs the AI: its link, its preparation, or an update swap. */
  const aiWorkPending = () => downloadsRepo.list().some((d) => d.catalogId !== null && !d.modelAsset && !d.compatPackage &&
    (WAITING_FOR_AI.has(d.state) || (d.state === 'completed' && d.installState !== 'installed' && d.installState !== 'failed')));
  let humanBrowserActive = false;
  let humanContext: 'interactive' | 'discovery' = 'interactive';
  const restoreAfterHuman = () => {
    const wasActive = humanBrowserActive;
    humanBrowserActive = false;
    publish('browser:humanMode', { active: false });
    if (wasActive && (storeRequestedActive || aiWorkPending())) {
      if(humanContext==='interactive')foreground.hold('human-download',true);
      session.enter();
      browserView.show(humanContext);
      discovery.poke();
      if (humanContext === 'interactive') {resolver.continueAfterHuman();foreground.hold('human-download',false);}
    }
  };
  browserWorker.on('event:humanMode', ({ active }: { active: boolean }) => {
    if (active) publish('browser:humanMode', { active: true });
    else restoreAfterHuman();
  });
  const resolver = new Resolver({
    foreground,
    agent: gameAgent,
    session,
    ai,
    browser,
    downloads,
    downloadsRepo,
    catalog: catalogRepo,
    downloadWorker: downloadsWorker,
    policy,
    recoverGamePage: async (catalogId, token) => {
      browserView.show('discovery');
      try { return await storeSearch.recoverPage(catalogId, token); }
      finally { browserView.show('interactive'); }
    },
    openDrawer: (reason, requiresUser) => {
      browserView.show();
      publish('browser:attention', { downloadId: 0, message: reason, requiresUser });
    },
    partsSettled: (groupId) => libraryRef?.partsSettled(groupId),
  });
  const models=new ModelManager({root:paths.models,repo:downloadsRepo,downloads,settings:settingsRepo,worker:installWorker,onSelected:async()=>{
    const active=session.active;session.leave();await ai.unload();await initInference(settingsRepo.get());
    if(active)session.enter();discovery.poke();
  }});
  // Load the model and compile its GPU pipelines as soon as the Store opens,
  // so the first real AI decision does not pay the cold-start cost.
  session.on('enter', () => {
    if (storeRequestedActive && !ai.paused && models.readyAgents()) void inferenceWorker.call('warmup', { modelId: settingsRepo.get().aiAgents.analysis }).catch(() => undefined);
  });
  const compat = new CompatManager({ settings: settingsRepo, repo: downloadsRepo, downloads, worker: installWorker, dataDir: paths.data, pin: manifest.onDemand.find((p) => p.id === 'ge-proton')!, detectProton });
  const protonReleases = new ProtonReleases(join(paths.data, 'compat', 'releases.json'));
  void protonReleases.refresh();
  const protonRefreshTimer = setInterval(() => { void protonReleases.refresh(); }, RELEASE_REFRESH_MS);
  protonRefreshTimer.unref();
  const library = new Library(installWorker, gamesRepo, downloadsRepo, downloads, catalogRepo, settingsRepo, policy, () => mainWindow, compat, {agent: gameAgent, session, foreground});
  /** Installed Proton builds with how many games chose each one. */
  const protonsWithUse = () => {
    const games = gamesRepo.list();
    return compat.installed().map((p) => ({ ...p, usedBy: games.filter((g) => g.launch.protonPath === p.path).length }));
  };
  libraryRef = library;
  // While a game runs: the model is unloaded, AI requests wait, and indexing pauses.
  // The model and classifier leave the GPU before the game process starts.
  library.setBeforeGame(async () => {
    if (!settingsRepo.get().freeGpuWhilePlaying) return;
    foreground.hold('gaming', true);
    await ai.pauseForGame(true);
  });
  library.onPlaying((playing) => {
    const free = playing && settingsRepo.get().freeGpuWhilePlaying;
    foreground.hold('gaming', free);
    void ai.pauseForGame(free);
    if (free) console.log('[main] a game started: AI unloaded and paused until it closes');
  });
  library.setRecovery({ redownload: (ids) => { syncSession(); for (const id of ids) resolver.enqueue(id); }, cache: aiCache });
  // Library updates download like any game; resolution continues while the Store is open.
  library.setDownloadStarter((catalogId, title, sourceHost) => {
    const d = downloads.create(catalogId, title, sourceHost);
    if (d.state === 'resolving' || d.state === 'needs-resolution') resolver.enqueue(d.id);
    return d;
  });
  updateService = new UpdateService({
    games: gamesRepo, catalog: catalogRepo, sources: sourcesRepo, downloads: downloadsRepo, settings: settingsRepo, limiter, fetcher,
    startUpdate: (id) => library.startUpdate(id), isRunning: (id) => library.isRunning(id), broadcast: () => library.broadcast(),
  });
  const updates = updateService;
  // Desktop notification (and toast); clicking it shows the game.
  const notify = (title: string, body: string, catalogId: number | null) => {
    toast('info', `${title} — ${body}`);
    if (!Notification.isSupported()) return;
    const icon = appIcon();
    const n = new Notification({ title, body, ...(existsSync(icon) ? { icon } : {}) });
    n.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
      if (catalogId !== null) publish('app:openGame', { catalogId });
    });
    n.show();
  };
  const wishlistRepo = new WishlistRepo(db);
  wishlistService = new WishlistService({
    wishlist: wishlistRepo, catalog: catalogRepo, sources: sourcesRepo, policy, notify,
    changed: () => { publish('wishlist:changed', wishlists.list()); publish('catalog:changed', { policyRevision: policy.policy().revision, sourceId: null }); },
  });
  const wishlists = wishlistService;

  // The launcher's own updates, from the project's GitHub releases.
  const selfUpdate = new SelfUpdater({
    version: app.getVersion(),
    appImage: process.env.APPIMAGE || null,
    fetch: (url, init) => net.fetch(url, init),
    publish: (st) => publish('launcher:update', st),
    announce: (version) => {
      toast('info', tm('Cool Games Launcher {version} is available. Install it from Settings → About.', { version }));
      if (Notification.isSupported()) new Notification({ title: tm('Launcher update available'), body: tm('Version {version} is ready to download in Settings → About.', { version }) }).show();
    },
    restart: (appImage) => {
      relaunchInto = appImage;
      app.quit();
    },
  });
  const checkLauncher = () => { if (settingsRepo.get().checkLauncherUpdates) void selfUpdate.check(); };
  setTimeout(checkLauncher, 20_000).unref();
  setInterval(checkLauncher, 6 * 3600_000).unref();
  const descriptions = new GameInfoService({
    catalog: catalogRepo, sources: sourcesRepo, cache: aiCache, fetcher, limiter,
    changed: (sourceId) => publish('catalog:changed', { policyRevision: policy.policy().revision, sourceId }),
  });
  // Trending decays with age: refresh the sort scores at start and daily.
  catalogRepo.rescoreWhere();
  const rescoreTimer = setInterval(() => catalogRepo.rescoreWhere(), 24 * 3600_000);
  rescoreTimer.unref();

  policy.on('changed', ({ showNsfw, revision }: { showNsfw: boolean; revision: number }) => {
    publish('policy:changed', { showNsfw, policyRevision: revision });
    publish('settings:changed', settingsRepo.get());
    publish('catalog:hidden', { policyRevision: revision, ids: catalogRepo.hiddenIds(policy.policy()) });
    coverCheck.poke();
    syncSession();
    publish('catalog:changed', { policyRevision: revision, sourceId: null });
  });

  handleMedia({ artworkDir: paths.artwork, catalog: catalogRepo, policy, browserView, thumbnails: new ArtworkThumbnails(paths.artwork, artworkWorker) });
  downloads.recover();
  compat.recover();
  models.recover();
  // Move users off the slow three-model team as soon as the single model is verified.
  if (models.upgradeLegacyTeam()) void initInference(settingsRepo.get());
  library.recover();
  updates.start();
  descriptions.startBackfill();

  // Names and covers for imported games (see game-identify.ts).
  const identifier = new GameIdentifier({
    games: gamesRepo,
    cache: aiCache,
    steam: { search: (term) => descriptions.searchSteam(term), media: (appid) => descriptions.steamMediaFor(appid) },
    ask: (req) => foreground.run(20, (token) => ai.chatJson(token, req)),
    saveArtwork: (url) => artwork.fetch(url, null),
    clues: (g) => {
      const exe = g.executable ?? '';
      const folders: string[] = [];
      for (let d = dirname(exe), i = 0; i < 3 && d !== dirname(d); i++, d = dirname(d)) folders.push(basename(d));
      let files: string[] = [];
      try { files = readdirSync(g.installDir ?? dirname(exe)).slice(0, 40); } catch { /* folder gone */ }
      return { executable: exe, folders, files };
    },
    changed: () => library.broadcast(),
  });
  session.on('enter', () => void identifier.pump());
  // GOG and Epic accounts (see stores.ts). The person logs in on the store's own page.
  const openStoreLogin = (store: StoreId) => new Promise<string | null>((resolve) => {
    const win = new BrowserWindow({
      width: 560, height: 780, parent: mainWindow ?? undefined, autoHideMenuBar: true, backgroundColor: '#ffffff',
      title: store === 'gog' ? 'Log in to GOG' : 'Log in to Epic Games',
      webPreferences: { partition: `persist:${store}-login`, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    // Read now: after 'closed' the window's contents are gone and touching them throws.
    const contentsId = win.webContents.id;
    storeLoginContents.add(contentsId);
    let finished = false;
    const finish = (code: string | null) => {
      if (finished) return;
      finished = true;
      resolve(code);
      if (!win.isDestroyed()) win.close();
    };
    win.webContents.on('render-process-gone', () => finish(null));
    const check = (url: string) => { if (store === 'gog') { const code = gogLoginCode(url); if (code) finish(code); } };
    win.webContents.on('will-redirect', (_e, url) => check(url));
    win.webContents.on('will-navigate', (_e, url) => check(url));
    win.webContents.on('did-navigate', (_e, url) => check(url));
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return;
      const url = win.webContents.getURL();
      check(url);
      // Epic shows the code as JSON on its redirect page.
      if (store === 'epic' && url.startsWith('https://www.epicgames.com/id/api/redirect')) {
        void win.webContents.executeJavaScript('document.body.innerText').then((text: string) => { const code = epicLoginCode(text); if (code) finish(code); }).catch(() => undefined);
      }
    });
    win.on('closed', () => { storeLoginContents.delete(contentsId); finish(null); });
    void win.loadURL(store === 'gog' ? GOG_LOGIN_URL : EPIC_LOGIN_URL);
  });
  const stores = new StoreService({
    tools: { legendary: vendor().legendary, gogdl: vendor().gogdl },
    dataDir: paths.data,
    gamesDir: () => settingsRepo.get().libraryDir,
    games: gamesRepo,
    login: openStoreLogin,
    prepareGame: (id) => gamesRepo.update(id, { prefixDir: join(paths.prefixes, `game-${id}`) }),
    changed: () => library.broadcast(),
    publish: (s) => publish('stores:changed', s),
    publishJobs: (jobs) => publish('stores:jobsChanged', jobs),
    cacheImage: async (url) => `cgl-media://artwork/${encodeURIComponent(await artwork.fetch(url, null))}`,
    allowArtwork: (file) => catalogRepo.allowArtwork(file),
    cachedImage: (url) => { const file = artwork.fileFor(url); return file ? `cgl-media://artwork/${encodeURIComponent(file)}` : null; },
    downloadConnections: () => settingsRepo.get().downloadConnections,
    isRunning: (id) => library.isRunning(id) || library.isChanging(id),
    legacyGogConfigDir: join(process.env.GOGDL_CONFIG_PATH ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'heroic_gogdl'),
  });
  library.storeUpdates = (g) => stores.hasUpdate(g);
  library.storeBusy = (id) => stores.isBusy(id);
  library.storeLaunchArgs = (g) => stores.launchArgs(g);
  library.onUninstalled = (g) => stores.forget(g);
  stores.recover();
  setTimeout(() => void stores.refresh().catch((e) => console.warn('[stores]', (e as Error).message)), 8_000).unref();
  setInterval(() => void stores.refresh().catch(() => undefined), 6 * 3600_000).unref();

  const gameImages = new GameImagesService({
    games: gamesRepo, catalog: catalogRepo, policy: () => policy.policy(), cache: aiCache,
    steamMedia: (appid) => descriptions.steamMediaFor(appid), artworkDir: paths.artwork,
  });
  setTimeout(() => identifier.resume(), 15_000).unref();

  // The AI keeps working on downloads (finding the file, unpacking, choosing
  // the executable) wherever the user is in the app. Indexing and the GPU
  // warm-up stay with the Store, so playing a game is not slowed by indexing.
  syncSession = () => {
    if (humanBrowserActive || shuttingDown) return;
    foreground.hold('outside-store', !storeRequestedActive);
    const want = storeRequestedActive || aiWorkPending();
    if (want && !session.active) session.enter();
    else if (!want && session.active) session.leave();
    else if (session.active) resolver.resumePending();
  };
  downloads.on('listChanged', () => syncSession());
  syncSession();
  // The cover filter checks the games already indexed as soon as the launcher starts.
  coverCheck.poke();

  const partsOf = (id: number) => {
    const d = downloadsRepo.get(id);
    return d?.groupId ? downloadsRepo.group(d.groupId).map((p) => p.id) : [id];
  };

  const trusted = (e: IpcMainInvokeEvent) => !!mainWindow && e.sender === mainWindow.webContents && e.senderFrame?.url === rendererUrl;

  const requireStore = () => {
    if (!session.active) throw new Error('Open the Store to use the browser and AI');
  };

  const handlers: Handlers = {
    'app:info': () => ({
      appVersion: app.getVersion(),
      cpuCount: cpus().length,
      totalMemGb: Math.round(totalmem() / 1024 ** 3),
      vulkanAvailable: existsSync('/usr/lib/x86_64-linux-gnu/libvulkan.so.1') || existsSync('/usr/lib64/libvulkan.so.1') || existsSync('/usr/lib/libvulkan.so.1'),
      vendorReady: {...vendorStatus(),model:models.readyAgents(['analysis','browsing'])},
      detectedProton: detectProton(),
      detectedWine: detectWine(),
      tools: (({ gamescope, mangohud, gamemode }) => ({ gamescope: !!gamescope, mangohud: !!mangohud, gamemode: !!gamemode }))(detectTools()),
      dataDir: paths.data,
      cacheDir: paths.cache,
      configDir: paths.config,
    }),
    'compat:releases': async ({ refresh }) => ({ ...await protonReleases.refresh(refresh), installed: protonsWithUse(), defaultPath: compat.protonPath() }),
    'compat:setDefault': ({ path }) => compat.setDefault(path),
    'compat:addFolder': async () => {
      const r = await dialog.showOpenDialog(mainWindow!, { title: tm('Choose a Proton folder'), properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      compat.addFolder(r.filePaths[0]);
      return protonsWithUse();
    },
    'compat:remove': ({ path }) => {
      compat.remove(path);
      // Games that used it go back to the default version.
      for (const g of gamesRepo.list()) if (g.launch.protonPath === path) library.configure(g.id, { launch: { protonPath: null } });
      return protonsWithUse();
    },
    'compat:installVersion': async ({ id }) => {
      await protonReleases.refresh();
      const release = protonReleases.find(id);
      if (!release || release.unavailableReason || !release.url || !release.sha256 || !release.size) throw new Error(release?.unavailableReason ?? 'This version is not available. Refresh the release list.');
      return compat.installPackage({ provider: release.provider, version: release.version, url: release.url, sha256: release.sha256, size: release.size, dir: `${release.provider}-${release.version}`.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 160) });
    },
    'compat:openRelease': async ({ id }) => {
      const release = protonReleases.find(id);
      if (!release) throw new Error('Release no longer available. Refresh the list.');
      await shell.openExternal(release.pageUrl);
    },
    'compat:status': () => compat.status(),
    'compat:installProton': () => compat.installProton(),
    'models:list':()=>models.list(),
    'models:download':({id})=>models.download(id),
    'models:select':({id})=>models.select(id),
    'models:assign':({role,id})=>models.assign(role,id),
    'models:assignAll':({id})=>models.assignAll(id),
    'app:openFolder': async ({ which }) => {
      const s = settingsRepo.get();
      const dir = { logs: paths.logs, data: paths.data, games: s.libraryDir, downloads: s.downloadsDir, cache: paths.cache }[which];
      const err = await shell.openPath(dir);
      if (err) throw new Error(err);
    },
    'settings:get': () => settingsRepo.get(),
    'settings:update': async (patch) => {
      if(patch.aiModelId!==undefined)throw Error('Use the model selector to switch verified local models.');
      const before = settingsRepo.get();
      const s = settingsRepo.update(patch);
      setMainLanguage(s.language);
      const aiKeys: Array<keyof Settings> = ['aiThreads', 'aiContextSize', 'aiAcceleration', 'aiImageTokens', 'aiIdleUnloadMinutes', 'classifierThreads'];
      if (aiKeys.some((k) => before[k] !== s[k])) await initInference(s);
      if (before.sendDoNotTrack !== s.sendDoNotTrack) await initBrowser(s);
      if (before.maxConcurrentDownloads !== s.maxConcurrentDownloads) downloads.pump();
      publish('settings:changed', s);
      return s;
    },
    'sounds:choose': async ({ sound }) => {
      const r = await dialog.showOpenDialog(mainWindow!, { title: tm('Choose a sound file'), properties: ['openFile'], filters: [{ name: tm('Audio files'), extensions: SOUND_EXTENSIONS }] });
      if (r.canceled || !r.filePaths[0]) return null;
      const s = customSounds.adopt(sound, r.filePaths[0]);
      publish('settings:changed', s);
      return s;
    },
    'sounds:reset': ({ sound }) => {
      const s = customSounds.reset(sound);
      publish('settings:changed', s);
      return s;
    },
    'sounds:read': ({ sound }) => customSounds.read(sound),
    'settings:pickDirectory': async ({ title }) => {
      const r = await dialog.showOpenDialog(mainWindow!, { title, properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    'settings:clearCache': async ({ what }) => {
      let freed = 0;
      const sizeOfDir = (d: string) => (existsSync(d) ? readdirSync(d).reduce((n, f) => n + (statSync(join(d, f), { throwIfNoEntry: false })?.size ?? 0), 0) : 0);
      if (what === 'artwork') {
        freed = sizeOfDir(paths.artwork);
        for (const f of readdirSync(paths.artwork)) rmSync(join(paths.artwork, f), { force: true });
        imageClass.clear();
        db.exec(`UPDATE catalog SET artwork_file = NULL, rating = 'unknown', classifier_version = NULL, classify_attempts = 0`);
        db.exec(`UPDATE games SET artwork_file = NULL`);
      } else if (what === 'ai') {
        aiCache.clear();
      } else if (what === 'browser') {
        await browser.clearData();
      } else if (what === 'catalog') {
        catalogRepo.clearAll();
        for (const s of sourcesRepo.list()) sourcesRepo.resetCrawl(s.id);
      }
      publish('catalog:changed', { policyRevision: policy.policy().revision, sourceId: null });
      publish('sources:changed', sourcesRepo.list());
      return { freedBytes: freed };
    },
    'consent:get': () => {
      const p = settingsRepo.policy();
      return { ...consentRepo.current(), showNsfw: p.showNsfw, policyRevision: p.revision };
    },
    'content:setHideWomenCovers': ({ on }) => policy.setHideWomenCovers(on),
    'content:setCoverStrictness': ({ strictness }) => {
      settingsRepo.setCoverStrictness(strictness);
      const s = settingsRepo.get();
      policy.emit('changed', { showNsfw: policy.policy().showNsfw, revision: s.policyRevision });
      return s;
    },
    'content:coverStatus': () => ({ ...catalogRepo.coverCounts(settingsRepo.policy().coverThreshold), enabled: settingsRepo.get().hideWomenCovers, model: coverModel.status() }),
    'sources:list': () => sourcesRepo.list(),
    'sources:add': ({ url, name }) => {
      if (sourcesRepo.list().some((s) => s.url === url)) throw new Error('This website is already in your sources');
      const s = sourcesRepo.add(url, name);
      publish('sources:changed', sourcesRepo.list());
      discovery.poke();
      return s;
    },
    'sources:update': ({ id, ...patch }) => {
      const s = sourcesRepo.update(id, patch);
      publish('sources:changed', sourcesRepo.list());
      return s;
    },
    'sources:remove': ({ id }) => {
      sourcesRepo.remove(id);
      publish('sources:changed', sourcesRepo.list());
      publish('catalog:changed', { policyRevision: policy.policy().revision, sourceId: id });
    },
    'sources:recrawl': async ({ id }) => {
      if (humanBrowserActive) { await browser.endHuman(); restoreAfterHuman(); }
      browserView.releaseDiscovery();
      sourcesRepo.setStatus(id, 'idle', 'Queued');
      discovery.recrawl(id);
      publish('sources:changed', sourcesRepo.list());
    },
    'sources:resume': async ({ id }) => {
      if (humanBrowserActive) { await browser.endHuman(); restoreAfterHuman(); }
      requireStore();
      storeSearch.releaseCheck();
      discovery.resumeVerification(id);
    },
    'sources:skipCheck': async ({ id }) => {
      if (humanBrowserActive) { await browser.endHuman(); restoreAfterHuman(); }
      storeSearch.releaseCheck();
      discovery.skipVerification(id);
    },
    'store:searchFocus': ({ focused }) => { foreground.hold('search-input',focused); },
    'store:searchCancel': () => { storeSearch.cancel(); },
    'store:search': async ({ query,sourceIds }) => {
      requireStore();
      return storeSearch.search(query,sourceIds);
    },
    'store:setActive': ({ active }) => {
      storeRequestedActive = active;
      if (!active) storeSearch.cancel();
      syncSession();
      if (active) discovery.poke();
      return ai.getStatus();
    },
    'catalog:facets': () => ({ ...catalogRepo.facets(policy.policy()), gathering: descriptions.pending(), policyRevision: policy.policy().revision }),
    'catalog:list': (q) => {
      const pol = policy.policy();
      const r = catalogRepo.query(pol, q);
      return { policyRevision: pol.revision, total: r.total, entries: r.entries, fuzzy: r.fuzzy };
    },
    // ProtonDB's public summary for a Steam game, cached for three days.
    'app:openExternal': async ({ url }) => { await shell.openExternal(url); },
    'compat:protondb': async ({ appid }) => {
      const key = `protondb:${appid}`;
      const hit = aiCache.get<ProtonDbSummary | { missing: true }>(key, 72);
      if (hit) return 'missing' in hit ? null : hit;
      try {
        const res = await fetch(`https://www.protondb.com/api/v1/reports/summaries/${appid}.json`, { signal: AbortSignal.timeout(15_000) });
        if (res.status === 404) { aiCache.set(key, { missing: true }); return null; }
        if (!res.ok) return null;
        const j = (await res.json()) as { tier?: string; trendingTier?: string; bestReportedTier?: string; confidence?: string; total?: number };
        if (!j.tier) return null;
        const summary: ProtonDbSummary = { tier: j.tier, trendingTier: j.trendingTier ?? null, bestReportedTier: j.bestReportedTier ?? null, confidence: j.confidence ?? null, total: j.total ?? 0 };
        aiCache.set(key, summary);
        return summary;
      } catch { return null; }
    },
    'catalog:similar': ({ id }) => ({ policyRevision: policy.policy().revision, entries: catalogRepo.similar(id, policy.policy()) }),
    'wishlist:list': () => wishlists.list(),
    'wishlist:add': (p) => wishlists.add(p),
    'wishlist:remove': (p) => wishlists.remove(p),
    'catalog:get': ({ id }) => {
      descriptions.prioritize(id);
      const pol = policy.policy();
      return { policyRevision: pol.revision, entry: catalogRepo.get(id, pol) };
    },
    'catalog:refreshDetail': async ({ id }) => {
      requireStore();
      if (!catalogRepo.get(id, policy.policy())) throw new Error('Not available');
      await foreground.run(10, token=>discovery.fetchDetail(id, token, { refresh:true,foreground:true }));
    },
    'download:start': ({ catalogId }) => {
      requireStore();
      if(!models.readyAgents())throw Error('Download the AI model in Settings → Local AI before downloading games.');
      const pol = policy.policy();
      const entry = catalogRepo.get(catalogId, pol);
      if (!entry) throw new Error('This game is not available');
      storeSearch.cancel();
      foreground.hold('search-input',false);
      const d = downloads.create(catalogId, entry.title, hostOf(entry.pageUrl));
      if(d.state==='needs-user'){browserView.show('interactive');publish('browser:attention',{downloadId:d.id,requiresUser:true,message:d.userPrompt?.message??'This download is waiting for your response.'});}
      if (d.state === 'resolving' || d.state === 'needs-resolution') resolver.enqueue(d.id);
      return downloads.items().find((x) => x.id === d.id)!;
    },
    'download:pause': ({ id }) => downloads.pause(id),
    'download:resume': ({ id }) => downloads.resume(id),
    // A split game is one download for the user: its parts go together.
    'download:cancel': ({ id }) => { for (const p of partsOf(id)) { resolver.cancel(p); downloads.cancel(p); } },
    'download:retry': ({ id }) => {
      const d = downloadsRepo.get(id);
      if (d?.state === 'needs-resolution' || (d?.state === 'failed' && !d.url)) {
        downloadsRepo.update(id, { resolution: null, state: 'resolving', errorCode: null });
        syncSession();
        resolver.enqueue(id);
      } else downloads.resume(id);
    },
    'download:remove': ({ id, deleteFile }) => { for (const p of partsOf(id)) { resolver.cancel(p); downloads.remove(p, deleteFile); } },
    'download:move': ({ id, direction }) => {
      downloadsRepo.move(id, direction);
      downloads.broadcastList();
      downloads.pump();
    },
    'download:list': () => downloads.items(),
    'download:historySize': ({ which }) => downloads.historySize(which),
    'download:clearHistory': ({ which, deleteFiles }) => downloads.clearHistory(which, deleteFiles),
    'download:chooseFile': ({ id, url }) => resolver.chooseFile(id, url),
    'download:continueResolution': async ({ id }) => {
      if (humanBrowserActive) { await browser.endHuman(); restoreAfterHuman(); }
      syncSession();
      resolver.continueAfterUser(id);
    },
    'download:resolveAgain': ({ id }) => {
      downloadsRepo.update(id, { resolution: null, state: 'resolving', errorCode: null, errorDetail: null });
      syncSession();
      downloads.broadcastList();
      storeSearch.cancel();foreground.hold(`download:${id}`,false);
      resolver.enqueue(id);
    },
    'download:install': ({ id }) => {
      // A manual retry after a failed preparation: the AI session follows the work.
      const d = downloadsRepo.get(id);
      if (d?.installState === 'installed' && d.gameId !== null) throw new Error('This game is already in your Library');
      downloadsRepo.update(id, { installState: 'none', installDetail: 'Preparing…' });
      syncSession();
      return library.installFromDownload(id);
    },
    'download:reveal': ({ id }) => downloads.reveal(id),
    'browser:open': ({ url }) => {
      requireStore();
      return browserView.openUrl(url);
    },
    'browser:show': () => {
      if (humanBrowserActive) { publish('browser:humanMode', { active: true }); return; }
      requireStore();
      return browserView.showDefault(sourcesRepo.list().find((s) => s.enabled)?.url ?? null);
    },
    'browser:humanStart': async () => {
      requireStore();
      humanContext = browserView.activeContext;
      humanBrowserActive = true;
      // Cancels every Store automation before releasing the Firefox profile.
      session.leave();
      try {
        await browser.beginHuman(humanContext);
        publish('browser:humanMode', { active: true });
      } catch (e) {
        restoreAfterHuman();
        throw e;
      }
    },
    'browser:humanFinish': async () => {
      await browser.endHuman();
      restoreAfterHuman();
    },
    'browser:close': () => { storeSearch.releaseCheck(); browserView.close(null); },
    'browser:click': ({ x, y, button }) => {
      requireStore();
      return browserView.click(x, y, button);
    },
    'browser:scroll': ({ x, y, dx, dy }) => {
      requireStore();
      return browserView.scroll(x, y, dx, dy);
    },
    'browser:type': ({ text }) => {
      requireStore();
      return browserView.type(text);
    },
    'browser:key': ({ key }) => {
      requireStore();
      return browserView.key(key);
    },
    'browser:navigate': ({ action }) => {
      requireStore();
      return browserView.history(action);
    },
    'library:list': () => library.list(),
    'library:launch': ({ id }) => library.launch(id),
    'library:stop': ({ id }) => library.stop(id),
    'library:favorite': ({ id, favorite }) => library.setFavorite(id, favorite),
    'library:uninstall': ({ id, removePrefix }) => library.uninstall(id, removePrefix),
    'library:configure': ({ id, ...patch }) => library.configure(id, patch),
    'library:import': async () => {
      const game = await library.importGame();
      if (game) void identifier.imported(game.id).catch((e) => console.warn('[identify]', (e as Error).message));
      return game;
    },
    'library:searchCover': ({ term }) => identifier.search(term),
    'library:imageOptions': ({ id }) => gameImages.options(id),
    'stores:state': () => stores.state(),
    'stores:refresh': () => stores.refresh(),
    'stores:login': ({ store }) => stores.login(store),
    'stores:logout': ({ store }) => stores.logout(store),
    'stores:install': async ({ store, id }) => {
      void stores.install(store, id).then((gameId) => toast('success', tm('{title} is installed.', { title: gamesRepo.get(gameId)?.title ?? '' })))
        .catch((e) => { if ((e as Error).name !== 'AbortError') toast('error', tm('Could not install: {detail}', { detail: (e as Error).message })); });
      return stores.state();
    },
    'stores:cancel': ({ store, id }) => { stores.cancel(store, id); },
    'stores:pause': ({ store, id }) => { stores.pause(store, id); },
    'stores:resume': ({ store, id }) => { stores.resume(store, id); },
    'stores:remove': ({ store, id }) => { stores.remove(store, id); },
    'stores:adopt': async ({ store, id }) => {
      const r = await dialog.showOpenDialog(mainWindow!, { title: tm('Choose the folder where the game is installed'), properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      const gameId = await stores.adopt(store, id, r.filePaths[0]);
      return library.list().find((g) => g.id === gameId) ?? null;
    },
    'stores:linkGame': async ({ store, id, gameId }) => {
      const g = gamesRepo.get(gameId);
      if (!g?.installDir) throw new Error('That game has no folder.');
      const adoptedId = await stores.adopt(store, id, g.installDir);
      return library.list().find((x) => x.id === adoptedId) ?? null;
    },
    'stores:update': async ({ id }) => {
      void stores.update(id).then(() => toast('success', tm('{title} is up to date.', { title: gamesRepo.get(id)?.title ?? '' })))
        .catch((e) => { if ((e as Error).name !== 'AbortError') toast('error', tm('Could not update: {detail}', { detail: (e as Error).message })); });
    },
    // Quietly: no settings broadcast on every tab switch.
    'app:setLastTab': ({ tab }) => { settingsRepo.update({ lastTab: tab }); },
    'library:rename': ({ id, title }) => {
      identifier.rename(id, title);
      return library.list().find((g) => g.id === id) ?? null;
    },
    'app:sceneEvent': ({ event, detail }) => { console.log(`[scene] ${event} ${detail}`); },
    'library:setImage': ({ id, which, url }) => {
      gameImages.set(id, which, url);
      library.broadcast();
      return library.list().find((g) => g.id === id) ?? null;
    },
    'library:imageFromFile': async ({ id, which }) => {
      const r = await dialog.showOpenDialog(mainWindow!, { title: tm('Choose an image'), properties: ['openFile'], filters: [{ name: tm('Images'), extensions: IMAGE_EXTENSIONS }] });
      if (r.canceled || !r.filePaths[0]) return null;
      gameImages.fromFile(id, which, r.filePaths[0]);
      library.broadcast();
      return library.list().find((g) => g.id === id) ?? null;
    },
    'library:chooseCover': async ({ id, appid, name }) => {
      await identifier.choose(id, appid, name);
      return library.list().find((g) => g.id === id) ?? null;
    },
    'library:pickExecutable': ({ id }) => library.pickExecutable(id),
    'library:runInstaller': ({ id }) => library.runInstaller(id),
    'library:reveal': ({ id }) => library.reveal(id),
    'library:update': ({ id }) => library.startUpdate(id),
    'library:ignoreUpdate': ({ id }) => library.ignoreUpdate(id),
    'library:rollback': ({ id }) => library.rollback(id),
    'library:checkUpdates': () => {
      void stores.checkUpdates().catch(() => undefined);
      return { checking: updates.checkNow() };
    },
    'library:deleteArchive': ({ id }) => library.deleteArchive(id),
    'library:saves': ({ id }) => library.listSaves(id),
    'library:backupSaves': ({ id }) => library.backupSaves(id, 'made by you'),
    'library:restoreSaves': ({ id, stamp }) => library.restoreSaves(id, stamp),
    'library:openSaves': ({ id }) => library.openSaves(id),
    'library:shortcut': ({ id, where }) => library.shortcut(id, where, appIcon()),
    'library:resetRuntimes': ({ id }) => library.resetRuntimes(id),
    'launcher:updateStatus': () => selfUpdate.status(),
    'library:stats': () => gamesRepo.playStats(),
    'launcher:checkUpdate': () => selfUpdate.check(true),
    'launcher:downloadUpdate': () => selfUpdate.download(),
    'launcher:cancelUpdate': () => selfUpdate.cancel(),
    'launcher:installUpdate': () => selfUpdate.install(),
    'launcher:installFromFile': async () => {
      const r = await dialog.showOpenDialog(mainWindow!, { title: tm('Choose the new Cool Games Launcher AppImage'), properties: ['openFile'], filters: [{ name: 'AppImage', extensions: ['AppImage', 'appimage'] }] });
      if (r.canceled || !r.filePaths[0]) return false;
      selfUpdate.installFile(r.filePaths[0]);
      return true;
    },
    'app:diagnostics': () => {
      const path = writeDiagnostics({ version: app.getVersion(), logsDir: paths.logs, ai: ai.getStatus(), settings: settingsRepo, sources: sourcesRepo, downloads: downloadsRepo, games: gamesRepo, storeJobs: stores.state().jobs });
      shell.showItemInFolder(path);
      return { path };
    },
    'library:keepArchive': ({ id }) => library.keepArchive(id),
  };
  registerIpc(handlers, trusted);

  mainWindow = createWindow();
  attach(mainWindow.webContents);
  // Name and icon for the taskbar (see ensureLauncherEntry).
  try { ensureLauncherEntry({ appImage: process.env.APPIMAGE, icon: appIcon() }); } catch (e) { console.warn('[main] menu entry:', (e as Error).message); }
  if (process.env.CGL_DEBUG) {
    mainWindow.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`));
  }
  const visibility = () => {
    const visible = !!mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized();
    browserView.setWindowVisible(visible);
    publish('app:visibility', { visible });
  };
  for (const ev of ['minimize', 'restore', 'hide', 'show'] as const) mainWindow.on(ev as 'show', visibility);
  mainWindow.on('closed', () => {
    mainWindow = null;
    session.leave();
  });
  // Starting the AppImage again (or a game shortcut) reuses this instance.
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    const game = gameFromArgs(argv);
    if (game !== null) launchFromShortcut(game);
  });
  const launchFromShortcut = (id: number) => void library.launch(id).catch((e) => toast('error', tm('Could not start the game: {detail}', { detail: (e as Error).message })));
  const startGame = gameFromArgs(process.argv);
  if (startGame !== null) setTimeout(() => launchFromShortcut(startGame), 1500);

  // The tray keeps the launcher running when its window is closed.
  const tray = new LauncherTray({
    icon: appIcon(), window: () => mainWindow, couch: () => publish('app:couch', { on: true }),
    launch: launchFromShortcut, quit: () => app.quit(),
  });
  if (tray.start()) {
    library.onChanged((games) => tray.setGames(games));
    onLanguage(() => tray.refresh());
  }
  let trayHintShown = false;
  mainWindow.on('close', (e) => {
    if (appQuitting || !tray.active || !settingsRepo.get().closeToTray) return;
    e.preventDefault();
    mainWindow?.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      if (Notification.isSupported()) new Notification({ title: tm('Still running in the tray'), body: tm('Downloads and game preparation continue. Quit from the tray icon, or turn this off in Settings.') }).show();
    }
  });

  // Window controls for the frameless window, through the same validated IPC surface.
  ipcMain.on('cgl:window', (e, action: unknown) => {
    if (!mainWindow || e.sender !== mainWindow.webContents) return;
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
    else if (action === 'close') mainWindow.close();
    else if (typeof action === 'string' && /^close-sound:\d{1,4}$/.test(action)) {
      closeSoundUntil = Date.now() + Number(action.slice('close-sound:'.length));
      // To the tray: the hidden window finishes the sound. Quitting: hide now, quit when the sound ends.
      if (tray.active && settingsRepo.get().closeToTray) mainWindow.close();
      else {
        mainWindow.hide();
        app.quit();
      }
    }
    else if (action === 'fullscreen-on') mainWindow.setFullScreen(true);
    else if (action === 'fullscreen-off') mainWindow.setFullScreen(false);
  });

  // Development aid: with CGL_DEV_CAPTURE=<dir>, SIGUSR2 saves a window screenshot there,
  // and SIGUSR1 runs <dir>/eval.js in the renderer (for scripted UI checks).
  const captureDir = process.env.CGL_DEV_CAPTURE;
  if (captureDir && !app.isPackaged) {
    let n = 0;
    const { writeFileSync, readFileSync } = await import('node:fs');
    process.on('SIGUSR2', () => {
      void mainWindow?.webContents.capturePage().then((img) => writeFileSync(join(captureDir, `shot-${++n}.png`), img.toPNG()));
    });
    process.on('SIGUSR1', () => {
      try {
        const code = readFileSync(join(captureDir, 'eval.js'), 'utf8');
        void mainWindow?.webContents
          .executeJavaScript(code)
          .then((r) => writeFileSync(join(captureDir, 'eval.out'), JSON.stringify(r ?? null, null, 2)))
          .catch((e) => writeFileSync(join(captureDir, 'eval.out'), `ERROR ${e}`));
      } catch (e) {
        console.error(e);
      }
    });
  }

  // Ends the process once all state is flushed. Chromium's own teardown (app.exit / process.exit)
  // intermittently deadlocks here after the utility processes stop, so the process ends itself;
  // its Chromium children exit with it.
  const terminate = () => {
    const left = closeSoundUntil - Date.now();
    if (left > 0) { setTimeout(terminate, left); return; }
    if (relaunchInto) startAfterExit(relaunchInto);
    process.kill(process.pid, 'SIGKILL');
  };

  // Stops AI, browser and workers and flushes the database. Idempotent.
  let cleanup: Promise<void> | null = null;
  const shutdownServices = () =>
    (cleanup ??= (async () => {
      console.log('[main] shutting down');
      shuttingDown = true;
      storeRequestedActive = false;
      clearInterval(protonRefreshTimer);
      updates.stop();
      descriptions.stop();
      resolver.shutdown();
      library.shutdown();
      await Promise.all([stores.shutdown(), downloads.shutdown()]);
      session.leave();
      try {
        const s = settingsRepo.get();
        await Promise.race([
          Promise.all([browser.shutdown(), ai.unload()]).then(async () => {
            if (s.clearBrowserDataOnExit) await browser.clearData().catch(() => undefined);
          }),
          new Promise((r) => setTimeout(r, 4000)),
        ]);
        for (const w of [inferenceWorker, browserWorker, downloadsWorker, installWorker, artworkWorker, ...fetcherWorkers]) w.stop();
        db.close();
        console.log('[main] services stopped');
      } catch (err) {
        console.error('[main] shutdown error', err);
      }
    })());

  let quitting = false;
  app.on('before-quit', (e) => {
    appQuitting = true;
    if (quitting) return;
    quitting = true;
    tray.destroy();
    e.preventDefault();
    void shutdownServices().finally(terminate);
  });
  // Session logout or `kill`: same cleanup, without entering Chromium's quit path.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => void shutdownServices().finally(terminate));
  app.on('window-all-closed', () => app.quit());

  if (!vendorStatus().firefox) {
    toast('warning', tm('Some bundled components are missing. Run “npm run vendor” in the source tree to fetch them.'));
  }
}

main().catch((e) => {
  console.error(e);
  dialog.showErrorBox('Cool Games Launcher failed to start', String(e?.stack ?? e));
  app.exit(1);
});
