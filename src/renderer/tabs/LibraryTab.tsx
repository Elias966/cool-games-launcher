import { KineticTitle } from '../components/KineticTitle';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { attempt, setTab, useApp } from '../state';
import { Artwork, placeholderStyle } from '../components/GameCard';
import { Button, Dialog, EmptyState, IconButton } from '../components/ui';
import { Icon } from '../components/Icon';
import type { DownloadItem, Game, LaunchOptions, Runner, SaveBackup } from '@shared/types';
import { ProgressRing } from '../components/ui';
import { ProtonDbBadge } from '../components/ProtonDb';
import { formatBytes, formatPlaytime, formatSpeed } from '@shared/format';
import { useMotionPrefs } from '../hooks/useMotion';

type Filter = 'all' | 'favorites' | 'linux' | 'windows';

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
    if (failed) return { label: `Part ${failed.partIndex} failed`, detail: failed.errorDetail, pct, failed: true, waiting: false };
    if (needs) return { label: 'Needs you', detail: needs.userPrompt?.message ?? null, pct, failed: false, waiting: true };
    return { label: `Downloading ${done}/${total} parts`, detail: null, pct, failed: false, waiting: false };
  }
  const pct = d.totalBytes ? Math.min(1, d.receivedBytes / d.totalBytes) : null;
  const unpack = /(\d+)%/.exec(d.installDetail ?? '');
  if (d.state === 'completed') {
    if (d.installState === 'failed') return { label: 'Could not prepare', detail: d.installDetail, pct: null, failed: true, waiting: false };
    return { label: unpack ? 'Unpacking' : 'Preparing', detail: d.installDetail, pct: unpack ? Number(unpack[1]) / 100 : null, failed: false, waiting: false };
  }
  if (d.state === 'failed') return { label: 'Download failed', detail: d.errorDetail, pct, failed: true, waiting: false };
  if (d.state === 'needs-user') return { label: 'Needs you', detail: d.userPrompt?.message ?? null, pct: null, failed: false, waiting: true };
  if (d.state === 'resolving' || d.state === 'needs-resolution') return { label: 'Finding the download', detail: null, pct: null, failed: false, waiting: false };
  if (d.state === 'paused') return { label: 'Paused', detail: d.errorDetail, pct, failed: false, waiting: true };
  if (d.state === 'queued') return { label: 'Queued', detail: null, pct, failed: false, waiting: false };
  return { label: 'Downloading', detail: null, pct, failed: false, waiting: false };
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

  const shown = useMemo(
    () =>
      games.filter(
        (g) =>
          (filter === 'all' || (filter === 'favorites' ? g.favorite : g.kind === filter)) &&
          (!search.trim() || g.title.toLowerCase().includes(search.trim().toLowerCase())),
      ),
    [games, filter, search],
  );
  const shownPending = useMemo(() => pending.filter((d) => (filter === 'all') && (!search.trim() || d.title.toLowerCase().includes(search.trim().toLowerCase()))), [pending, filter, search]);
  // With nothing installed yet, the game on its way fills the big panel.
  const selectedPending = pendingId !== null ? pending.find((d) => d.id === pendingId) ?? null : shown.length === 0 ? shownPending[0] ?? null : null;
  const selected = selectedPending ? null : games.find((g) => g.id === selectedId) ?? shown[0] ?? null;
  const updateCount = games.filter((g) => g.update?.state === 'available').length;

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
      <div className="page__scroll">
        <header className="page__header">
          <div className="page__titles">
            <p className="eyebrow">Collection</p>
            <KineticTitle text="Library" />
            <p className="page__subtitle">
              {games.length === 0 && !pending.length ? 'Installed and imported games appear here.' : `${games.length} game${games.length === 1 ? '' : 's'}${pending.length ? ` · ${pending.length} on the way` : ''} · ${games.filter((g) => g.running).length ? 'a game is running' : 'ready for launch'}${updateCount ? ` · ${updateCount} update${updateCount === 1 ? '' : 's'} available` : ''}`}
            </p>
          </div>
          <div className="page__actions">
            {games.some((g) => g.catalogId !== null) && (
              <Button variant="ghost" icon="reload" onClick={() => void attempt(async () => {
                const r = await api.invoke('library:checkUpdates');
                return r;
              }, 'Checking your games for updates…')}>
                Check for updates
              </Button>
            )}
            <Button variant="secondary" icon="import" onClick={() => void attempt(async () => {
              const g = await api.invoke('library:import');
              if (g) setSelectedId(g.id);
            })}>
              Import game
            </Button>
          </div>
        </header>

        {games.length === 0 && pending.length === 0 ? (
          <EmptyState
            icon="library"
            title="No games in your Library yet"
            action={
              <div className="empty__actions">
                <Button variant="primary" icon="store" onClick={() => setTab('store')}>
                  Browse the Store
                </Button>
              </div>
            }
          >
            Download a game from the Store and install it from Downloads, or import a game you already have with “Import game”.
          </EmptyState>
        ) : (
          <div className="library">
            {selectedPending ? <PendingHero key={`dl-${selectedPending.id}`} d={selectedPending} parts={partsOf(selectedPending)} /> : selected && <LibraryHero key={selected.id} game={selected} />}
            <div className="library__browser">
              <div className="toolbar toolbar--compact">
                <label className="search search--sm">
                  <Icon name="search" size={16} />
                  <span className="sr-only">Search your Library</span>
                  <input type="search" placeholder="Search library" value={search} onChange={(e) => setSearch(e.target.value)} />
                </label>
                <div className="chips" role="group" aria-label="Filter library">
                  {(['all', 'favorites', 'linux', 'windows'] as Filter[]).map((f) => (
                    <button key={f} className={`chip ${filter === f ? 'is-on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                      {f === 'all' ? 'All' : f === 'favorites' ? 'Favorites' : f === 'linux' ? 'Linux' : 'Windows'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="covers" role="listbox" aria-label="Games" aria-activedescendant={selected ? `cover-${selected.id}` : undefined}>
                {shownPending.map((d, i) => (
                  <PendingCover key={`dl-${d.id}`} d={d} parts={partsOf(d)} index={i} selected={selectedPending?.id === d.id} onSelect={() => setPendingId(d.id)} />
                ))}
                {shown.map((g, i) => (
                  <CoverPanel key={g.id} game={g} index={i + shownPending.length} selected={!selectedPending && selected?.id === g.id} onSelect={() => { setPendingId(null); setSelectedId(g.id); }} />
                ))}
                {shown.length === 0 && shownPending.length === 0 && <p className="muted">No games match.</p>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A game being downloaded or prepared: locked until it is ready to play. */
function PendingCover({ d, parts, index, selected, onSelect }: { d: DownloadItem; parts: DownloadItem[]; index: number; selected: boolean; onSelect: () => void }) {
  const { reduced } = useMotionPrefs();
  const st = pendingStatus(d, parts);
  return (
    <motion.button
      role="option"
      aria-selected={selected}
      aria-label={`${d.title}: ${st.label}${st.pct !== null ? ` ${Math.round(st.pct * 100)}%` : ''}`}
      className={`cover cover--pending ${selected ? 'is-selected' : ''} ${st.failed ? 'is-failed' : ''}`}
      onClick={onSelect}
      onFocus={onSelect}
      initial={reduced ? false : { opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : 0.5, delay: reduced ? 0 : Math.min(index, 12) * 0.05 }}
    >
      <span className="cover__float">
        <Artwork src={d.artwork} title={d.title} className="cover__art" />
        <span className="cover__lock" aria-hidden="true">
          <ProgressRing value={st.pct} indeterminate={st.pct === null && !st.failed && !st.waiting} size={64} stroke={4} tone={st.failed ? 'danger' : st.waiting ? 'warn' : 'cyan'}>
            <span className="mono cover__pct">{st.pct !== null ? `${Math.round(st.pct * 100)}%` : <Icon name={st.failed ? 'alert' : 'downloads'} size={18} />}</span>
          </ProgressRing>
          <span className="cover__state">{st.label}</span>
        </span>
        <span className="cover__title">{d.title}</span>
      </span>
    </motion.button>
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
          <p className="eyebrow">{d.sourceHost ?? 'Download'} · on its way to your Library</p>
          <h2 className="hero__title">{d.title}</h2>
          <p className="hero__stats">
            <span>{st.label}{st.pct !== null ? ` · ${Math.round(st.pct * 100)}%` : ''}</span>
            {d.state === 'active' && d.totalBytes ? <span className="mono">{formatBytes(d.receivedBytes)} of {formatBytes(d.totalBytes)} · {formatSpeed(d.speedBps)}</span> : null}
          </p>
          {st.detail && <p className="muted hero__pending-detail">{st.detail}</p>}
          <div className="bar hero__pending-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={st.pct !== null ? Math.round(st.pct * 100) : undefined}>
            <span style={{ width: st.pct !== null ? `${st.pct * 100}%` : '30%' }} className={st.pct === null ? 'is-indeterminate' : ''} />
          </div>
          <p className="muted">It unlocks here as soon as it is ready to play. The AI keeps working while you use other tabs.</p>
          <div className="hero__update-actions">
            {d.state === 'active' && <Button variant="ghost" size="sm" icon="pause" onClick={() => void attempt(() => api.invoke('download:pause', { id: d.id }))}>Pause</Button>}
            {d.state === 'paused' && <Button variant="primary" size="sm" icon="resume" onClick={() => void attempt(() => api.invoke('download:resume', { id: d.id }))}>Resume</Button>}
            {d.state === 'failed' && <Button variant="primary" size="sm" icon="retry" onClick={() => void attempt(() => api.invoke('download:retry', { id: d.id }))}>Try again</Button>}
            {d.state === 'completed' && d.installState === 'failed' && <Button variant="primary" size="sm" icon="retry" onClick={() => void attempt(() => api.invoke('download:install', { id: d.id }))}>Prepare again</Button>}
            <Button variant="ghost" size="sm" icon="downloads" onClick={() => setTab('downloads')}>Show in Downloads</Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function CoverPanel({ game, index, selected, onSelect }: { game: Game; index: number; selected: boolean; onSelect: () => void }) {
  const { reduced } = useMotionPrefs();
  return (
    <motion.button
      id={`cover-${game.id}`}
      role="option"
      aria-selected={selected}
      className={`cover ${selected ? 'is-selected' : ''} ${game.running ? 'is-running' : ''}`}
      onClick={onSelect}
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
      onFocus={onSelect}
      style={{ ['--float-delay' as string]: `${(index % 7) * -0.9}s` }}
      initial={reduced ? false : { opacity: 0, y: 30, rotateY: -14 }}
      animate={{ opacity: 1, y: 0, rotateY: 0 }}
      transition={{ duration: reduced ? 0 : 0.6, delay: reduced ? 0 : Math.min(index, 12) * 0.05, ease: [0.16, 1, 0.3, 1] }}
    >
      <span className="cover__float">
        <Artwork src={game.art?.capsule ?? game.artwork} title={game.title} className="cover__art" />
        <span className="cover__edge" aria-hidden="true" />
        <span className="cover__title">{game.title}</span>
        {game.favorite && (
          <span className="cover__fav" aria-label="Favorite">
            <Icon name="heart" size={13} />
          </span>
        )}
        {game.running && <span className="cover__live">Running</span>}
        {!game.running && game.update && ['available', 'downloading', 'preparing', 'waiting'].includes(game.update.state) && (
          <span className={`cover__update ${game.update.state === 'available' ? '' : 'is-busy'}`}>{game.update.state === 'available' ? 'Update' : 'Updating'}</span>
        )}
        {game.status !== 'installed' && <span className="cover__attention">Setup needed</span>}
      </span>
    </motion.button>
  );
}

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
      <button className="play__btn" onClick={onClick} disabled={!ready || busy} aria-label={game.running ? `Stop ${game.title}` : `Play ${game.title}`}>
        <Icon name={game.running ? 'stop' : 'play'} size={34} />
      </button>
      <span className="play__label">{game.running ? 'Stop' : 'Play'}</span>
    </div>
  );
}

const UPDATE_STEP: Record<string, string> = { downloading: 'Downloading the update', preparing: 'Installing the update', waiting: 'Update ready' };

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
            <strong>Update available{versions ? `: ${versions}` : ''}.</strong> <span className="muted">{u.reason}</span>
          </p>
          <p className="muted">Your saves are carried over, and the current version is kept until you have played the new one.</p>
          <div className="hero__update-actions">
            <Button variant="primary" size="sm" icon="downloads" onClick={() => void attempt(() => api.invoke('library:update', { id: game.id }))}>
              Update now
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void attempt(() => api.invoke('library:ignoreUpdate', { id: game.id }))}>
              Skip this version
            </Button>
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
            <strong>{UPDATE_STEP[u.state]}{versions ? ` (${versions})` : ''}.</strong> {u.detail ?? ''}
          </p>
          <p className="muted">You can keep playing the installed version meanwhile.</p>
          {u.state === 'downloading' && (
            <div className="hero__update-actions">
              <Button variant="ghost" size="sm" icon="downloads" onClick={() => setTab('downloads')}>Show in Downloads</Button>
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
            <strong>The update{versions ? ` (${versions})` : ''} did not finish.</strong> {u.detail ?? ''}
          </p>
          <p className="muted">The installed version was not changed.</p>
          <div className="hero__update-actions">
            <Button variant="primary" size="sm" icon="reload" onClick={() => void attempt(() => api.invoke('library:update', { id: game.id }))}>Try again</Button>
            <Button variant="ghost" size="sm" onClick={() => void attempt(() => api.invoke('library:ignoreUpdate', { id: game.id }))}>Skip this version</Button>
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
          <strong>Updated{u.to ? ` to ${u.to}` : ''}.</strong>{' '}
          {u.carried ? `${u.carried} save/settings file${u.carried === 1 ? ' was' : 's were'} carried over. ` : ''}
          {game.canRollback ? `${game.previousVersion} is kept until you have played this version.` : ''}
        </p>
        {game.canRollback && (
          <div className="hero__update-actions">
            <Button variant="ghost" size="sm" icon="reload" disabled={game.running} onClick={() => void attempt(() => api.invoke('library:rollback', { id: game.id }))}>
              Roll back to {game.previousVersion}
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
      <span className="field__label">Save backups</span>
      {saves === null ? <span className="muted">Loading…</span> : saves.length === 0 ? (
        <span className="field__hint">No backups yet. Saves are backed up after each play session of a minute or more, and before updates.</span>
      ) : (
        <ul className="saves-list">
          {saves.slice(0, 6).map((s) => (
            <li key={s.stamp}>
              <span>
                {new Date(s.at).toLocaleString()} <span className="muted">· {s.reason}{s.version ? ` · ${s.version}` : ''} · {s.files} file{s.files === 1 ? '' : 's'}, {formatBytes(s.bytes)}</span>
              </span>
              <Button variant="ghost" size="sm" icon="retry" disabled={busy || game.running} onClick={() => void run(() => api.invoke('library:restoreSaves', { id: game.id, stamp: s.stamp }))}>Restore</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="launch-row">
        <Button variant="ghost" size="sm" icon="downloads" disabled={busy} onClick={() => void run(async () => { const b = await api.invoke('library:backupSaves', { id: game.id }); if (!b) throw new Error('No save files were found yet — play the game first.'); return b; }, 'Saves backed up.')}>Back up now</Button>
        {!!saves?.length && <Button variant="ghost" size="sm" icon="folder" onClick={() => void attempt(() => api.invoke('library:openSaves', { id: game.id }))}>Open backups folder</Button>}
      </div>
    </div>
  );
}

const RESOLUTIONS = ['1280x720', '1920x1080', '2560x1440', '3840x2160'];
const FPS = [30, 60, 90, 120, 144, 165];

/** Heroic-style per-game options: Proton build, Gamescope, frame cap, overlay, GameMode, Proton switches, variables. */
function LaunchOptionsPanel({ game }: { game: Game }) {
  const tools = useApp((s) => s.info?.tools) ?? { gamescope: false, mangohud: false, gamemode: false };
  const [protons, setProtons] = useState<Array<{ path: string; name: string }>>([]);
  const [env, setEnv] = useState(game.launch.env);
  useEffect(() => setEnv(game.launch.env), [game.launch.env]);
  useEffect(() => {
    if (game.kind !== 'windows') return;
    void api.invoke('compat:releases', { refresh: false }).then((r) => setProtons(r.installed ?? [])).catch(() => undefined);
  }, [game.kind]);
  const l = game.launch;
  const set = (launch: Partial<LaunchOptions>) => void attempt(() => api.invoke('library:configure', { id: game.id, launch }));
  const windows = game.kind === 'windows';
  const missing = (name: string) => <span className="field__hint">Not installed — install “{name}” with your distribution’s package manager to use this.</span>;
  return (
    <>
      {windows && (
        <div className="field">
          <label className="field__label" htmlFor={`proton-${game.id}`}>Proton version</label>
          <select id={`proton-${game.id}`} className="input" value={l.protonPath ?? ''} onChange={(e) => set({ protonPath: e.target.value || null })}>
            <option value="">Launcher default (Settings → Windows games)</option>
            {protons.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
          </select>
        </div>
      )}
      <div className="field">
        <span className="field__label">Display</span>
        <label className="check">
          <input type="checkbox" checked={l.gamescope} disabled={!tools.gamescope} onChange={(e) => set({ gamescope: e.target.checked })} />
          <span>True fullscreen with Gamescope</span>
        </label>
        {!tools.gamescope && missing('gamescope')}
        {l.gamescope && tools.gamescope && (
          <div className="launch-row">
            <select aria-label="Resolution" className="input" value={l.resolution ?? ''} onChange={(e) => set({ resolution: e.target.value || null })}>
              <option value="">Screen resolution</option>
              {RESOLUTIONS.map((r) => <option key={r} value={r}>{r.replace('x', ' × ')}</option>)}
            </select>
            <select aria-label="Upscaling" className="input" value={l.upscale} onChange={(e) => set({ upscale: e.target.value as LaunchOptions['upscale'] })}>
              <option value="off">No upscaling</option>
              <option value="fsr">AMD FSR upscaling</option>
              <option value="nis">NVIDIA NIS upscaling</option>
            </select>
          </div>
        )}
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`fps-${game.id}`}>Frame rate limit</label>
        <select id={`fps-${game.id}`} className="input" value={l.fpsLimit ?? ''} onChange={(e) => set({ fpsLimit: e.target.value ? Number(e.target.value) : null })}>
          <option value="">No limit</option>
          {FPS.map((f) => <option key={f} value={f}>{f} FPS</option>)}
        </select>
        {!l.gamescope && l.fpsLimit && <span className="field__hint">Applies to Direct3D games (through DXVK / VKD3D).</span>}
      </div>
      <div className="field">
        <span className="field__label">Performance</span>
        <label className="check">
          <input type="checkbox" checked={l.gamemode} disabled={!tools.gamemode} onChange={(e) => set({ gamemode: e.target.checked })} />
          <span>GameMode (CPU and GPU performance mode while playing)</span>
        </label>
        {!tools.gamemode && missing('gamemode')}
        <label className="check">
          <input type="checkbox" checked={l.mangohud} disabled={!tools.mangohud} onChange={(e) => set({ mangohud: e.target.checked })} />
          <span>MangoHud overlay (FPS, frame times, temperatures)</span>
        </label>
        {!tools.mangohud && missing('mangohud')}
      </div>
      {windows && (
        <div className="field">
          <span className="field__label">Proton options</span>
          <label className="check">
            <input type="checkbox" checked={l.nvapi} onChange={(e) => set({ nvapi: e.target.checked })} />
            <span>NVIDIA DLSS and Reflex (NVAPI)</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={l.wined3d} onChange={(e) => set({ wined3d: e.target.checked })} />
            <span>Compatibility renderer (WineD3D) — for games that crash or show black screens</span>
          </label>
        </div>
      )}
      <div className="field">
        <label className="field__label" htmlFor={`env-${game.id}`}>Environment variables</label>
        <textarea id={`env-${game.id}`} className="input mono launch-env" rows={3} placeholder={'One per line, e.g.\nDXVK_HUD=fps'} value={env}
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
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [removePrefix, setRemovePrefix] = useState(false);
  const [args, setArgs] = useState(game.args);
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
      <div className={`hero__backdrop ${game.art?.hero ? 'is-steam' : ''}`} aria-hidden="true" style={game.art?.hero || game.artwork ? undefined : placeholderStyle(game.title)}>
        {(game.art?.hero ?? game.artwork) && <img src={game.art?.hero ?? game.artwork!} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
      </div>
      <div className="hero__content">
        <div className="hero__main">
          <p className="eyebrow">{game.kind === 'windows' ? `Windows · ${game.runner === 'proton' ? 'Proton' : 'Wine'}` : 'Native Linux'}{game.sourceHost ? ` · ${game.sourceHost}` : game.managed ? '' : ' · Imported'}</p>
          <GameLogo game={game} />
          <p className="hero__stats">
            {game.version && <span className="mono">{game.version}</span>}
            {game.kind === 'windows' && game.art?.appid ? <ProtonDbBadge appid={game.art.appid} /> : null}
            <span>{formatPlaytime(game.playtimeSeconds)}</span>
            {game.lastPlayedAt && <span>Last played {new Date(game.lastPlayedAt).toLocaleDateString()}</span>}
          </p>
          <div className="hero__quick">
            <IconButton icon="heart" label={game.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={game.favorite} className={`icon-btn ${game.favorite ? 'is-on' : ''}`} onClick={() => void attempt(() => api.invoke('library:favorite', { id: game.id, favorite: !game.favorite }))} />
            <IconButton icon="folder" label="Show files" onClick={() => void attempt(() => api.invoke('library:reveal', { id: game.id }))} />
            <IconButton icon="trash" label="Uninstall" onClick={() => setUninstallOpen(true)} disabled={game.running} />
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
                <strong>{formatBytes(game.archive.bytes)} of downloaded files can be deleted.</strong> {game.title} is installed and no longer needs {game.archive.files === 1 ? 'its download' : `its ${game.archive.files} downloaded parts`}.
              </p>
              <div className="hero__update-actions">
                <Button variant="primary" size="sm" icon="trash" onClick={() => void attempt(async () => { const r = await api.invoke('library:deleteArchive', { id: game.id }); return r; }, `Freed ${formatBytes(game.archive!.bytes)}.`)}>
                  Delete them
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void attempt(() => api.invoke('library:keepArchive', { id: game.id }))}>Keep</Button>
              </div>
            </div>
          </motion.div>
        )}
        {game.status === 'installer-pending' && (
          <motion.div className="hero__setup" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <Icon name="info" size={18} />
            <div>
              <p>
                <strong>This game ships with a Windows installer.</strong> Run it yourself — it opens in {game.runner === 'proton' ? 'Proton' : 'Wine'} inside this game's own prefix. Afterwards, choose the installed program.
              </p>
              <Button variant="primary" size="sm" icon="play" onClick={() => void attempt(() => api.invoke('library:runInstaller', { id: game.id }))}>
                Run installer
              </Button>
            </div>
          </motion.div>
        )}
        {game.status === 'installing' && (
          <motion.div className="hero__setup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="status">
            <span className="spinner" aria-hidden="true" />
            <p>The installer is running. Follow its window; this updates when it closes.</p>
          </motion.div>
        )}
        {game.status === 'needs-executable' && (
          <motion.div className="hero__setup" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <Icon name="alert" size={18} />
            <div className="hero__choose">
              <p>
                <strong>Which file starts the game?</strong> Several candidates were found.
              </p>
              <ul className="exec-list" role="radiogroup" aria-label="Executable">
                {game.executableCandidates.slice(0, 8).map((c) => (
                  <li key={c}>
                    <button role="radio" aria-checked={game.executable === c} className="exec-option" onClick={() => configure({ executable: c })}>
                      <span className="mono">{c.split('/').slice(-2).join('/')}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <Button variant="ghost" size="sm" icon="folder" onClick={() => void attempt(() => api.invoke('library:pickExecutable', { id: game.id }))}>
                Browse…
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <details className="hero__manage">
        <summary>
          <Icon name="sliders" size={16} /> Launch options
        </summary>
        <div className="manage-grid">
          {game.kind === 'windows' && (
            <div className="field">
              <span className="field__label" id={`runner-${game.id}`}>
                Compatibility runner
              </span>
              <div className="segmented" role="radiogroup" aria-labelledby={`runner-${game.id}`}>
                {(['proton', 'wine'] as Runner[]).map((r) => (
                  <button key={r} role="radio" aria-checked={game.runner === r} className={game.runner === r ? 'is-on' : ''} onClick={() => configure({ runner: r })}>
                    {r === 'proton' ? 'Proton (umu)' : 'Wine'}
                  </button>
                ))}
              </div>
            </div>
          )}
          {game.status === 'installed' && game.executableCandidates.length > 1 && (
            <div className="field">
              <span className="field__label" id={`build-${game.id}`}>
                Build
              </span>
              <div className="segmented segmented--wrap" role="radiogroup" aria-labelledby={`build-${game.id}`}>
                {game.executableCandidates.slice(0, 6).map((c) => (
                  <button key={c} role="radio" aria-checked={game.executable === c} className={game.executable === c ? 'is-on' : ''} onClick={() => configure({ executable: c })} title={c}>
                    {/\.exe$/i.test(c) ? 'Windows' : 'Linux'} · {c.split('/').pop()}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="field">
            <span className="field__label">Executable</span>
            <div className="path-row">
              <span className="mono path-row__value" title={game.executable ?? ''}>
                {game.executable ?? 'Not chosen'}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void attempt(() => api.invoke('library:pickExecutable', { id: game.id }))}>
                Change
              </Button>
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`args-${game.id}`}>
              Launch arguments
            </label>
            <input
              id={`args-${game.id}`}
              className="input mono"
              value={args}
              placeholder="e.g. -windowed"
              onChange={(e) => setArgs(e.target.value)}
              onBlur={() => args !== argsRef.current && configure({ args })}
            />
          </div>
          <LaunchOptionsPanel game={game} />
          <SavesPanel game={game} />
          {game.kind === 'windows' && game.managed && (
            <div className="field">
              <span className="field__label">Game runtimes</span>
              <span className="field__hint">Visual C++, DirectX, OpenAL and similar installers shipped with the game are installed silently before its first start.</span>
              <div className="launch-row">
                <Button variant="ghost" size="sm" icon="retry" onClick={() => void attempt(() => api.invoke('library:resetRuntimes', { id: game.id }), 'The runtimes will be installed again before the next start.')}>Reinstall runtimes</Button>
              </div>
            </div>
          )}
          <div className="field">
            <span className="field__label">Shortcuts</span>
            <div className="launch-row">
              <Button variant="ghost" size="sm" icon="grid" onClick={() => void attempt(() => api.invoke('library:shortcut', { id: game.id, where: 'menu' }), `${game.title} is in your applications menu.`)}>Add to applications menu</Button>
              <Button variant="ghost" size="sm" icon="link" onClick={() => void attempt(() => api.invoke('library:shortcut', { id: game.id, where: 'desktop' }), `Shortcut for ${game.title} added to your desktop.`)}>Add to desktop</Button>
            </div>
          </div>
          {game.canRollback && game.update?.state !== 'updated' && (
            <div className="field">
              <span className="field__label">Previous version</span>
              <div className="path-row">
                <span className="path-row__value">{game.previousVersion} is kept until you have played the current version.</span>
                <Button variant="ghost" size="sm" icon="reload" disabled={game.running} onClick={() => void attempt(() => api.invoke('library:rollback', { id: game.id }))}>
                  Roll back
                </Button>
              </div>
            </div>
          )}
          {game.prefixDir && (
            <div className="field">
              <span className="field__label">Wine prefix</span>
              <span className="mono path-row__value">{game.prefixDir}</span>
            </div>
          )}
        </div>
      </details>

      <Dialog
        open={uninstallOpen}
        title={`Uninstall ${game.title}?`}
        onClose={() => setUninstallOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setUninstallOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={() => {
                setUninstallOpen(false);
                void attempt(() => api.invoke('library:uninstall', { id: game.id, removePrefix }), `${game.title} was removed.`);
              }}
            >
              Uninstall
            </Button>
          </>
        }
      >
        <p>
          {game.managed
            ? 'The game folder managed by the launcher will be deleted. The downloaded archive stays in Downloads until you remove it.'
            : 'This game was imported. It is removed from the Library only; its files stay where they are.'}
        </p>
        {game.prefixDir && (
          <label className="check">
            <input type="checkbox" checked={removePrefix} onChange={(e) => setRemovePrefix(e.target.checked)} />
            <span>Also delete its Wine prefix (saves and settings stored there are lost)</span>
          </label>
        )}
      </Dialog>
    </motion.section>
  );
}
