// Download-link resolution: after the user presses Download, follows the
// game page's links in the Store browser until a file URL is found, then hands
// it to the download worker. The AI may only choose navigation actions
// (click an element, scroll, go back, stop). It pauses for login, CAPTCHA,
// payment, age gates and ambiguous file choices.
import type { ForegroundWork } from './foreground';
import { setTimeout as delay } from 'node:timers/promises';
import { countdownSeconds, waitMs } from '@shared/countdown';
import {BrowserActionRejectedError, type BrowserRouteConstraint} from './browser-agent';
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
import { fastestMirrors, mirrorRoutes, mirrorsForPart, recordMirror, mirrorFileName, type MeasuredMirror, type MirrorComparison } from './download-mirrors';
import type { MirrorSample } from '../workers/mirror-probe';
import { formatSpeed } from '@shared/format';
import { unavailableHostReason } from '@shared/download-host';
import { downloadPageKey, isGameBookmark, isSiteBrowseUrl } from '@shared/download-page';

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

class MirrorReady extends Error { constructor(readonly sample: MeasuredMirror) { super('Mirror measured'); } }
class BrowserOnlyReady extends Error { constructor(readonly download: BrowserDownload) { super('Keep the original browser transfer'); } }

export class Resolver {
  private agent: LocalGameAgent;
  private queue: number[] = [];
  private busy = false;
  private closing = false;
  private gateWatches = new Set<NodeJS.Timeout>();
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
  private trial: { comparison: MirrorComparison; route: DownloadCandidate; source: PageExtract; resume?: boolean } | null = null;

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
      openDrawer: (reason: string, requiresUser?: boolean) => void;
      browserSampleMs?: number;
      /** Every part of a split game is known and downloading/downloaded: preparation may start when they finish. */
      partsSettled?: (groupId: number) => void;
      recoverGamePage?: (catalogId: number, token: SessionToken) => Promise<{url:string;scrollY:number;candidates?:DownloadCandidate[]}|null>;
    },
  ) {
    this.agent = deps.agent ?? new LocalGameAgent(deps.ai, deps.browser, deps.session);
    deps.session.on('enter', () => this.resumePending());
    for(const d of deps.downloadsRepo.byState('needs-user'))deps.foreground?.hold(`download:${d.id}`,true);
  }

  shutdown() {
    this.closing = true;
    this.queue = [];
    this.controller?.abort();
    for (const timer of this.gateWatches) clearInterval(timer);
    this.gateWatches.clear();
  }

  enqueue(id: number) {
    if (this.closing) return;
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
    if (this.busy || this.closing) return;
    const token = this.deps.session.token();
    if (!token) return; // resumes when the Store becomes active
    const id = this.queue.shift();
    if (id === undefined) {this.deps.foreground?.hold('resolution-queue',false);return;}
    this.busy = true;
    this.activeId=id;this.activeEpoch=token.epoch;this.controller=new AbortController();
    try {
      if (this.deps.foreground) await this.deps.foreground.run(20, t => this.resolve(id, t),this.controller.signal);
      else await this.resolve(id, { ...token, signal: AbortSignal.any([token.signal, this.controller.signal]) });
    } catch (e) {
      if (this.closing) return;
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
        const previous = this.deps.downloadsRepo.get(id)?.resolution;
        const original = this.deps.downloadsRepo.get(id);
        const resolution = previous ? { ...previous, pageUrl: previous.linkPage?.url ?? (original?.catalogId ? this.deps.catalog.raw(original.catalogId)?.pageUrl : null) ?? previous.pageUrl, steps: 0, history: [], mirrors: undefined } : null;
        this.deps.downloadsRepo.update(id, { resolution, state: 'resolving', errorCode: null, errorDetail: null });
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
      if (this.closing) return;
      const pending = this.deps.downloadsRepo.get(id);
      if (pending?.state !== 'needs-user') this.deps.ai.setStatus({ phase: 'idle', detail: null });
      if(!this.queue.length)this.deps.foreground?.hold('resolution-queue',false);
      void this.pump();
    }
  }

  private pause(id: number, prompt: UserPrompt, checkpoint: ResolutionCheckpoint) {
    if (this.trial) {
      this.trial.comparison.paused = {route:this.trial.route.url,pageUrl:checkpoint.pageUrl};
      checkpoint.mirrors = this.trial.comparison;
    }
    this.deps.downloadsRepo.update(id, { resolution: checkpoint });
    this.deps.foreground?.hold(`download:${id}`, true);
    this.deps.downloads.setPrompt(id, prompt, 'needs-user');
    this.deps.ai.setStatus({ phase: 'paused', detail: prompt.message, context: 'interactive' });
    this.deps.openDrawer(prompt.message, true);
    if (['captcha', 'login', 'blocked'].includes(prompt.kind)) this.watchGate(id);
  }

  /** Resumes on its own as soon as the page's check/sign-in is gone; no Continue click needed. */
  private watchGate(id: number) {
    const timer = setInterval(async () => {
      const d = this.deps.downloadsRepo.get(id);
      if (!d || d.state !== 'needs-user' || !this.deps.session.active) { clearInterval(timer); this.gateWatches.delete(timer); return; }
      try {
        const ex = await this.deps.browser.extract('interactive');
        const expected = [d.resolution?.pageUrl, d.resolution?.mirrors?.paused?.pageUrl, d.resolution?.mirrors?.paused?.route];
        if (!expected.some(url => url && downloadPageKey(url) === downloadPageKey(ex.url))) return;
        if (!ex.gates.captcha && !ex.gates.login && !ex.gates.blocked) { clearInterval(timer); this.gateWatches.delete(timer); this.continueAfterUser(id); }
      } catch { /* browser busy or closed; try again on the next tick */ }
    }, 2500);
    this.gateWatches.add(timer);
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

    let resuming = d.state === 'resolving' && !!d.resolution && d.errorCode !== 'interrupted';
    const checkpoint: ResolutionCheckpoint = d.resolution ?? { pageUrl: entry.pageUrl, steps: 0, history: [] };
    if (checkpoint.linkPage && !isGameBookmark(checkpoint.linkPage.url, entry.pageUrl)) delete checkpoint.linkPage;
    // Fresh multipart jobs also have a checkpoint, but the browser can still
    // be on the previous volume's host. Restore their saved links viewport.
    if (checkpoint.steps === 0) resuming = false;
    if (checkpoint.mirrors && !checkpoint.mirrors.paused && !this.trial) {
      const source = checkpoint.mirrors.sourceUrl;
      checkpoint.linkPage ??= source && isGameBookmark(source, entry.pageUrl) ? {url:source,scrollY:checkpoint.mirrors.sourceScrollY ?? 0} : {url:entry.pageUrl,scrollY:0};
      checkpoint.pageUrl = checkpoint.linkPage.url; resuming = false;
    }
    if (!this.trial && isSiteBrowseUrl(checkpoint.pageUrl, entry.pageUrl)) { checkpoint.pageUrl = checkpoint.linkPage?.url ?? entry.pageUrl; resuming = false; }
    downloadsRepo.update(id, { state: 'resolving', errorCode: null, errorDetail: null });
    this.deps.downloads.broadcastList();
    ai.setStatus({ phase: 'navigating', detail: tm('Finding the download for {title}', { title: entry.title }), context: 'interactive' });
    this.deps.openDrawer(`Finding the download for ${entry.title}`);

    session.assertLive(token);
    if (checkpoint.mirrors?.paused && !this.trial) {
      const url = checkpoint.linkPage?.url ?? entry.pageUrl;
      const source: PageExtract = {url,title:entry.title,site:null,meta:{},jsonLd:[],cards:[],cardConfidence:0,nextPage:null,game:null,controls:[],links:[],fileLinks:[],gates:{captcha:false,login:false,blocked:false,ageGate:false,payment:false},adultSignals:[],text:'',media:[],viewport:{w:1280,h:800,scrollY:checkpoint.linkPage?.scrollY ?? checkpoint.mirrors.sourceScrollY ?? 0,docH:0}};
      return this.compareMirrors(id, token, source, checkpoint.mirrors.routes, checkpoint);
    }
    if (resuming || this.trial?.resume) {
      const shot = await browser.snapshot('interactive', false, token.signal);
      resuming = downloadPageKey(shot.url) === downloadPageKey(checkpoint.pageUrl);
    }
    // Another part of a split game seen as a direct link next to the first: no browsing needed.
    if (d.groupId && checkpoint.partUrl && checkpoint.steps === 0 && mirrorRoutes(checkpoint.mirrorCandidates ?? []).length < 2 && await this.handoffUrl(id, checkpoint.partUrl, entry.pageUrl, token, checkpoint.partName ?? null)) return;
    // Snapshot old transfers before navigation can start a new one.
    const earlierMirrors=new Set(this.trial?.comparison.browserTransfers?.filter(t=>t.route!==this.trial!.route.url).map(t=>t.download.target));
    this.ignoredBrowserTargets = new Set((await browser.takeDownloads(false)).filter((x) => checkpoint.steps === 0 || x.stopped && !x.succeeded || earlierMirrors.has(x.target)).map((x) => x.target));
    // After the user handled a login/CAPTCHA, continue on the page they are on.
    if (!resuming) {
      if (this.trial && !this.trial.resume && /#cgl-(?:control|upload)-\d+$/.test(this.trial.route.url)) {
        await this.returnToLinks({ url: this.trial.source.url, scrollY: this.trial.source.viewport.scrollY }, token);
      } else if (this.trial && !/#cgl-/.test(this.trial.route.url)) {
        let restored=true;
        try { await this.returnToLinks({url:this.trial.source.url,scrollY:this.trial.source.viewport.scrollY},token); }
        catch { session.assertLive(token); restored=false; } // Missing pages may still have working cached hosts.
        const followed=restored ? await browser.followLink('interactive',this.trial.source.url,this.trial.route.url,token.signal) : {followed:false,scrollY:0};
        if(followed.followed){
          this.trial.source.viewport.scrollY=followed.scrollY;
          this.trial.comparison.sourceScrollY=followed.scrollY;
          checkpoint.linkPage={url:this.trial.source.url,scrollY:followed.scrollY};
        }else await browser.navigate('interactive',checkpoint.pageUrl,token.signal);
      } else if (checkpoint.linkPage?.url === checkpoint.pageUrl) await this.returnToLinks(checkpoint.linkPage, token);
      else await browser.navigate('interactive', checkpoint.pageUrl, token.signal);
    }
    // The AI is told exactly which part of a split game this download is for.
    const goal = d.groupId && d.partIndex && d.groupId !== d.id
      ? `${entry.title}' — ONLY PART ${d.partIndex}${d.partTotal ? ` of ${d.partTotal}` : ''} (a file named like '${checkpoint.partName ?? `part ${d.partIndex}`}'). The other parts are downloaded separately: do not download them. If the page has no part ${d.partIndex}, stop and say so`
      : entry.title;
    const routeGoal = this.trial ? `${goal}. Test ONLY the observed download route ${JSON.stringify(this.trial.route.label)} (${this.trial.route.url}). This is one host in a mirror speed comparison. Follow this route's real controls; do not choose a different mirror or a different game/build/part. The launcher measures file bytes before selecting the fastest working mirror.` : goal;
    // Do not cancel another game's browser-only transfer or destroy a one-shot file.

    const rejected = new Set<string>();
    let rejectedBrowserActions=0;
    let note = '';
    let routeUrl = this.trial?.route.url ?? checkpoint.routeUrl ?? checkpoint.pageUrl;
    let emptyHostSteps = 0;
    let seenGamePage = false, sourceReturns = 0;
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
      checkpoint.pageUrl = ex.url;
      if (hostOf(ex.url) !== hostOf(entry.pageUrl) && !ex.gates.captcha && !ex.gates.blocked && !ex.gates.login && !ex.gates.ageGate && !ex.gates.payment) {
        if (downloadEvidence(ex).length || countdownSeconds(ex.text) !== null) emptyHostSteps = 0;
        const unavailable = unavailableHostReason(ex, routeUrl)
          ?? (emptyHostSteps >= 4 ? 'This host made no progress toward a file after several actions.' : null);
        if (unavailable) {
          if (this.trial) throw new Error(unavailable);
          // Older/resumed jobs can arrive on a host without a comparison. Go
          // back to observed source links; never blacklist a whole host, which
          // may still serve a different multipart volume.
          console.warn('[resolver] unavailable download route:', hostOf(routeUrl), unavailable);
          await this.returnToLinks(checkpoint.linkPage ?? { url: entry.pageUrl, scrollY: 0 }, token);
          const source = await browser.extract('interactive', token.signal);
          session.assertLive(token);
          const offered = mirrorsForPart(mirrorRoutes([...downloadEvidence(source, Number.MAX_SAFE_INTEGER), ...entry.candidates, ...(checkpoint.mirrorCandidates ?? [])]), checkpoint.partName ?? d.fileName, d.partIndex);
          const remaining = offered.filter(c => c.url !== routeUrl);
          if (!remaining.length && this.deps.recoverGamePage) return this.recoverIndexedPage(id, token, checkpoint, unavailable, true);
          if (!remaining.length) throw new Error(`${unavailable} No other download link is available on the game page.`);
          checkpoint.pageUrl = source.url;
          checkpoint.history = []; checkpoint.steps = 0;
          checkpoint.linkPage = { url: source.url, scrollY: source.viewport.scrollY };
          checkpoint.mirrors = { sourceUrl: source.url, sourceScrollY: source.viewport.scrollY, routes: offered, tested: [routeUrl], samples: [], failures: [{ route: routeUrl, reason: unavailable }] };
          return this.compareMirrors(id, token, source, remaining, checkpoint);
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

      if (hostOf(ex.url) === hostOf(entry.pageUrl)) {
        const browse = isSiteBrowseUrl(ex.url, entry.pageUrl), unavailable = unavailableHostReason(ex, entry.pageUrl);
        if (browse || unavailable) {
          if (this.trial) throw new Error('The host left the observed route for a homepage/search page or unavailable game page.');
          if (browse && seenGamePage && ++sourceReturns <= 2) {
            await this.returnToLinks(checkpoint.linkPage ?? {url:entry.pageUrl,scrollY:0}, token);
            note = `This game is already indexed at ${entry.pageUrl}. Continue from its download links without searching.`;
            continue;
          }
          return this.recoverIndexedPage(id, token, checkpoint, unavailable ?? 'The saved game URL redirected to a homepage or search page.');
        }
        seenGamePage = true;
      }
      this.lastPage = ex;
      if (hostOf(ex.url) === hostOf(entry.pageUrl)) {
        // Screenshot-only/script controls may not be recognised as download
        // evidence yet; their source viewport still needs a return bookmark.
        checkpoint.linkPage = { url: ex.url, scrollY: ex.viewport.scrollY };
        if (this.trial && ex.url === this.trial.source.url) {
          this.trial.source.viewport.scrollY = ex.viewport.scrollY;
          this.trial.comparison.sourceScrollY = ex.viewport.scrollY;
        }
        const offered = mirrorsForPart(mirrorRoutes([...downloadEvidence(ex, Number.MAX_SAFE_INTEGER), ...entry.candidates, ...(checkpoint.mirrorCandidates ?? []), ...(!checkpoint.mirrors?.selected && !checkpoint.mirrors?.finished ? checkpoint.mirrors?.routes ?? [] : [])]), checkpoint.partName ?? d.fileName, d.partIndex);
        if (!this.trial && offered.length > 1) {
          try { await this.compareMirrors(id, token, ex, offered, checkpoint); return; }
          catch (error) {
            session.assertLive(token); if (isCancelled(error) || !this.deps.recoverGamePage) throw error;
            // A valid indexed page is not missing just because its hosts failed.
            // Leave its links visible instead of opening a homepage search.
            await this.returnToLinks(checkpoint.linkPage ?? {url:ex.url,scrollY:ex.viewport.scrollY},token);
            throw error;
          }
        }
        if (this.trial) this.trial.comparison.routes = mirrorRoutes([...this.trial.comparison.routes, ...offered]);
      }
      const restriction = this.routeConstraint(ex, entry.pageUrl);
      const candidates = this.candidatesFrom(ex).filter(c => !restriction || !restriction.alternatives.includes(c.url) || c.url === restriction.url).filter((c) => !rejected.has(`${ex.url}|${c.url}`));
      if (this.partNote) { note = `${note} ${this.partNote}`.trim(); this.partNote = ''; }
      if (process.env.CGL_DEBUG) console.log('[resolver] step', checkpoint.steps, ex.url, 'candidates', JSON.stringify(candidates.map((c) => [c.fileName, c.platform, c.url.slice(-16)])));
      // The model chooses each route and file from this current observation.
      const action = await this.agent.transfer(ex, token, routeGoal, checkpoint.history, candidates, note, entry.pageUrl);
      note = '';
      session.assertLive(token);
      if(downloadsRepo.get(id)?.state!=='resolving')return;
      const chosen = ex.controls.find((c) => c.i === action.index);
      if (hostOf(ex.url) === hostOf(entry.pageUrl)) {
        const tool = action.computer?.action;
        const selected = action.kind === 'download' ? candidates[action.index!]?.url
          : action.kind === 'click' ? chosen?.href ?? `${ex.url.split('#')[0]}#cgl-control-${action.index}`
          : tool?.action === 'visit_url' ? tool.url
          : tool?.action === 'click_element' ? ex.controls.find(c => c.i === tool.element)?.href
          : undefined;
        const observed = downloadEvidence(ex, Number.MAX_SAFE_INTEGER);
        routeUrl = selected ?? (observed.length === 1 ? observed[0].url : routeUrl);
        checkpoint.routeUrl = routeUrl;
        emptyHostSteps = 0;
      } else if (action.kind !== 'wait' && action.computer?.action.action !== 'wait') {
        // A page without any download evidence must not turn into a tour of
        // the host website. Explicit waits/countdowns keep their own budget.
        emptyHostSteps = downloadEvidence(ex).length ? 0 : emptyHostSteps + 1;
      }
      checkpoint.history.push(chosen && action.kind === 'click' ? actionKey(ex.url, chosen) : `${action.kind}:${action.label ?? ''}`.slice(0, 120));
      checkpoint.steps++;
      downloadsRepo.update(id, { resolution: checkpoint });
      if(action.kind==='computer'){
        if(!action.computer)throw Error('Missing browser agent action');
        let result:'continue'|'done'|'human';
        try{result=await this.agent.actBrowser(action.computer,ex,token,true,restriction);}
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
        if (restriction?.blockedControls.includes(action.index!)) {
          if (++rejectedBrowserActions >= 3) throw new Error('The AI repeatedly selected a different mirror.');
          note = 'That mirror is tested separately. Choose only the requested download route.';
          continue;
        }
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

  /** Every observed host gets its own navigation budget; byte samples run sequentially. */
  private async compareMirrors(id: number, token: SessionToken, source: PageExtract, routes: DownloadCandidate[], checkpoint: ResolutionCheckpoint): Promise<void> {
    const { downloadsRepo, browser, session, ai } = this.deps;
    const saved = checkpoint.mirrors;
    const reusable = saved && !saved.finished && !saved.selected && (saved.paused || saved.samples.every(s => Date.now() - s.measuredAt < 10 * 60_000));
    const comparison: MirrorComparison = reusable ? { ...saved, routes: mirrorRoutes([...routes, ...saved.routes]) } : { sourceUrl: source.url, routes, tested: [], samples: [], failures: [] };
    comparison.sourceUrl = source.url; comparison.sourceScrollY = source.viewport.scrollY;
    checkpoint.linkPage = { url: source.url, scrollY: source.viewport.scrollY };
    const persist = () => {
      checkpoint.linkPage = {url:source.url,scrollY:source.viewport.scrollY};
      downloadsRepo.update(id, { resolution: { ...checkpoint, pageUrl: comparison.paused?.pageUrl ?? source.url, mirrors: comparison } });
      this.deps.downloads.broadcastList();
    };
    persist();
    try {
      if (!comparison.paused && !comparison.samples.length && this.agent.mirrorVariant) {
        const record = downloadsRepo.get(id);
        const title = `${record?.title ?? ''}${checkpoint.partName ? ` — ONLY part ${record?.partIndex ?? ''}: ${checkpoint.partName}` : ''}`;
        const primary = await this.agent.mirrorVariant(token, title, comparison.routes);
        const chosen = comparison.routes[primary];
        comparison.routes = [chosen, ...comparison.routes.filter((_, i) => i !== primary)];
        persist();
      }
      while (true) {
        const route = comparison.routes.find(r => r.url === comparison.paused?.route) ?? comparison.routes.find(r => !comparison.tested.includes(r.url));
        if (!route) break;
        const index = comparison.tested.length;
        session.assertLive(token);
        if (downloadsRepo.get(id)?.state !== 'resolving') return;
        downloadsRepo.update(id, { errorDetail: tm('Testing download mirror {n} of {total}: {host}', { n: index + 1, total: comparison.routes.length, host: hostOf(route.url) }) });
        this.deps.downloads.broadcastList();
        ai.setStatus({ phase: 'navigating', detail: tm('Testing download mirror {n} of {total}: {host}', { n: index + 1, total: comparison.routes.length, host: hostOf(route.url) }), context: 'interactive' });
        const deadline = AbortSignal.timeout(180_000);
        const routeToken: SessionToken = { ...token, signal: AbortSignal.any([token.signal, deadline]) };
        const paused = comparison.paused;
        this.trial = { comparison, route, source, resume:!!paused };
        // Each host starts from an observed URL; script buttons stay on the source page.
        downloadsRepo.update(id, { resolution: { ...checkpoint, pageUrl: paused?.pageUrl ?? (/#cgl-(?:control|upload)-\d+$/.test(route.url) ? source.url : route.url), steps: paused ? Math.max(1,checkpoint.steps) : 0, history: paused ? checkpoint.history : [], mirrors: comparison }, state: 'resolving' });
        try {
          if (!paused && route.fileName && !isHostLanding(route.url) && !/#cgl-/.test(route.url)) {
            await this.takeCandidate(id, route, source, routeToken);
          }
          await this.resolve(id, routeToken);
          if (downloadsRepo.get(id)?.state === 'needs-user') return;
          throw new Error('The mirror did not start a game file transfer.');
        } catch (error) {
          session.assertLive(token); // Parent cancellation is never a failed mirror.
          if (downloadsRepo.get(id)?.state !== 'resolving' && downloadsRepo.get(id)?.state !== 'needs-resolution') return;
          delete comparison.paused;
          if (error instanceof BrowserOnlyReady) {
            // Keep one-shot requests alive, but do not skip the other hosts.
            comparison.browserTransfers ??= [];
            comparison.browserTransfers.push({route:route.url,download:error.download});
            const sample=await this.measureBrowserMirror(error.download,route,source,token);
            if(sample)recordMirror(comparison,sample);
            else comparison.failures.push({route:route.url,reason:'The browser file could not be measured and verified; retained as a fallback.'});
          } else if (error instanceof MirrorReady) {
            recordMirror(comparison, error.sample);
          } else {
            const reason = deadline.aborted ? 'The mirror navigation timed out.' : (error as Error).message.slice(0, 180);
            comparison.failures.push({ route: route.url, reason });
            console.warn('[resolver] skipping unavailable mirror:', hostOf(route.url), reason);
          }
          comparison.tested.push(route.url);
          downloadsRepo.update(id, { state: 'resolving' });
          persist();
          if (!(error instanceof MirrorReady)) {
            // Reset the browser to the real game page before trying another
            // observed route. The failed route remains recorded across restart.
            await this.returnToLinks(checkpoint.linkPage, token);
          }
        } finally { this.trial = null; }
      }
      this.lastPage = source;
      for (const winner of fastestMirrors(comparison.samples)) {
        session.assertLive(token);
        if (downloadsRepo.get(id)?.state !== 'resolving') return;
        try {
          if(winner.browserDownload){
            const live=(await browser.takeDownloads(false)).find(d=>d.target===winner.browserDownload!.target&&(d.succeeded||!d.stopped));
            if(!live)continue;
            this.claimedBrowserTargets.add(live.target);
            this.deps.downloads.adoptBrowserDownload(id,live);
            this.afterFile(id,basename(live.target));
          } else {
          // Refresh cookies and validate the selected link again before handoff.
          if (!await this.handoffUrl(id, winner.url, winner.referer, token, winner.fileName ?? winner.nameHint, winner)) { comparison.failures.push({ route: winner.route, reason: 'The measured link expired or changed before handoff.' }); continue; }
          }
          comparison.finished = true;
          comparison.selected = { host: hostOf(winner.url)||hostOf(winner.route), speedBps: winner.speedBps, tested: comparison.samples.length };
          persist();
          await this.cancelBrowserAlternatives(comparison,winner.browserDownload?.target);
          console.log(`[resolver] selected fastest measured mirror ${comparison.selected.host}: ${formatSpeed(winner.speedBps)} (${comparison.samples.length} measured mirrors)`);
          return;
        } catch (error) { session.assertLive(token); comparison.failures.push({ route: winner.route, reason: 'Measured link expired before handoff.' }); }
      }
      // Only after all routes have been attempted may an unmeasurable original
      // be adopted. No fastest-host claim is made without measured bytes.
      const live=await browser.takeDownloads(false);
      for(const fallback of comparison.browserTransfers??[]){
        const download=live.find(d=>d.target===fallback.download.target&&(d.succeeded||!d.stopped));
        if(!download)continue;
        this.claimedBrowserTargets.add(download.target);
        this.deps.downloads.adoptBrowserDownload(id,download);
        this.afterFile(id,basename(download.target));
        comparison.finished=true;persist();
        await this.cancelBrowserAlternatives(comparison,download.target);
        this.deps.foreground?.transferHandoff();return;
      }
      comparison.finished = true; persist();
      throw new Error('None of the tested download mirrors returned a working copy of the selected game file.');
    } finally { this.trial = null; }
  }

  private async cancelBrowserAlternatives(comparison:MirrorComparison,keep?:string){
    for(const candidate of comparison.browserTransfers??[]){
      if(candidate.download.target===keep)continue;
      await this.deps.browser.takeDownloads(true,candidate.download.target).catch(()=>undefined);
    }
  }

  private async measureBrowserMirror(download:BrowserDownload,route:DownloadCandidate,source:PageExtract,token:SessionToken):Promise<MeasuredMirror|null>{
    const start=Date.now();
    if(!download.succeeded)await delay(this.deps.browserSampleMs??5000,undefined,{signal:token.signal});
    const live=(await this.deps.browser.takeDownloads(false)).find(d=>d.target===download.target&&(d.succeeded||!d.stopped));
    if(!live)return null;
    const prefix=await this.deps.downloadWorker.call<{hash:string;bytes:number}|null>('browserFilePrefix',{target:live.target,partFilePath:live.partFilePath},token.signal);
    if(!prefix)return null;
    const elapsedMs=Math.max(1,Date.now()-start),sampledBytes=Math.max(0,live.currentBytes-download.currentBytes);
    const speedBps=live.speedBps || (sampledBytes?sampledBytes*1000/elapsedMs:live.succeeded&&live.startedAt?live.currentBytes*1000/Math.max(1,Date.now()-live.startedAt):0);
    return {route:route.url,url:live.url,referer:live.referrer??source.url,nameHint:basename(live.target),platform:route.platform,browserDownload:live,fileName:basename(live.target),totalBytes:live.totalBytes,speedBps,sampledBytes,elapsedMs,prefixHash:prefix.hash,prefixBytes:prefix.bytes,resumable:false,measuredAt:Date.now()};
  }

  private async returnToLinks(page: { url: string; scrollY: number }, token: SessionToken) {
    await this.deps.browser.returnToPage('interactive', page.url, page.scrollY, token.signal);
    this.deps.session.assertLive(token);
  }

  private async recoverIndexedPage(id: number, token: SessionToken, checkpoint: ResolutionCheckpoint, reason: string, skipCached = false): Promise<void> {
    const d = this.deps.downloadsRepo.get(id), entry = d?.catalogId ? this.deps.catalog.raw(d.catalogId) : null;
    if (!entry || checkpoint.pageRecoveryAttempted) throw new Error(`${reason} No verified replacement game page was found.`);
    // A page can disappear while its already indexed file hosts still work.
    // Try those before spending time on a new website search.
    const cached = mirrorsForPart(mirrorRoutes([...(checkpoint.mirrorCandidates ?? []), ...entry.candidates]), checkpoint.partName ?? d!.fileName, d!.partIndex);
    if (cached.length && !skipCached) {
      const source: PageExtract = {url:entry.pageUrl,title:entry.title,site:null,meta:{},jsonLd:[],cards:[],cardConfidence:0,nextPage:null,game:null,controls:[],links:[],fileLinks:[],gates:{captcha:false,login:false,blocked:false,ageGate:false,payment:false},adultSignals:[],text:'',media:[],viewport:{w:1280,h:800,scrollY:checkpoint.linkPage?.scrollY ?? 0,docH:0}};
      try { await this.compareMirrors(id, token, source, cached, checkpoint); return; }
      catch (error) { this.deps.session.assertLive(token); if (isCancelled(error)) throw error; }
    }
    checkpoint.pageRecoveryAttempted = true;
    this.deps.downloadsRepo.update(id, {state:'resolving',resolution:checkpoint});
    const recovered = await this.deps.recoverGamePage?.(entry.id, token);
    this.deps.session.assertLive(token);
    if (this.deps.downloadsRepo.get(id)?.state !== 'resolving') return;
    if (!recovered || !isGameBookmark(recovered.url, entry.pageUrl)) throw new Error(`${reason} No verified replacement game page was found.`);
    this.deps.catalog.saveRecoveredPage(entry.id, recovered.url, recovered.candidates);
    this.deps.downloadsRepo.update(id, {resolution:{...checkpoint,pageUrl:recovered.url,linkPage:{url:recovered.url,scrollY:recovered.scrollY},steps:0,history:[],mirrors:undefined}});
    await this.resolve(id, token);
  }

  private routeConstraint(ex: PageExtract, gamePageUrl: string): BrowserRouteConstraint {
    const base: BrowserRouteConstraint = {pageUrl:ex.url,url:this.trial?.route.url ?? '',alternatives:[],blockedControls:[],gamePageUrl};
    if (!this.trial || ex.url.split('#')[0] !== this.trial.source.url.split('#')[0]) return base;
    const controlIndex = (url: string) => {
      const control = /#cgl-control-(\d+)$/.exec(url);
      const upload = /#cgl-upload-(\d+)$/.exec(url);
      return control ? Number(control[1]) : upload ? ex.game?.uploads[Number(upload[1])]?.i : ex.controls.find(c => c.href === url)?.i;
    };
    const chosen = controlIndex(this.trial.route.url);
    return {
      gamePageUrl,
      pageUrl: this.trial.source.url, url: this.trial.route.url,
      alternatives: this.trial.comparison.routes.map(r => r.url),
      blockedControls: this.trial.comparison.routes.filter(r => r.url !== this.trial!.route.url).map(r => controlIndex(r.url)).filter((i): i is number => i != null && i !== chosen),
    };
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
    if (this.trial && c.platform) this.trial.route = { ...this.trial.route, platform: c.platform };
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
  private async handoffUrl(id: number, url: string, referer: string, token: SessionToken, nameHint: string | null, expected?: MeasuredMirror): Promise<boolean> {
    const { browser, session, downloadWorker } = this.deps;
    const auth = await browser.cookieHeader('interactive', url);
    session.assertLive(token);
    // Same cookies Firefox would send to the file's host (domain/path/secure-matched in the worker).
    const headers: Record<string, string> = { 'User-Agent': auth.userAgent, Referer: referer };
    if (auth.cookie) headers.Cookie = auth.cookie;
    if (this.trial) {
      const detail = tm('Testing download speed from {host}', { host: hostOf(url) });
      this.deps.ai.setStatus({ phase: 'navigating', detail, context: 'interactive' });
      this.deps.downloadsRepo.update(id, { errorDetail: detail });
      this.deps.downloads.broadcastList();
      let sample: MirrorSample;
      try { sample = await downloadWorker.call<MirrorSample>('benchmarkMirror', { url, headers }, token.signal); } catch (error) {
        if ((error as { code?: string }).code === 'not-a-file') return false;
        throw error;
      }
      session.assertLive(token, 'mirror measurement');
      const name = sample.fileName ?? nameHint;
      if (!this.partAccepted(id, name)) throw new Error('This mirror serves a different archive part.');
      throw new MirrorReady({ ...sample, route: this.trial.route.url, url, referer, nameHint, platform: this.trial.route.platform });
    }
    const probe = await downloadWorker.call<{ isFile: boolean; fileName: string | null; totalBytes: number | null; finalUrl: string; status: number }>('probe', { url, headers }, token.signal);
    session.assertLive(token, 'link check');
    if (!probe.isFile) return false;
    if (expected && ((expected.totalBytes !== null && probe.totalBytes !== null && expected.totalBytes !== probe.totalBytes) || (expected.fileName && probe.fileName && mirrorFileName(expected.fileName) !== mirrorFileName(probe.fileName)))) return false;
    if (this.deps.downloadsRepo.get(id)?.state !== 'resolving') return false;
    const name = probe.fileName ?? nameHint;
    if (!this.partAccepted(id, name)) return false;
    const linkPage = this.deps.downloadsRepo.get(id)?.resolution?.linkPage;
    this.deps.downloads.handoff(id, url, headers, name, probe.totalBytes);
    this.afterFile(id, name, linkPage);
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
    if (this.trial) {
      if (dl.succeeded) throw new BrowserOnlyReady(dl);
      if (/^https?:/i.test(dl.url)) {
        try {
          const auth = await this.deps.browser.cookieHeader('interactive', dl.url);
          const headers: Record<string, string> = { 'User-Agent': auth.userAgent, Referer: dl.referrer ?? this.trial.source.url };
          if (auth.cookie) headers.Cookie = auth.cookie;
          const sample = await this.deps.downloadWorker.call<MirrorSample>('benchmarkMirror', { url: dl.url, headers }, token.signal);
          const prefix = await this.deps.downloadWorker.call<{ hash: string; bytes: number } | null>('browserFilePrefix', { target: dl.target, partFilePath:dl.partFilePath }, token.signal);
          this.deps.session.assertLive(token);
          if (sample.resumable && prefix?.hash === sample.prefixHash && prefix.bytes === sample.prefixBytes && (dl.totalBytes === null || sample.totalBytes === dl.totalBytes)) {
            await this.deps.browser.takeDownloads(true, dl.target);
            this.ignoredBrowserTargets.add(dl.target);
            throw new MirrorReady({ ...sample, route: this.trial.route.url, url: dl.url, referer: headers.Referer, nameHint: nameHint ?? basename(dl.target), platform: this.trial.route.platform });
          }
        } catch (error) {
          if (error instanceof MirrorReady || token.signal.aborted) throw error;
          // Failed replay proof must never discard the original Firefox request.
        }
      }
      throw new BrowserOnlyReady(dl);
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
  private afterFile(id: number, fileName: string | null, linkPage?: ResolutionCheckpoint['linkPage']) {
    const repo = this.deps.downloadsRepo;
    const d = repo.get(id);
    if (!d?.catalogId || !fileName) return;
    const entry = this.deps.catalog.raw(d.catalogId);
    if (!entry) return;
    linkPage ??= d.resolution?.linkPage;
    const offered = [...(this.lastPage ? downloadEvidence(this.lastPage, Number.MAX_SAFE_INTEGER) : []), ...entry.candidates];
    if (d.groupId) {
      const lead = repo.get(d.groupId);
      if (lead && lead.partTotal === null && d.partIndex) this.createPart(lead, d.partIndex + 1, offered, linkPage);
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
    for (const k of wanted) this.createPart(lead, k, offered, linkPage);
    if (total) this.deps.partsSettled?.(id);
  }

  private createPart(lead: ReturnType<DownloadsRepo['get']> & object, index: number, offered: DownloadCandidate[], linkPage = lead.resolution?.linkPage) {
    const repo = this.deps.downloadsRepo;
    if (repo.group(lead.id).some((x) => x.partIndex === index)) return;
    const sample = lead.fileName ?? '';
    const set = this.partName(sample, offered.map((o) => o.fileName).find((f) => partOf(f)) ?? null)?.set;
    const direct = offered.find((o) => { const q = this.partName(o.fileName, sample); return !!q && q.index === index && q.set === set && /^https?:/i.test(o.url) && !isHostLanding(o.url); });
    const entry = this.deps.catalog.raw(lead.catalogId!);
    const oldRar = /\.rar$/i.test(sample) && offered.some(o => partOf(o.fileName)?.style === 'rar-old' && partOf(o.fileName)?.set === sample.toLowerCase());
    const expectedName = oldRar && index > 1 ? sample.replace(/\.rar$/i, `.r${String(index - 2).padStart(2, '0')}`) : partFileName(sample, index);
    const rec = repo.create({ catalogId: lead.catalogId, title: lead.title, sourceHost: lead.sourceHost, state: 'resolving' });
    repo.update(rec.id, {
      groupId: lead.id, partIndex: index, partTotal: lead.partTotal, updateGameId: lead.updateGameId,
      resolution: { pageUrl: linkPage?.url ?? entry?.pageUrl ?? lead.resolution?.pageUrl ?? '', linkPage, steps: 0, history: [], partUrl: direct?.url, partName: expectedName, mirrorCandidates: mirrorsForPart(offered, expectedName, index) },
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
