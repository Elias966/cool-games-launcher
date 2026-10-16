// Download-link resolution: after the user presses Download, follows the
// game page's links in the Store browser until a file URL is found, then hands
// it to the download worker. The AI may only choose navigation actions
// (click an element, scroll, go back, stop). It pauses for login, CAPTCHA,
// payment, age gates and ambiguous file choices.
import type { ForegroundWork } from './foreground';
import { setTimeout as delay } from 'node:timers/promises';
import { waitMs } from '@shared/countdown';
import {BrowserActionRejectedError} from './browser-agent';
import type { PageExtract } from '@shared/page-extract';
import type { DownloadCandidate, Platform, UserPrompt } from '@shared/types';
import type { CatalogRepo, DownloadsRepo, ResolutionCheckpoint } from './repos';
import type { StoreSession, SessionToken } from './store-session';
import type { AiService } from './ai';
import type { BrowserClient, BrowserDownload } from './browser-client';
import type { DownloadManager } from './downloads';
import type { WorkerHost } from './worker-host';
import type { PolicyService } from './policy-service';
import { actionKey, downloadEvidence, isHostLanding } from '@shared/download-evidence';
import { LocalGameAgent, type TransferDecision } from './game-agent';
import { isCancelled } from '@shared/worker-protocol';
import { hostOf } from '@shared/urls';
import { partFileName, partOf, partTotal, type PartName } from '@shared/parts';
import { basename } from 'node:path';
import { tm } from './i18n';

const MAX_STEPS = 24;
/** Optional-payment pages ("pay what you want") offer a free path; only a required payment pauses. */
const FREE_PATH_TEXT = /^(?:no thanks\b.*|just take me to the downloads|continue without (?:paying|donating)|skip(?: and download)?|download for free|free download)(?:\s*[.!→»›]*)$/i;


function platformRank(p: Platform | null): number {
  return p === 'linux' ? 3 : p === 'windows' ? 2 : p === null ? 1 : 0;
}

export function rankCandidates(cands: DownloadCandidate[]): { best: DownloadCandidate | null; ambiguous: DownloadCandidate[] } {
  const usable = cands.filter((c) => c.platform !== 'macos' && c.platform !== 'android' && c.platform !== 'web');
  if (!usable.length) return { best: null, ambiguous: [] };
  const top = Math.max(...usable.map((c) => platformRank(c.platform)));
  const tier = usable.filter((c) => platformRank(c.platform) === top);
  // De-duplicate by URL.
  const unique = [...new Map(tier.map((c) => [c.url, c])).values()];
  if (unique.length === 1) return { best: unique[0], ambiguous: [] };
  // Identical filenames on different hosts are mirrors of one build.
  if (unique.length > 1 && unique[0].fileName && unique.every((c) => c.fileName?.toLowerCase() === unique[0].fileName?.toLowerCase())) return { best: unique[0], ambiguous: [] };
  return { best: null, ambiguous: unique.slice(0, 12) };
}

export class Resolver {
  private agent: LocalGameAgent;
  private queue: number[] = [];
  private busy = false;
  private activeId: number | null = null;
  private activeEpoch: number | null = null;
  private controller: AbortController | null = null;
  private claimedBrowserTargets = new Set<string>();
  private retried = new Set<number>();
  private ignoredBrowserTargets = new Set<string>();
  /** The page the resolver last looked at (its links name the other parts of a split game). */
  private lastPage: PageExtract | null = null;
  /** Told to the AI after it fetched the wrong part of a split game. */
  private partNote = '';

  constructor(
    private deps: {
      session: StoreSession;
      foreground?: ForegroundWork;
      ai: AiService;
      browser: BrowserClient;
      downloads: DownloadManager;
      downloadsRepo: DownloadsRepo;
      catalog: CatalogRepo;
      downloadWorker: WorkerHost;
      policy: PolicyService;
      agent?: LocalGameAgent;
      openDrawer: (reason: string) => void;
      /** Every part of a split game is known and downloading/downloaded: preparation may start when they finish. */
      partsSettled?: (groupId: number) => void;
    },
  ) {
    this.agent = deps.agent ?? new LocalGameAgent(deps.ai, deps.browser, deps.session);
    deps.session.on('enter', () => this.resumePending());
    for(const d of deps.downloadsRepo.byState('needs-user'))deps.foreground?.hold(`download:${d.id}`,true);
  }

  enqueue(id: number) {
    if (this.activeId===id && this.activeEpoch===this.deps.session.token()?.epoch && !this.controller?.signal.aborted) return;
    if (!this.queue.includes(id)) this.queue.push(id);
    this.deps.foreground?.hold('resolution-queue',true);
    void this.pump();
  }

  cancel(id: number) {
    this.queue=this.queue.filter(queued=>queued!==id);
    if(this.activeId===id)this.controller?.abort();
    if(!this.busy&&!this.queue.length)this.deps.foreground?.hold('resolution-queue',false);
    this.deps.foreground?.hold(`download:${id}`,false);
  }

  /** Called when the Store opens: picks up resolutions that were interrupted. */
  resumePending() {
    for (const d of this.deps.downloadsRepo.byState('needs-resolution', 'resolving')) {
      if (d.errorCode === 'interrupted' || d.errorCode === 'link-expired' || d.state === 'resolving') this.enqueue(d.id);
    }
  }

  continueAfterUser(id: number) {
    const d = this.deps.downloadsRepo.get(id);
    if (!d || d.state !== 'needs-user') return;
    this.deps.foreground?.hold(`download:${id}`, false);
    this.deps.downloads.setPrompt(id, null, 'resolving');
    this.enqueue(id);
  }

  /** Returning from direct Firefox resumes website checks, never purchases or file choices. */
  continueAfterHuman() {
    for (const d of this.deps.downloadsRepo.byState('needs-user')) {
      if (d.userPrompt && ['captcha', 'login', 'blocked'].includes(d.userPrompt.kind)) this.continueAfterUser(d.id);
    }
  }

  private async pump() {
    if (this.busy) return;
    const token = this.deps.session.token();
    if (!token) return; // resumes when the Store becomes active
    const id = this.queue.shift();
    if (id === undefined) {this.deps.foreground?.hold('resolution-queue',false);return;}
    this.busy = true;
    this.activeId=id;this.activeEpoch=token.epoch;this.controller=new AbortController();
    try {
      if (this.deps.foreground) await this.deps.foreground.run(20, t => this.resolve(id, t),this.controller.signal);
      else await this.resolve(id, token);
    } catch (e) {
      if (isCancelled(e) || !this.deps.session.isLive(token)) {
        const d = this.deps.downloadsRepo.get(id);
        if (d && (d.state === 'resolving' || d.state === 'needs-resolution')) {
          this.deps.downloads.failResolution(id, 'interrupted', 'Paused — it continues automatically.', 'needs-resolution');
        }
      } else if (!this.retried.has(id)) {
        // One automatic second attempt from the game page with a fresh agent
        // conversation before involving the user.
        this.retried.add(id);
        console.warn('[resolver] retrying from the game page:', (e as Error).message);
        this.deps.downloadsRepo.update(id, { resolution: null, state: 'resolving', errorCode: null, errorDetail: null });
        this.queue.push(id);
      } else if (this.endOfParts(id)) {
        // Looked for one more part than the page listed, and there is none: the set is complete.
      } else {
        console.error('[resolver]', e);
        this.deps.downloads.failResolution(id, 'resolution-failed', `Could not find the download: ${(e as Error).message}`.slice(0, 400));
      }
    } finally {
      this.activeId=null;this.activeEpoch=null;this.controller=null;
      this.busy = false;
      const pending = this.deps.downloadsRepo.get(id);
      if (pending?.state !== 'needs-user') this.deps.ai.setStatus({ phase: 'idle', detail: null });
      if(!this.queue.length)this.deps.foreground?.hold('resolution-queue',false);
      void this.pump();
    }
  }

  private pause(id: number, prompt: UserPrompt, checkpoint: ResolutionCheckpoint) {
    this.deps.downloadsRepo.update(id, { resolution: checkpoint });
    this.deps.foreground?.hold(`download:${id}`, true);
    this.deps.downloads.setPrompt(id, prompt, 'needs-user');
    this.deps.ai.setStatus({ phase: 'paused', detail: prompt.message, context: 'interactive' });
    this.deps.openDrawer(prompt.message);
    if (['captcha', 'login', 'blocked'].includes(prompt.kind)) this.watchGate(id);
  }

  /** Resumes on its own as soon as the page's check/sign-in is gone; no Continue click needed. */
  private watchGate(id: number) {
    const timer = setInterval(async () => {
      const d = this.deps.downloadsRepo.get(id);
      if (!d || d.state !== 'needs-user' || !this.deps.session.active) { clearInterval(timer); return; }
      try {
        const ex = await this.deps.browser.extract('interactive');
        if (!ex.gates.captcha && !ex.gates.login && !ex.gates.blocked) { clearInterval(timer); this.continueAfterUser(id); }
      } catch { /* browser busy or closed; try again on the next tick */ }
    }, 2500);
    timer.unref?.();
  }

  private async resolve(id: number, token: SessionToken) {
    const { session, browser, downloadsRepo, catalog, ai } = this.deps;
    const d = downloadsRepo.get(id);
    if (!d || !d.catalogId || !['resolving', 'needs-resolution'].includes(d.state)) return;
    const entry = catalog.raw(d.catalogId);
    if (!entry) throw new Error('The game is no longer in the catalog');
    if (entry.rating === 'adult' && !this.deps.policy.policy().showNsfw) throw new Error('This game is hidden by your content settings');
    if (entry.rating === 'unknown') throw new Error('This game has not been content-checked yet');

    const resuming = d.state === 'resolving' && !!d.resolution && d.errorCode !== 'interrupted';
    const checkpoint: ResolutionCheckpoint = d.resolution ?? { pageUrl: entry.pageUrl, steps: 0, history: [] };
    downloadsRepo.update(id, { state: 'resolving', errorCode: null, errorDetail: null });
    this.deps.downloads.broadcastList();
    ai.setStatus({ phase: 'navigating', detail: tm('Finding the download for {title}', { title: entry.title }), context: 'interactive' });
    this.deps.openDrawer(`Finding the download for ${entry.title}`);

    session.assertLive(token);
    // Another part of a split game seen as a direct link next to the first: no browsing needed.
    if (d.groupId && checkpoint.partUrl && checkpoint.steps === 0 && await this.handoffUrl(id, checkpoint.partUrl, entry.pageUrl, token, checkpoint.partName ?? null)) return;
    // After the user handled a login/CAPTCHA, continue on the page they are on.
    if (!resuming) await browser.navigate('interactive', checkpoint.pageUrl, token.signal);
    // The AI is told exactly which part of a split game this download is for.
    const goal = d.groupId && d.partIndex && d.groupId !== d.id
      ? `${entry.title}' — ONLY PART ${d.partIndex}${d.partTotal ? ` of ${d.partTotal}` : ''} (a file named like '${checkpoint.partName ?? `part ${d.partIndex}`}'). The other parts are downloaded separately: do not download them. If the page has no part ${d.partIndex}, stop and say so`
      : entry.title;
    // Do not cancel another game's browser-only transfer or destroy a one-shot file.
    this.ignoredBrowserTargets = new Set((await browser.takeDownloads(false)).filter((x) => checkpoint.steps === 0 || x.stopped && !x.succeeded).map((x) => x.target));

    const rejected = new Set<string>();
    let rejectedBrowserActions=0;
    let note = '';
    // Keep cumulative progress for restart, but grant each explicit resume a
    // bounded new attempt instead of permanently exhausting its saved budget.
    for (let attempt = 0; attempt < MAX_STEPS; attempt++) {
      session.assertLive(token);
      const current = downloadsRepo.get(id);
      if (!current || current.state !== 'resolving') return;
      if (entry.rating === 'adult' && !this.deps.policy.policy().showNsfw) throw new Error('This game is hidden by your content settings');
      if (await this.tryBrowserDownload(id, token)) return;
      let ex = await browser.extract('interactive', token.signal);
      session.assertLive(token, 'page state');
      if (ex.gates.captcha) ex = await this.agent.verify(ex, 'interactive', token);
      checkpoint.pageUrl = ex.url;
      // A mirror that wants a human check is skipped automatically: back to
      // the game page, and the agent is told to choose another host. The user
      // is asked only when the game page itself is gated or mirrors run out.
      if ((ex.gates.captcha || ex.gates.blocked) && hostOf(ex.url) !== hostOf(entry.pageUrl)) {
        const gated = [...new Set([...(checkpoint.gatedHosts ?? []), hostOf(ex.url)])];
        checkpoint.gatedHosts = gated;
        if (gated.length <= 3) {
          checkpoint.history.push(`gate:${hostOf(ex.url)}`);
          downloadsRepo.update(id, { resolution: checkpoint });
          ai.setStatus({ phase: 'navigating', detail: tm('{host} wants a human check — trying another mirror', { host: hostOf(ex.url) }), context: 'interactive' });
          await browser.navigate('interactive', entry.pageUrl, token.signal);
          note = `The host${gated.length > 1 ? 's' : ''} ${gated.join(', ')} showed a human-verification page, so the launcher returned to the game page. Choose a DIFFERENT download mirror or host.`;
          continue;
        }
      }


      // Gates the user has to handle personally.
      if (ex.gates.captcha) return this.pause(id, { kind: 'captcha', message: checkpoint.gatedHosts?.length ? tm('Every mirror tried ({hosts}) wants a human check. Complete it in the browser below and the download continues automatically.', { hosts: checkpoint.gatedHosts.join(', ') }) : tm('This site wants a human check. Complete it in the browser below and the download continues automatically.') }, checkpoint);
      if (ex.gates.login) return this.pause(id, { kind: 'login', message: tm('The site asks you to log in. Sign in yourself in the browser below, then press Continue.') }, checkpoint);
      const freePath = ex.controls.find((c) => FREE_PATH_TEXT.test(c.text));
      // "Name your own price" stores embed payment widgets next to a free
      // path; the agent takes that path. Only a required payment pauses.
      const optionalPayment = /\b(?:name your own price|pay what you want|no thanks,? just take me to the downloads|\$0(?:\.00)? or more)\b/i.test(ex.text);
      if (ex.gates.payment && !freePath && !optionalPayment) return this.pause(id, { kind: 'payment', message: tm('This download needs a payment. Purchases are never automated — complete it yourself if you want, then press Continue.') }, checkpoint);
      if (ex.gates.ageGate) {
        if (!this.deps.policy.policy().showNsfw) throw new Error('The site shows an adult-content age gate; adult content is hidden by your settings');
        return this.pause(id, { kind: 'confirm', message: tm('The site asks you to confirm your age. Answer it yourself in the browser below, then press Continue.') }, checkpoint);
      }
      if (ex.gates.blocked) return this.pause(id, { kind: 'blocked', message: tm('The site blocked automated access. You can try navigating in the browser below, then press Continue.') }, checkpoint);

      this.lastPage = ex;
      const candidates = this.candidatesFrom(ex).filter((c) => !rejected.has(`${ex.url}|${c.url}`));
      if (this.partNote) { note = `${note} ${this.partNote}`.trim(); this.partNote = ''; }
      if (process.env.CGL_DEBUG) console.log('[resolver] step', checkpoint.steps, ex.url, 'candidates', JSON.stringify(candidates.map((c) => [c.fileName, c.platform, c.url.slice(-16)])));
      // The model chooses each route and file from this current observation.
      const action = await this.agent.transfer(ex, token, goal, checkpoint.history, candidates, note);
      note = '';
      session.assertLive(token);
      if(downloadsRepo.get(id)?.state!=='resolving')return;
      const chosen = ex.controls.find((c) => c.i === action.index);
      checkpoint.history.push(chosen && action.kind === 'click' ? actionKey(ex.url, chosen) : `${action.kind}:${action.label ?? ''}`.slice(0, 120));
      checkpoint.steps++;
      downloadsRepo.update(id, { resolution: checkpoint });
      if(action.kind==='computer'){
        if(!action.computer)throw Error('Missing browser agent action');
        let result:'continue'|'done'|'human';
        try{result=await this.agent.actBrowser(action.computer,ex,token,true);}
        catch(error){
          if(!(error instanceof BrowserActionRejectedError)||++rejectedBrowserActions>=3)throw error;
          // The native agent receives its real rejected-tool result and a new
          // screenshot. No alternative control is chosen by launcher code.
          continue;
        }
        // Do not add another 1.5s to waits, scrolling or pointer movement.
        // A terminal decision still needs time to observe a delayed transfer;
        // the model saying "done" is never itself proof that a download began.
        const click = ['left_click','double_click','triple_click','click_element','visit_url','key'].includes(action.computer.action.action);
        const polls = result === 'done' ? 14 : click ? 3 : 0;
        for(let n=0;n<polls;n++){
          await delay(500,undefined,{signal:token.signal});session.assertLive(token);
          if(await this.tryBrowserDownload(id,token))return;
        }
        if(result==='human')return this.pause(id,{kind:'confirm',message:action.computer.action.question??tm('The browser agent needs your help on this page.')},checkpoint);
        if(result==='done')throw Error(action.computer.action.answer??'The browser agent stopped before a game download started.');
      } else if (action.kind === 'stop') {
        throw new Error(action.label || 'No download link was found on this page');
      } else if (action.kind === 'download') {
        const selected = candidates[action.index!];
        const result = await this.takeCandidate(id, selected, ex, token);
        if (result === 'handed-off') return;
        if (result === 'unavailable') rejected.add(`${ex.url}|${selected.url}`);
      } else if (action.kind === 'wait') {
        // A countdown on the page ("starts in 15 seconds") sets how long.
        await delay(waitMs(ex.text ?? ''),undefined,{signal:token.signal});
      } else if (action.kind === 'click') {
        ai.setStatus({ phase: 'navigating', detail: tm('Opening “{label}”', { label: action.label }), context: 'interactive' });
        // Click the observed control so host scripts, tokens and popups work
        // exactly as they do in Firefox; naked navigation can skip that logic.
        await browser.clickElement('interactive', action.index!, token.signal);
        // Script/HTMX controls can start a transfer only after an async host
        // response. Give that request time before trying another mirror.
        const polls = chosen && !chosen.href ? 10 : 2;
        for (let n = 0; n < polls; n++) {
          await delay(700,undefined,{signal:token.signal});
          session.assertLive(token);
          if (await this.tryBrowserDownload(id, token)) return;
        }
      } else if (action.kind === 'scroll') {
        await browser.scroll('interactive', 640, 400, 0, 700, token.signal);
      } else if (action.kind === 'back') {
        await browser.history('interactive', 'back', token.signal);
      }
    }
    throw new Error('Gave up after following several links without finding a file');
  }

  private candidatesFrom(ex: PageExtract): DownloadCandidate[] {
    // Navigation links (including mirror landing pages) are handled by nextAction,
    // while actual uploads and file-looking URLs are probed before handoff.
    return downloadEvidence(ex).filter((c) => c.fileName !== null || /#cgl-upload-\d+$/.test(c.url));
  }

  /** User picked a file in the choose-file prompt. */
  async chooseFile(id: number, url: string) {
    if(this.deps.foreground)return this.deps.foreground.run(20,token=>this.chooseObservedFile(id,url,token));
    return this.chooseObservedFile(id,url);
  }

  private async chooseObservedFile(id: number, url: string, foregroundToken?:SessionToken) {
    if (this.busy) throw new Error('Another game is being resolved. Wait for it to finish, then choose this file again.');
    const token = foregroundToken ?? this.deps.session.token();
    if (!token) throw new Error('The AI is not ready yet. Try again in a moment.');
    const d = this.deps.downloadsRepo.get(id);
    const choice = d?.userPrompt?.choices?.find((c) => c.url === url);
    if (!d || d.state !== 'needs-user' || !choice) throw new Error('That file is no longer offered');
    this.busy = true;
    this.deps.foreground?.hold(`download:${id}`, false);
    this.deps.downloads.setPrompt(id, null, 'resolving');
    try {
      const ex = await this.deps.browser.extract('interactive', token.signal);
      const result = await this.takeCandidate(id, choice, ex, token);
      if (result === 'unavailable') this.deps.downloads.failResolution(id, 'resolution-failed', 'The selected file could not be downloaded.');
      else if (result === 'navigated') {
        const page = await this.deps.browser.extract('interactive', token.signal);
        this.deps.session.assertLive(token);
        this.deps.downloadsRepo.update(id, { resolution: { ...(d.resolution ?? { steps: 0, history: [] }), pageUrl: page.url } });
        this.enqueue(id);
      }
    } catch (e) {
      if (isCancelled(e)) this.deps.downloads.failResolution(id, 'interrupted', 'Paused — it continues automatically.', 'needs-resolution');
      else this.deps.downloads.failResolution(id, 'resolution-failed', (e as Error).message);
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  private async takeCandidate(id: number, c: DownloadCandidate, ex: PageExtract, token: SessionToken): Promise<'handed-off' | 'navigated' | 'unavailable'> {
    const { browser, session } = this.deps;
    if (process.env.CGL_DEBUG) console.log('[resolver] taking', c.fileName, c.platform, c.url.slice(-20));
    if (c.fileName && !this.partAccepted(id, c.fileName)) return 'unavailable';
    const upload = c.url.match(/#cgl-upload-(\d+)$/);
    if (upload) {
      const n = Number(upload[1]);
      const btn = ex.game?.uploads[n];
      if (!btn || btn.i === null) return 'unavailable';
      this.deps.ai.setStatus({ phase: 'navigating', detail: tm('Requesting {file}', { file: c.fileName ?? tm('the file') }), context: 'interactive' });
      await browser.clickElement('interactive', btn.i, token.signal);
      for (let i = 0; i < 12; i++) {
        session.assertLive(token);
        await delay(700,undefined,{signal:token.signal});
        if (await this.tryBrowserDownload(id, token, c.fileName)) return 'handed-off';
      }
      const after = await browser.extract('interactive', token.signal);
      return after.url !== ex.url ? 'navigated' : 'unavailable';
    }
    // A URL ending in .zip can still be a MediaFire/Drive landing page.
    if (isHostLanding(c.url)) {
      await browser.navigate('interactive', c.url, token.signal);
      return 'navigated';
    }
    if (await this.handoffUrl(id, c.url, ex.url, token, c.fileName)) return 'handed-off';
    // Some hosts serve an HTML interstitial at the file-looking URL.
    if (c.url !== ex.url && /^https?:/i.test(c.url)) {
      await browser.navigate('interactive', c.url, token.signal);
      return 'navigated';
    }
    return 'unavailable';
  }

  /** Probes a URL with the browser's cookies; hands it over if it serves a file. */
  private async handoffUrl(id: number, url: string, referer: string, token: SessionToken, nameHint: string | null): Promise<boolean> {
    const { browser, session, downloadWorker } = this.deps;
    const auth = await browser.cookieHeader('interactive', url);
    session.assertLive(token);
    // Same cookies Firefox would send to the file's host (domain/path/secure-matched in the worker).
    const headers: Record<string, string> = { 'User-Agent': auth.userAgent, Referer: referer };
    if (auth.cookie) headers.Cookie = auth.cookie;
    const probe = await downloadWorker.call<{ isFile: boolean; fileName: string | null; totalBytes: number | null; finalUrl: string; status: number }>('probe', { url, headers }, token.signal);
    session.assertLive(token, 'link check');
    if (!probe.isFile) return false;
    if (this.deps.downloadsRepo.get(id)?.state !== 'resolving') return false;
    const name = probe.fileName ?? nameHint;
    if (!this.partAccepted(id, name)) return false;
    this.deps.downloads.handoff(id, url, headers, name, probe.totalBytes);
    this.afterFile(id, name);
    this.deps.foreground?.transferHandoff();
    this.deps.ai.setStatus({ phase: 'idle', detail: tm('Download handed to the download manager') });
    return true;
  }

  /** Checks whether the last action made Firefox start a download, and takes it over. */
  private async tryBrowserDownload(id: number, token: SessionToken, nameHint?: string | null): Promise<boolean> {
    const list = await this.deps.browser.takeDownloads(false);
    if (process.env.CGL_DEBUG && list.length) console.log('[resolver] browser downloads', JSON.stringify(list.map((x) => [x.target, x.currentBytes, x.succeeded])));
    const dl = list.find((x) => !this.claimedBrowserTargets.has(x.target) && !this.ignoredBrowserTargets.has(x.target) && (!x.stopped || x.succeeded));
    if (!dl) return false;
    this.deps.session.assertLive(token);
    if (this.deps.downloadsRepo.get(id)?.state !== 'resolving') return false;
    if (!this.partAccepted(id, basename(dl.target))) {
      this.ignoredBrowserTargets.add(dl.target);
      return false;
    }
    // Preserve the original request: even a successful HEAD probe cannot prove
    // that a signed URL or POST-generated download can be replayed with GET.
    this.claimedBrowserTargets.add(dl.target);
    this.deps.downloads.adoptBrowserDownload(id, dl);
    this.afterFile(id, basename(dl.target));
    this.deps.foreground?.transferHandoff();
    return true;
  }

  /** A download for one part of a split game takes only that part's file. */
  private partAccepted(id: number, fileName: string | null): boolean {
    const d = this.deps.downloadsRepo.get(id);
    if (!d?.groupId || d.groupId === d.id || !d.partIndex) return true;
    const lead = this.deps.downloadsRepo.get(d.groupId);
    const want = partOf(lead?.fileName)?.set;
    const got = this.partName(fileName, lead?.fileName ?? null);
    if (got && got.index === d.partIndex && (!want || got.set === want)) return true;
    this.partNote = `That file (${fileName ?? 'unknown'}) is not part ${d.partIndex}. Download only part ${d.partIndex} of this game.`;
    return false;
  }

  /** Part number of a file; a plain "game.rar" is part 1 of an old-style "game.r00 …" set. */
  private partName(fileName: string | null, sibling: string | null): PartName | null {
    const p = partOf(fileName);
    if (p) return p;
    const s = partOf(sibling);
    if (fileName && s?.style === 'rar-old' && s.set === fileName.toLowerCase()) return { set: s.set, index: 1, style: 'rar-old' };
    return null;
  }

  /**
   * A file arrived. When it is one part of a split game, the other parts are
   * queued: direct links seen on the page are taken as they are; otherwise the
   * AI fetches "part N" from the game page. Without a stated number of parts,
   * the next one is looked for until there is none.
   */
  private afterFile(id: number, fileName: string | null) {
    const repo = this.deps.downloadsRepo;
    const d = repo.get(id);
    if (!d?.catalogId || !fileName) return;
    const entry = this.deps.catalog.raw(d.catalogId);
    if (!entry) return;
    const offered = [...(this.lastPage ? downloadEvidence(this.lastPage) : []), ...entry.candidates].map((c) => ({ fileName: c.fileName, label: c.label, url: c.url }));
    if (d.groupId) {
      const lead = repo.get(d.groupId);
      if (lead && lead.partTotal === null && d.partIndex) this.createPart(lead, d.partIndex + 1, offered);
      return;
    }
    let p = partOf(fileName);
    if (!p && /\.rar$/i.test(fileName) && offered.some((o) => { const q = partOf(o.fileName); return q?.style === 'rar-old' && q.set === fileName.toLowerCase(); })) p = { set: fileName.toLowerCase(), index: 1, style: 'rar-old' };
    if (!p) return;
    const total = partTotal(p, offered);
    repo.update(id, { groupId: id, partIndex: p.index, partTotal: total });
    const lead = repo.get(id)!;
    console.log(`[resolver] ${entry.title} is split into ${total ?? 'several'} parts (got part ${p.index})`);
    const wanted = total ? Array.from({ length: total }, (_, i) => i + 1).filter((k) => k !== p!.index) : [...Array.from({ length: p.index - 1 }, (_, i) => i + 1), p.index + 1];
    for (const k of wanted) this.createPart(lead, k, offered);
    if (total) this.deps.partsSettled?.(id);
  }

  private createPart(lead: ReturnType<DownloadsRepo['get']> & object, index: number, offered: Array<{ fileName: string | null; label: string; url: string }>) {
    const repo = this.deps.downloadsRepo;
    if (repo.group(lead.id).some((x) => x.partIndex === index)) return;
    const sample = lead.fileName ?? '';
    const set = this.partName(sample, offered.map((o) => o.fileName).find((f) => partOf(f)) ?? null)?.set;
    const direct = offered.find((o) => { const q = this.partName(o.fileName, sample); return !!q && q.index === index && q.set === set && /^https?:/i.test(o.url) && !isHostLanding(o.url); });
    const entry = this.deps.catalog.raw(lead.catalogId!);
    const rec = repo.create({ catalogId: lead.catalogId, title: lead.title, sourceHost: lead.sourceHost, state: 'resolving' });
    repo.update(rec.id, {
      groupId: lead.id, partIndex: index, partTotal: lead.partTotal, updateGameId: lead.updateGameId,
      resolution: { pageUrl: entry?.pageUrl ?? lead.resolution?.pageUrl ?? '', steps: 0, history: [], partUrl: direct?.url, partName: partFileName(sample, index) },
    });
    this.deps.downloads.broadcastList();
    this.enqueue(rec.id);
  }

  /** A looked-for extra part does not exist: the set ends before it. */
  private endOfParts(id: number): boolean {
    const repo = this.deps.downloadsRepo;
    const d = repo.get(id);
    if (!d?.groupId || d.groupId === d.id || !d.partIndex) return false;
    const lead = repo.get(d.groupId);
    if (!lead || lead.partTotal !== null) return false;
    // Only a look past the highest part found; a missing earlier part is a real failure.
    if (repo.group(d.groupId).some((x) => x.id !== id && (x.partIndex ?? 0) > d.partIndex!)) return false;
    const total = d.partIndex - 1;
    console.log(`[resolver] ${d.title}: no part ${d.partIndex}; the game has ${total} part${total === 1 ? '' : 's'}`);
    for (const x of repo.group(d.groupId)) repo.update(x.id, { partTotal: total });
    repo.update(id, { state: 'cancelled', errorCode: null, errorDetail: null });
    this.deps.downloads.broadcastList();
    this.deps.partsSettled?.(d.groupId);
    return true;
  }

  // Kept as a narrow entry point for decision-contract tests.
  private nextAction(ex: PageExtract, token: SessionToken, cp: ResolutionCheckpoint, _sameUrlCount: number, title: string): Promise<TransferDecision> {
    return this.agent.transfer(ex, token, title, cp.history, this.candidatesFrom(ex));
  }
}
