import type { ClassificationService } from './classification';
import { hostOf } from '@shared/urls';
import { isCancelled } from '@shared/worker-protocol';
import type { StoreSearchResult } from '@shared/types';
import type { StoreSession, SessionToken } from './store-session';
import type { ForegroundWork } from './foreground';
import type { SourcesRepo, CatalogRepo } from './repos';
import type { PolicyService } from './policy-service';
import type { BrowserClient } from './browser-client';
import { SearchDecisionRejected, type LocalGameAgent } from './game-agent';
import type { Discovery } from './discovery';
import type { AiService } from './ai';
import type { HostRateLimiter } from './rate-limit';
import { tm } from './i18n';

// Keep non-Latin titles searchable too; the catalog's legacy titleKey is ASCII.
const searchTitle=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();

export class StoreSearch {
  private controller: AbortController | null = null;
  constructor(private deps: { session: StoreSession; foreground: ForegroundWork; sources: SourcesRepo; catalog: CatalogRepo; policy: PolicyService; browser: BrowserClient; agent: LocalGameAgent; discovery: Discovery; ai: AiService; limiter: HostRateLimiter; classification?: ClassificationService; isModelReady?:()=>boolean; showBrowser: (message: string) => void }) {
    deps.session.on('leave', () => this.releaseCheck());
  }
  cancel() { this.controller?.abort(); this.controller = null; this.releaseCheck(); }
  private checkTimer: NodeJS.Timeout | null = null;
  /**
   * While the user completes a search's website check, indexing pauses so it
   * does not navigate that browser away — but never indefinitely: the pause
   * ends when the check is done, the panel closes, Store is left, or after 3 min.
   */
  private holdForCheck() {
    this.deps.foreground.hold('search-verification',true);
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => this.releaseCheck(), 3 * 60_000);
    this.checkTimer.unref?.();
  }
  releaseCheck() {
    if (this.checkTimer) { clearTimeout(this.checkTimer); this.checkTimer = null; }
    this.deps.foreground.hold('search-verification',false);
  }
  async search(query: string, sourceIds?: number[]): Promise<StoreSearchResult> {
    this.cancel();
    const controller = new AbortController(); this.controller = controller;
    try {
      return await this.deps.foreground.run(10, token => this.find(query.trim(), sourceIds, token), controller.signal);
    } catch (error) {
      if (controller.signal.aborted || isCancelled(error)) return { id:null, message:'Search cancelled', cancelled:true };
      throw error;
    } finally { if (this.controller === controller) this.controller = null; }
  }
  private async find(query: string, sourceIds: number[] | undefined, token: SessionToken): Promise<StoreSearchResult> {
    const { session, catalog, sources, policy, browser, agent, discovery, ai, limiter } = this.deps;
    if(!searchTitle(query))return {id:null,message:'Enter a game title to search'};
    const enabled = sources.list().filter(s => s.enabled && (!sourceIds?.length || sourceIds.includes(s.id)));
    const cached = catalog.query(policy.policy(), { search:query,sourceIds:enabled.map(s=>s.id),limit:100 }).entries.find(e => searchTitle(e.title).includes(searchTitle(query)));
    if (cached && enabled.some(s=>s.id===cached.sourceId)) return { id:cached.id,message:'Opened saved game — no website rescan needed' };
    if (!enabled.length) return { id:null,message:'Add or enable a game website first' };
    if(this.deps.isModelReady&&!this.deps.isModelReady())throw Error('Download the browsing and analysis agents in Settings → Local AI first.');
    const errors: string[] = [];
    for (const source of enabled) {
      try {
        ai.setStatus({phase:'navigating',detail:tm('Searching {name} for “{query}”',{name:source.name,query}),context:'discovery'});
        await limiter.wait(hostOf(source.url), source.rateLimitMs, token.signal);
        session.assertLive(token);
        await browser.navigate('discovery',source.url,token.signal);
        const history: string[] = [];
        let rejected=0;
        for (let turn=0;turn<10;turn++) {
          session.assertLive(token);
          let ex = await browser.extract('discovery',token.signal);
          if (ex.gates.captcha) ex = await agent.verify(ex,'discovery',token);
          session.assertLive(token);
          if (ex.gates.captcha || ex.gates.login || ex.gates.blocked || ex.gates.ageGate) {
            const message=`${source.name} requires your website verification. Complete it in the browser, then search again.`;
            this.holdForCheck();
            this.deps.showBrowser(message); errors.push(message); break;
          }
          // Fast path: a card or link whose text is exactly the requested title
          // needs no model decision.
          const exact = [...ex.cards, ...ex.links.filter(l => l.inContent !== false).map(l => ({ href:l.href, title:l.text, img:l.img, text:'', platforms:[], price:null, author:null, tags:[], categories:[] }))]
            .find(c => searchTitle(c.title) === searchTitle(query) && new URL(c.href).origin !== 'null' && c.href.split('#')[0] !== ex.url.split('#')[0]);
          let decision: Awaited<ReturnType<LocalGameAgent['search']>>;
          if (exact) decision = { cards:[exact], action:'done', index:null };
          else try { decision=await agent.search(ex,token,query,history); }
          catch(error){
            if(!(error instanceof SearchDecisionRejected)||++rejected>=3)throw error;
            history.push(error.message);continue;
          }
          session.assertLive(token,'search results');
          const ids=decision.cards.map(card=>discovery.storeCard(source.id,card,ex)?.id).filter((id):id is number=>!!id);
          // Like indexing: the confirmed game shows once its cover passes the
          // content check; the detail check below then verifies its download
          // (an AI-selected review without download evidence is hidden again).
          catalog.markListed(ids);
          for (const id of ids) {
            session.assertLive(token);
            await discovery.fetchDetail(id,token,{foreground:true});
            if (catalog.raw(id)?.rating === 'unknown') await this.deps.classification?.classifyEntry(id, token.signal);
            session.assertLive(token);
            const verified=catalog.get(id,policy.policy());
            if (verified && searchTitle(verified.title).includes(searchTitle(query))) return {id,message:`Found and verified on ${source.name}`};
            history.push(`Rejected result ${JSON.stringify(verified?.title??catalog.raw(id)?.title)}: it does not provide the requested playable game ${JSON.stringify(query)}. Search for the user's title using the observed site search, or choose another matching result.`);
          }
          if (ids.length) {
            session.assertLive(token);
            await limiter.wait(hostOf(ex.url),source.rateLimitMs,token.signal);
            await browser.navigate('discovery',ex.url,token.signal);
            continue;
          }
          if (decision.action === 'done') break;
          const key=JSON.stringify([ex.url,ex.viewport.scrollY,decision.action,decision.index]);
          if (history.includes(key)) break;
          history.push(key);
          await limiter.wait(hostOf(ex.url),source.rateLimitMs,token.signal);
          session.assertLive(token,'search tool');
          if (decision.action === 'submit') {
            await browser.clickElement('discovery',decision.index!,token.signal);
            await browser.type('discovery',{key:'SelectAll'},token.signal);
            await browser.type('discovery',{text:query},token.signal);
            await browser.type('discovery',{key:'Enter'},token.signal);
          } else if (decision.action === 'click') await browser.clickElement('discovery',decision.index!,token.signal);
          else if (decision.action === 'scroll') await browser.scroll('discovery',640,400,0,650,token.signal);
          else await new Promise<void>((resolve,reject)=>{
            const abort=()=>{clearTimeout(timer);reject(Object.assign(Error('Cancelled'),{code:'cancelled'}));};
            const timer=setTimeout(()=>{token.signal.removeEventListener('abort',abort);resolve();},1000);
            token.signal.addEventListener('abort',abort,{once:true});
          });
        }
      } catch (error) {
        if (isCancelled(error) || !session.isLive(token)) throw error;
        errors.push(`${source.name}: ${(error as Error).message}`);
      }
    }
    ai.setStatus({phase:'idle',detail:null});
    return {id:null,message:errors.length?errors.join(' · ').slice(0,500):'No matching downloadable game was found on your enabled websites. Try another title.'};
  }
}
