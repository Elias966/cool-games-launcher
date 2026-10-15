import { KineticTitle } from '../components/KineticTitle';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { attempt, setState, setTab, useApp } from '../state';
import { Button, Dialog, EmptyState, IconButton, ProgressRing } from '../components/ui';
import { Icon } from '../components/Icon';
import { placeholderStyle } from '../components/GameCard';
import type { DownloadItem } from '@shared/types';
import { formatBytes, formatDuration, formatSpeed } from '@shared/format';
import { useMotionPrefs } from '../hooks/useMotion';

const STATE_LABEL: Record<DownloadItem['state'], string> = {
  queued: 'Queued',
  resolving: 'Finding the file',
  'needs-user': 'Waiting for you',
  'needs-resolution': 'Finding the file again',
  active: 'Downloading',
  paused: 'Paused',
  failed: 'Failed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function DownloadsTab() {
  const downloads = useApp((s) => s.downloads);
  const groups = useMemo(() => {
    const attention = downloads.filter((d) => d.state === 'needs-user' || d.state === 'needs-resolution' || (d.state === 'paused' && d.errorCode === 'disk-full'));
    const live = downloads.filter((d) => ['active', 'queued', 'resolving'].includes(d.state) || (d.state === 'paused' && d.errorCode !== 'disk-full'));
    const done = downloads.filter((d) => d.state === 'completed');
    const failed = downloads.filter((d) => d.state === 'failed');
    return { attention, live, done, failed };
  }, [downloads]);
  const totalSpeed = downloads.filter((d) => d.state === 'active').reduce((n, d) => n + d.speedBps, 0);

  return (
    <div className="page page--downloads">
      <div className="page__scroll">
        <header className="page__header">
          <div className="page__titles">
            <p className="eyebrow">Transfers</p>
            <KineticTitle text="Downloads" />
            <p className="page__subtitle">
              {groups.live.length ? (
                <>
                  {groups.live.filter((d) => d.state === 'active').length} active · <span className="mono">{formatSpeed(totalSpeed)}</span>
                </>
              ) : (
                'The AI finds, downloads and prepares games in the background — use any tab meanwhile. Transfers resume after a restart.'
              )}
            </p>
          </div>
        </header>

        {downloads.length === 0 ? (
          <EmptyState icon="downloads" title="No downloads" action={<Button variant="primary" icon="store" onClick={() => setTab('store')}>Find games</Button>}>
            Choose Download on a game in the Store. The AI finds the file, and the transfer appears here.
          </EmptyState>
        ) : (
          <>
            <TransferMap items={[...groups.live, ...groups.attention]} />
            {groups.attention.length > 0 && <Section title="Needs attention" items={groups.attention} />}
            {groups.live.length > 0 && <Section title="Queue" items={groups.live} reorder />}
            {groups.failed.length > 0 && <Section title="Failed" items={groups.failed} />}
            {groups.done.length > 0 && <Section title="Completed" items={groups.done} />}
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
          This computer
        </text>
      </svg>
    </figure>
  );
}

function Section({ title, items, reorder }: { title: string; items: DownloadItem[]; reorder?: boolean }) {
  return (
    <section className="dl-section" aria-label={title}>
      <h2 className="section-title">
        {title} <span className="section-title__count">{items.length}</span>
      </h2>
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
          <h3 className="dl-row__title">{d.title}{d.updateFor ? <span className="dl-row__tag">Update</span> : null}{d.groupId && d.partIndex ? <span className="dl-row__tag dl-row__tag--part">Part {d.partIndex}{d.partTotal ? `/${d.partTotal}` : ''}</span> : null}</h3>
          <span className={`state-pill state-pill--${tone}`}>{d.installState === 'installing' ? 'Preparing' : STATE_LABEL[d.state]}</span>
        </div>
        <p className="dl-row__sub">
          {d.sourceHost && <span>{d.sourceHost}</span>}
          {d.fileName && <span className="mono">{d.fileName}</span>}
          {!d.resumable && d.state === 'active' && <span className="muted">not resumable</span>}
        </p>
        {(d.state === 'active' || d.state === 'paused' || d.state === 'queued') && (
          <div className="dl-row__stats mono" aria-live="off">
            <span>
              {formatBytes(d.receivedBytes)} / {formatBytes(d.totalBytes)}
            </span>
            {d.state === 'active' && <span>{formatSpeed(d.speedBps)}</span>}
            {d.state === 'active' && !!d.connections && <span>{d.connections === 1 ? 'Single connection' : `${d.connections} parallel connections`}</span>}
            {d.state === 'active' && d.etaSeconds !== null && <span>{formatDuration(d.etaSeconds)} left</span>}
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
            {formatBytes(d.totalBytes)} · {d.installState === 'installed' ? d.installDetail ?? 'In Library' : d.installState === 'installing' ? d.installDetail ?? 'Installing…' : d.installState === 'failed' ? `Install failed: ${d.installDetail}` : d.catalogId === null ? d.installDetail ?? 'Compatibility package' : 'Waiting to prepare'}
          </p>
        )}
        {(d.userPrompt || d.errorDetail) && d.state !== 'completed' && <p className={`dl-row__msg dl-row__msg--${tone}`}>{d.userPrompt?.message ?? d.errorDetail}</p>}
      </div>
      <div className="dl-row__actions">
        {d.state === 'active' && <IconButton icon="pause" label="Pause" onClick={() => call(() => api.invoke('download:pause', { id: d.id }))} />}
        {d.state === 'queued' && <IconButton icon="pause" label="Pause" onClick={() => call(() => api.invoke('download:pause', { id: d.id }))} />}
        {d.state === 'paused' && <IconButton icon="resume" label="Resume" onClick={() => call(() => api.invoke('download:resume', { id: d.id }))} />}
        {d.state === 'failed' && <IconButton icon="retry" label="Retry" onClick={() => call(() => api.invoke('download:retry', { id: d.id }))} />}
        {d.state === 'needs-user' && (
          <Button variant="primary" size="sm" icon="browser" onClick={openStore}>
            Open browser
          </Button>
        )}
        {d.state === 'needs-resolution' && (
          <Button variant="primary" size="sm" icon="retry" onClick={() => call(() => api.invoke('download:resolveAgain', { id: d.id }))}>
            Find the file again
          </Button>
        )}
        {d.catalogId !== null && d.state === 'completed' && d.installState !== 'installed' && d.installState !== 'installing' && (
          <Button variant="primary" size="sm" icon="check" onClick={() => call(() => api.invoke('download:install', { id: d.id }))}>
            Retry preparation
          </Button>
        )}
        {d.gameId !== null && d.state === 'completed' && d.installState === 'installed' && (
          <Button variant="secondary" size="sm" icon="library" onClick={() => setTab('library')}>
            Library
          </Button>
        )}
        {d.state === 'completed' && <IconButton icon="folder" label="Show file" onClick={() => call(() => api.invoke('download:reveal', { id: d.id }))} />}
        {reorder && !first && <IconButton icon="up" label="Move up" onClick={() => call(() => api.invoke('download:move', { id: d.id, direction: 'up' }))} />}
        {reorder && !last && <IconButton icon="down" label="Move down" onClick={() => call(() => api.invoke('download:move', { id: d.id, direction: 'down' }))} />}
        {d.state !== 'completed' && d.state !== 'failed' ? (
          <IconButton icon="close" label="Cancel download" onClick={() => call(() => api.invoke('download:cancel', { id: d.id }))} />
        ) : (
          <IconButton icon="trash" label="Remove from list" onClick={() => setConfirmRemove(true)} />
        )}
      </div>
      <Dialog
        open={confirmRemove}
        title="Remove this download?"
        onClose={() => setConfirmRemove(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => { setConfirmRemove(false); call(() => api.invoke('download:remove', { id: d.id, deleteFile: false })); }}>
              Remove from list
            </Button>
            {d.state === 'completed' && (
              <Button variant="danger" icon="trash" onClick={() => { setConfirmRemove(false); call(() => api.invoke('download:remove', { id: d.id, deleteFile: true })); }}>
                Delete file too
              </Button>
            )}
          </>
        }
      >
        <p>{d.state === 'completed' ? 'You can keep the downloaded file on disk or delete it. Installed games are not affected.' : 'The record of this failed download will be removed.'}</p>
      </Dialog>
    </motion.li>
  );
}
