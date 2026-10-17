// Minimal global state for the renderer, backed by main-process events.
import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { AiStatus, DateCheckPhase, BrowserSnapshot, CatalogSort, CrawlProgress, DownloadItem, Game, Platform, Settings, Source, StoresState, SystemInfo, TabId, WishItem } from '@shared/types';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface BrowserState {
  open: boolean;
  snapshot: (BrowserSnapshot & { policyRevision: number }) | null;
  attention: string | null;
  attentionSourceId?: number | null;
  humanMode?: boolean;
  /** Set when the policy changed and the current frame must not be shown until a fresh one arrives. */
  stale: boolean;
}

export interface AppState {
  tab: TabId;
  settings: Settings | null;
  info: SystemInfo | null;
  policy: { showNsfw: boolean; revision: number };
  sources: Source[];
  downloads: DownloadItem[];
  library: Game[];
  ai: AiStatus;
  crawl: Record<number, CrawlProgress>;
  datePhase: DateCheckPhase;
  toasts: Toast[];
  appVisible: boolean;
  /** GOG and Epic accounts, the games they own, and installs in progress. */
  stores: StoresState;
  /** Increments whenever the catalog changed under the current policy. */
  catalogVersion: number;
  /** Catalog ids that must disappear immediately (policy tightened). */
  hiddenIds: Set<number>;
  browser: BrowserState;
  detailId: number | null;
  /** Where the user was in the Store: kept while they visit other tabs. */
  storeView: StoreView;
  wishlist: WishItem[];
  /** Full-screen, controller-driven view. */
  couch: boolean;
}

export interface StoreView {
  search: string;
  sort: CatalogSort;
  category: string;
  tag: string;
  platforms: Platform[];
  sources: number[];
  scrollTop: number;
  /** How many games were loaded, so coming back restores the same scroll position. */
  loaded: number;
  /** Show only wishlisted games. */
  wishlist: boolean;
}

const STORE_VIEW_KEY = 'cgl.storeView';
function initialStoreView(): StoreView {
  const base: StoreView = { search: '', sort: 'popular', category: '', tag: '', platforms: [], sources: [], scrollTop: 0, loaded: 0, wishlist: false };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_VIEW_KEY) ?? 'null') as Partial<StoreView> | null;
    if (saved) return { ...base, sort: saved.sort ?? base.sort, category: saved.category ?? '', tag: saved.tag ?? '', platforms: saved.platforms ?? [], sources: saved.sources ?? [] };
  } catch { /* storage unavailable */ }
  return base;
}

/** Updates the Store view; the filters (not the search text or scroll) also survive restarts. */
export function setStoreView(patch: Partial<StoreView>) {
  setState((s) => ({ storeView: { ...s.storeView, ...patch } }));
  if ('sort' in patch && state.tab === 'store') void api.invoke('store:setActive',{active:true,sort:state.storeView.sort}).catch(()=>undefined);
  if (['sort', 'category', 'tag', 'platforms', 'sources'].some((k) => k in patch)) {
    try {
      const { sort, category, tag, platforms, sources } = getState().storeView;
      localStorage.setItem(STORE_VIEW_KEY, JSON.stringify({ sort, category, tag, platforms, sources }));
    } catch { /* storage unavailable */ }
  }
}

let state: AppState = {
  // The page the app was last on comes with the settings at start (see init).
  tab: 'store',
  settings: null,
  info: null,
  policy: { showNsfw: false, revision: 0 },
  sources: [],
  downloads: [],
  library: [],
  ai: { phase: 'idle', detail: null, context: null, storeActive: false, modelLoaded: false, accel: null },
  crawl: {},
  datePhase: 'idle',
  toasts: [],
  appVisible: true,
  stores: { accounts: { gog: { loggedIn: false, user: null, error: null }, epic: { loggedIn: false, user: null, error: null } }, owned: [], jobs: [], refreshing: false },
  catalogVersion: 0,
  hiddenIds: new Set(),
  browser: { open: false, snapshot: null, attention: null, stale: false },
  detailId: null,
  storeView: initialStoreView(),
  wishlist: [],
  couch: false,
};

const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

let toastSeq = 0;
export function pushToast(kind: Toast['kind'], message: string) {
  const id = ++toastSeq;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
  setTimeout(() => dismissToast(id), kind === 'error' ? 9000 : 5500);
}

export function dismissToast(id: number) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Runs an API call and surfaces failures as a toast. */
export async function attempt<T>(fn: () => Promise<T>, okMessage?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (okMessage) pushToast('success', okMessage);
    return r;
  } catch (e) {
    pushToast('error', (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return undefined;
  }
}

export function setTab(tab: TabId) {
  const prev = state.tab;
  if (prev === tab) return;
  setState({ tab, detailId: tab === 'store' ? state.detailId : null });
  // Remembered in the launcher's database right away: it reopens on this page after a restart.
  void api.invoke('app:setLastTab', { tab }).catch(() => undefined);
  // Leaving the Store pauses indexing (download work continues); entering starts it.
  if (prev === 'store' || tab === 'store') void api.invoke('store:setActive', { active: tab === 'store', sort: state.storeView.sort }).then((ai) => setState({ ai })).catch(() => undefined);
  if (tab !== 'store') setState((s) => ({ browser: { ...s.browser, open: false, snapshot: null } }));
}

export async function boot() {
  const [settings, info, sources, downloads, library, consent] = await Promise.all([
    api.invoke('settings:get'),
    api.invoke('app:info'),
    api.invoke('sources:list'),
    api.invoke('download:list'),
    api.invoke('library:list'),
    api.invoke('consent:get'),
  ]);
  setState({ settings, info, sources, downloads, library, policy: { showNsfw: consent.showNsfw, revision: consent.policyRevision }, tab: settings.lastTab ?? 'store' });

  api.on('settings:changed', (s) => setState({ settings: s }));
  api.on('policy:changed', ({ showNsfw, policyRevision }) => {
    setState((s) => ({
      policy: { showNsfw, revision: policyRevision },
      // Hide the browser frame until one approved under the new policy arrives.
      browser: { ...s.browser, stale: true },
    }));
  });
  api.on('catalog:hidden', ({ policyRevision, ids }) => {
    if (policyRevision !== state.policy.revision) return;
    const hidden = new Set(ids);
    setState((s) => ({ hiddenIds: hidden, detailId: s.detailId !== null && hidden.has(s.detailId) ? null : s.detailId }));
  });
  api.on('catalog:changed', ({ policyRevision }) => {
    if (policyRevision !== state.policy.revision) return;
    setState((s) => ({ catalogVersion: s.catalogVersion + 1 }));
  });
  api.on('sources:changed', (sources) => setState({ sources }));
  api.on('store:dateStatus', datePhase => setState({datePhase}));
  void api.invoke('store:dateStatus').then(datePhase => setState({datePhase}));
  api.on('crawl:progress', (p) => setState((s) => ({ crawl: { ...s.crawl, [p.sourceId]: p } })));
  api.on('downloads:changed', (downloads) => setState({ downloads }));
  api.on('download:progress', (p) =>
    setState((s) => ({ downloads: s.downloads.map((d) => (d.id === p.id ? { ...d, ...p } : d)) })),
  );
  api.on('library:changed', (library) => setState({ library }));
  api.on('wishlist:changed', (wishlist) => setState({ wishlist }));
  // A notification was clicked: show that game in the Store.
  api.on('app:openGame', ({ catalogId }) => { setTab('store'); setState({ detailId: catalogId }); });
  api.on('app:couch', ({ on }) => setState({ couch: on }));
  api.on('ai:status', (ai) => setState({ ai }));
  api.on('toast', ({ kind, message }) => pushToast(kind, message));
  api.on('app:visibility', ({ visible }) => setState({ appVisible: visible }));
  api.on('browser:snapshot', (snap) => {
    if (snap.policyRevision !== state.policy.revision) return; // produced under an older policy
    setState((s) => (s.tab === 'store' ? { ...(snap.verificationRequired ? {detailId:null} : {}), browser: { ...s.browser, open: true, snapshot: snap, stale: false } } : {}));
  });
  api.on('browser:humanMode', ({ active }) => setState((s) => ({ browser: { ...s.browser, humanMode: active, open: s.tab === 'store' ? true : s.browser.open, snapshot: null } })));
  api.on('browser:closed', () => setState((s) => ({ browser: { ...s.browser, open: false, snapshot: null } })));
  api.on('browser:attention', ({ message, sourceId, requiresUser }) => setState((s) => (s.tab === 'store' ? { ...(requiresUser ? {detailId:null} : {}), browser: { ...s.browser, open: true, attention: message, attentionSourceId: sourceId ?? null } } : {})));
  api.on('browser:verificationResolved', ({ sourceId }) => setState((s) => s.browser.attentionSourceId === sourceId ? { browser: { ...s.browser, attention: null, attentionSourceId: null } } : {}));

  document.addEventListener('visibilitychange', () => setState({ appVisible: document.visibilityState === 'visible' }));
  api.on('stores:changed', (stores) => setState({ stores }));
  api.on('stores:jobsChanged', (jobs) => setState((s) => ({ stores: { ...s.stores, jobs } })));
  void api.invoke('stores:state').then((stores) => setState({ stores })).catch(() => undefined);
  void api.invoke('wishlist:list').then((wishlist) => setState({ wishlist })).catch(() => undefined);
  // Also picks up the AI status from before this window subscribed to updates.
  const ai = await api.invoke('store:setActive', { active: state.tab === 'store', sort: state.storeView.sort }).catch(() => null);
  if (ai) setState({ ai });
}
