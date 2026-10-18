// Browser utility process: drives the bundled Firefox through geckodriver with
// a dedicated profile, uBlock Origin and Cookie-Editor. Exposes only navigation, inspection
// and input forwarding — nothing here can touch the filesystem or a shell on
// behalf of a web page.
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WebDriver } from 'selenium-webdriver';
import { extractPage, type PageExtract } from '@shared/page-extract';
import {closestElement} from '@shared/dom-ancestor';
import {downloadPageKey,withoutChallengeTokens} from '@shared/download-page';
import { downloadEvidence, isFileUrl, isHostLanding,isTorrentDownload } from '@shared/download-evidence';
import { emit, log, serve, throwIfAborted } from './rpc';
import {connectInstalledFirefox} from './installed-firefox';
import { NormalFirefox } from './normal-firefox';
import { VerificationResume, type VerificationObservation } from '@shared/verification-resume';

process.title = 'cgl-browser';
process.env.SE_OFFLINE = 'true'; // never let Selenium Manager reach the network

type ContextName = 'interactive' | 'discovery' | 'updates' | 'dates' | 'index';

interface InitParams {
  firefoxPath: string;
  geckodriverPath: string;
  profileDir: string;
  ublockXpi: string;
  cookieEditorXpi?: string;
  browserMode?: 'ai' | 'normal' | 'installed';
    installedBinary?:string;
  stagingDir: string;
  doNotTrack: boolean;
  width: number;
  height: number;
  headless?: boolean;
}

let cfg: InitParams | null = null;
let driver: WebDriver | null = null;
let normalFirefox: NormalFirefox | null = null;
let starting: Promise<WebDriver> | null = null;
let stopping=false;
let liveHuman: { context: ContextName; handle: string; lastUrl: string; verification?: VerificationResume } | null = null;
let humanMonitor: ReturnType<typeof setInterval> | null = null;
const headless = () => cfg?.headless ?? !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const resumeUrls = new Map<ContextName, string>();
const windows = new Map<ContextName, string>();
const savedSourceTabs=new Map<string,string>();
const closedContexts=new Set<ContextName>();
const latePopups=new Map<ContextName,{handle:string;old:Set<string>;before:string;expected:string|null;expires:number}>();
let current: ContextName | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Native visibility does not destroy the document or its CAPTCHA session. */
async function nativeVisibility(d: WebDriver, visible: boolean) {
  if(normalFirefox){await normalFirefox.nativeVisibility(visible);return;}
  const firefox = d as import('selenium-webdriver/firefox').Driver;
  await firefox.setContext('chrome' as import('selenium-webdriver/firefox').Context);
  try {
    await firefox.executeScript(`
      const dir=Services.dirsvc.get('GreD',Ci.nsIFile);dir.append('cgl-browser');
      Services.io.getProtocolHandler('resource').QueryInterface(Ci.nsIResProtocolHandler).setSubstitution('cgl-browser',Services.io.newFileURI(dir));
      ChromeUtils.importESModule('resource://cgl-browser/CglBackground.sys.mjs').hiddenRenderer(window).touch(!arguments[0]);
      Services.prefs.setBoolPref('cgl.browser.userControl', arguments[0]);
      Services.prefs.setBoolPref('browser.tabs.loadDivertedInBackground', !arguments[0]);
      Services.prefs.setIntPref('browser.link.open_newwindow.restriction', arguments[0] ? 2 : 0);
      if (arguments[0]) {
        window.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).visibility = true;
      } else {
        for (const win of Services.wm.getEnumerator('navigator:browser')) {
          win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).visibility = false;
        }
      }
    `, visible);
  } finally { await firefox.setContext('content' as import('selenium-webdriver/firefox').Context); }
}

/** Serialises every command and keeps background work off the desktop. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    try { return await fn(); }
    finally {
      if (driver && !liveHuman && !headless()) {
        await nativeVisibility(driver, false).catch(error => log('Could not hide background Firefox:', (error as Error).message));
      }
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

function prefs(c: InitParams): string {
  const p: Record<string, string | number | boolean> = {
    'extensions.autoDisableScopes': 0,
    'extensions.enabledScopes': 15,
    'extensions.update.enabled': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.aboutwelcome.enabled': false,
    'browser.tabs.warnOnClose': false,
    'browser.link.open_newwindow': 3,
    'browser.link.open_newwindow.restriction': 0,
    'browser.tabs.loadInBackground': true,
    'browser.tabs.loadDivertedInBackground': true,
    'browser.sessionstore.resume_from_crash': false,
    'browser.startup.page': 0,
    'browser.startup.blankWindow': false,
    'browser.sessionstore.resume_session_once': false,
    'browser.sessionstore.interval': 15000,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.enabled': false,
    'app.update.auto': false,
    'browser.download.folderList': 2,
    'browser.download.dir': c.stagingDir,
    'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
    'browser.download.start_downloads_in_tmp_dir': false,
    'browser.download.alwaysOpenPanel': false,
    'browser.download.manager.addToRecentDocs': false,
    'pdfjs.disabled': false,
    'dom.disable_open_during_load': true,
    'media.autoplay.default': 5,
    'permissions.default.desktop-notification': 2,
    'permissions.default.geo': 2,
    'permissions.default.camera': 2,
    'permissions.default.microphone': 2,
    'privacy.donottrackheader.enabled': c.doNotTrack,
    'privacy.globalprivacycontrol.enabled': c.doNotTrack,
    'signon.rememberSignons': false,
    'dom.webnotifications.enabled': false,
    'network.protocol-handler.external-default': false,
    'network.protocol-handler.warn-external-default': true,
  };
  return Object.entries(p)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n');
}

function prepareProfile(c: InitParams) {
  mkdirSync(join(c.profileDir, 'extensions'), { recursive: true, mode: 0o700 });
  mkdirSync(c.stagingDir, { recursive: true });
  for (const [id, source] of [
    ['uBlock0@raymondhill.net', c.ublockXpi],
    ['{c3c10168-4186-445c-9c5b-63f12b8e2c87}', c.cookieEditorXpi],
  ]) {
    const target = join(c.profileDir, 'extensions', `${id}.xpi`);
    if (source && existsSync(source) && (!existsSync(target) || statSync(target).size !== statSync(source).size)) {
      copyFileSync(source, target);
    }
  }
  writeFileSync(join(c.profileDir, 'user.js'), prefs(c));
  // A stale lock after a crash would stop Firefox from reusing the profile.
  if(c.browserMode!=='installed')for (const f of ['lock', '.parentlock']) rmSync(join(c.profileDir, f), { force: true });
}

async function getDriver(): Promise<WebDriver> {
  if(stopping)throw Error('The launcher browser is shutting down.');
  if (liveHuman) throw new Error('Firefox is under direct human control. Return to the launcher before resuming AI.');
  if (driver) return driver;
  if (starting) return starting;
  if (!cfg) throw new Error('Browser worker not initialised');
  const c = cfg;
  starting = (async () => {
    if (!existsSync(c.firefoxPath)) throw new Error('Bundled Firefox is missing');
    prepareProfile(c);
    if (c.browserMode === 'normal'||c.browserMode === 'installed') {
      normalFirefox = c.browserMode==='installed' ? await connectInstalledFirefox({bridgeDir:require('node:path').dirname(c.firefoxPath),profileDir:c.profileDir,binary:c.installedBinary}) : await NormalFirefox.start({...c,headless:headless()});
      const d = normalFirefox.asDriver();
      if (!headless()) await nativeVisibility(d, false);
      windows.clear(); windows.set('interactive', await d.getWindowHandle());
      current = 'interactive'; driver = d;
      log(c.browserMode==='installed'?'installed Firefox connected (dedicated launcher profile, no WebDriver)':'normal Firefox session started (local bridge, no WebDriver)');
      return d;
    }
    const { Builder } = require('selenium-webdriver') as typeof import('selenium-webdriver');
    const firefox = require('selenium-webdriver/firefox') as typeof import('selenium-webdriver/firefox');
    const opts = new firefox.Options()
      .setBinary(c.firefoxPath)
      .addArguments('-profile', c.profileDir, '-no-remote')
      .windowSize({ width: c.width, height: c.height });
    if (headless()) opts.addArguments('-headless');
    opts.setPageLoadStrategy('eager');
    const service = new firefox.ServiceBuilder(c.geckodriverPath).addArguments('--allow-system-access');
    const d = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).setFirefoxService(service).build();
    if (!headless()) await nativeVisibility(d, false);
    await d.manage().setTimeouts({ pageLoad: 30000, script: 15000, implicit: 0 });
    windows.clear();
    windows.set('interactive', await d.getWindowHandle());
    current = 'interactive';
    driver = d;
    log('firefox session started');
    return d;
  })();
  try {
    const d=await starting;
    if(stopping){await shutdownDriver();throw Error('The launcher browser is shutting down.');}
    return d;
  } finally {
    starting = null;
  }
}

async function useContext(ctx: ContextName): Promise<WebDriver> {
  const d = await getDriver();
  let handle = windows.get(ctx);
  let handles = await d.getAllWindowHandles();
  const live=handle&&handles.includes(handle)?handle:handles[0];
  if(live)await d.switchTo().window(live);
  let chromeDialog=false;
  if(normalFirefox)chromeDialog=await normalFirefox.hasDialog();
  else {
    const f=d as import('selenium-webdriver/firefox').Driver;
    try{await f.setContext('chrome' as import('selenium-webdriver/firefox').Context);chromeDialog=await d.executeScript<boolean>("return document.documentElement.hasAttribute('window-modal-open')");}
    finally{await f.setContext('content' as import('selenium-webdriver/firefox').Context);}
  }
  if(chromeDialog){
    if(!headless())await revealHuman(d,{context:current??'interactive'});
    throw Error('Firefox setup needs your attention. Complete it in Firefox and return control to the launcher.');
  }
  const late=latePopups.get(ctx);
  const otherContexts=new Set([...windows.entries()].filter(([name])=>name!==ctx).map(([,h])=>h));
  if(late){
    if(late.expires<Date.now()||late.handle!==handle||!handles.includes(late.handle))latePopups.delete(ctx);
    else if(handles.some(h=>!late.old.has(h)&&!otherContexts.has(h))){
      latePopups.delete(ctx);
      await d.switchTo().window(late.handle);
      await adoptClickPopup(d,ctx,late.old,late.before,late.expected,true,AbortSignal.timeout(15000));
      handle=windows.get(ctx);
      handles=await d.getAllWindowHandles();
    }
  }
  if (!handle || !handles.includes(handle)) {
    const recovered=handle&&[...savedSourceTabs.entries()].reverse().find(([key,h])=>key.startsWith(ctx+'|')&&handles.includes(h))?.[1];
    if(handle)closedContexts.add(ctx);
    if(recovered){handle=recovered;await d.switchTo().window(handle);}
    else if (handles.length && !windows.size) {
      handle = handles[0];
    } else {
      await d.switchTo().newWindow('tab');
      handle = await d.getWindowHandle();
    }
    windows.set(ctx, handle);
    current = ctx;
    await restorePage(d, ctx);
    return d;
  }
  // A tab may keep its handle while redirects or a human's tab selection
  // discard Marionette's current browsing context. Re-select the live tab
  // even when our logical context name did not change.
  await d.switchTo().window(handle);
  current = ctx;
  // Close stray popups the page may have opened in this session.
  if (handles.length > windows.size + 2) {
    const known = new Set([...windows.values(),...savedSourceTabs.values()]);
    for (const h of handles) {
      if (!known.has(h)) {
        await d.switchTo().window(h);
        await d.close();
      }
    }
    await d.switchTo().window(handle);
  }
  await restorePage(d, ctx);
  return d;
}

async function restorePage(d: WebDriver, ctx: ContextName) {
  const url = resumeUrls.get(ctx);
  if (!url) return;
  resumeUrls.delete(ctx);
  await d.get(url).catch(() => undefined);
}

function isHttp(url: string) {
  return /^https?:\/\//i.test(url);
}

function pageLocation(url: string) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
}

async function navigate(p: { context: ContextName; url: string; onlyIfBlank?: boolean }, signal: AbortSignal) {
  if (!isHttp(p.url)) throw new Error('Only http(s) pages can be opened');
  return exclusive(async () => {
    latePopups.delete(p.context);
    throwIfAborted(signal);
    const d = await useContext(p.context);
    // Check inside the serialized browser operation, not a stale screenshot.
    const currentUrl = await d.getCurrentUrl();
    if (process.env.CGL_DEBUG) log('navigate', {context:p.context,from:pageLocation(currentUrl),to:pageLocation(p.url)});
    if (p.onlyIfBlank && /^https?:/i.test(currentUrl)) return {url:currentUrl,title:await d.getTitle()};
    // Attachment navigation leaves the original document open. Don't spend
    // 30 seconds waiting for a document that Firefox is downloading instead.
    const fileNavigation = isFileUrl(p.url) && !isHostLanding(p.url);
    if (fileNavigation) await d.manage().setTimeouts({pageLoad:3000});
    try {
      await d.get(p.url);
    } catch (e) {
      // Timeouts on slow pages still leave a usable document.
      if (!/timeout|timed out|NS_BINDING_ABORTED|NS_ERROR_WONT_HANDLE_CONTENT/i.test((e as Error).message)) throw e;
    } finally { if (fileNavigation) await d.manage().setTimeouts({pageLoad:30000}); }
    const result = { url: await d.getCurrentUrl(), title: await d.getTitle() };
    if (process.env.CGL_DEBUG) log('navigated', {context:p.context,url:pageLocation(result.url),title:result.title});
    return result;
  });
}

/** Restore the observed links viewport, reusing a source tab left by a popup. */
async function returnToPage(p: { context: ContextName; url: string; scrollY: number }, signal: AbortSignal) {
  if (!isHttp(p.url) || !Number.isFinite(p.scrollY) || p.scrollY < 0) throw new Error('Invalid return page');
  const target=withoutChallengeTokens(p.url),isTarget=(url:string)=>downloadPageKey(url)===downloadPageKey(target);
  return exclusive(async () => {
    throwIfAborted(signal);
    const d = await useContext(p.context);
    let reused = isTarget(await d.getCurrentUrl());
    if (!reused) {
      const original = await d.getWindowHandle();
      const otherContexts = new Set([...windows.entries()].filter(([ctx]) => ctx !== p.context).map(([, handle]) => handle));
      for (const handle of await d.getAllWindowHandles()) {
        if (handle === original || otherContexts.has(handle)) continue;
        throwIfAborted(signal);
        await d.switchTo().window(handle);
        if (isTarget(await d.getCurrentUrl())) {
          windows.set(p.context, handle); current = p.context; reused = true;
          break;
        }
      }
      if (!reused) {
        await d.switchTo().window(original);
        // Jump straight to the observed source history entry, skipping all
        // intermediate host pages. Firefox can restore the document from its
        // back/forward cache, including expanded sections and lazy content.
        const firefox = d as import('selenium-webdriver/firefox').Driver;
        let jumped = false;
        try {
          await firefox.setContext('chrome' as import('selenium-webdriver/firefox').Context);
          jumped = await firefox.executeScript<boolean>(`
            const browser = gBrowser.selectedBrowser, history = browser.browsingContext.sessionHistory;
            if (!history) return false;
            for (let i = history.index - 1; i >= 0; i--) {
              if ((${withoutChallengeTokens.toString()})(history.getEntryAtIndex(i).URI.spec) === arguments[0]) {
                browser.webNavigation.gotoIndex(i); return true;
              }
            }
            return false;
          `, target);
        } catch { /* A new session or unsupported history API uses the saved URL. */ }
        finally { await firefox.setContext('content' as import('selenium-webdriver/firefox').Context); }
        if (jumped) {
          try {
            await d.wait(async () => {
              throwIfAborted(signal);
              return isTarget(await d.getCurrentUrl()) && await d.executeScript('return document.readyState !== "loading"');
            }, 3000, 'Waiting for the saved game page', 50);
            reused = true;
          } catch { throwIfAborted(signal); }
        }
        if (!reused) {
          throwIfAborted(signal);
          try { await d.get(target); } catch (error) {
            if (!/timeout|NS_BINDING_ABORTED|NS_ERROR_WONT_HANDLE_CONTENT/i.test((error as Error).message)) throw error;
          }
        }
      }
    }
    throwIfAborted(signal);
    if (!isTarget(await d.getCurrentUrl())) throw new Error('The saved game download-links page redirected elsewhere.');
    // Absolute positioning avoids an AI scroll/search loop. Retry briefly when
    // late images increase the document height after a reload.
    const scrollY = await d.executeAsyncScript<number>(`
      const top = arguments[0], done = arguments[arguments.length - 1], start = Date.now();
      function restore() {
        window.scrollTo({top, left: 0, behavior: 'instant'});
        if (Math.abs(window.scrollY - top) <= 2 || Date.now() - start >= 1200) done(window.scrollY);
        else setTimeout(restore, 50);
      }
      restore();
    `, p.scrollY);
    throwIfAborted(signal);
    const sourceKey=p.context+'|'+downloadPageKey(p.url);
    savedSourceTabs.delete(sourceKey);savedSourceTabs.set(sourceKey,await d.getWindowHandle());
    closedContexts.delete(p.context);
    // Retain the live links document across host popups, including its expanded
    // controls and dismissed warnings, without accumulating tabs indefinitely.
    while(savedSourceTabs.size>4)savedSourceTabs.delete(savedSourceTabs.keys().next().value!);
    return { url: await d.getCurrentUrl(), scrollY, reused };
  });
}

async function snapshot(p: { context: ContextName; withMedia?: boolean; labels?: boolean }) {
  return exclusive(async () => {
    const d = await useContext(p.context);
    let layer: unknown;
    let png: string;
    try {
      if (p.labels) layer = await d.executeScript(`
        const layer=document.createElement('div');
        layer.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none';
        const shadow=layer.attachShadow({mode:'closed'});
        for(const el of document.querySelectorAll('[data-cgl-i]')){
          const r=el.getBoundingClientRect(),s=getComputedStyle(el);
          if(r.width<2||r.height<2||r.bottom<0||r.right<0||r.top>=innerHeight||r.left>=innerWidth||s.display==='none'||s.visibility==='hidden')continue;
          const badge=document.createElement('span');badge.textContent=el.getAttribute('data-cgl-i');
          badge.style.cssText='position:absolute;background:#ffe600;color:#000;font:bold 15px monospace;border:1px solid #111;border-radius:3px;padding:1px 3px;line-height:18px;pointer-events:none';
          badge.style.left=Math.max(0,r.left)+'px';badge.style.top=Math.max(0,r.top-20)+'px';shadow.append(badge);
        }
        document.documentElement.append(layer);return layer;
      `);
      png = await d.takeScreenshot();
    } finally {
      if(layer) await d.executeScript('arguments[0].remove()',layer).catch(()=>undefined);
    }
    const info = (await d.executeScript(
      `return { url: location.href, title: document.title, loading: document.readyState !== 'complete',
        dpr: window.devicePixelRatio || 1, w: window.innerWidth, h: window.innerHeight }`,
    )) as { url: string; title: string; loading: boolean; dpr: number; w: number; h: number };
    let media: PageExtract['media'] = [];
    let adultSignals: string[] = [];
    let gates: PageExtract['gates'] | undefined;
    if (p.withMedia) {
      const ex = (await d.executeScript(`return (${extractPage.toString()})(arguments[0])`, { maxLinks: 0, maxControls: 0, mark: false })) as PageExtract;
      media = ex.media;
      adultSignals = ex.adultSignals;
      gates = ex.gates;
    }
    return { png, ...info, media, adultSignals, gates };
  });
}

async function extract(p: { context: ContextName }) {
  return exclusive(async () => {
    const d = await useContext(p.context);
    // HTMX can receive a Cloudflare challenge in an XHR without displaying it
    // in the DOM. Open that observed request so the human can see the check.
    const gate = await d.executeScript('const u = window.__cglHtmxGate; window.__cglHtmxGate = null; return u || null;') as string | null;
    if (gate && isHttp(gate) && new URL(gate).origin === new URL(await d.getCurrentUrl()).origin) {
      await d.get(gate).catch((e: Error) => {
        if (!/timeout|NS_BINDING_ABORTED|NS_ERROR_WONT_HANDLE_CONTENT/i.test(e.message)) throw e;
      });
    }
    // A popup can acquire its destination URL before the HTML parser creates
    // its root. Let that transient state settle instead of rejecting a host.
    for(let n=0;n<40;n++){
      if(await d.executeScript('return !!document.documentElement && document.readyState !== "loading"'))break;
      await d.sleep(50);
    }
    const ex = (await d.executeScript(`return (${extractPage.toString()})(arguments[0])`, p.context === 'discovery' ? {maxLinks:20000,maxCards:10000} : {})) as PageExtract;
    if(closedContexts.delete(p.context))ex.navigationRecovery='closed-tab';
    if (process.env.CGL_DEBUG) log('observed', {context:p.context,url:pageLocation(ex.url),title:ex.title,gates:ex.gates});
    return ex;
  });
}

/** An atomic background read in its own tab; never moves the user's browser
 * or the indexer's tab between their navigation and extraction commands. */
async function readUpdatePage(p: { url: string }, signal: AbortSignal) {
  if (!isHttp(p.url)) throw new Error('Invalid game page URL');
  return exclusive(async () => {
    throwIfAborted(signal);
    const previous = current;
    const d = await useContext('updates');
    try {
      await d.get(p.url);
      await new Promise(resolve => setTimeout(resolve, 500));
      throwIfAborted(signal);
      let ex = await d.executeScript(`return (${extractPage.toString()})({mark:false,maxLinks:1000,maxControls:300})`) as PageExtract;
      // Let normal verification redirects and script-generated links settle.
      for (let n = 0; n < 8 && (ex.gates.captcha || ex.gates.blocked || !downloadEvidence(ex).length); n++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        throwIfAborted(signal);
        ex = await d.executeScript(`return (${extractPage.toString()})({mark:false,maxLinks:1000,maxControls:300})`) as PageExtract;
      }
      return ex;
    } finally {
      if (previous && windows.has(previous)) await useContext(previous).catch(() => undefined);
    }
  });
}

/** Deterministic rendering for date metadata: no model, links or AI actions. */
async function fetchPages(p:{urls:string[]},signal:AbortSignal){
  if(!p.urls.length||p.urls.length>6||p.urls.some(url=>!isHttp(url)||new URL(url).origin!==new URL(p.urls[0]).origin||isFileUrl(url)||isTorrentDownload('',url)))throw Error('Invalid indexing page batch');
  return exclusive(async()=>{
    throwIfAborted(signal);
    if(liveHuman)return p.urls.map(url=>({url,status:0,html:null,ms:0}));
    const previous=current,d=await useContext('index');
    try{
      if(new URL(await d.getCurrentUrl()).origin!==new URL(p.urls[0]).origin){
        await d.manage().setTimeouts({pageLoad:15000});
        try{await d.get(p.urls[0]);}catch(error){if(!/timeout|NS_BINDING_ABORTED/i.test((error as Error).message))throw error;}
        finally{await d.manage().setTimeouts({pageLoad:30000});}
      }
      if(new URL(await d.getCurrentUrl()).origin!==new URL(p.urls[0]).origin)return p.urls.map(url=>({url,status:0,html:null,ms:0}));
      // Same-origin page fetches use Firefox's real network/session without
      // navigating each game, executing its scripts or consulting the AI.
      const out=await d.executeAsyncScript(`
        const urls=arguments[0],done=arguments[arguments.length-1];
        Promise.all(urls.map(async url=>{const start=Date.now();try{
          const r=await window.fetch(url,{credentials:'same-origin',mode:'same-origin',signal:window.AbortSignal.timeout(8000)});
          if(!/html|xml/i.test(r.headers.get('content-type')||'')){await r.body?.cancel();return {url:r.url,status:r.status,html:null,ms:Date.now()-start};}
          const reader=r.body.getReader(),chunks=[];let bytes=0;
          for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>8*1024*1024){await reader.cancel();return {url:r.url,status:r.status,html:null,ms:Date.now()-start};}chunks.push(part.value);}
          const data=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
          return {url:r.url,status:r.status,html:new TextDecoder().decode(data),ms:Date.now()-start};
        }catch{return {url,status:0,html:null,ms:Date.now()-start};}})).then(done);`,p.urls);
      throwIfAborted(signal);return out as import('../main/browser-client').BrowserHtml[];
    }finally{if(previous&&windows.has(previous))await useContext(previous).catch(()=>undefined);}
  });
}

async function readDatePage(p: {url: string; detail?: boolean}, signal: AbortSignal) {
  if (!isHttp(p.url)) throw new Error('Invalid date page URL');
  return exclusive(async () => {
    throwIfAborted(signal);
    const previous = current, d = await useContext('dates');
    try {
      // A human may just have completed a check on this exact live page.
      if (await d.getCurrentUrl() !== p.url) {
        await d.manage().setTimeouts({pageLoad:15000});
        try { await d.get(p.url); }
        catch (error) { if (!/timeout|NS_BINDING_ABORTED/i.test((error as Error).message)) throw error; }
        finally { await d.manage().setTimeouts({pageLoad:30000}); }
      }
      for (let n = 0; ; n++) {
        throwIfAborted(signal);
        const ex = await d.executeScript(`return (${extractPage.toString()})({mark:false,fast:true,maxLinks:1000,maxControls:0})`) as PageExtract;
        if (n >= 8 || !ex.gates.captcha && !ex.gates.blocked && (p.detail ? !!ex.published : !!ex.cards.length)) return ex;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } finally {
      if (previous && windows.has(previous)) await useContext(previous).catch(() => undefined);
    }
  });
}

// Installed before either click tool fires. A challenge in an HTMX response
// otherwise leaves the visible page unchanged and the agent keeps clicking.
async function watchDownloadRequest(d: WebDriver, element: unknown) {
  await d.executeScript(`
    const el = arguments[0];
    if (!el || el.__cglWatchingRequest) return;
    const request = el.getAttribute('hx-get') || el.getAttribute('data-hx-get');
    if (!request) return;
    const url = new URL(request, document.baseURI);
    if (url.origin !== location.origin) return;
    el.__cglWatchingRequest = true;
    el.addEventListener('htmx:afterRequest', (event) => {
      const xhr = event.detail && event.detail.xhr;
      if (xhr && xhr.status === 403 && /just a moment|challenge-platform|challenges.cloudflare.com/i.test(String(xhr.responseText).slice(0, 10000))) {
        window.__cglHtmxGate = url.href;
      }
    });
  `, element);
}

async function pointer(p: { context: ContextName; x: number; y: number; button?: 'left' | 'middle' | 'right' },signal:AbortSignal) {
  return exclusive(async () => {
    throwIfAborted(signal);
    const d = await useContext(p.context);
    const before=await d.getCurrentUrl(),oldHandles=new Set(await d.getAllWindowHandles());
    const target=await d.executeScript(`const el=(${closestElement.toString()})(document.elementFromPoint(arguments[0],arguments[1]),'a,button,[role="button"]');return {href:el?.href||null,text:el?.innerText||''}`,p.x,p.y) as {href:string|null;text:string};
    throwIfAborted(signal);
    if(p.button !== 'right' && p.button !== 'middle') {
      const element = await d.executeScript(`return (${closestElement.toString()})(document.elementFromPoint(arguments[0],arguments[1]),'a,button,input,[role=button],[hx-get],[data-hx-get]')`,p.x,p.y);
      await watchDownloadRequest(d,element);
    }
    const { Origin, Button } = require('selenium-webdriver/lib/input') as typeof import('selenium-webdriver/lib/input');
    const btn = p.button === 'right' ? Button.RIGHT : p.button === 'middle' ? Button.MIDDLE : Button.LEFT;
    await d
      .actions({ async: true })
      .move({ x: Math.round(p.x), y: Math.round(p.y), origin: Origin.VIEWPORT })
      .press(btn)
      .release(btn)
      .perform();
    if(p.button!=='right'&&p.button!=='middle'){
      await d.sleep(600);throwIfAborted(signal);
      await adoptClickPopup(d,p.context,oldHandles,before,target.href,!!target.href||/download|mirror|get (?:the )?(?:game|file)/i.test(target.text),signal);
    }
  });
}

async function inspectPoint(p:{context:ContextName;x:number;y:number}){
  return exclusive(async()=>{
    const d=await useContext(p.context);
    return d.executeScript(`
      const hit=document.elementFromPoint(arguments[0],arguments[1]);
      const closest=(${closestElement.toString()});
      const el=closest(hit,'a,button,input,textarea,[role="button"],[role="link"]')||hit;
      const text=(el?.innerText||el?.getAttribute('aria-label')||el?.getAttribute('placeholder')||'').slice(0,240);
      // Forms can shadow DOM methods through named child controls. Invoke the
      // Element methods directly rather than trusting properties on the page.
      const marked=closest(el,'[data-cgl-i]');
      const id=marked instanceof Element?Element.prototype.getAttribute.call(marked,'data-cgl-i'):null;
      return {text,index:id==null?null:Number(id),href:el?.href||null,password:el?.type==='password',untrustedRegion:!el||!!closest(el,'aside,[data-ad],.advertisement,.sponsored'),download:!!el?.hasAttribute('download')||/\\.(zip|rar|7z|exe|msi)([?#]|$)/i.test(el?.href||'')};
    `,p.x,p.y);
  });
}

async function movePointer(p:{context:ContextName;x:number;y:number;drag?:boolean},signal:AbortSignal){
  return exclusive(async()=>{
    throwIfAborted(signal);const d=await useContext(p.context);throwIfAborted(signal);
    const {Origin,Button}=require('selenium-webdriver/lib/input') as typeof import('selenium-webdriver/lib/input');
    let actions=d.actions({async:true});
    if(p.drag)actions=actions.press(Button.LEFT);
    actions=actions.move({x:Math.round(p.x),y:Math.round(p.y),origin:Origin.VIEWPORT});
    if(p.drag)actions=actions.release(Button.LEFT);
    await actions.perform();
  });
}

async function scroll(p: { context: ContextName; x: number; y: number; dx: number; dy: number }, signal:AbortSignal) {
  return exclusive(async () => {
    throwIfAborted(signal);
    const d = await useContext(p.context);
    throwIfAborted(signal);
    const scroller = `let target=document.elementFromPoint(arguments[0],arguments[1]);
      while(target){const style=getComputedStyle(target);if(/auto|scroll|overlay/.test(style.overflowY+' '+style.overflowX)&&(target.scrollHeight>target.clientHeight||target.scrollWidth>target.clientWidth))break;target=target.parentElement;}`;
    const before=await d.executeScript(`${scroller} return [location.href,scrollX,scrollY,target?.scrollLeft??null,target?.scrollTop??null]`,p.x,p.y);
    // Wheel actions exist at runtime but are missing from the bundled typings.
    const actions = d.actions({ async: true }) as unknown as { scroll(x: number, y: number, dx: number, dy: number): { perform(): Promise<void> } };
    await actions.scroll(Math.round(p.x), Math.round(p.y), Math.round(p.dx), Math.round(p.dy)).perform();
    // Native hiding can suspend Firefox's APZ wheel animation in either mode.
    // Fall back only when the wheel left the page and its scroll container still.
    await d.sleep(80);throwIfAborted(signal);
    await d.executeScript(`${scroller}
      const before=arguments[2];
      if(location.href===before[0]&&scrollX===before[1]&&scrollY===before[2]&&(target?.scrollLeft??null)===before[3]&&(target?.scrollTop??null)===before[4])
        (target||window).scrollBy({left:arguments[3],top:arguments[4],behavior:'instant'});`,p.x,p.y,before,p.dx,p.dy);
  });
}

const KEY_NAMES: Record<string, string> = {
  Enter: 'ENTER',
  Backspace: 'BACK_SPACE',
  Tab: 'TAB',
  Escape: 'ESCAPE',
  ArrowUp: 'ARROW_UP',
  ArrowDown: 'ARROW_DOWN',
  ArrowLeft: 'ARROW_LEFT',
  ArrowRight: 'ARROW_RIGHT',
  PageUp: 'PAGE_UP',
  PageDown: 'PAGE_DOWN',
  Home: 'HOME',
  End: 'END',
  Delete: 'DELETE',
  Control: 'CONTROL',
  Ctrl: 'CONTROL',
  Shift: 'SHIFT',
  Alt: 'ALT',
  Meta: 'META',
  Space: 'SPACE',
  ' ': 'SPACE',
};

async function type(p: { context: ContextName; text?: string; key?: string; keys?: string[] }, signal:AbortSignal) {
  return exclusive(async () => {
    throwIfAborted(signal);
    const d = await useContext(p.context);
    throwIfAborted(signal);
    const { Key } = require('selenium-webdriver') as typeof import('selenium-webdriver');
    if (p.key === 'SelectAll') { await d.actions({ async: true }).keyDown(Key.CONTROL).sendKeys('a').keyUp(Key.CONTROL).perform(); return; }
    if (p.keys?.length) {
      // Fara's key action: press in order, release in reverse (e.g. Control+a).
      const codes = p.keys.map((k) => (Key as unknown as Record<string, string>)[KEY_NAMES[k] ?? ''] ?? (k.length === 1 ? k : ''));
      if (codes.some((c) => !c)) throw new Error(`Unsupported key: ${p.keys.join('+')}`);
      let chain = d.actions({ async: true });
      for (const c of codes) chain = chain.keyDown(c);
      for (const c of [...codes].reverse()) chain = chain.keyUp(c);
      await chain.perform();
      return;
    }
    const seq = p.key ? (Key as unknown as Record<string, string>)[KEY_NAMES[p.key] ?? ''] : p.text;
    if (!seq) throw new Error('Unsupported key');
    await d.actions({ async: true }).sendKeys(seq).perform();
  });
}

async function history(p: { context: ContextName; action: 'back' | 'forward' | 'reload' }, signal:AbortSignal) {
  return exclusive(async () => {
    throwIfAborted(signal);
    const d = await useContext(p.context);
    throwIfAborted(signal);
    const nav = d.navigate();
    try {
      if (p.action === 'back') await nav.back();
      else if (p.action === 'forward') await nav.forward();
      else await nav.refresh();
    } catch (e) {
      if (!/timeout|NS_BINDING_ABORTED|NS_ERROR_WONT_HANDLE_CONTENT/i.test((e as Error).message)) throw e;
    }
  });
}

/** Clicks an element previously tagged by extractPage (data-cgl-i). */
async function clickElement(p: { context: ContextName; index: number }, signal: AbortSignal) {
  return exclusive(async () => {
    const d = await useContext(p.context);
    const { By } = require('selenium-webdriver') as typeof import('selenium-webdriver');
    const els = await d.findElements(By.css(`[data-cgl-i="${Math.floor(p.index)}"]`));
    if (!els.length) throw new Error('Element is no longer on the page');
    await d.executeScript('arguments[0].scrollIntoView({block: "center"})', els[0]);
    throwIfAborted(signal);
    const before = await d.getCurrentUrl();
    const oldHandles = new Set(await d.getAllWindowHandles());
    const expected = await els[0].getAttribute('href');
    const downloadButton = /download|mirror|get (?:the )?game/i.test(await els[0].getText());
    await watchDownloadRequest(d, els[0]);

    try {
      await els[0].click();
    } catch {
      await d.executeScript('arguments[0].click()', els[0]);
    }
    await d.sleep(600);
    throwIfAborted(signal);
    await adoptClickPopup(d,p.context,oldHandles,before,expected,downloadButton,signal);
    return { before, after: await d.getCurrentUrl().catch(()=>before) };
  });
}

/** Preserve the page's referrer, target and scripts when testing an observed host. */
async function followLink(p: {context:ContextName;sourceUrl:string;url:string}, signal:AbortSignal) {
  if (!isHttp(p.sourceUrl) || !isHttp(p.url)) throw Error('Only observed HTTP links can be followed');
  return exclusive(async()=>{
    throwIfAborted(signal);
    const d=await useContext(p.context);
    const before=await d.getCurrentUrl();
    const samePage=(a:string,b:string)=>a.split('#')[0].replace(/\/$/,'')===b.split('#')[0].replace(/\/$/,'');
    if(!samePage(before,p.sourceUrl)) return {followed:false,url:before,scrollY:0};
    const element=await d.executeScript(`return [...document.querySelectorAll('a[href]')].find(a=>a.href===arguments[0]) || null`,p.url);
    if(!element) return {followed:false,url:before,scrollY:0};
    await d.executeScript('arguments[0].scrollIntoView({block:"center"})',element);
    const scrollY=await d.executeScript<number>('return window.scrollY');
    const handles=new Set(await d.getAllWindowHandles());
    throwIfAborted(signal);
    try{await (element as import('selenium-webdriver').WebElement).click();}
    catch{throwIfAborted(signal);await d.executeScript('arguments[0].click()',element);}
    await d.sleep(600);
    await adoptClickPopup(d,p.context,handles,before,p.url,true,signal);
    const url=await d.getCurrentUrl();
    if(process.env.CGL_DEBUG)log('followed download link',{from:pageLocation(before),to:pageLocation(url),scrollY});
    return {followed:true,url,scrollY};
  });
}

async function adoptClickPopup(d:WebDriver,context:ContextName,oldHandles:Set<string>,before:string,expected:string|null,downloadButton:boolean,signal:AbortSignal){
    // Script-driven host links may open a new tab instead of navigating the
    // original page. Adopt a related destination and close unrelated ad popups.
    const original = windows.get(context)!;
    const otherContexts=new Set([...windows.entries()].filter(([name])=>name!==context).map(([,h])=>h));
    const opened = (await d.getAllWindowHandles()).filter((h) => !oldHandles.has(h)&&!otherContexts.has(h));
    let adopted: string | null = null;
    if(!opened.length&&downloadButton){latePopups.set(context,{handle:original,old:oldHandles,before,expected,expires:Date.now()+15000});return;}
    latePopups.delete(context);
    for (const h of opened) {
      throwIfAborted(signal);
      await d.switchTo().window(h);
      let url = await d.getCurrentUrl();
      // A target=_blank tab can stay about:blank while a slow host or short
      // link responds. Closing it immediately discards the real download.
      for (let n = 0; n < 20 && /^(?:about:blank|about:newtab)$/.test(url); n++) {
        throwIfAborted(signal);
        await d.sleep(500);
        url = await d.getCurrentUrl();
      }
      let matches = false;
      try { matches = !!expected && new URL(expected).origin === new URL(url).origin; } catch { /* script button */ }
      if (!adopted && isHttp(url) && (matches || isHostLanding(url) || url.startsWith(new URL(before).origin + '/') || opened.length === 1 && downloadButton)) adopted = h;
      else await d.close();
    }
    await d.switchTo().window(adopted ?? original);
    if (adopted) windows.set(context, adopted);
    current = context;
}

/**
 * Lists downloads Firefox started (for example from script-driven buttons),
 * and optionally removes a selected transfer after adoption or cancellation.
 */
async function takeBrowserDownloads(p: { cancel: boolean; target?: string }) {
  return exclusive(async () => {
    const d = (await getDriver()) as import('selenium-webdriver/firefox').Driver;
    const handles=await d.getAllWindowHandles(),selected=await d.getWindowHandle().catch(()=>null);
    if(handles.length&&!handles.includes(selected??''))await d.switchTo().window(handles[0]);
    await d.setContext('chrome' as import('selenium-webdriver/firefox').Context);
    try {
      return (await d.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         const cancel = arguments[0]; const target = arguments[1];
         const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
         Downloads.getList(Downloads.ALL).then(async (list) => {
           const all = (await list.getAll()).filter((dl) => (typeof cglOwnsDownload !== 'function' || cglOwnsDownload(dl)) && (!target || dl.target.path === target));
           const out = all.map((dl) => ({
             url: dl.source.url,
             referrer: dl.source.referrerInfo?.originalReferrer?.spec ?? null,
             isPrivate: !!dl.source.isPrivate,
             target: dl.target.path,
             partFilePath: dl.target.partFilePath ?? null,
             speedBps: dl.speed || 0,
             startedAt: dl.startTime?.getTime() ?? null,
             contentType: dl.contentType ?? null,
             totalBytes: dl.totalBytes || null,
             currentBytes: dl.currentBytes || 0,
             succeeded: dl.succeeded,
             stopped: dl.stopped,
           }));
           if (cancel) for (const dl of all) { if (!dl.succeeded) { try { await dl.finalize(true); } catch (e) {} } await list.remove(dl); }
           done(out);
         }).catch((e) => done({ error: String(e) }));`,
        p.cancel, p.target ?? null,
      )) as Array<{ url: string; referrer: string | null; target: string; totalBytes: number | null; currentBytes: number; succeeded: boolean; stopped: boolean; contentType: string | null }> | { error: string };
    } finally {
      await d.setContext('content' as import('selenium-webdriver/firefox').Context);
    }
  });
}

async function cookieHeader(p: { context: ContextName; url: string; allPaths?: boolean }) {
  return exclusive(async () => {
    const d = await useContext(p.context);
    const target = new URL(p.url);
    // WebDriver getCookies only sees the current page's host. Query Firefox's
    // own cookie jar for the target host after a cross-site download redirect.
    const firefox = d as import('selenium-webdriver/firefox').Driver;
    await firefox.setContext('chrome' as import('selenium-webdriver/firefox').Context);
    let matching: Array<{ name: string; value: string; host:string; path:string; secure:boolean }>;
    try {
      matching = await d.executeScript(`
        const target = new URL(arguments[0]);
        const Services = window.Services;
        const attrs=gBrowser.selectedBrowser.contentPrincipal?.originAttributes??{};
        const top = new URL(gBrowser.selectedBrowser.currentURI.spec);
        const partition=protocol=>{let host=protocol.hostname;try{host=Services.eTLD.getBaseDomainFromHost(host)}catch{}return '('+protocol.protocol.slice(0,-1)+','+host+')'};
        const jars=[attrs,{...attrs,partitionKey:partition(target)},...(/^https?:$/.test(top.protocol)?[{...attrs,partitionKey:partition(top)}]:[])];
        const seen=new Set();
        return jars.flatMap(a=>[...Services.cookies.getCookiesFromHost(target.hostname,a)]).filter((c) => {const id=c.host+'|'+c.path+'|'+c.name;if(seen.has(id))return false;seen.add(id);
          const domain = c.host.replace(/^\\./, '');
          const hostOk = target.hostname === domain || c.isDomain && target.hostname.endsWith('.' + domain);
          const path = c.path || '/';
          const pathOk = target.pathname === path || target.pathname.startsWith(path.endsWith('/') ? path : path + '/');
          return hostOk && (arguments[1] || pathOk) && (!c.isSecure || target.protocol === 'https:') && (c.isSession || (c.expiry>1e12?c.expiry:c.expiry*1000) > Date.now());
        }).map((c) => ({ name: c.name, value: c.value, host:c.host,path:c.path,secure:c.isSecure }));`, target.href,!!p.allPaths) as typeof matching;
    } finally {
      await firefox.setContext('content' as import('selenium-webdriver/firefox').Context);
    }
    const ua = (await d.executeScript('return navigator.userAgent')) as string;
    return { cookie: matching.map((c) => `${c.name}=${c.value}`).join('; '), cookies:matching, userAgent: ua, currentUrl: await d.getCurrentUrl() };
  });
}

/** Stops whatever the page is loading. Used when automation is cancelled. */
async function stopLoading(p: { context: ContextName }) {
  if (!driver) return;
  return exclusive(async () => {
    const d = await useContext(p.context);
    await d.executeScript('window.stop()').catch(() => undefined);
  });
}

async function closeContext(p: { context: ContextName }) {
  if (liveHuman) return;
  if (!driver) return;
  return exclusive(async () => {
    if (liveHuman) return;
    const handle = windows.get(p.context);
    if (!handle) return;
    const d = driver!;
    // Keep one window alive; blank it instead of closing the last one.
    if (windows.size <= 1) {
      await d.switchTo().window(handle);
      await d.get('about:blank').catch(() => undefined);
      return;
    }
    await d.switchTo().window(handle);
    await d.close();
    windows.delete(p.context);
    const [nextCtx, nextHandle] = [...windows.entries()][0];
    await d.switchTo().window(nextHandle);
    current = nextCtx;
  });
}

/** Reveal the actual page, retaining its JavaScript, forms and verification state. */
async function beginHuman(p: { context: ContextName; resumeAfterVerification?: boolean }) {
  if (headless()) throw new Error('Direct browsing requires a desktop display.');
  return exclusive(async () => {
    if (liveHuman) return { active: true };
    return revealHuman(await useContext(p.context),p);
  });
}
async function revealHuman(d:WebDriver,p:{context:ContextName;resumeAfterVerification?:boolean}) {
    const handle = await d.getWindowHandle();
    await nativeVisibility(d, true);
    await d.manage().window().maximize();
    const firefox = d as import('selenium-webdriver/firefox').Driver;
    try {
      await firefox.setContext('chrome' as import('selenium-webdriver/firefox').Context);
      await firefox.executeScript('window.focus();');
    } finally { await firefox.setContext('content' as import('selenium-webdriver/firefox').Context); }
    liveHuman = { context: p.context, handle, lastUrl: await d.getCurrentUrl() };
    if(p.resumeAfterVerification)liveHuman.verification=new VerificationResume(liveHuman.lastUrl);
    log('human control started', {context:p.context,automaticReturn:!!p.resumeAfterVerification});
    emit('humanMode', { active: true, automaticReturn: !!p.resumeAfterVerification });
    humanMonitor = setInterval(() => {
      void exclusive(async () => {
        if (!liveHuman || !driver) return;
        try {
          const handles = await driver.getAllWindowHandles();
          if (handles.includes(liveHuman.handle) || handles.some(h => ![...windows.values()].includes(h))) {
            const firefox = driver as import('selenium-webdriver/firefox').Driver;
            try {
              await firefox.setContext('chrome' as import('selenium-webdriver/firefox').Context);
              const url = normalFirefox ? await normalFirefox.selectedUrl() : await firefox.executeScript<string>("return Services.wm.getMostRecentWindow('navigator:browser')?.gBrowser.selectedBrowser.currentURI.spec ?? ''");
              if (liveHuman && isHttp(url)) liveHuman.lastUrl = url;
            } catch { /* Closing the controlled window can invalidate only this target. */ }
            finally { await firefox.setContext('content' as import('selenium-webdriver/firefox').Context).catch(() => undefined); }
            if(liveHuman?.verification){
              try{
                const source=`if(document.hidden)return {url:location.href,ready:false,content:false,gates:{captcha:true,blocked:false,login:false}};const ex=(${extractPage.toString()})({fast:true,mark:false,maxLinks:25,maxCards:10,maxControls:0});return {url:ex.url,ready:document.readyState!=='loading',content:!!ex.game||ex.cards.length>0||ex.links.length>=3||ex.text.trim().length>=80,gates:ex.gates}`;
                // Read the selected page without changing tabs or issuing input.
                // In WebDriver mode, check only the original controlled tab.
                const page=normalFirefox
                  ? await normalFirefox.readSelected<VerificationObservation>(source)
                  : await driver.executeScript<VerificationObservation>(source);
                if(liveHuman?.verification.observe(page)){
                  log('website verification completed; resuming launcher', {context:liveHuman.context});
                  await finishHuman();
                }
              }catch{/* A navigation or open dialog is not proof of completion. */}
            }
            return;
          }
          const context = liveHuman.context;
          if (isHttp(liveHuman.lastUrl)) resumeUrls.set(context, liveHuman.lastUrl);
          clearHumanMonitor(); liveHuman = null; windows.delete(context); current = null;
          if (!handles.length) { driver = null; windows.clear(); killGeckodriver(); }
          emit('humanMode', { active: false });
        } catch {
          if (liveHuman && isHttp(liveHuman.lastUrl)) resumeUrls.set(liveHuman.context, liveHuman.lastUrl);
          clearHumanMonitor(); liveHuman = null; driver = null; windows.clear(); current = null;
          killGeckodriver(); emit('humanMode', { active: false });
        }
      });
    }, 1000);
    humanMonitor.unref();
    return { active: true };
}
function clearHumanMonitor() {
  if (humanMonitor) clearInterval(humanMonitor);
  humanMonitor = null;
}

/** Find the tab the user selected before WebDriver can change selection. */
async function selectedHumanTab(d: WebDriver, fallback: string) {
  if(normalFirefox){const selected=await normalFirefox.selectedWindowHandle();await d.switchTo().window(selected);return selected;}
  const firefox = d as import('selenium-webdriver/firefox').Driver;
  let selected: number | null = null;
  try {
    await firefox.setContext('chrome' as import('selenium-webdriver/firefox').Context);
    selected = await firefox.executeScript<number>(`return Services.wm.getMostRecentWindow('navigator:browser')?.gBrowser.selectedBrowser.browsingContext.id ?? null;`);
  } catch { /* The window was closed; use a surviving tab below. */ }
  finally { await firefox.setContext('content' as import('selenium-webdriver/firefox').Context).catch(() => undefined); }
  const handles = await d.getAllWindowHandles();
  for (const handle of handles.slice(0, 100)) {
    await d.switchTo().window(handle);
    if (selected !== null) {
      try {
        await firefox.setContext('chrome' as import('selenium-webdriver/firefox').Context);
        const id = await firefox.executeScript<number>('return gBrowser.selectedBrowser.browsingContext.id');
        if (id === selected) return handle;
      } finally { await firefox.setContext('content' as import('selenium-webdriver/firefox').Context); }
    }
  }
  const handle = handles.includes(fallback) ? fallback : handles[0];
  if (!handle) throw new Error('Firefox was closed');
  await d.switchTo().window(handle);
  return handle;
}

async function endHuman() {
  if (liveHuman) return exclusive(finishHuman);
  return { active: false };
}

async function finishHuman() {
    if (!liveHuman) return { active: false };
    const context = liveHuman.context, fallback = liveHuman.handle;
    clearHumanMonitor();
    try {
      if (driver) {
        const handle = await selectedHumanTab(driver, fallback);
        for (const [ctx, h] of windows) if (ctx !== context && h === handle) windows.delete(ctx);
        windows.set(context, handle); current = context;
      }
    } finally { liveHuman = null; emit('humanMode', { active: false }); }
    return { active: false };
}

async function shutdownDriver() {
  const d = driver;
  driver = null;
  windows.clear();latePopups.clear();savedSourceTabs.clear();closedContexts.clear();
  current = null;
  if (d) await d.quit().catch(() => undefined);
  normalFirefox = null;
  killGeckodriver();
}

/**
 * Selenium's quit() closes Firefox but leaves the geckodriver service process
 * running, and it outlives this worker. Stop our own child explicitly
 * (matched by parent PID and exact name, never a broad pattern).
 */
function killGeckodriver() {
  try {
    require('node:child_process').execFileSync('pkill', ['-TERM', '-P', String(process.pid), '-x', 'geckodriver'], { stdio: 'ignore' });
  } catch { /* none running */ }
}

async function shutdown() {
  stopping=true;
  await endHuman();
  await shutdownDriver();
  resumeUrls.clear();
}

function stagedFiles() {
  if (!cfg || !existsSync(cfg.stagingDir)) return [];
  return readdirSync(cfg.stagingDir)
    .filter((f) => !f.endsWith('.part'))
    .map((f) => {
      const s = statSync(join(cfg!.stagingDir, f));
      return { name: f, path: join(cfg!.stagingDir, f), size: s.size, mtimeMs: s.mtimeMs };
    });
}

serve({
  async init(p: InitParams) {
    stopping=false;
    if (cfg && cfg.browserMode !== p.browserMode) {
      if (liveHuman) throw Error('Return control to the launcher before switching browser mode.');
      await exclusive(async () => {
        if (driver) {
          for (const [context, handle] of windows) {
            await driver.switchTo().window(handle).catch(()=>undefined);
            const url=await driver.getCurrentUrl().catch(()=>null);
            if (url && isHttp(url)) resumeUrls.set(context,url);
          }
        }
        await shutdownDriver();
        const previous=cfg;
        cfg=p;
        try { await getDriver(); }
        catch(error) {
          normalFirefox?.terminate();normalFirefox=null;driver=null;windows.clear();current=null;cfg=previous;
          throw error;
        }
      });
    }
    cfg = p;
    return { ok: true };
  },
  navigate,
  followLink,
  returnToPage,
  snapshot,
  extract,
  readUpdatePage,
  readDatePage,
  fetchPages,
  pointer,
  inspectPoint,
  movePointer,
  scroll,
  type,
  history,
  clickElement,
  takeBrowserDownloads,
  cookieHeader,
  beginHuman,
  endHuman,
  stopLoading,
  closeContext,
  stagedFiles,
  async clearData() {
    await shutdown();
    if (cfg) rmSync(cfg.profileDir, { recursive: true, force: true });
    stopping=false;
    return { ok: true };
  },
  async shutdown() {
    await shutdown();
    return { ok: true };
  },
  status() {
    return { running: !!driver, contexts: [...windows.keys()] };
  },
});

// Workers are stopped with SIGTERM, which skips 'exit' handlers unless handled.
process.once('SIGTERM', () => {
  stopping=true;
  clearHumanMonitor();
  // Give attached Firefox time to close only the launcher's windows before
  // disconnecting its bridge. Never terminate the user's Firefox process.
  const deadline=setTimeout(()=>{normalFirefox?.terminate();killGeckodriver();process.exit(0)},5000);
  void shutdownDriver().finally(()=>{clearTimeout(deadline);process.exit(0)});
});
process.on('exit', () => {
  normalFirefox?.terminate();
  killGeckodriver();
  void driver?.quit();
});

emit('ready', {});
