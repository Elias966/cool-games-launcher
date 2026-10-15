import { KineticTitle } from '../components/KineticTitle';
import { latestCatalogDownload } from '@shared/download-state';
import { AnimatePresence } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';
import { attempt, setState, setStoreView, setTab, useApp } from '../state';
import { GameCard } from '../components/GameCard';
import { GameDetail } from '../components/GameDetail';
import { sound } from '../sound';
import { BrowserDrawer } from '../components/BrowserDrawer';
import { Button, EmptyState, Overlay } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import type { CatalogEntry, CatalogSort, DownloadItem, FacetValue, Platform } from '@shared/types';
import { t, tk, locale, platformName } from '../i18n';

const PLATFORM_FILTERS: Platform[] = ['linux', 'windows'];
const PAGE = 120;

const SORTS: Array<{ id: CatalogSort; label: string; icon: IconName; hint: string }> = [
  { id: 'popular', label: tk('Popular'), icon: 'star', hint: tk('Most downloaded and played first, from the sites’ own lists and counters') },
  { id: 'trending', label: tk('Trending'), icon: 'flame', hint: tk('Popular right now: the sites’ trending lists, then popular recent releases') },
  { id: 'new', label: tk('New'), icon: 'clock', hint: tk('Most recently found first') },
  { id: 'title', label: tk('A–Z'), icon: 'sort', hint: tk('Alphabetical') },
];

export function StoreTab() {
  const policy = useApp((s) => s.policy);
  const catalogVersion = useApp((s) => s.catalogVersion);
  const hiddenIds = useApp((s) => s.hiddenIds);
  const sources = useApp((s) => s.sources);
  const crawl = useApp((s) => s.crawl);
  const detailId = useApp((s) => s.detailId);
  const browserOpen = useApp((s) => s.browser.open);
  const downloads = useApp((s) => s.downloads);
  // Filters, sort and scroll live in app state: leaving the Store keeps your place.
  const view = useApp((s) => s.storeView);
  const { sort, category, tag } = view;
  const wishOnly = view.wishlist;
  const wishlist = useApp((s) => s.wishlist);
  const [fuzzy, setFuzzy] = useState(false);
  const [watchTitle, setWatchTitle] = useState('');
  const platformFilter = view.platforms;
  const sourceFilter = view.sources;
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearchText] = useState(view.search);
  const [debounced, setDebounced] = useState(view.search);
  const [searching,setSearching] = useState(false);
  const [searchMessage,setSearchMessage] = useState('');
  const searchGeneration=useRef(0);
  const [facets, setFacets] = useState<{ categories: FacetValue[]; tags: FacetValue[]; ranked: number; gathering: number }>({ categories: [], tags: [], ranked: 0, gathering: 0 });
  const [detail, setDetail] = useState<CatalogEntry | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const lastFocusedCard = useRef<number | null>(null);
  const restoreScroll = useRef(view.scrollTop);
  const wanted = useRef(Math.max(PAGE, view.loaded));
  const loadingMore = useRef(false);

  const setSort = (v: CatalogSort) => setStoreView({ sort: v, scrollTop: 0 });
  const setCategory = (v: string) => setStoreView({ category: v, scrollTop: 0 });
  const setTag = (v: string) => setStoreView({ tag: v, scrollTop: 0 });
  const setPlatformFilter = (v: Platform[]) => setStoreView({ platforms: v, scrollTop: 0 });
  const setSourceFilter = (v: number[]) => setStoreView({ sources: v, scrollTop: 0 });
  const setSearch = (v: string) => { setSearchText(v); setStoreView({ search: v }); };

  // Remember the scroll position when leaving the tab (read while scrolling:
  // by the time an unmount cleanup runs, the element is already detached).
  const scrollTop = useRef(view.scrollTop);
  useEffect(() => () => { setStoreView({ scrollTop: scrollTop.current }); }, []);

  useEffect(() => () => {
    searchGeneration.current++;
    void api.invoke('store:searchCancel').catch(()=>undefined);
    void api.invoke('store:searchFocus',{focused:false}).catch(()=>undefined);
  }, []);

  const cancelSearch = () => {
    searchGeneration.current++;
    setSearching(false);
    void api.invoke('store:searchCancel').catch(()=>undefined);
  };
  const submitSearch = async () => {
    if (!search.trim()) return;
    const generation=++searchGeneration.current;
    setSearching(true);setSearchMessage(t('Local AI is searching your websites…'));
    setStoreView({ category: '', tag: '', platforms: [] });
    try {
      const result=await api.invoke('store:search',{query:search.trim(),sourceIds:sourceFilter.length?sourceFilter:undefined});
      if(generation!==searchGeneration.current)return;
      setSearchMessage(result.message);
      if(result.id!==null){searchRef.current?.blur();setState({detailId:result.id});}
    } catch(error) { if(generation===searchGeneration.current)setSearchMessage((error as Error).message); }
    finally { if(generation===searchGeneration.current)setSearching(false); }
  };

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let live = true;
    const revision = policy.revision;
    api.invoke('catalog:facets').then((r) => {
      if (live && r.policyRevision === revision) setFacets({ categories: r.categories, tags: r.tags, ranked: r.ranked, gathering: r.gathering ?? 0 });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [catalogVersion, policy.revision]);

  const previousRevision = useRef(policy.revision);
  useEffect(() => {
    if (previousRevision.current === policy.revision) return;
    previousRevision.current = policy.revision;
    setFacets({ categories: [], tags: [], ranked: 0, gathering: 0 });
    setStoreView({ category: '', tag: '' });
  }, [policy.revision]);

  const query = useMemo(() => ({
    search: debounced || undefined, sourceIds: sourceFilter.length ? sourceFilter : undefined, platforms: platformFilter.length ? platformFilter : undefined,
    categories: category ? [category] : undefined, tags: tag ? [tag] : undefined, sort, wishlist: wishOnly || undefined,
  }), [debounced, sourceFilter, platformFilter, category, tag, sort, wishOnly]);

  // Loads games [0, count) in pages of at most 500; responses from an older
  // query or policy revision are dropped.
  const generation = useRef(0);
  const fetchWindow = useCallback(async (count: number, replace: boolean) => {
    const gen = ++generation.current;
    const revision = policy.revision;
    const out: CatalogEntry[] = [];
    let sum = 0;
    let lastFuzzy = false;
    for (let offset = 0; offset < count; offset += 500) {
      const page = await api.invoke('catalog:list', { ...query, limit: Math.min(500, count - offset), offset }).catch(() => null);
      if (!page || gen !== generation.current || page.policyRevision !== revision) return;
      out.push(...page.entries);
      sum = page.total;
      lastFuzzy = !!page.fuzzy;
      if (page.entries.length < Math.min(500, count - offset)) break;
    }
    setState((s) => ({ hiddenIds: new Set([...s.hiddenIds].filter((id) => !out.some((e) => e.id === id))) }));
    setEntries(replace ? out : out);
    setTotal(sum);
    setFuzzy(!!lastFuzzy);
    setLoaded(true);
    setStoreView({ loaded: out.length });
  }, [query, policy.revision]);

  // A new query starts from the top (or from where the user left it, once).
  const firstLoad = useRef(true);
  useEffect(() => {
    if (!firstLoad.current) { wanted.current = PAGE; scrollRef.current?.scrollTo({ top: 0 }); }
    void fetchWindow(wanted.current, true).then(() => {
      if (firstLoad.current && restoreScroll.current) requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: restoreScroll.current }));
      firstLoad.current = false;
    });
  }, [fetchWindow]);

  // While indexing adds games, refresh what is loaded at most every few seconds.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (firstLoad.current) return;
    if (refreshTimer.current) return;
    const wait = Math.max(0, 4000 - (Date.now() - lastRefresh.current));
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      lastRefresh.current = Date.now();
      void fetchWindow(Math.max(PAGE, wanted.current), false);
    }, wait);
  }, [catalogVersion]);
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  // Endless scrolling: the next page loads before the bottom comes into view.
  const loadMore = useCallback(() => {
    if (loadingMore.current || entries.length >= total) return;
    loadingMore.current = true;
    wanted.current = entries.length + PAGE;
    void fetchWindow(wanted.current, false).finally(() => { loadingMore.current = false; });
  }, [entries.length, total, fetchWindow]);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((items) => { if (items.some((i) => i.isIntersecting)) loadMore(); }, { root: scrollRef.current, rootMargin: '1400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, loaded]);

  // Immediate local purge when adult content becomes hidden, before the refetch lands.
  const visible = useMemo(
    () => entries.filter((e) => !hiddenIds.has(e.id) && (policy.showNsfw || e.rating !== 'adult')),
    [entries, hiddenIds, policy.showNsfw],
  );

  // Detail view follows the global detail id and is closed when its entry becomes hidden.
  useEffect(() => {
    if (detailId === null) {
      setDetail(null);
      return;
    }
    const local = visible.find((e) => e.id === detailId);
    if (local) setDetail((d) => (d?.id === local.id ? { ...local, screenshots: d.screenshots, description: d.description ?? local.description } : local));
    let live = true;
    const revision = policy.revision;
    api.invoke('catalog:get', { id: detailId }).then((r) => {
      if (!live || r.policyRevision !== revision) return;
      if (!r.entry) setState({ detailId: null });
      else setDetail(r.entry);
    });
    return () => {
      live = false;
    };
  }, [detailId, policy.revision, catalogVersion, visible]);

  useEffect(() => {
    if (detail && detail.rating === 'adult' && !policy.showNsfw) setState({ detailId: null });
  }, [detail, policy.showNsfw]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const origin = useRef<DOMRect | null>(null);
  const openDetail = useCallback((id: number, rect: DOMRect) => {
    lastFocusedCard.current = id;
    origin.current = rect;
    setState({ detailId: id });
  }, []);

  // Detail view opening/closing has its own sound pair.
  const openDetailId = detail?.id ?? null;
  const prevDetail = useRef<number | null>(null);
  useEffect(() => {
    if (openDetailId !== null && prevDetail.current === null) sound.play('open');
    else if (openDetailId === null && prevDetail.current !== null) sound.play('close');
    prevDetail.current = openDetailId;
  }, [openDetailId]);
  const closeDetail = useCallback(() => {
    setState({ detailId: null });
    const id = lastFocusedCard.current;
    setTimeout(() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-card-id="${id}"]`)?.focus(), 30);
  }, []);

  // Arrow-key navigation across the grid.
  const onKeyNav = useCallback((e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const cards = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-card-index]') ?? [])];
    const top = cards[index]?.getBoundingClientRect().top ?? 0;
    const cols = Math.max(1, cards.slice(Math.max(0, index - 12), index + 12).filter((c) => Math.abs(c.getBoundingClientRect().top - top) < 4).length);
    let next = index;
    if (e.key === 'ArrowLeft') next = index - 1;
    if (e.key === 'ArrowRight') next = index + 1;
    if (e.key === 'ArrowUp') next = index - cols;
    if (e.key === 'ArrowDown') next = index + cols;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = cards.length - 1;
    cards[Math.max(0, Math.min(cards.length - 1, next))]?.focus();
  }, []);

  // One pass over the download queue per change, not one per card.
  const downloadStates = useMemo(() => {
    const latest = new Map<number, DownloadItem>();
    for (const d of downloads) if (d.catalogId !== null && d.state !== 'cancelled' && (!latest.get(d.catalogId) || d.id > latest.get(d.catalogId)!.id)) latest.set(d.catalogId, d);
    const out = new Map<number, string | null>();
    for (const [id, d] of latest) out.set(id, d.state === 'completed' ? t('Downloaded') : d.state === 'active' ? `${d.totalBytes ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0}%` : d.state === 'failed' ? null : t('In queue'));
    return out;
  }, [downloads]);
  const rankFor = (e: CatalogEntry) => (sort === 'popular' && e.rankPopular ? { kind: 'popular' as const, n: e.rankPopular } : sort === 'trending' && e.rankTrending ? { kind: 'trending' as const, n: e.rankTrending } : null);
  const filtered = !!(search || category || tag || platformFilter.length || sourceFilter.length);

  const crawling = Object.values(crawl).filter((c) => c.status === 'crawling');
  const enabledSources = sources.filter((s) => s.enabled);
  const blocked = sources.filter((s) => s.enabled && (s.status === 'blocked' || s.status === 'unsupported' || s.status === 'error'));
  return (
    <div className={`page page--store ${browserOpen ? 'has-drawer' : ''}`}>
      <div className="page__scroll" ref={scrollRef} onScroll={(e) => { scrollTop.current = e.currentTarget.scrollTop; }}>
        <header className="page__header">
          <div className="page__titles">
            <p className="eyebrow">{t('Discovery')}</p>
            <KineticTitle text={t('Store')} />
            <p className="page__subtitle">
              {enabledSources.length === 0
                ? t('Add websites to start discovering games.')
                : crawling.length
                  ? t('{detail} · {n} verified games', { detail: crawling[0].detail ?? t('Reading websites'), n: total })
                  : t(enabledSources.length === 1 ? (total === 1 ? '{n} game from 1 website' : '{n} games from 1 website') : total === 1 ? '{n} game from {m} websites' : '{n} games from {m} websites', { n: total, m: enabledSources.length })}
              {!policy.showNsfw && <span className="page__subtle"> {t('· Adult content hidden')}</span>}
            </p>
          </div>
          <div className="page__actions">
            <Button
              variant="secondary"
              icon="browser"
              aria-pressed={browserOpen}
              onClick={() => {
                if (browserOpen) {
                  void api.invoke('browser:close');
                  setState((s) => ({ browser: { ...s.browser, open: false, snapshot: null } }));
                } else {
                  setState((s) => ({ browser: { ...s.browser, open: true } }));
                  void attempt(() => api.invoke('browser:show'));
                }
              }}
            >
              {t('Browser')}</Button>
          </div>
        </header>

        <div className="toolbar" role="search">
          <label className="search">
            <Icon name="search" size={17} />
            <span className="sr-only">{t('Search the Store')}</span>
            <input ref={searchRef} type="search" maxLength={200} placeholder={t('Search saved games · Enter to ask AI  ( / )')} value={search}
              onFocus={()=>void api.invoke('store:searchFocus',{focused:true}).catch(()=>undefined)}
              onBlur={()=>void api.invoke('store:searchFocus',{focused:false}).catch(()=>undefined)}
              onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void submitSearch();}if(e.key==='Escape'){cancelSearch();searchRef.current?.blur();}}}
              onChange={e=>{cancelSearch();setSearch(e.target.value);setSearchMessage('');}} />
          </label>
          <Button variant="secondary" icon="search" disabled={!search.trim()} onClick={()=>void submitSearch()}>{searching?t('Search again'):t('AI search')}</Button>
          {searching&&<Button variant="secondary" onClick={()=>{cancelSearch();setSearchMessage(t('Search cancelled'));}}>{t('Stop search')}</Button>}
          <label className="store-filter">
            <span>{t('Category')}</span>
            <select aria-label={t('Filter by category')} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('All categories')}</option>
              {category && !facets.categories.some((c) => c.name === category) && <option value={category}>{category}</option>}
              {facets.categories.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
            </select>
          </label>
          <TagPicker value={tag} tags={facets.tags} onChange={setTag} />
          {filtered && (
            <button className="chip" onClick={() => { cancelSearch();setSearchMessage(''); setSearch(''); setDebounced(''); setStoreView({ category: '', tag: '', platforms: [], sources: [], scrollTop: 0 }); }}>{t('Clear filters')}</button>
          )}
          <div className="chips" role="group" aria-label={t('Filter by platform')}>
            {PLATFORM_FILTERS.map((p) => {
              const on = platformFilter.includes(p);
              return (
                <button key={p} className={`chip ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={() => setPlatformFilter(on ? platformFilter.filter((x) => x !== p) : [...platformFilter, p])}>
                  {platformName(p)}
                </button>
              );
            })}
          </div>
          {sources.length > 1 && (
            <div className="chips" role="group" aria-label={t('Filter by website')}>
              {sources.map((s) => {
                const on = sourceFilter.includes(s.id);
                return (
                  <button key={s.id} className={`chip chip--source ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={() => setSourceFilter(on ? sourceFilter.filter((x) => x !== s.id) : [...sourceFilter, s.id])}>
                    {s.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="sort-tabs" role="tablist" aria-label={t('Sort games')}>
          {SORTS.map((o) => (
            <button key={o.id} role="tab" aria-selected={sort === o.id} title={t(o.hint)} className={`sort-tab sort-tab--${o.id} ${sort === o.id ? 'is-on' : ''}`} onClick={() => setSort(o.id)}>
              <Icon name={o.icon} size={16} />
              {t(o.label)}
            </button>
          ))}
          <button role="tab" aria-selected={wishOnly} className={`sort-tab sort-tab--wish ${wishOnly ? 'is-on' : ''}`} onClick={() => setStoreView({ wishlist: !wishOnly, scrollTop: 0 })}>
            <Icon name="heart" size={16} />
            {t('Wishlist')}{wishlist.length ? ` (${wishlist.length})` : ''}
          </button>
          {(sort === 'popular' || sort === 'trending') && loaded && facets.gathering > 0 && (
            <span className="sort-tabs__note">
              {t('Collecting popularity for {n} more games from their Steam pages (players’ recommendations and release dates) — about {min} min left. The order gets better as it runs; games without data come last.', { n: facets.gathering.toLocaleString(locale()), min: Math.max(1, Math.round((facets.gathering * 1.8) / 60)) })}</span>
          )}
          {(sort === 'popular' || sort === 'trending') && loaded && facets.ranked === 0 && facets.gathering === 0 && (
            <span className="sort-tabs__note">{t('No popularity information was found for these games yet (no Popular/Trending lists on the websites, no counters, no Steam pages), so this shows the newest games first.')}</span>
          )}
        </div>

        {searchMessage && <p className="store-search-status" role="status" aria-live="polite">{searchMessage}</p>}
        {fuzzy && debounced && <p className="store-search-status" role="status">{t('No title contains “{query}” — showing the closest matches.', { query: debounced })}</p>}
        {wishOnly && (
          <div className="wish-panel">
            <form className="wish-panel__add" onSubmit={(e) => { e.preventDefault(); const wanted = watchTitle.trim(); if (!wanted) return; void attempt(() => api.invoke('wishlist:add', { title: wanted }), t('Watching for “{title}”. You’ll get a notification when a website lists it.', { title: wanted })).then(() => setWatchTitle('')); }}>
              <input className="input" placeholder={t('Watch for a game that isn’t here yet…')} value={watchTitle} onChange={(e) => setWatchTitle(e.target.value)} maxLength={200} />
              <Button variant="secondary" size="sm" icon="plus" type="submit" disabled={!watchTitle.trim()}>{t('Notify me')}</Button>
            </form>
            {wishlist.filter((w) => w.catalogId === null).length > 0 && (
              <ul className="wish-panel__list" aria-label={t('Games you are watching')}>
                {wishlist.filter((w) => w.catalogId === null).map((w) => (
                  <li key={w.id}>
                    <Icon name="clock" size={14} /> {w.title} <span className="muted">{t('— waiting for a website to list it')}</span>
                    <button className="link-btn" onClick={() => void attempt(() => api.invoke('wishlist:remove', { id: w.id }))}>{t('Remove')}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {blocked.length > 0 && (
          <div className="notice-row">
            {blocked.map((s) => (
              <div key={s.id} className={`notice notice--${s.status}`}>
                <Icon name="alert" size={16} />
                <span>
                  <strong>{s.name}</strong> — {s.status === 'blocked' ? t('blocked') : s.status === 'unsupported' ? t('not supported') : t('error')}: {s.statusDetail}
                </span>
                {s.status === 'blocked' && (
                  <button className="link-btn" onClick={() => void attempt(() => api.invoke('browser:open', { url: s.url }))}>
                    {t('Open in browser')}</button>
                )}
                <button className="link-btn" onClick={() => void attempt(() => api.invoke('sources:recrawl', { id: s.id }))}>
                  {t('Retry')}</button>
              </div>
            ))}
          </div>
        )}

        {enabledSources.length === 0 ? (
          <EmptyState
            icon="globe"
            title={t('Your orbit is empty')}
            action={
              <Button variant="primary" icon="plus" onClick={() => setTab('settings')}>
                {t('Add a website')}</Button>
            }
          >
            {t('Add game websites in Settings. The local AI explores them while the Store is open, verifies game download links, checks artwork, and lists downloadable games here.')}</EmptyState>
        ) : !loaded ? (
          <SkeletonGrid />
        ) : visible.length === 0 ? (
          crawling.length ? (
            <SkeletonGrid label={t('Scanning websites for games…')} />
          ) : (
            <EmptyState icon="search" title={filtered ? t('No matches') : t('Nothing to show yet')}
              action={debounced.trim() ? <Button variant="secondary" icon="heart" onClick={() => void attempt(() => api.invoke('wishlist:add', { title: debounced.trim() }), t('Watching for “{title}”. You’ll get a notification when a website lists it.', { title: debounced.trim() }))}>{t('Notify me when “{title}” appears', { title: debounced.trim() })}</Button> : undefined}>
              {filtered
                ? t('Try a different search or clear the filters.')
                : t('Games appear after the AI verifies a download route and checks their artwork. Articles without game downloads are excluded. Indexing runs while the Store is open.')}
            </EmptyState>
          )
        ) : (
          <>
            <div className="grid" role="list" aria-label={t('Games')} ref={gridRef}>
              {visible.map((e, i) => (
                <div role="listitem" key={e.id} className="grid__cell">
                  <GameCard entry={e} index={i} onOpen={openDetail} onKeyNav={onKeyNav} downloadState={downloadStates.get(e.id) ?? null} rank={rankFor(e)} />
                </div>
              ))}
            </div>
            <div ref={sentinelRef} className="load-more" aria-hidden={entries.length >= total}>
              {entries.length < total && <span className="muted">{t('Loading more · {n} of {total}', { n: visible.length, total })}</span>}
            </div>
            <Overlay>
              <AnimatePresence>{detail && <GameDetail key={detail.id} entry={detail} origin={origin.current} onClose={closeDetail} />}</AnimatePresence>
            </Overlay>
          </>
        )}
      </div>
      <AnimatePresence>{browserOpen && <BrowserDrawer />}</AnimatePresence>
    </div>
  );
}

function SkeletonGrid({ label }: { label?: string }) {
  return (
    <div className="grid grid--skeleton" aria-busy="true" aria-label={label ?? t('Loading games')}>
      {label && <p className="grid__scan-label">{label}</p>}
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="skeleton-card" style={{ animationDelay: `${i * 80}ms` }}>
          <span className="skeleton-card__scan" />
        </div>
      ))}
    </div>
  );
}

/** Tag filter with search: hundreds of tags are unusable as a plain list. */
function TagPicker({ value, tags, onChange }: { value: string; tags: FacetValue[]; onChange: (tag: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setTimeout(() => input.current?.focus(), 0);
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const hits = needle ? tags.filter((t) => t.name.includes(needle)) : tags;
    // Prefix matches first, then by how many games carry the tag.
    return (needle ? [...hits].sort((a, b) => Number(b.name.startsWith(needle)) - Number(a.name.startsWith(needle)) || b.count - a.count) : hits).slice(0, 150);
  }, [tags, needle]);
  const pick = (t: string) => { onChange(t); setOpen(false); setQ(''); };
  return (
    <div className="store-filter tag-picker" ref={box}>
      <span>{t('Tag')}</span>
      <button type="button" className={`tag-picker__button ${value ? 'is-on' : ''}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="tag" size={14} />
        <span className="tag-picker__value">{value || t('All tags')}</span>
        <Icon name="down" size={13} />
      </button>
      {open && (
        <div className="tag-picker__panel" role="dialog" aria-label={t('Choose a tag')}>
          <input
            ref={input}
            className="input tag-picker__search"
            type="search"
            placeholder={t('Search {n} tags…', { n: tags.length })}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter' && shown[0]) pick(shown[0].name);
            }}
          />
          <ul className="tag-picker__list" role="listbox" aria-label={t('Tags')}>
            <li><button role="option" aria-selected={!value} className="tag-picker__option" onClick={() => pick('')}>{t('All tags')}</button></li>
            {shown.map((item) => (
              <li key={item.name}>
                <button role="option" aria-selected={value === item.name} className="tag-picker__option" onClick={() => pick(item.name)}>
                  <span>{item.name}</span>
                  <span className="tag-picker__count mono">{item.count}</span>
                </button>
              </li>
            ))}
            {!shown.length && <li className="muted tag-picker__empty">{t('No tag matches “{query}”.', { query: q })}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
