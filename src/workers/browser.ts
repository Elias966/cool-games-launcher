// Browser utility process: drives the bundled Firefox through geckodriver with
// a dedicated profile and uBlock Origin. Exposes only navigation, inspection
// and input forwarding — nothing here can touch the filesystem or a shell on
// behalf of a web page.
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { WebDriver } from 'selenium-webdriver';
import { extractPage, type PageExtract } from '@shared/page-extract';
import { isFileUrl, isHostLanding } from '@shared/download-evidence';
import { emit, log, serve, throwIfAborted } from './rpc';
import { humanFirefoxPage } from './firefox-session';

process.title = 'cgl-browser';
process.env.SE_OFFLINE = 'true'; // never let Selenium Manager reach the network

type ContextName = 'interactive' | 'discovery';

interface InitParams {
  firefoxPath: string;
  geckodriverPath: string;
  profileDir: string;
  ublockXpi: string;
  stagingDir: string;
  doNotTrack: boolean;
  width: number;
  height: number;
}

let cfg: InitParams | null = null;
let driver: WebDriver | null = null;
let starting: Promise<WebDriver> | null = null;
let humanProcess: ChildProcess | null = null;
let humanExit: Promise<void> | null = null;
const resumeUrls = new Map<ContextName, string>();
const windows = new Map<ContextName, string>();
let current: ContextName | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Serialises every WebDriver command: one session, many callers. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
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
    'browser.sessionstore.resume_from_crash': false,
    'browser.startup.page': 0,
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
  const target = join(c.profileDir, 'extensions', 'uBlock0@raymondhill.net.xpi');
  if (existsSync(c.ublockXpi) && (!existsSync(target) || statSync(target).size !== statSync(c.ublockXpi).size)) {
    copyFileSync(c.ublockXpi, target);
  }
  writeFileSync(join(c.profileDir, 'user.js'), prefs(c));
  // A stale lock after a crash would stop Firefox from reusing the profile.
  for (const f of ['lock', '.parentlock']) rmSync(join(c.profileDir, f), { force: true });
}

async function getDriver(): Promise<WebDriver> {
  if (humanProcess) throw new Error('Firefox is under direct human control. Return to the launcher before resuming AI.');
  if (driver) return driver;
  if (starting) return starting;
  if (!cfg) throw new Error('Browser worker not initialised');
  const c = cfg;
  starting = (async () => {
    if (!existsSync(c.firefoxPath)) throw new Error('Bundled Firefox is missing');
    prepareProfile(c);
    const { Builder } = require('selenium-webdriver') as typeof import('selenium-webdriver');
    const firefox = require('selenium-webdriver/firefox') as typeof import('selenium-webdriver/firefox');
    const opts = new firefox.Options()
      .setBinary(c.firefoxPath)
      .addArguments('-headless', '-profile', c.profileDir, '-no-remote')
      .windowSize({ width: c.width, height: c.height });
    opts.setPageLoadStrategy('eager');
    const service = new firefox.ServiceBuilder(c.geckodriverPath).addArguments('--allow-system-access');
    const d = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).setFirefoxService(service).build();
    await d.manage().setTimeouts({ pageLoad: 30000, script: 15000, implicit: 0 });
    windows.clear();
    windows.set('interactive', await d.getWindowHandle());
    current = 'interactive';
    driver = d;
    log('firefox session started');
    return d;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function useContext(ctx: ContextName): Promise<WebDriver> {
  const d = await getDriver();
  let handle = windows.get(ctx);
  const handles = await d.getAllWindowHandles();
  if (!handle || !handles.includes(handle)) {
    if (handles.length && !windows.size) {
      handle = handles[0];
    } else {
      await d.switchTo().newWindow('window');
      handle = await d.getWindowHandle();
      await d.manage().window().setRect({ width: cfg!.width, height: cfg!.height });
    }
    windows.set(ctx, handle);
    current = ctx;
    await restorePage(d, ctx);
    return d;
  }
  if (current !== ctx) {
    await d.switchTo().window(handle);
    current = ctx;
  }
  // Close stray popups the page may have opened in this session.
  if (handles.length > windows.size + 2) {
    const known = new Set(windows.values());
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
  return exclusive(async () => {
    throwIfAborted(signal);
    const d = await useContext(p.context);
    let reused = await d.getCurrentUrl() === p.url;
    if (!reused) {
      const original = await d.getWindowHandle();
      const otherContexts = new Set([...windows.entries()].filter(([ctx]) => ctx !== p.context).map(([, handle]) => handle));
      for (const handle of await d.getAllWindowHandles()) {
        if (handle === original || otherContexts.has(handle)) continue;
        throwIfAborted(signal);
        await d.switchTo().window(handle);
        if (await d.getCurrentUrl() === p.url) {
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
              if (history.getEntryAtIndex(i).URI.spec === arguments[0]) {
                browser.webNavigation.gotoIndex(i); return true;
              }
            }
            return false;
          `, p.url);
        } catch { /* A new session or unsupported history API uses the saved URL. */ }
        finally { await firefox.setContext('content' as import('selenium-webdriver/firefox').Context); }
        if (jumped) {
          try {
            await d.wait(async () => {
              throwIfAborted(signal);
              return await d.getCurrentUrl() === p.url && await d.executeScript('return document.readyState !== "loading"');
            }, 3000, 'Waiting for the saved game page', 50);
            reused = true;
          } catch { throwIfAborted(signal); }
        }
        if (!reused) {
          throwIfAborted(signal);
          try { await d.get(p.url); } catch (error) {
            if (!/timeout|NS_BINDING_ABORTED|NS_ERROR_WONT_HANDLE_CONTENT/i.test((error as Error).message)) throw error;
          }
        }
      }
    }
    throwIfAborted(signal);
    if (await d.getCurrentUrl() !== p.url) throw new Error('The saved game download-links page redirected elsewhere.');
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
    const ex = (await d.executeScript(`return (${extractPage.toString()})(arguments[0])`, {})) as PageExtract;
    if (process.env.CGL_DEBUG) log('observed', {context:p.context,url:pageLocation(ex.url),title:ex.title,gates:ex.gates});
    return ex;
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
    const target=await d.executeScript(`const hit=document.elementFromPoint(arguments[0],arguments[1]);const el=hit?.closest('a,button,[role="button"]');return {href:el?.href||null,text:el?.innerText||''}`,p.x,p.y) as {href:string|null;text:string};
    throwIfAborted(signal);
    if(p.button !== 'right' && p.button !== 'middle') {
      const element = await d.executeScript("return document.elementFromPoint(arguments[0],arguments[1])?.closest('a,button,input,[role=button],[hx-get],[data-hx-get]') || null",p.x,p.y);
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
      await adoptClickPopup(d,p.context,oldHandles,before,target.href,true,signal);
    }
  });
}

async function inspectPoint(p:{context:ContextName;x:number;y:number}){
  return exclusive(async()=>{
    const d=await useContext(p.context);
    return d.executeScript(`
      const hit=document.elementFromPoint(arguments[0],arguments[1]);
      const el=hit?.closest('a,button,input,textarea,[role="button"],[role="link"]')||hit;
      const text=(el?.innerText||el?.getAttribute('aria-label')||el?.getAttribute('placeholder')||'').slice(0,240);
      // Forms can shadow DOM methods through named child controls. Invoke the
      // Element methods directly rather than trusting properties on the page.
      const marked=el instanceof Element?Element.prototype.closest.call(el,'[data-cgl-i]'):null;
      const id=marked instanceof Element?Element.prototype.getAttribute.call(marked,'data-cgl-i'):null;
      return {text,index:id==null?null:Number(id),href:el?.href||null,password:el?.type==='password',untrustedRegion:!el||!!el.closest('aside,[data-ad],.advertisement,.sponsored'),download:!!el?.hasAttribute('download')||/\\.(zip|rar|7z|exe|msi)([?#]|$)/i.test(el?.href||'')};
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
    // Wheel actions exist at runtime but are missing from the bundled typings.
    const actions = d.actions({ async: true }) as unknown as { scroll(x: number, y: number, dx: number, dy: number): { perform(): Promise<void> } };
    await actions.scroll(Math.round(p.x), Math.round(p.y), Math.round(p.dx), Math.round(p.dy)).perform();
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
    return { before, after: await d.getCurrentUrl() };
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
    const opened = (await d.getAllWindowHandles()).filter((h) => !oldHandles.has(h));
    let adopted: string | null = null;
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
    await d.setContext('chrome' as import('selenium-webdriver/firefox').Context);
    try {
      return (await d.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         const cancel = arguments[0]; const target = arguments[1];
         const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
         Downloads.getList(Downloads.ALL).then(async (list) => {
           const all = (await list.getAll()).filter((dl) => !target || dl.target.path === target);
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

async function cookieHeader(p: { context: ContextName; url: string }) {
  return exclusive(async () => {
    const d = await useContext(p.context);
    const target = new URL(p.url);
    // WebDriver getCookies only sees the current page's host. Query Firefox's
    // own cookie jar for the target host after a cross-site download redirect.
    const firefox = d as import('selenium-webdriver/firefox').Driver;
    await firefox.setContext('chrome' as import('selenium-webdriver/firefox').Context);
    let matching: Array<{ name: string; value: string }>;
    try {
      matching = await d.executeScript(`
        const target = new URL(arguments[0]);
        const Services = window.Services;
        return [...Services.cookies.getCookiesFromHost(target.hostname, {})].filter((c) => {
          const domain = c.host.replace(/^\\./, '');
          const hostOk = target.hostname === domain || c.isDomain && target.hostname.endsWith('.' + domain);
          const path = c.path || '/';
          const pathOk = target.pathname === path || target.pathname.startsWith(path.endsWith('/') ? path : path + '/');
          return hostOk && pathOk && (!c.isSecure || target.protocol === 'https:') && (c.isSession || c.expiry > Date.now()/1000);
        }).map((c) => ({ name: c.name, value: c.value }));`, target.href) as Array<{ name: string; value: string }>;
    } finally {
      await firefox.setContext('content' as import('selenium-webdriver/firefox').Context);
    }
    const ua = (await d.executeScript('return navigator.userAgent')) as string;
    return { cookie: matching.map((c) => `${c.name}=${c.value}`).join('; '), userAgent: ua, currentUrl: await d.getCurrentUrl() };
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
  if (!driver) return;
  return exclusive(async () => {
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

/** Transfer the profile to ordinary Firefox, with no WebDriver or screenshot input path. */
async function beginHuman(p: { context: ContextName }) {
  return exclusive(async () => {
    if (humanProcess) return { active: true };
    const d = await useContext(p.context);
    const url = await d.getCurrentUrl();
    for (const [ctx, handle] of windows) {
      await d.switchTo().window(handle);
      const page = await d.getCurrentUrl();
      if (isHttp(page)) resumeUrls.set(ctx, page);
    }
    await shutdownDriver();
    const startedAt=Date.now();
    // Observe the human's final selected tab without WebDriver controlling
    // that Firefox window. The normal worker restores the longer interval.
    writeFileSync(join(cfg!.profileDir,'user.js'),prefs(cfg!)+'\nuser_pref("browser.sessionstore.interval", 1000);\nuser_pref("browser.sessionstore.resume_from_crash", true);\n');
    const proc = spawn(cfg!.firefoxPath, ['-no-remote', '-profile', cfg!.profileDir, isHttp(url) ? url : 'about:blank'], { stdio: 'ignore' });
    humanProcess = proc;
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', resolve);
      proc.once('error', reject);
    }).catch((e) => { humanProcess = null; throw e; });
    humanExit = new Promise<void>((resolve)=>proc.once('exit', async () => {
      if (humanProcess === proc) {
        humanProcess = null;
        // Firefox finishes replacing its session file as its process exits.
        await new Promise(r=>setTimeout(r,250));
        const page=humanFirefoxPage(cfg!.profileDir,startedAt);
        if(process.env.CGL_DEBUG)log('human return page',page? pageLocation(page):'pre-handoff bookmark');
        if(page)resumeUrls.set(p.context,page);
        emit('humanMode', { active: false });
      }
      resolve();
    }));
    emit('humanMode', { active: true });
    return { active: true };
  });
}

async function endHuman() {
  const proc = humanProcess;
  if (!proc) { await humanExit; return { active: false }; }
  // Allow one session-store interval after the user's last navigation.
  await new Promise(r=>setTimeout(r,1100));
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), 6000);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    proc.kill('SIGTERM');
  });
  await humanExit;
  return { active: false };
}

async function shutdownDriver() {
  const d = driver;
  driver = null;
  windows.clear();
  current = null;
  if (d) await d.quit().catch(() => undefined);
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
  init(p: InitParams) {
    cfg = p;
    return { ok: true };
  },
  navigate,
  followLink,
  returnToPage,
  snapshot,
  extract,
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
process.on('SIGTERM', () => { killGeckodriver(); humanProcess?.kill('SIGTERM'); process.exit(0); });
process.on('exit', () => {
  killGeckodriver();
  humanProcess?.kill('SIGTERM');
  void driver?.quit();
});

emit('ready', {});
