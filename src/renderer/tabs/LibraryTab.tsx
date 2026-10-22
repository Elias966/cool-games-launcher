import { KineticTitle } from '../components/KineticTitle';
import { AnimatePresence, motion } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { attempt, setTab, useApp } from '../state';
import { Artwork, placeholderStyle } from '../components/GameCard';
import { Button, Dialog, EmptyState, IconButton } from '../components/ui';
import { Icon } from '../components/Icon';
import type { DownloadItem, Game, ImageOptions, NrReport, ProtonAdvice, LaunchOptions, OwnedGame, ProtonInstall, Runner, SaveBackup } from '@shared/types';
import { ProgressRing } from '../components/ui';
import { ProtonDbBadge } from '../components/ProtonDb';
import { PlayWeek, usePlayStats } from '../components/PlayWeek';
import { formatBytes, formatSpeed } from '@shared/format';
import { useMotionPrefs } from '../hooks/useMotion';
import { hours, playtime, t, tk, locale } from '../i18n';
import { dlss5Choice, dlss5On, type Dlss5Choice } from '@shared/dlss5';

type Filter = 'all' | 'favorites' | 'linux' | 'windows' | 'local' | 'gog' | 'epic';

const STORE_LABEL = { gog: 'GOG', epic: 'Epic' } as const;
/** Where a Library game comes from: GOG, Epic, or Local (from disk or a website). */
const sourceTag = (g: Game) => (g.store ? STORE_LABEL[g.store] : t('Local'));

/** Where a game on its way to the Library is, in a few words, with its progress (0..1) when known. */
export function pendingStatus(d: DownloadItem, parts: DownloadItem[] = []): { label: string; detail: string | null; pct: number | null; failed: boolean; waiting: boolean } {
  // A split game: one entry for all its parts, with their combined progress.
  if (parts.length > 1 && d.state !== 'completed') {
    const total = d.partTotal ?? parts.length;
    const known = parts.every((p) => p.totalBytes);
    const pct = known ? Math.min(1, parts.reduce((n, p) => n + (p.state === 'completed' ? p.totalBytes ?? 0 : p.receivedBytes), 0) / parts.reduce((n, p) => n + (p.totalBytes ?? 0), 0)) : null;
    const done = parts.filter((p) => p.state === 'completed').length;
    const failed = parts.find((p) => p.state === 'failed');
    const needs = parts.find((p) => p.state === 'needs-user');
    if (failed) return { label: t('Part {n} failed', { n: failed.partIndex ?? '?' }), detail: failed.errorDetail, pct, failed: true, waiting: false };
    if (needs) return { label: t('Needs you'), detail: needs.userPrompt?.message ?? null, pct, failed: false, waiting: true };
    return { label: t('Downloading {done}/{total} parts', { done, total }), detail: null, pct, failed: false, waiting: false };
  }
  const pct = d.totalBytes ? Math.min(1, d.receivedBytes / d.totalBytes) : null;
  const unpack = /(\d+)%/.exec(d.installDetail ?? '');
  if (d.state === 'completed') {
    if (d.installState === 'failed') return { label: t('Could not prepare'), detail: d.installDetail, pct: null, failed: true, waiting: false };
    return { label: unpack ? t('Unpacking') : t('Preparing'), detail: d.installDetail, pct: unpack ? Number(unpack[1]) / 100 : null, failed: false, waiting: false };
  }
  if (d.state === 'failed') return { label: t('Download failed'), detail: d.errorDetail, pct, failed: true, waiting: false };
  if (d.state === 'needs-user') return { label: t('Needs you'), detail: d.userPrompt?.message ?? null, pct: null, failed: false, waiting: true };
  if (d.state === 'resolving' || d.state === 'needs-resolution') return { label: t('Finding the download'), detail: null, pct: null, failed: false, waiting: false };
  if (d.state === 'paused') return { label: t('Paused'), detail: d.errorDetail, pct, failed: false, waiting: true };
  if (d.state === 'queued') return { label: t('Queued'), detail: null, pct, failed: false, waiting: false };
  return { label: t('Downloading'), detail: null, pct, failed: false, waiting: false };
}

export function LibraryTab() {
  const games = useApp((s) => s.library);
  const downloads = useApp((s) => s.downloads);
  // Games on their way: shown locked, with progress, until they are ready to play.
  const pending = useMemo(
    () => downloads.filter((d) => d.catalogId !== null && !d.updateFor && (!d.groupId || d.groupId === d.id) && d.state !== 'cancelled' && !(d.state === 'completed' && d.installState === 'installed') && !games.some((g) => g.catalogId === d.catalogId)),
    [downloads, games],
  );
  const partsOf = (d: DownloadItem) => (d.groupId ? downloads.filter((x) => x.groupId === d.groupId) : []);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const allOwned = useApp((s) => s.stores.owned);
  const stats = usePlayStats();
  const scrollRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  /** The big panel of the chosen game has scrolled out of view: its compact bar floats on top. */
  const [heroHidden, setHeroHidden] = useState(false);
  const [farDown, setFarDown] = useState(false);
  useEffect(() => {
    const el = heroRef.current;
    if (!el || !scrollRef.current) return;
    const io = new IntersectionObserver(([e]) => setHeroHidden(!e.isIntersecting), { root: scrollRef.current, threshold: 0, rootMargin: '-120px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [games.length > 0 || pending.length > 0 || allOwned.length > 0]);
  const toTop = () => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  /** Scrolled down, a clicked game opens in a pop-up instead of the panel at the top. */
  const [popup, setPopup] = useState<{ gameId?: number; owned?: string } | null>(null);
  const selectGame = useCallback((id: number) => { setPendingId(null); setOwnedKey(null); setSelectedId(id); if (heroHidden) setPopup({ gameId: id }); }, [heroHidden]);
  const selectOwned = useCallback((key: string) => { setPendingId(null); setOwnedKey(key); if (heroHidden) setPopup({ owned: key }); }, [heroHidden]);
  const popupGame = popup?.gameId !== undefined ? games.find((g) => g.id === popup.gameId) ?? null : null;
  const popupOwned = popup?.owned ? allOwned.find((o) => `${o.store}:${o.id}` === popup.owned && o.gameId === null) ?? null : null;
  useEffect(() => {
    if (!popup) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal = document.querySelector<HTMLElement>('.library-popup__card');
    modal?.querySelector<HTMLElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setPopup(null); }
      if (e.key !== 'Tab' || !modal) return;
      const controls = [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter((el) => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); previous?.focus(); };
  }, [popup]);

  const shown = useMemo(
    () =>
      games.filter(
        (g) =>
          (filter === 'all' || (filter === 'favorites' ? g.favorite : filter === 'gog' || filter === 'epic' ? g.store === filter : filter === 'local' ? !g.store : g.kind === filter)) &&
          (!search.trim() || g.title.toLowerCase().includes(search.trim().toLowerCase())),
      ),
    [games, filter, search],
  );
  const stores = useApp((s) => s.stores);
  const [ownedKey, setOwnedKey] = useState<string | null>(null);
  // Bought on GOG or Epic but not installed: shown greyed, ready to install.
  const shownOwned = useMemo(
    () => stores.owned.filter((o) => o.gameId === null && (filter === 'all' || filter === o.store) && (!search.trim() || o.title.toLowerCase().includes(search.trim().toLowerCase()))),
    [stores.owned, filter, search],
  );
  const shownPending = useMemo(() => pending.filter((d) => (filter === 'all') && (!search.trim() || d.title.toLowerCase().includes(search.trim().toLowerCase()))), [pending, filter, search]);
  // With nothing installed yet, the game on its way fills the big panel.
  const selectedPending = pendingId !== null ? pending.find((d) => d.id === pendingId) ?? null : shown.length === 0 ? shownPending[0] ?? null : null;
  const selectedOwned = !selectedPending ? shownOwned.find((o) => `${o.store}:${o.id}` === ownedKey) ?? (shown.length === 0 ? shownOwned[0] ?? null : null) : null;
  const selected = selectedPending || selectedOwned ? null : shown.find((g) => g.id === selectedId) ?? shown[0] ?? null;
  const updateCount = games.filter((g) => g.update?.state === 'available' && !g.update.unverified).length;

  useEffect(() => {
    if (selectedId !== null && !games.some((g) => g.id === selectedId)) setSelectedId(null);
  }, [games, selectedId]);
  // A game that finished preparing takes over its placeholder's selection.
  useEffect(() => {
    if (pendingId === null || pending.some((d) => d.id === pendingId)) return;
    const done = downloads.find((d) => d.id === pendingId);
    const game = done && games.find((g) => g.catalogId === done.catalogId);
    setPendingId(null);
    if (game) setSelectedId(game.id);
  }, [pending, pendingId, downloads, games]);

  return (
    <div className="page page--library">
      <div className="page__scroll" ref={scrollRef} onScroll={(e) => { const far = e.currentTarget.scrollTop > 700; if (far !== farDown) setFarDown(far); }}>
        <header className="page__header">
          <div className="page__titles">
            <p className="eyebrow">{t('Collection')}</p>
            <KineticTitle text={t('Library')} />
            <p className="page__subtitle">
              {games.length === 0 && !pending.length ? t('Installed and imported games appear here.') : [
                t(games.length === 1 ? '{n} game' : '{n} games', { n: games.length }),
                pending.length ? t('{n} on the way', { n: pending.length }) : null,
                games.some((g) => g.running) ? t('a game is running') : t('ready for launch'),
                updateCount ? t(updateCount === 1 ? '{n} update available' : '{n} updates available', { n: updateCount }) : null,
              ].filter(Boolean).join(' · ')}
            </p>
          </div>
          {stats && games.length > 0 && <PlayWeek stats={stats} />}
          <div className="page__actions">
            {games.some((g) => g.catalogId !== null || g.store) && (
              <Button variant="ghost" icon="reload" onClick={() => void attempt(async () => {
                const r = await api.invoke('library:checkUpdates');
                return r;
              }, t('Checking your games for updates…'))}>
                {t('Check for updates')}</Button>
            )}
            <Button variant="secondary" icon="import" onClick={() => void attempt(async () => {
              const g = await api.invoke('library:import');
              if (g) setSelectedId(g.id);
            })}>
              {t('Import game')}</Button>
          </div>
        </header>

        {games.length === 0 && pending.length === 0 && stores.owned.length === 0 ? (
          <EmptyState
            icon="library"
            title={t('No games in your Library yet')}
            action={
              <div className="empty__actions">
                <Button variant="primary" icon="store" onClick={() => setTab('store')}>
                  {t('Browse the Store')}</Button>
              </div>
            }
          >
            {t('Download a game from the Store and install it from Downloads, or import a game you already have with “Import game”.')}</EmptyState>
        ) : (
          <div className="library">
            <div ref={heroRef}>
              {selectedPending ? <PendingHero key={`dl-${selectedPending.id}`} d={selectedPending} parts={partsOf(selectedPending)} />
                : selectedOwned ? <OwnedHero key={`own-${selectedOwned.store}-${selectedOwned.id}`} o={selectedOwned} />
                : selected && <LibraryHero key={selected.id} game={selected} />}
            </div>
            <div className="library__browser">
              <div className="toolbar toolbar--compact">
                <label className="search search--sm">
                  <Icon name="search" size={16} />
                  <span className="sr-only">{t('Search your Library')}</span>
                  <input type="search" placeholder={t('Search library')} value={search} onChange={(e) => setSearch(e.target.value)} />
                </label>
                <div className="chips" role="group" aria-label={t('Filter library')}>
                  {(['all', 'favorites', 'linux', 'windows', 'local', ...(stores.owned.some((o) => o.store === 'gog') || games.some((g) => g.store === 'gog') ? ['gog'] : []), ...(stores.owned.some((o) => o.store === 'epic') || games.some((g) => g.store === 'epic') ? ['epic'] : [])] as Filter[]).map((f) => (
                    <button key={f} className={`chip ${filter === f ? 'is-on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                      {f === 'all' ? t('All') : f === 'favorites' ? t('Favorites') : f === 'linux' ? t('Linux') : f === 'windows' ? t('Windows') : f === 'local' ? t('Local') : STORE_LABEL[f]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="covers" role="listbox" aria-label={t('Games')} aria-activedescendant={selected ? `cover-${selected.id}` : undefined}>
                {shownPending.map((d, i) => (
                  <PendingCover key={`dl-${d.id}`} d={d} parts={partsOf(d)} index={i} selected={selectedPending?.id === d.id} onSelect={() => setPendingId(d.id)} />
                ))}
                {shown.map((g, i) => (
                  <CoverPanel key={g.id} game={g} index={i + shownPending.length} selected={!selectedPending && selected?.id === g.id} onSelect={selectGame} />
                ))}
                {shownOwned.map((o, i) => (
                  <OwnedCover key={`own-${o.store}-${o.id}`} o={o} index={i + shown.length + shownPending.length} selected={selectedOwned === o || (!!selectedOwned && selectedOwned.store === o.store && selectedOwned.id === o.id)} onSelect={selectOwned} />
                ))}
                {shown.length === 0 && shownPending.length === 0 && shownOwned.length === 0 && <p className="muted">{t('No games match.')}</p>}
              </div>
            </div>
          </div>
        )}
      </div>
      <AnimatePresence>
        {(popupGame || popupOwned) && (
          <motion.div key="popup" className="library-popup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={(e) => { if (e.target === e.currentTarget) setPopup(null); }}>
            <div className="library-popup__card" role="dialog" aria-modal="true" aria-label={popupGame?.title ?? popupOwned?.title}>
              <button type="button" className="library-popup__close" aria-label={t('Close')} onClick={() => setPopup(null)}><Icon name="close" size={18} /></button>
              {popupGame ? <LibraryHero key={popupGame.id} game={popupGame} /> : popupOwned && <OwnedHero key={`own-${popupOwned.store}-${popupOwned.id}`} o={popupOwned} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {heroHidden && selected && !selectedPending && !popup && (
          <motion.div key="float" className="library-float" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}>
            <FloatingGame game={selected} onDetails={toTop} />
          </motion.div>
        )}
        {farDown && (
          <motion.button key="to-top" className="to-top" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} onClick={toTop} aria-label={t('Back to top')} title={t('Back to top')}>
            <Icon name="up" size={20} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The chosen game, kept in view while the Library scrolls: its cover, name and Play. */
function FloatingGame({ game, onDetails }: { game: Game; onDetails: () => void }) {
  const ready = game.status === 'installed' && !!game.executable;
  const [busy, setBusy] = useState(false);
  const cover = game.images.cover ?? game.art?.capsule ?? game.artwork;
  return (
    <div className="library-float__bar">
      <button type="button" className="library-float__game" onClick={onDetails} title={t('Show details')}>
        {cover ? <img src={cover} alt="" /> : <span className="library-float__blank" style={placeholderStyle(game.title)} />}
        <span className="library-float__title">{game.title}</span>
      </button>
      <Button size="sm" variant="ghost" icon="up" onClick={onDetails}>{t('Details')}</Button>
      <Button size="sm" variant={game.running ? 'secondary' : 'primary'} icon={game.running ? 'stop' : 'play'} disabled={!ready || busy}
        onClick={() => { setBusy(true); void attempt(() => api.invoke(game.running ? 'library:stop' : 'library:launch', { id: game.id })).finally(() => setTimeout(() => setBusy(false), 800)); }}>
        {game.running ? t('Stop') : t('Play')}
      </Button>
    </div>
  );
}

/** A game being downloaded or prepared: locked until it is ready to play. */
function PendingCover({ d, parts, index, selected, onSelect }: { d: DownloadItem; parts: DownloadItem[]; index: number; selected: boolean; onSelect: () => void }) {
  const st = pendingStatus(d, parts);
  return (
    <button
      role="option"
      aria-selected={selected}
      aria-label={`${d.title}: ${st.label}${st.pct !== null ? ` ${Math.round(st.pct * 100)}%` : ''}`}
      className={`cover cover--pending ${selected ? 'is-selected' : ''} ${st.failed ? 'is-failed' : ''}`}
      onClick={onSelect}
    >
      <span className="cover__float">
        <Artwork card src={d.artwork} title={d.title} className="cover__art" />
        <span className="cover__lock" aria-hidden="true">
          <ProgressRing value={st.pct} indeterminate={st.pct === null && !st.failed && !st.waiting} size={64} stroke={4} tone={st.failed ? 'danger' : st.waiting ? 'warn' : 'cyan'}>
            <span className="mono cover__pct">{st.pct !== null ? `${Math.round(st.pct * 100)}%` : <Icon name={st.failed ? 'alert' : 'downloads'} size={18} />}</span>
          </ProgressRing>
          <span className="cover__state">{st.label}</span>
        </span>
        <span className="cover__title">{d.title}</span>
      </span>
    </button>
  );
}

function PendingHero({ d, parts }: { d: DownloadItem; parts: DownloadItem[] }) {
  const st = pendingStatus(d, parts);
  return (
    <section className="hero hero--pending" aria-label={`${d.title} progress`}>
      <div className="hero__backdrop" aria-hidden="true" style={d.artwork ? undefined : placeholderStyle(d.title)}>
        {d.artwork && <img src={d.artwork} alt="" />}
      </div>
      <div className="hero__content">
        <div className="hero__main">
          <p className="eyebrow">{t('{source} · on its way to your Library', { source: d.sourceHost ?? t('Download') })}</p>
          <h2 className="hero__title">{d.title}</h2>
          <p className="hero__stats">
            <span>{st.label}{st.pct !== null ? ` · ${Math.round(st.pct * 100)}%` : ''}</span>
            {d.state === 'active' && d.totalBytes ? <span className="mono">{t('{done} of {total}', { done: formatBytes(d.receivedBytes), total: formatBytes(d.totalBytes) })} · {formatSpeed(d.speedBps)}</span> : null}
          </p>
          {st.detail && <p className="muted hero__pending-detail">{st.detail}</p>}
          <div className="bar hero__pending-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={st.pct !== null ? Math.round(st.pct * 100) : undefined}>
            <span style={{ width: st.pct !== null ? `${st.pct * 100}%` : '30%' }} className={st.pct === null ? 'is-indeterminate' : ''} />
          </div>
          <p className="muted">{t('It unlocks here as soon as it is ready to play. The AI keeps working while you use other tabs.')}</p>
          <div className="hero__update-actions">
            {d.state === 'active' && <Button variant="ghost" size="sm" icon="pause" onClick={() => void attempt(() => api.invoke('download:pause', { id: d.id }))}>{t('Pause')}</Button>}
            {d.state === 'paused' && <Button variant="primary" size="sm" icon="resume" onClick={() => void attempt(() => api.invoke('download:resume', { id: d.id }))}>{t('Resume')}</Button>}
            {d.state === 'failed' && <Button variant="primary" size="sm" icon="retry" onClick={() => void attempt(() => api.invoke('download:retry', { id: d.id }))}>{t('Try again')}</Button>}
            {d.state === 'completed' && d.installState === 'failed' && <Button variant="primary" size="sm" icon="retry" onClick={() => void attempt(() => api.invoke('download:install', { id: d.id }))}>{t('Prepare again')}</Button>}
            <Button variant="ghost" size="sm" icon="downloads" onClick={() => setTab('downloads')}>{t('Show in Downloads')}</Button>
          </div>
        </div>
      </div>
    </section>
  );
}

const CoverPanel = memo(function CoverPanel({ game, index, selected, onSelect }: { game: Game; index: number; selected: boolean; onSelect: (id: number) => void }) {
  return (
    <button
      id={`cover-${game.id}`}
      role="option"
      aria-selected={selected}
      className={`cover ${selected ? 'is-selected' : ''} ${game.running ? 'is-running' : ''}`}
      onClick={() => onSelect(game.id)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
        }
      }}
      style={{ ['--float-delay' as string]: `${(index % 7) * -0.9}s` }}
    >
      <span className="cover__float">
        <Artwork card src={game.images.cover ?? game.art?.capsule ?? game.artwork} title={game.title} className="cover__art" />
        <span className="cover__edge" aria-hidden="true" />
        <span className="cover__title">{game.title}</span>
        <span className={`cover__store cover__store--${game.store ?? 'local'}`}>{sourceTag(game)}</span>
        {game.favorite && (
          <span className="cover__fav" aria-label={t('Favorite')}>
            <Icon name="heart" size={13} />
          </span>
        )}
        {game.running && <span className="cover__live">{t('Running')}</span>}
        {!game.running && game.storeUpdate && <span className="cover__update">{t('Update')}</span>}
        {!game.running && game.update && ['available', 'downloading', 'preparing', 'waiting'].includes(game.update.state) && (
          <span className={`cover__update ${game.update.state === 'available' ? '' : 'is-busy'}`}>{game.update.state === 'available' ? t(game.update.unverified ? 'Build available' : 'Update') : t('Updating')}</span>
        )}
        {game.status !== 'installed' && <span className="cover__attention">{t('Setup needed')}</span>}
      </span>
    </button>
  );
});

function PlayControl({ game }: { game: Game }) {
  const { reduced } = useMotionPrefs();
  const [busy, setBusy] = useState(false);
  const ready = game.status === 'installed' && !!game.executable;
  const onClick = async () => {
    setBusy(true);
    await attempt(() => api.invoke(game.running ? 'library:stop' : 'library:launch', { id: game.id }));
    setTimeout(() => setBusy(false), 800);
  };
  return (
    <div className={`play ${game.running ? 'is-running' : ''} ${!ready ? 'is-disabled' : ''} ${reduced ? 'is-static' : ''}`}>
      <svg className="play__orbit" viewBox="0 0 120 120" aria-hidden="true">
        <defs>
          <linearGradient id="play-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#48e1ff" />
            <stop offset="1" stopColor="#a084ff" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r="56" fill="none" stroke="url(#play-g)" strokeWidth="1.2" strokeDasharray="3 7" opacity="0.7" />
        <circle cx="60" cy="60" r="49" fill="none" stroke="url(#play-g)" strokeWidth="2" strokeDasharray="60 250" strokeLinecap="round" />
      </svg>
      <button className="play__btn" onClick={onClick} disabled={!ready || busy} aria-label={game.running ? t('Stop {title}', { title: game.title }) : t('Play {title}', { title: game.title })}>
        <Icon name={game.running ? 'stop' : 'play'} size={34} />
      </button>
      <span className="play__label">{game.running ? t('Stop') : t('Play')}</span>
    </div>
  );
}

const UPDATE_STEP: Record<string, string> = { downloading: tk('Downloading the update'), preparing: tk('Installing the update'), waiting: tk('Update ready') };

/** New version available, in progress, installed (with rollback) or failed. */
function UpdatePanel({ game }: { game: Game }) {
  const u = game.update!;
  const versions = u.from && u.to ? `${u.from} → ${u.to}` : u.to ?? null;
  const motionProps = { initial: { opacity: 0, height: 0 }, animate: { opacity: 1, height: 'auto' }, exit: { opacity: 0, height: 0 } };
  if (u.state === 'available') {
    return (
      <motion.div className="hero__setup hero__update" {...motionProps}>
        <Icon name="downloads" size={18} />
        <div>
          <p>
            <strong>{t(u.unverified ? 'Website build available' : 'Update available')}{versions ? `: ${versions}` : ''}.</strong> <span className="muted">{u.reason}</span>
          </p>
          <p className="muted">{t('Your saves are carried over, and the current version is kept until you have played the new one.')}</p>
          <div className="hero__update-actions">
            <Button variant="primary" size="sm" icon="downloads" onClick={() => void attempt(() => api.invoke('library:update', { id: game.id }))}>
              {t('Update now')}</Button>
            <Button variant="ghost" size="sm" onClick={() => void attempt(() => api.invoke('library:ignoreUpdate', { id: game.id }))}>
              {t('Skip this version')}</Button>
          </div>
        </div>
      </motion.div>
    );
  }
  if (u.state === 'downloading' || u.state === 'preparing' || u.state === 'waiting') {
    return (
      <motion.div className="hero__setup hero__update" role="status" {...motionProps}>
        <span className="spinner" aria-hidden="true" />
        <div>
          <p>
            <strong>{t(UPDATE_STEP[u.state])}{versions ? ` (${versions})` : ''}.</strong> {u.detail ?? ''}
          </p>
          <p className="muted">{t('You can keep playing the installed version meanwhile.')}</p>
          {u.state === 'downloading' && (
            <div className="hero__update-actions">
              <Button variant="ghost" size="sm" icon="downloads" onClick={() => setTab('downloads')}>{t('Show in Downloads')}</Button>
            </div>
          )}
        </div>
      </motion.div>
    );
  }
  if (u.state === 'failed') {
    return (
      <motion.div className="hero__setup hero__update is-error" {...motionProps}>
        <Icon name="alert" size={18} />
        <div>
          <p>
            <strong>{versions ? t('The update ({versions}) did not finish.', { versions }) : t('The update did not finish.')}</strong> {u.detail ?? ''}
          </p>
          <p className="muted">{t('The installed version was not changed.')}</p>
          <div className="hero__update-actions">
            <Button variant="primary" size="sm" icon="reload" onClick={() => void attempt(() => api.invoke('library:update', { id: game.id }))}>{t('Try again')}</Button>
            <Button variant="ghost" size="sm" onClick={() => void attempt(() => api.invoke('library:ignoreUpdate', { id: game.id }))}>{t('Skip this version')}</Button>
          </div>
        </div>
      </motion.div>
    );
  }
  // updated
  return (
    <motion.div className="hero__setup hero__update is-done" {...motionProps}>
      <Icon name="check" size={18} />
      <div>
        <p>
          <strong>{u.to ? t('Updated to {version}.', { version: u.to }) : t('Updated.')}</strong>{' '}
          {u.carried ? t('{n} save/settings files were carried over.', { n: u.carried }) + ' ' : ''}
          {game.canRollback ? t('{version} is kept until you have played this version.', { version: game.previousVersion ?? '' }) : ''}
        </p>
        {game.canRollback && (
          <div className="hero__update-actions">
            <Button variant="ghost" size="sm" icon="reload" disabled={game.running} onClick={() => void attempt(() => api.invoke('library:rollback', { id: game.id }))}>
              {t('Roll back to {version}', { version: game.previousVersion })}
            </Button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/** Save backups: made after playing and before updates; restorable with one click. */
function SavesPanel({ game }: { game: Game }) {
  const [saves, setSaves] = useState<SaveBackup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void api.invoke('library:saves', { id: game.id }).then(setSaves).catch(() => setSaves([]));
  useEffect(load, [game.id, game.lastPlayedAt]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); await attempt(fn, ok); setBusy(false); load(); };
  return (
    <div className="field">
      <span className="field__label">{t('Save backups')}</span>
      {saves === null ? <span className="muted">{t('Loading…')}</span> : saves.length === 0 ? (
        <span className="field__hint">{t('No backups yet. Saves are backed up after each play session of a minute or more, and before updates.')}</span>
      ) : (
        <ul className="saves-list">
          {saves.slice(0, 6).map((s) => (
            <li key={s.stamp}>
              <span>
                {new Date(s.at).toLocaleString()} <span className="muted">· {s.reason}{s.version ? ` · ${s.version}` : ''} · {s.files === 1 ? t('1 file') : t('{n} files', { n: s.files })}, {formatBytes(s.bytes)}</span>
              </span>
              <Button variant="ghost" size="sm" icon="retry" disabled={busy || game.running} onClick={() => void run(() => api.invoke('library:restoreSaves', { id: game.id, stamp: s.stamp }))}>{t('Restore')}</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="launch-row">
        <Button variant="ghost" size="sm" icon="downloads" disabled={busy} onClick={() => void run(async () => { const b = await api.invoke('library:backupSaves', { id: game.id }); if (!b) throw new Error(t('No save files were found yet — play the game first.')); return b; }, t('Saves backed up.'))}>{t('Back up now')}</Button>
        {!!saves?.length && <Button variant="ghost" size="sm" icon="folder" onClick={() => void attempt(() => api.invoke('library:openSaves', { id: game.id }))}>{t('Open backups folder')}</Button>}
      </div>
    </div>
  );
}

const RESOLUTIONS = ['1280x720', '1920x1080', '2560x1440', '3840x2160'];
const PROVIDER_LABEL: Record<ProtonInstall['provider'], string> = { ge: 'GE-Proton', cachyos: 'CachyOS', valve: 'Valve', other: 'Proton' };
/** "GE-Proton10-25" from a Proton folder path (launcher installs are named "<provider>-<version>"). */
const protonName = (path: string) => (path.split('/').pop() ?? path).replace(/^(ge|cachyos|valve)-/, '');
const FPS = [30, 60, 90, 120, 144, 165];

/** Heroic-style per-game options: Proton build, Gamescope, frame cap, overlay, GameMode, Proton switches, variables. */
function LaunchOptionsPanel({ game }: { game: Game }) {
  const tools = useApp((s) => s.info?.tools) ?? { gamescope: false, mangohud: false, gamemode: false };
  const [protons, setProtons] = useState<ProtonInstall[]>([]);
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [env, setEnv] = useState(game.launch.env);
  useEffect(() => setEnv(game.launch.env), [game.launch.env]);
  useEffect(() => {
    if (game.kind !== 'windows') return;
    void api.invoke('compat:releases', { refresh: false }).then((r) => { setProtons(r.installed ?? []); setDefaultPath(r.defaultPath ?? null); }).catch(() => undefined);
  }, [game.kind, game.launch.protonPath]);
  const l = game.launch;
  const defaultName = protons.find((p) => p.path === defaultPath)?.name ?? null;
  const set = (launch: Partial<LaunchOptions>) => void attempt(() => api.invoke('library:configure', { id: game.id, launch }));
  const windows = game.kind === 'windows';
  const allGames = useApp((s) => s.settings?.nrAllGames ?? false);
  const dlss5Active = windows && dlss5On(l, allGames);
  const missing = (name: string) => <span className="field__hint">{t('Not installed — install “{name}” with your distribution’s package manager to use this.', { name })}</span>;
  return (
    <>
      {windows && (
        <div className="field">
          <label className="field__label" htmlFor={`proton-${game.id}`}>{t('Proton version')}</label>
          <select id={`proton-${game.id}`} className="input" value={l.protonPath ?? ''} onChange={(e) => set({ protonPath: e.target.value || null })}>
            <option value="">{defaultName ? t('Default ({name})', { name: defaultName }) : t('Launcher default (Settings → Windows games)')}</option>
            {protons.map((p) => <option key={p.path} value={p.path}>{p.name} · {PROVIDER_LABEL[p.provider]}</option>)}
          </select>
          <span className="field__hint launch-proton-note">
            {l.protonPath
              ? t('Only this game uses {name}; the choice is kept with the game. Other games use the default.', { name: protonName(l.protonPath) })
              : t('Uses the default Proton. Pick a version here to use a different one for this game only.')}
          </span>
        </div>
      )}
      <div className="field">
        <span className="field__label">{t('Display')}</span>
        <label className="check">
          <input type="checkbox" checked={l.gamescope} disabled={!tools.gamescope} onChange={(e) => set({ gamescope: e.target.checked })} />
          <span>{t('True fullscreen with Gamescope')}</span>
        </label>
        {!tools.gamescope && missing('gamescope')}
        {l.gamescope && tools.gamescope && (
          <div className="launch-row">
            <select aria-label={t('Resolution')} className="input" value={l.resolution ?? ''} onChange={(e) => set({ resolution: e.target.value || null })}>
              <option value="">{t('Screen resolution')}</option>
              {RESOLUTIONS.map((r) => <option key={r} value={r}>{r.replace('x', ' × ')}</option>)}
            </select>
            <select aria-label={t('Upscaling')} className="input" value={l.upscale} onChange={(e) => set({ upscale: e.target.value as LaunchOptions['upscale'] })}>
              <option value="off">{t('No upscaling')}</option>
              <option value="fsr">{t('AMD FSR upscaling')}</option>
              <option value="nis">{t('NVIDIA NIS upscaling')}</option>
            </select>
          </div>
        )}
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`fps-${game.id}`}>{t('Frame rate limit')}</label>
        <select id={`fps-${game.id}`} className="input" value={l.fpsLimit ?? ''} onChange={(e) => set({ fpsLimit: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t('No limit')}</option>
          {FPS.map((f) => <option key={f} value={f}>{t('{n} FPS', { n: f })}</option>)}
        </select>
        {!l.gamescope && l.fpsLimit && <span className="field__hint">{t('Applies to Direct3D games (through DXVK / VKD3D).')}</span>}
      </div>
      <div className="field">
        <span className="field__label">{t('Performance')}</span>
        <label className="check">
          <input type="checkbox" checked={l.gamemode} disabled={!tools.gamemode} onChange={(e) => set({ gamemode: e.target.checked })} />
          <span>{t('GameMode (CPU and GPU performance mode while playing)')}</span>
        </label>
        {!tools.gamemode && missing('gamemode')}
        <label className="check">
          <input type="checkbox" checked={l.mangohud} disabled={!tools.mangohud} onChange={(e) => set({ mangohud: e.target.checked })} />
          <span>{t('MangoHud overlay (FPS, frame times, temperatures)')}</span>
        </label>
        {!tools.mangohud && missing('mangohud')}
      </div>
      {windows && (
        <div className="field">
          <span className="field__label">{t('Proton options')}</span>
          <label className="check">
            <input type="checkbox" checked={l.nvapi} onChange={(e) => set({ nvapi: e.target.checked })} />
            <span>{t('NVIDIA DLSS and Reflex (NVAPI)')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={l.wined3d} onChange={(e) => set({ wined3d: e.target.checked })} />
            <span>{t('Compatibility renderer (WineD3D) — for games that crash or show black screens')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={l.optiscalerFsr4} disabled={dlss5Active} onChange={(e) => set({ optiscalerFsr4: e.target.checked })} />
            <span>{t('AMD: FSR 4 in this game through OptiScaler (for games with DLSS, XeSS or FSR 2)')}</span>
          </label>
          {l.optiscalerFsr4 && !dlss5Active && <span className="field__hint">{t('Needs a Radeon RX 7000 or 9000 card and GE-Proton 10-26 or newer. Its files go into the game folder at the next start and come out when you turn this off. Pick DLSS, XeSS or FSR in the game.')}</span>}
        </div>
      )}
      {windows && (
        <div className="field">
          <label className="field__label" htmlFor={`dlss5-${game.id}`}>{t('DLSS 5 Neural Rendering')}</label>
          <select id={`dlss5-${game.id}`} className="input" value={dlss5Choice(l)} onChange={(e) => { const v = e.target.value as Dlss5Choice; set({ dlss5: v, neuralRendering: v === 'on' }); }}>
            <option value="auto">{allGames ? t('As in Settings: on (all games)') : t('As in Settings: off')}</option>
            <option value="on">{t('On for this game')}</option>
            <option value="off">{t('Off for this game')}</option>
          </select>
          <span className="field__hint">{dlss5Active
            ? t('On: its files go into the game folder at the next start and come out when you turn it off. Turn DLSS, FSR or XeSS on in the game; OptiScaler\'s menu opens with the Insert key. Picture settings are in Settings → Graphics.')
            : t('Off in this game. Settings → Graphics turns it on for all games at once.')}</span>
        </div>
      )}
      <div className="field">
        <label className="field__label" htmlFor={`env-${game.id}`}>{t('Environment variables')}</label>
        <textarea id={`env-${game.id}`} className="input mono launch-env" rows={3} placeholder={t('One per line, e.g.\nDXVK_HUD=fps')} value={env}
          onChange={(e) => setEnv(e.target.value)} onBlur={() => env !== l.env && set({ env })} />
      </div>
    </>
  );
}

/** The game's own logo from Steam over the banner; its title when there is none. */
function GameLogo({ game }: { game: Game }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [game.art?.logo]);
  if (!game.art?.logo || failed) return <h2 className="hero__title">{game.title}</h2>;
  return (
    <h2 className="hero__title hero__title--logo">
      <img src={game.art.logo} alt={game.title} onError={() => setFailed(true)} />
    </h2>
  );
}

function LibraryHero({ game }: { game: Game }) {
  const { reduced } = useMotionPrefs();
  const week = usePlayStats()?.games.find((x) => x.gameId === game.id);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [removePrefix, setRemovePrefix] = useState(false);
  const [args, setArgs] = useState(game.args);
  const [coverOpen, setCoverOpen] = useState(false);
  const [imagesOpen, setImagesOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const storeJob = useApp((s) => (game.store ? s.stores.jobs.find((j) => j.store === game.store && j.id === game.storeId && ['active', 'queued'].includes(j.state)) : undefined));
  // A game from disk that the person also owns on GOG or Epic: offer to merge it.
  const storeTwin = useApp((s) => (game.store ? undefined : s.stores.owned.find((o) => o.gameId === null && o.title.toLowerCase().replace(/[^a-z0-9]+/g, '') === game.title.toLowerCase().replace(/[^a-z0-9]+/g, ''))));
  const heroImage = game.images.hero ?? game.art?.hero ?? game.artwork;
  const nrAllGames = useApp((s) => s.settings?.nrAllGames ?? false);
  const argsRef = useRef(game.args);
  useEffect(() => {
    setArgs(game.args);
    argsRef.current = game.args;
  }, [game.args]);

  const configure = (patch: { runner?: Runner; executable?: string; args?: string }) => void attempt(() => api.invoke('library:configure', { id: game.id, ...patch }));

  return (
    <motion.section
      className="hero"
      aria-label={`${game.title} details`}
      initial={reduced ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : 0.45, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className={`hero__backdrop ${heroImage && heroImage === game.art?.hero ? 'is-steam' : ''}`} aria-hidden="true" style={heroImage ? undefined : placeholderStyle(game.title)}>
        {heroImage && <img key={heroImage} src={heroImage} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
      </div>
      <div className="hero__content">
        <div className="hero__main">
          <p className="eyebrow">{game.kind === 'windows' ? `${t('Windows')} · ${game.runner === 'proton' ? (game.launch.protonPath ? protonName(game.launch.protonPath) : 'Proton') : 'Wine'}` : t('Native Linux')}{game.store ? ` · ${STORE_LABEL[game.store]}` : game.sourceHost ? ` · ${game.sourceHost}` : game.managed ? '' : t(' · Imported')}</p>
          <GameLogo game={game} />
          <p className="hero__stats">
            {game.version && <span className="mono">{game.version}</span>}
            {game.kind === 'windows' && game.art?.appid ? <ProtonDbBadge appid={game.art.appid} /> : null}
            {game.kind === 'windows' && dlss5On(game.launch, nrAllGames) && <Dlss5Badge game={game} />}
            <span>{playtime(game.playtimeSeconds)}</span>
            {week && <span>{t('{time} this week', { time: hours(week.seconds) })}</span>}
            {game.lastPlayedAt && <span>{t('Last played {date}', { date: new Date(game.lastPlayedAt).toLocaleDateString(locale()) })}</span>}
          </p>
          {game.versionCheck && game.versionCheck.state !== 'identified' && <p className="muted" role="status">{game.versionCheck.detail}</p>}
          {storeTwin && (
            <div className="hero__store-update">
              <span>{t('You own this game on {store}.', { store: STORE_LABEL[storeTwin.store] })}</span>
              <Button size="sm" variant="primary" onClick={() => void attempt(() => api.invoke('stores:linkGame', { store: storeTwin.store, id: storeTwin.id, gameId: game.id }), t('{title} is linked to {store}; updates come from there.', { title: game.title, store: STORE_LABEL[storeTwin.store] }))}>{t('Merge them')}</Button>
              <Button size="sm" variant="ghost" icon="trash" onClick={() => void attempt(() => api.invoke('library:uninstall', { id: game.id, removePrefix: false }))}>{t('Remove the copy from the Library')}</Button>
            </div>
          )}
          {game.kind === 'windows' && <ProtonAdviceBox game={game} />}
          {game.store && (storeJob || game.storeUpdate) && (
            <div className="hero__store-update">
              {storeJob
                ? <><span>{storeJob.progress !== null ? t('Updating from {store} · {p}%', { store: STORE_LABEL[game.store], p: Math.round(storeJob.progress * 100) }) : t('Updating from {store}…', { store: STORE_LABEL[game.store] })}</span>
                    <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.invoke('stores:cancel', { store: game.store!, id: game.storeId! }))}>{t('Cancel')}</Button></>
                : <Button size="sm" variant="primary" icon="downloads" disabled={game.running} onClick={() => void attempt(() => api.invoke('stores:update', { id: game.id }))}>{t('Update from {store}', { store: STORE_LABEL[game.store] })}</Button>}
            </div>
          )}
          <div className="hero__quick">
            <IconButton icon="heart" label={game.favorite ? t('Remove from favorites') : t('Add to favorites')} aria-pressed={game.favorite} className={`icon-btn ${game.favorite ? 'is-on' : ''}`} onClick={() => void attempt(() => api.invoke('library:favorite', { id: game.id, favorite: !game.favorite }))} />
            <IconButton icon="folder" label={t('Show files')} onClick={() => void attempt(() => api.invoke('library:reveal', { id: game.id }))} />
            <IconButton icon="trash" label={t('Uninstall')} onClick={() => setUninstallOpen(true)} disabled={game.running} />
            <IconButton icon="edit" label={t('Rename')} onClick={() => setRenameOpen(true)} />
            <IconButton icon="palette" label={t('Change cover and background')} onClick={() => setImagesOpen(true)} />
            {game.catalogId === null && <IconButton icon="search" label={t('Find the cover by name')} onClick={() => setCoverOpen(true)} />}
          </div>
        </div>
        <PlayControl game={game} />
      </div>

      <AnimatePresence initial={false}>
        {game.update && game.update.state !== 'ignored' && <UpdatePanel key="update" game={game} />}
        {game.archive && !game.running && (
          <motion.div key="archive" className="hero__setup hero__update" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <Icon name="hdd" size={18} />
            <div>
              <p>
                <strong>{t('{size} of downloaded files can be deleted.', { size: formatBytes(game.archive.bytes) })}</strong>{' '}
                {t(game.archive.files === 1 ? '{title} is installed and no longer needs its download.' : '{title} is installed and no longer needs its {n} downloaded parts.', { title: game.title, n: game.archive.files })}
              </p>
              <div className="hero__update-actions">
                <Button variant="primary" size="sm" icon="trash" onClick={() => void attempt(async () => { const r = await api.invoke('library:deleteArchive', { id: game.id }); return r; }, t('Freed {size}.', { size: formatBytes(game.archive!.bytes) }))}>
                  {t('Delete them')}</Button>
                <Button variant="ghost" size="sm" onClick={() => void attempt(() => api.invoke('library:keepArchive', { id: game.id }))}>{t('Keep')}</Button>
              </div>
            </div>
          </motion.div>
        )}
        {game.status === 'installer-pending' && (
          <motion.div className="hero__setup" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <Icon name="info" size={18} />
            <div>
              <p>
                <strong>{t('This game ships with a Windows installer.')}</strong> {' '}{t('Run it yourself — it opens in {runner} inside this game\'s own prefix. Afterwards, choose the installed program.', { runner: game.runner === 'proton' ? 'Proton' : 'Wine' })}</p>
              <Button variant="primary" size="sm" icon="play" onClick={() => void attempt(() => api.invoke('library:runInstaller', { id: game.id }))}>
                {t('Run installer')}</Button>
            </div>
          </motion.div>
        )}
        {game.status === 'installing' && (
          <motion.div className="hero__setup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="status">
            <span className="spinner" aria-hidden="true" />
            <p>{t('The installer is running. Follow its window; this updates when it closes.')}</p>
          </motion.div>
        )}
        {game.status === 'needs-executable' && (
          <motion.div className="hero__setup" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <Icon name="alert" size={18} />
            <div className="hero__choose">
              <p>
                <strong>{t('Which file starts the game?')}</strong> {' '}{t('Several candidates were found.')}</p>
              <ul className="exec-list" role="radiogroup" aria-label={t('Executable')}>
                {game.executableCandidates.slice(0, 8).map((c) => (
                  <li key={c}>
                    <button role="radio" aria-checked={game.executable === c} className="exec-option" onClick={() => configure({ executable: c })}>
                      <span className="mono">{c.split('/').slice(-2).join('/')}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <Button variant="ghost" size="sm" icon="folder" onClick={() => void attempt(() => api.invoke('library:pickExecutable', { id: game.id }))}>
                {t('Browse…')}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <details className="hero__manage">
        <summary>
          <Icon name="sliders" size={16} /> {' '}{t('Launch options')}</summary>
        <div className="manage-grid">
          {game.kind === 'windows' && (
            <div className="field">
              <span className="field__label" id={`runner-${game.id}`}>
                {t('Compatibility runner')}</span>
              <div className="segmented" role="radiogroup" aria-labelledby={`runner-${game.id}`}>
                {(['proton', 'wine'] as Runner[]).map((r) => (
                  <button key={r} role="radio" aria-checked={game.runner === r} className={game.runner === r ? 'is-on' : ''} onClick={() => configure({ runner: r })}>
                    {r === 'proton' ? t('Proton (umu)') : t('Wine')}
                  </button>
                ))}
              </div>
            </div>
          )}
          {game.status === 'installed' && game.executableCandidates.length > 1 && (
            <div className="field">
              <span className="field__label" id={`build-${game.id}`}>
                {t('Build')}</span>
              <div className="segmented segmented--wrap" role="radiogroup" aria-labelledby={`build-${game.id}`}>
                {game.executableCandidates.slice(0, 6).map((c) => (
                  <button key={c} role="radio" aria-checked={game.executable === c} className={game.executable === c ? 'is-on' : ''} onClick={() => configure({ executable: c })} title={c}>
                    {/\.exe$/i.test(c) ? t('Windows') : t('Linux')} · {c.split('/').pop()}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="field">
            <span className="field__label">{t('Executable')}</span>
            <div className="path-row">
              <span className="mono path-row__value" title={game.executable ?? ''}>
                {game.executable ?? t('Not chosen')}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void attempt(() => api.invoke('library:pickExecutable', { id: game.id }))}>
                {t('Change')}</Button>
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`args-${game.id}`}>
              {t('Launch arguments')}</label>
            <input
              id={`args-${game.id}`}
              className="input mono"
              value={args}
              placeholder={t('e.g. -windowed')}
              onChange={(e) => setArgs(e.target.value)}
              onBlur={() => args !== argsRef.current && configure({ args })}
            />
          </div>
          <LaunchOptionsPanel game={game} />
          <SavesPanel game={game} />
          <div className="field">
            <span className="field__label">{t('Shortcuts')}</span>
            <div className="launch-row">
              <Button variant="ghost" size="sm" icon="grid" onClick={() => void attempt(() => api.invoke('library:shortcut', { id: game.id, where: 'menu' }), t('{title} is in your applications menu.', { title: game.title }))}>{t('Add to applications menu')}</Button>
              <Button variant="ghost" size="sm" icon="link" onClick={() => void attempt(() => api.invoke('library:shortcut', { id: game.id, where: 'desktop' }), t('Shortcut for {title} added to your desktop.', { title: game.title }))}>{t('Add to desktop')}</Button>
            </div>
          </div>
          {game.canRollback && game.update?.state !== 'updated' && (
            <div className="field">
              <span className="field__label">{t('Previous version')}</span>
              <div className="path-row">
                <span className="path-row__value">{t('{version} is kept until you have played the current version.', { version: game.previousVersion })}</span>
                <Button variant="ghost" size="sm" icon="reload" disabled={game.running} onClick={() => void attempt(() => api.invoke('library:rollback', { id: game.id }))}>
                  {t('Roll back')}</Button>
              </div>
            </div>
          )}
          {game.prefixDir && (
            <div className="field">
              <span className="field__label">{t('Wine prefix')}</span>
              <span className="mono path-row__value">{game.prefixDir}</span>
            </div>
          )}
        </div>
      </details>

      <CoverSearch game={game} open={coverOpen} onClose={() => setCoverOpen(false)} />
      <ImagePicker game={game} open={imagesOpen} onClose={() => setImagesOpen(false)} />
      <RenameGame game={game} open={renameOpen} onClose={() => setRenameOpen(false)} />
      <Dialog
        open={uninstallOpen}
        title={t('Uninstall {title}?', { title: game.title })}
        onClose={() => setUninstallOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setUninstallOpen(false)}>
              {t('Keep it')}</Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={() => {
                setUninstallOpen(false);
                void attempt(() => api.invoke('library:uninstall', { id: game.id, removePrefix }), t('{title} was removed.', { title: game.title }));
              }}
            >
              {t('Uninstall')}</Button>
          </>
        }
      >
        <p>
          {game.managed
            ? t('The game folder managed by the launcher will be deleted. The downloaded archive stays in Downloads until you remove it.')
            : t('This game was imported. It is removed from the Library only; its files stay where they are.')}
        </p>
        {game.prefixDir && (
          <label className="check">
            <input type="checkbox" checked={removePrefix} onChange={(e) => setRemovePrefix(e.target.checked)} />
            <span>{t('Also delete its Wine prefix (saves and settings stored there are lost)')}</span>
          </label>
        )}
      </Dialog>
    </motion.section>
  );
}

/**
 * Picks an imported game's cover: search Steam by name and choose the game.
 * (The local AI already tries this on its own after an import.)
 */
function CoverSearch({ game, open, onClose }: { game: Game; open: boolean; onClose: () => void }) {
  const [term, setTerm] = useState(game.title);
  const [results, setResults] = useState<Array<{ appid: number; name: string; image: string | null }> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setTerm(game.title); setResults(null); } }, [open, game.title]);
  const search = async () => {
    if (term.trim().length < 2) return;
    setBusy(true);
    const r = await attempt(() => api.invoke('library:searchCover', { term: term.trim() }));
    setBusy(false);
    setResults(r ?? []);
  };
  useEffect(() => { if (open) void search(); }, [open]);
  const choose = (r: { appid: number; name: string }) => {
    onClose();
    void attempt(() => api.invoke('library:chooseCover', { id: game.id, appid: r.appid, name: r.name }), t('{title} now has its cover.', { title: r.name }));
  };
  return (
    <Dialog open={open} title={t('Find the cover of {title}', { title: game.title })} onClose={onClose}
      actions={<Button variant="secondary" onClick={onClose}>{t('Close')}</Button>}>
      <form className="cover-search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input className="input" value={term} onChange={(e) => setTerm(e.target.value)} aria-label={t('Game name')} placeholder={t('Game name')} autoFocus />
        <Button type="submit" variant="primary" size="sm" icon="search" disabled={busy || term.trim().length < 2}>{t('Search')}</Button>
      </form>
      {busy && <p className="muted">{t('Searching Steam…')}</p>}
      {results && !busy && (results.length === 0
        ? <p className="muted">{t('No games found. Try a shorter or different name.')}</p>
        : (
          <ul className="cover-search__list">
            {results.map((r) => (
              <li key={r.appid}>
                <button type="button" className="cover-search__item" onClick={() => choose(r)}>
                  {r.image ? <img src={r.image} alt="" /> : <span className="cover-search__blank" />}
                  <span>{r.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </Dialog>
  );
}

/**
 * Choose a game's cover (its Library card) and background (the big image when
 * it is open) among its Steam artwork and screenshots, the download site's
 * images, or an image file of your own.
 */
function ImagePicker({ game, open, onClose }: { game: Game; open: boolean; onClose: () => void }) {
  const [options, setOptions] = useState<ImageOptions | null>(null);
  const [which, setWhich] = useState<'cover' | 'hero'>('cover');
  useEffect(() => {
    if (!open) return;
    setOptions(null);
    let live = true;
    void attempt(() => api.invoke('library:imageOptions', { id: game.id })).then((o) => { if (live) setOptions(o ?? { covers: [], heroes: [] }); });
    return () => { live = false; };
  }, [open, game.id]);
  const current = which === 'cover' ? (game.images.cover ?? game.art?.capsule ?? game.artwork) : (game.images.hero ?? game.art?.hero ?? game.artwork);
  const list = options ? (which === 'cover' ? options.covers : options.heroes) : [];
  const set = (url: string | null) => void attempt(() => api.invoke('library:setImage', { id: game.id, which, url }));
  return (
    <Dialog open={open} title={t('Images of {title}', { title: game.title })} onClose={onClose}
      actions={<Button variant="secondary" onClick={onClose}>{t('Done')}</Button>}>
      <div className="image-picker__tabs" role="tablist">
        <button role="tab" aria-selected={which === 'cover'} className={`sort-tab ${which === 'cover' ? 'is-on' : ''}`} onClick={() => setWhich('cover')}>{t('Cover')}</button>
        <button role="tab" aria-selected={which === 'hero'} className={`sort-tab ${which === 'hero' ? 'is-on' : ''}`} onClick={() => setWhich('hero')}>{t('Background')}</button>
      </div>
      <p className="muted image-picker__hint">{which === 'cover' ? t('The picture on the game\'s card in your Library.') : t('The big picture behind the game when you open it.')}</p>
      {!options ? <p className="muted">{t('Looking for images…')}</p> : (
        <ul className={`image-picker__grid ${which === 'hero' ? 'is-wide' : ''}`}>
          {list.map((url) => (
            <li key={url}>
              <button type="button" className={`image-picker__item ${url === current ? 'is-on' : ''}`} aria-pressed={url === current} onClick={() => set(url)} aria-label={t('Use this image')}>
                <img src={url} alt="" loading="lazy" onError={(e) => { (e.currentTarget.closest('li') as HTMLElement).style.display = 'none'; }} />
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="muted">{t('No other images were found for this game.')}</li>}
        </ul>
      )}
      <div className="image-picker__actions">
        <Button size="sm" variant="ghost" icon="folder" onClick={() => void attempt(() => api.invoke('library:imageFromFile', { id: game.id, which }))}>{t('Use an image file…')}</Button>
        {(which === 'cover' ? game.images.cover : game.images.hero) && <Button size="sm" variant="ghost" icon="retry" onClick={() => set(null)}>{t('Back to the default')}</Button>}
      </div>
    </Dialog>
  );
}

/** Type the game's name; its cover and background stay as they are. */
function RenameGame({ game, open, onClose }: { game: Game; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(game.title);
  useEffect(() => { if (open) setName(game.title); }, [open, game.title]);
  const save = () => {
    const title = name.trim();
    if (!title || title === game.title) { onClose(); return; }
    onClose();
    void attempt(() => api.invoke('library:rename', { id: game.id, title }));
  };
  return (
    <Dialog open={open} title={t('Rename {title}', { title: game.title })} onClose={onClose}
      actions={<>
        <Button variant="secondary" onClick={onClose}>{t('Cancel')}</Button>
        <Button variant="primary" icon="check" disabled={!name.trim()} onClick={save}>{t('Save')}</Button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <input className="input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} aria-label={t('Game name')} autoFocus />
      </form>
      <p className="muted">{t('Only the name changes; the cover and background stay as they are.')}</p>
    </Dialog>
  );
}

/** A game bought on GOG or Epic that is not installed: greyed, with its store and install progress. */
const OwnedCover = memo(function OwnedCover({ o, index, selected, onSelect }: { o: OwnedGame; index: number; selected: boolean; onSelect: (id: string) => void }) {
  const job = useApp((s) => s.stores.jobs.find((j) => j.store === o.store && j.id === o.id && ['active', 'queued'].includes(j.state)));
  return (
    <button
      role="option"
      aria-selected={selected}
      aria-label={`${o.title}: ${STORE_LABEL[o.store]}, ${job ? t('installing') : t('not installed')}`}
      className={`cover cover--owned ${selected ? 'is-selected' : ''}`}
      onClick={() => onSelect(`${o.store}:${o.id}`)}
    >
      <span className="cover__float">
        <Artwork card src={o.cover} title={o.title} className="cover__art" />
        <span className="cover__veil" aria-hidden="true" />
        <span className="cover__title">{o.title}</span>
        <span className={`cover__store cover__store--${o.store}`}>{STORE_LABEL[o.store]}</span>
        <span className="cover__owned-state">
          {job ? (job.progress !== null ? t('Installing {p}%', { p: Math.round(job.progress * 100) }) : t('Installing…')) : <><Icon name="downloads" size={14} /> {t('Install')}</>}
        </span>
        {job?.progress != null && <span className="cover__progress" style={{ width: `${Math.round(job.progress * 100)}%` }} aria-hidden="true" />}
      </span>
    </button>
  );
});

/** The big panel of a GOG or Epic game that is not installed: install it, or link a copy already on disk. */
function OwnedHero({ o }: { o: OwnedGame }) {
  const job = useApp((s) => s.stores.jobs.find((j) => j.store === o.store && j.id === o.id && ['active', 'queued'].includes(j.state)));
  const store = STORE_LABEL[o.store];
  // The same game already in the Library from disk: offer to link it, or remove it.
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const twin = useApp((s) => s.library.find((g) => !g.store && norm(g.title) === norm(o.title)));
  return (
    <section className="hero hero--owned" aria-label={`${o.title}`}>
      <div className="hero__backdrop" aria-hidden="true" style={o.hero ? undefined : placeholderStyle(o.title)}>
        {o.hero && <img src={o.hero} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
      </div>
      <div className="hero__content">
        <div className="hero__main">
          <p className="eyebrow">{t('{store} · in your account, not installed', { store })}</p>
          <h2 className="hero__title">{o.title}</h2>
          <p className="hero__stats">
            {job ? <span>{job.kind === 'import' ? t('Linking…') : job.progress !== null ? t('Installing {p}%', { p: Math.round(job.progress * 100) }) : t('Preparing the download…')}</span>
              : <span>{t('Installs into your games folder with {store}\'s own tool, and runs through Proton.', { store })}</span>}
          </p>
          {job?.progress != null && <div className="st-progress st-progress--inline"><span style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
          {twin && !job && (
            <div className="hero__store-update">
              <span>{t('{title} is already in your Library from disk.', { title: twin.title })}</span>
              <Button size="sm" variant="primary" onClick={() => void attempt(() => api.invoke('stores:linkGame', { store: o.store, id: o.id, gameId: twin.id }), t('{title} is linked to {store}; updates come from there.', { title: o.title, store }))}>{t('Merge them')}</Button>
              <Button size="sm" variant="ghost" icon="trash" onClick={() => void attempt(() => api.invoke('library:uninstall', { id: twin.id, removePrefix: false }))}>{t('Remove the copy from the Library')}</Button>
            </div>
          )}
          <div className="hero__actions-row">
            {job
              ? <Button variant="ghost" onClick={() => void attempt(() => api.invoke('stores:cancel', { store: o.store, id: o.id }))}>{t('Cancel')}</Button>
              : <>
                  <Button variant="primary" icon="downloads" onClick={() => void attempt(() => api.invoke('stores:install', { store: o.store, id: o.id }))}>{t('Install')}</Button>
                  <Button variant="ghost" icon="folder" onClick={() => void attempt(() => api.invoke('stores:adopt', { store: o.store, id: o.id }), t('{title} is linked to {store}; updates come from there.', { title: o.title, store }))}>{t('I already have it installed')}</Button>
                </>}
          </div>
        </div>
      </div>
    </section>
  );
}

/** DLSS 5 is on for this game; what OptiScaler's log showed the last time it was played. */
function Dlss5Badge({ game }: { game: Game }) {
  const [r, setR] = useState<NrReport | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void api.invoke('nr:report', { id: game.id }).then((x) => { if (live) setR(x); }).catch(() => undefined);
    load();
    const off = api.on('nr:changed', load);
    return () => { live = false; off(); };
  }, [game.id, game.running]);
  const state = r?.state === 'running' ? 'ok' : r?.state === 'failed' || r?.state === 'not-used' ? 'warn' : 'new';
  const label = r?.state === 'running' ? t('DLSS 5 ran') : r?.state === 'failed' ? t('DLSS 5 did not start') : r?.state === 'not-used' ? t('DLSS 5 unused') : 'DLSS 5';
  const detail = r?.state === 'running'
    ? (r.modelMs !== null ? t('Ran last time at {size}, {ms} ms per frame.', { size: r.size ?? '?', ms: r.modelMs.toFixed(1) }) : t('Ran last time at {size}.', { size: r.size ?? '?' }))
    : r?.state === 'failed' ? t('Did not start last time: {reason}.', { reason: r.reason ?? '?' })
    : r?.state === 'not-used' ? t('Last time the game did not use DLSS, FSR or XeSS: turn one of them on in its graphics settings.')
    : t('DLSS 5 Neural Rendering is on for this game. After you play, this shows whether it really ran.');
  return (
    <>
      <span className={`hero__dlss5 hero__dlss5--${state}`} title={detail}><Icon name={state === 'warn' ? 'alert' : 'sparkle'} size={13} /> {label}</span>
      {state === 'warn' && !game.running && <span className="hero__dlss5-why">{detail}</span>}
    </>
  );
}

const TIER_LABEL: Record<string, string> = { platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borderline: 'Borderline', native: 'Native', pending: 'Pending' };

/** The Proton build that suits this game, from ProtonDB, Steam Deck verification, anti-cheat and umu. */
function ProtonAdviceBox({ game }: { game: Game }) {
  const [a, setA] = useState<ProtonAdvice | null>(null);
  const [loading, setLoading] = useState(false);
  // The suggested build being downloaded; the game switches to it once it is installed.
  const [fetching, setFetching] = useState<string | null>(null);
  const load = () => { setLoading(true); void api.invoke('library:protonAdvice', { id: game.id }).then(setA).catch(() => setA(null)).finally(() => setLoading(false)); };
  useEffect(load, [game.id, game.launch.protonPath]);
  useEffect(() => setFetching(null), [game.launch.protonPath]);
  if (loading && !a) return <p className="proton-advice proton-advice--loading muted">{t('Checking ProtonDB and other sources for the best Proton…')}</p>;
  if (!a) return null;
  const facts = [
    a.protondb ? t('ProtonDB: {tier} ({n} reports)', { tier: TIER_LABEL[a.protondb.tier] ?? a.protondb.tier, n: a.protondb.total }) + (a.protondb.trendingTier && a.protondb.trendingTier !== a.protondb.tier ? ` · ${t('trending {tier}', { tier: TIER_LABEL[a.protondb.trendingTier] ?? a.protondb.trendingTier })}` : '') : t('ProtonDB: no reports found'),
    a.deck && a.deck !== 'unknown' ? t('Steam Deck: {status}', { status: a.deck === 'verified' ? t('Verified') : a.deck === 'playable' ? t('Playable') : t('Unsupported') }) : null,
  ].filter(Boolean).join(' · ');
  const using = game.launch.protonPath && a.recommended?.path === game.launch.protonPath;
  const install = (release: { id: string; name: string }) => void attempt(async () => {
    const r = await api.invoke('library:installSuggestedProton', { id: game.id, release: release.id });
    if (!r.ready) setFetching(release.name);
  });
  return (
    <div className={`proton-advice proton-advice--${a.verdict}`}>
      <span className="field__label">{t('Suggested Proton')}</span>
      <span className="field__hint">{facts}</span>
      {a.antiCheat && ['Denied', 'Broken'].includes(a.antiCheat.status) && (
        <span className="field__hint proton-advice__warn">{t('Uses {list}, which blocks Linux: it will most likely not start on any Proton.', { list: a.antiCheat.anticheats.join(', ') })}</span>
      )}
      <div className="launch-row">
        {fetching
          ? <span className="field__hint" role="status"><span className="spinner" aria-hidden="true" /> {t('Downloading {name} (see Downloads); this game switches to it when it is ready.', { name: fetching })}</span>
          : a.installRelease
            ? <Button size="sm" variant="primary" icon="downloads" onClick={() => install(a.installRelease!)}>{t('Install and use {name}', { name: a.installRelease.name })}</Button>
            : null}
        {a.recommended && (using
          ? <span className="field__hint">{t('This game uses {name}, the suggested build.', { name: a.recommended.name })}</span>
          : <Button size="sm" variant={a.installRelease ? 'ghost' : 'primary'} icon="check" onClick={() => void attempt(() => api.invoke('library:configure', { id: game.id, launch: { protonPath: a.recommended!.path } }), t('{title} now uses {name}.', { title: game.title, name: a.recommended!.name }))}>{t('Use {name}', { name: a.recommended.name })}</Button>)}
        <Button size="sm" variant="ghost" icon="reload" disabled={loading} onClick={load}>{t('Check again')}</Button>
      </div>
      <span className="field__hint">{t('GE-Proton is suggested first: it is Valve\'s Proton plus media codecs and the community\'s fixes for each game.')}</span>
    </div>
  );
}
