import { KineticTitle } from '../components/KineticTitle';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { attempt, setState, setTab, useApp } from '../state';
import { Button, Dialog, EmptyState, IconButton, ProgressRing } from '../components/ui';
import { Icon } from '../components/Icon';
import { placeholderStyle } from '../components/GameCard';
import type { DownloadItem, StoreJob } from '@shared/types';
import { formatBytes, formatSpeed } from '@shared/format';
import { useMotionPrefs } from '../hooks/useMotion';
import { duration, t, tk, locale } from '../i18n';

const STATE_LABEL: Record<DownloadItem['state'], string> = {
  queued: tk('Queued'),
  resolving: tk('Finding the file'),
  'needs-user': tk('Waiting for you'),
  'needs-resolution': tk('Finding the file again'),
  active: tk('Downloading'),
  paused: tk('Paused'),
  failed: tk('Failed'),
  completed: tk('Completed'),
  cancelled: tk('Cancelled'),
};

export function DownloadsTab() {
  const downloads = useApp((s) => s.downloads);
  const storeJobs = useApp((s) => s.stores.jobs);
  const groups = useMemo(() => {
    const attention = downloads.filter((d) => d.state === 'needs-user' || d.state === 'needs-resolution' || (d.state === 'paused' && d.errorCode === 'disk-full'));
    const live = downloads.filter((d) => ['active', 'queued', 'resolving'].includes(d.state) || (d.state === 'paused' && d.errorCode !== 'disk-full'));
    const done = downloads.filter((d) => d.state === 'completed');
    const failed = downloads.filter((d) => d.state === 'failed');
    const cancelled = downloads.filter((d) => d.state === 'cancelled');
    return { attention, live, done, failed, cancelled };
  }, [downloads]);
  const totalSpeed = downloads.filter((d) => d.state === 'active').reduce((n, d) => n + d.speedBps, 0) + storeJobs.filter((j) => j.state === 'active').reduce((n, j) => n + j.speedBps, 0);

  return (
    <div className="page page--downloads">
      <div className="page__scroll">
        <header className="page__header">
          <div className="page__titles">
            <p className="eyebrow">{t('Transfers')}</p>
            <KineticTitle text={t('Downloads')} />
            <p className="page__subtitle">
              {groups.live.length || storeJobs.some((j) => ['active', 'queued'].includes(j.state)) ? (
                <>
                  {t('{n} active ·', { n: groups.live.filter((d) => d.state === 'active').length + storeJobs.filter((j) => j.state === 'active').length })}{' '}<span className="mono">{formatSpeed(totalSpeed)}</span>
                </>
              ) : (
                t('The AI finds, downloads and prepares games in the background — use any tab meanwhile. Transfers resume after a restart.')
              )}
            </p>
          </div>
        </header>

        {downloads.length === 0 && storeJobs.length === 0 ? (
          <EmptyState icon="downloads" title={t('No downloads')} action={<Button variant="primary" icon="store" onClick={() => setTab('store')}>{t('Find games')}</Button>}>
            {t('Choose Download on a game in the Store. The AI finds the file, and the transfer appears here.')}</EmptyState>
        ) : (
          <>
            <StoreTransfers jobs={storeJobs} />
            <TransferMap items={[...groups.live, ...groups.attention]} />
            {groups.attention.length > 0 && <Section title={t('Needs attention')} items={groups.attention} />}
            {groups.live.length > 0 && <Section title={t('Queue')} items={groups.live} reorder />}
            {groups.failed.length > 0 && <Section title={t('Failed')} items={groups.failed} clear="failed" />}
            {groups.cancelled.length > 0 && <Section title={t('Cancelled')} items={groups.cancelled} />}
            {groups.done.length > 0 && <Section title={t('Completed')} items={groups.done} clear="completed" />}
          </>
        )}
      </div>
    </div>
  );
}

/** Animated paths from each source host into the local machine. Purely visual; numbers live in the rows. */
function TransferMap({ items }: { items: DownloadItem[] }) {
  const { animate, low } = useMotionPrefs();
  const hosts = useMemo(() => {
    const m = new Map<string, { speed: number; count: number }>();
    for (const d of items) {
      const h = d.sourceHost ?? 'web';
      const cur = m.get(h) ?? { speed: 0, count: 0 };
      cur.speed += d.state === 'active' ? d.speedBps : 0;
      cur.count++;
      m.set(h, cur);
    }
    return [...m.entries()].slice(0, 6);
  }, [items]);
  if (!hosts.length) return null;
  const W = 900;
  const H = Math.max(150, hosts.length * 46 + 40);
  const cx = W - 120;
  const cy = H / 2;
  return (
    <figure className="transfer-map" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="tm-line" x1="0" x2="1">
            <stop offset="0" stopColor="#a084ff" stopOpacity="0.2" />
            <stop offset="1" stopColor="#48e1ff" stopOpacity="0.9" />
          </linearGradient>
          <radialGradient id="tm-core">
            <stop offset="0" stopColor="#bff4ff" />
            <stop offset="0.45" stopColor="#48e1ff" stopOpacity="0.6" />
            <stop offset="1" stopColor="#48e1ff" stopOpacity="0" />
          </radialGradient>
        </defs>
        {hosts.map(([host, h], i) => {
          const y = 30 + i * ((H - 60) / Math.max(1, hosts.length - 1 || 1));
          const sy = hosts.length === 1 ? cy : y;
          const path = `M 150 ${sy} C ${W * 0.45} ${sy}, ${W * 0.55} ${cy}, ${cx - 26} ${cy}`;
          const active = h.speed > 0;
          const dur = active ? Math.max(0.6, 3.2 - Math.log10(1 + h.speed / 1e5)) : 0;
          return (
            <g key={host}>
              <path d={path} className="tm-path" stroke="url(#tm-line)" />
              {active && animate && !low && <path d={path} className="tm-packets" style={{ animationDuration: `${dur}s` }} />}
              <circle cx={150} cy={sy} r={6} className={`tm-node ${active ? 'is-active' : ''}`} />
              <text x={136} y={sy + 4} textAnchor="end" className="tm-label">
                {host}
              </text>
            </g>
          );
        })}
        <circle cx={cx} cy={cy} r={46} fill="url(#tm-core)" opacity={0.5} />
        <circle cx={cx} cy={cy} r={20} className="tm-core" />
        <text x={cx} y={cy + 44} textAnchor="middle" className="tm-label tm-label--core">
          {t('This computer')}</text>
      </svg>
    </figure>
  );
}

function Section({ title, items, reorder, clear }: { title: string; items: DownloadItem[]; reorder?: boolean; clear?: 'completed' | 'failed' }) {
  const [clearing, setClearing] = useState(false);
  return (
    <section className="dl-section" aria-label={title}>
      <div className="section-head">
        <h2 className="section-title">
          {title} <span className="section-title__count">{items.length}</span>
        </h2>
        {clear && <Button size="sm" variant="ghost" icon="trash" onClick={() => setClearing(true)}>{t('Clear')}</Button>}
      </div>
      {clear && <ClearHistoryDialog which={clear} open={clearing} onClose={() => setClearing(false)} />}
      <ul className="dl-list">
        <AnimatePresence initial={false}>
          {items.map((d, i) => (
            <DownloadRow key={d.id} d={d} first={i === 0} last={i === items.length - 1} reorder={reorder} />
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

/** Clears finished downloads from the list in one go, optionally with their files. */
function ClearHistoryDialog({ which, open, onClose }: { which: 'completed' | 'failed'; open: boolean; onClose: () => void }) {
  const [size, setSize] = useState<{ entries: number; bytes: number } | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  useEffect(() => {
    if (!open) return;
    setSize(null);
    setDeleteFiles(false);
    void api.invoke('download:historySize', { which }).then(setSize).catch(() => setSize({ entries: 0, bytes: 0 }));
  }, [open, which]);
  const n = size?.entries ?? 0;
  const clear = () => {
    onClose();
    void attempt(async () => {
      const r = await api.invoke('download:clearHistory', { which, deleteFiles });
      return r;
    }, n === 1 ? t('1 download cleared from the list.') : t('{n} downloads cleared from the list.', { n }));
  };
  return (
    <Dialog
      open={open}
      title={which === 'completed' ? t('Clear completed downloads?') : t('Clear failed downloads?')}
      onClose={onClose}
      actions={<>
        <Button variant="secondary" onClick={onClose}>{t('Cancel')}</Button>
        <Button variant={deleteFiles ? 'danger' : 'primary'} icon="trash" disabled={!n} onClick={clear}>{t('Clear')}</Button>
      </>}
    >
      {size === null ? <p>{t('Loading…')}</p> : !n ? (
        <p>{t('Nothing to clear yet. Downloads that are still being prepared, and the AI model, stay in the list.')}</p>
      ) : (
        <>
          <p>{which === 'completed'
            ? (n === 1 ? t('1 finished download leaves the list. Installed games are not affected.') : t('{n} finished downloads leave the list. Installed games are not affected.', { n }))
            : (n === 1 ? t('1 failed download leaves the list.') : t('{n} failed downloads leave the list.', { n }))}</p>
          {which === 'completed' && size.bytes > 0 && (
            <label className="check">
              <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
              <span>{t('Also delete their downloaded files ({size}) from the downloads folder. Otherwise the files stay there.', { size: formatBytes(size.bytes) })}</span>
            </label>
          )}
        </>
      )}
    </Dialog>
  );
}

function DownloadRow({ d, first, last, reorder }: { d: DownloadItem; first: boolean; last: boolean; reorder?: boolean }) {
  const { reduced } = useMotionPrefs();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const pct = d.totalBytes ? d.receivedBytes / d.totalBytes : null;
  const tone = d.state === 'failed' ? 'danger' : d.state === 'completed' ? 'ok' : d.state === 'needs-user' || d.state === 'needs-resolution' || d.errorCode === 'disk-full' ? 'warn' : d.state === 'paused' ? 'violet' : 'cyan';
  const call = (fn: () => Promise<unknown>) => void attempt(fn);
  const openStore = () => {
    setTab('store');
    setState((s) => ({ browser: { ...s.browser, open: true } }));
    void api.invoke('browser:show').catch(() => undefined);
  };

  return (
    <motion.li
      layout={!reduced}
      className={`dl-row dl-row--${d.state}`}
      initial={reduced ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: -20 }}
      transition={{ duration: reduced ? 0 : 0.25 }}
    >
      <div className="dl-row__visual">
        <ProgressRing value={d.state === 'completed' ? 1 : pct} indeterminate={d.state === 'resolving' || (d.state === 'active' && pct === null) || d.state === 'queued'} size={58} stroke={4} tone={tone}>
          <span className="dl-row__thumb" style={d.artwork ? undefined : placeholderStyle(d.title)}>
            {d.artwork ? <img src={d.artwork} alt="" /> : <Icon name="downloads" size={16} />}
          </span>
        </ProgressRing>
      </div>
      <div className="dl-row__main">
        <div className="dl-row__head">
          <h3 className="dl-row__title">{d.title}</h3>{d.updateFor ? <span className="dl-row__tag">{t('Update')}</span> : null}{d.groupId && d.partIndex ? <span className="dl-row__tag dl-row__tag--part">{t('Part')}{' '}{d.partIndex}{d.partTotal ? `/${d.partTotal}` : ''}</span> : null}
          <span className={`state-pill state-pill--${tone}`}>{d.installState === 'installing' ? t('Preparing') : t(STATE_LABEL[d.state])}</span>
        </div>
        <p className="dl-row__sub">
          {d.sourceHost && <span>{d.sourceHost}</span>}
          {d.fileName && <span className="mono">{d.fileName}</span>}
          {!d.resumable && d.state === 'active' && <span className="muted">{t('not resumable')}</span>}
        </p>
        {(d.state === 'active' || d.state === 'paused' || d.state === 'queued') && (
          <div className="dl-row__stats mono" aria-live="off">
            <span>
              {formatBytes(d.receivedBytes)} / {formatBytes(d.totalBytes)}
            </span>
            {d.state === 'active' && <span>{formatSpeed(d.speedBps)}</span>}
            {d.state === 'active' && !!d.connections && <span>{d.connections === 1 ? t('Single connection') : t('{n} parallel connections', { n: d.connections })}</span>}
            {d.state === 'active' && d.etaSeconds !== null && <span>{t('{time} left', { time: duration(d.etaSeconds) })}</span>}
            {pct !== null && <span>{Math.round(pct * 100)}%</span>}
          </div>
        )}
        {d.state === 'active' && (
          <div className="bar" role="progressbar" aria-label={`${d.title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct !== null ? Math.round(pct * 100) : undefined}>
            <span style={{ width: pct !== null ? `${pct * 100}%` : '30%' }} className={pct === null ? 'is-indeterminate' : ''} />
          </div>
        )}
        {d.state === 'completed' && (
          <p className="dl-row__sub mono">
            {formatBytes(d.totalBytes)} · {d.installState === 'installed' ? d.installDetail ?? t('In Library') : d.installState === 'installing' ? d.installDetail ?? t('Installing…') : d.installState === 'failed' ? t('Install failed: {detail}', { detail: d.installDetail ?? '' }) : d.catalogId === null ? d.installDetail ?? t('Compatibility package') : t('Waiting to prepare')}
          </p>
        )}
        {d.mirrorChoice && <p className="dl-row__sub">{t('Fastest tested host: {host} · {speed} ({n} mirrors)', { host: d.mirrorChoice.host, speed: formatSpeed(d.mirrorChoice.speedBps), n: d.mirrorChoice.tested })}</p>}
        {(d.userPrompt || d.errorDetail) && d.state !== 'completed' && <p className={`dl-row__msg dl-row__msg--${tone}`}>{d.userPrompt?.message ?? d.errorDetail}</p>}
      </div>
      <div className="dl-row__actions">
        {d.state === 'active' && <IconButton icon="pause" label={t('Pause')} onClick={() => call(() => api.invoke('download:pause', { id: d.id }))} />}
        {d.state === 'queued' && <IconButton icon="pause" label={t('Pause')} onClick={() => call(() => api.invoke('download:pause', { id: d.id }))} />}
        {d.state === 'paused' && <IconButton icon="resume" label={t('Resume')} onClick={() => call(() => api.invoke('download:resume', { id: d.id }))} />}
        {d.state === 'failed' && <IconButton icon="retry" label={t('Retry')} onClick={() => call(() => api.invoke('download:retry', { id: d.id }))} />}
        {(d.state === 'failed' || d.installState === 'failed') && <IconButton icon="info" label={t('Create a diagnostics file for this problem')} onClick={() => call(() => api.invoke('app:diagnostics'))} />}
        {d.state === 'needs-user' && (
          <Button variant="primary" size="sm" icon="browser" onClick={openStore}>
            {t('Open browser')}</Button>
        )}
        {d.state === 'needs-resolution' && (
          <Button variant="primary" size="sm" icon="retry" onClick={() => call(() => api.invoke('download:resolveAgain', { id: d.id }))}>
            {t('Find the file again')}</Button>
        )}
        {d.catalogId !== null && d.state === 'completed' && d.installState !== 'installed' && d.installState !== 'installing' && (
          <Button variant="primary" size="sm" icon="check" onClick={() => call(() => api.invoke('download:install', { id: d.id }))}>
            {t('Retry preparation')}</Button>
        )}
        {d.gameId !== null && d.state === 'completed' && d.installState === 'installed' && (
          <Button variant="secondary" size="sm" icon="library" onClick={() => setTab('library')}>
            {t('Library')}</Button>
        )}
        {d.state === 'completed' && <IconButton icon="folder" label={t('Show file')} onClick={() => call(() => api.invoke('download:reveal', { id: d.id }))} />}
        {reorder && !first && <IconButton icon="up" label={t('Move up')} onClick={() => call(() => api.invoke('download:move', { id: d.id, direction: 'up' }))} />}
        {reorder && !last && <IconButton icon="down" label={t('Move down')} onClick={() => call(() => api.invoke('download:move', { id: d.id, direction: 'down' }))} />}
        {d.state !== 'completed' && d.state !== 'failed' && d.state !== 'cancelled' ? (
          <IconButton icon="close" label={t('Cancel download')} onClick={() => call(() => api.invoke('download:cancel', { id: d.id }))} />
        ) : (
          <IconButton icon="trash" label={t('Remove from list')} onClick={() => setConfirmRemove(true)} />
        )}
      </div>
      <Dialog
        open={confirmRemove}
        title={t('Remove this download?')}
        onClose={() => setConfirmRemove(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmRemove(false)}>
              {t('Cancel')}</Button>
            <Button variant="secondary" onClick={() => { setConfirmRemove(false); call(() => api.invoke('download:remove', { id: d.id, deleteFile: false })); }}>
              {t('Remove from list')}</Button>
            {d.state === 'completed' && (
              <Button variant="danger" icon="trash" onClick={() => { setConfirmRemove(false); call(() => api.invoke('download:remove', { id: d.id, deleteFile: true })); }}>
                {t('Delete file too')}</Button>
            )}
          </>
        }
      >
        <p>{d.state === 'completed' ? t('You can keep the downloaded file on disk or delete it. Installed games are not affected.') : t('The record of this failed download will be removed.')}</p>
      </Dialog>
    </motion.li>
  );
}

/** Store clients own their chunk checkpoints; their durable jobs share Downloads. */
function StoreTransfers({ jobs }: { jobs: StoreJob[] }) {
  if (!jobs.length) return null;
  return <section className="dl-section" aria-label="GOG · Epic">
    <div className="section-head"><h2 className="section-title">GOG · Epic <span className="section-title__count">{jobs.length}</span></h2></div>
    <ul className="dl-list">{jobs.map((j) => <StoreDownloadRow key={`${j.store}:${j.id}`} job={j} />)}</ul>
  </section>;
}

function StoreDownloadRow({ job: j }: { job: StoreJob }) {
  const tone = j.state === 'failed' ? 'danger' : j.state === 'completed' ? 'ok' : j.state === 'paused' ? 'violet' : 'cyan';
  const call = (channel: 'stores:pause' | 'stores:resume' | 'stores:cancel' | 'stores:remove') => void attempt(() => api.invoke(channel, { store: j.store, id: j.id }));
  return <li className={`dl-row dl-row--${j.state}`}>
    <div className="dl-row__visual"><ProgressRing value={j.progress} indeterminate={j.state === 'active' && j.progress === null} size={58} tone={tone}><Icon name="downloads" size={20} /></ProgressRing></div>
    <div className="dl-row__main">
      <div className="dl-row__head">
        <h3 className="dl-row__title">{j.title}</h3>
        {j.kind === 'update' && <span className="dl-row__tag">{t('Update')}</span>}
        <span className={`state-pill state-pill--${tone}`}>{t(STATE_LABEL[j.state])}</span>
      </div>
      <p className="dl-row__sub">{j.store === 'gog' ? 'GOG' : 'Epic'}</p>
      <div className="dl-row__stats mono">
        {j.progress !== null && <span>{Math.round(j.progress * 100)}%</span>}
        {j.receivedBytes > 0 && <span>{formatBytes(j.receivedBytes)}{j.totalBytes ? ` / ${formatBytes(j.totalBytes)}` : ''}</span>}
        {j.state === 'active' && <span>{formatSpeed(j.speedBps)}</span>}
        {j.state === 'active' && <span>{j.workers === 1 ? t('Single connection') : t('Up to {n} parallel downloads', { n: j.workers })}</span>}
      </div>
      {j.state === 'active' && <div className="bar" role="progressbar" aria-label={j.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={j.progress === null ? undefined : Math.round(j.progress * 100)}><span className={j.progress === null ? 'is-indeterminate' : ''} style={{ width: `${j.progress === null ? 30 : j.progress * 100}%` }} /></div>}
      {j.detail && <p className="dl-row__msg dl-row__msg--danger">{j.detail}</p>}
    </div>
    <div className="dl-row__actions">
      {['active', 'queued'].includes(j.state) && <IconButton icon="pause" label={t('Pause')} onClick={() => call('stores:pause')} />}
      {j.state === 'paused' && <Button size="sm" variant="primary" icon="resume" onClick={() => call('stores:resume')}>{t('Resume')}</Button>}
      {j.state === 'failed' && <Button size="sm" icon="retry" onClick={() => call('stores:resume')}>{t('Retry')}</Button>}
      {['active', 'queued', 'paused'].includes(j.state) && <IconButton icon="close" label={t('Cancel download')} onClick={() => call('stores:cancel')} />}
      {j.state === 'completed' && <Button size="sm" icon="library" onClick={() => setTab('library')}>{t('Library')}</Button>}
      {['completed', 'failed', 'cancelled'].includes(j.state) && <IconButton icon="trash" label={t('Remove from list')} onClick={() => call('stores:remove')} />}
    </div>
  </li>;
}
