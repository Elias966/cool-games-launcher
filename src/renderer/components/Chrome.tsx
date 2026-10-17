// Window chrome: frameless title bar, AI status, and the floating navigation dock.
import { motion } from 'motion/react';
import { api } from '../api';
import { setTab, useApp, setState } from '../state';
import { Icon, type IconName } from './Icon';
import type { TabId } from '@shared/types';
import { useMotionPrefs } from '../hooks/useMotion';
import { sound } from '../sound';
import { t, tk } from '../i18n';
import appIcon from '../assets/app-icon.png';

export const TABS: Array<{ id: TabId; label: string; icon: IconName; key: string }> = [
  { id: 'library', label: tk('Library'), icon: 'library', key: '1' },
  { id: 'store', label: tk('Store'), icon: 'store', key: '2' },
  { id: 'downloads', label: tk('Downloads'), icon: 'downloads', key: '3' },
  { id: 'settings', label: tk('Settings'), icon: 'settings', key: '4' },
];

const PHASE_LABEL: Record<string, string> = {
  idle: tk('AI idle'),
  loading: tk('Loading model'),
  thinking: tk('AI thinking'),
  navigating: tk('AI browsing'),
  classifying: tk('Checking content'),
  paused: tk('Waiting for you'),
};

export function AiStatusChip() {
  const ai = useApp((s) => s.ai);
  const tab = useApp((s) => s.tab);
  const active = ai.phase !== 'idle' && ai.storeActive;
  // Idle with the model loaded is "ready", not a stall.
  // Outside the Store the AI still works on downloads; only indexing pauses.
  const label = t(!ai.storeActive ? (tab === 'store' ? tk('AI ready') : tk('Indexing paused outside Store')) : ai.phase === 'idle' ? (ai.modelLoaded ? tk('AI ready') : tk('AI idle')) : PHASE_LABEL[ai.phase] ?? ai.phase);
  return (
    <div className={`ai-chip ${active ? 'is-active' : ''} phase-${ai.phase}`} role="status" aria-live="polite" title={ai.detail ?? label}>
      <span className="ai-chip__dot" aria-hidden="true" />
      <span className="ai-chip__label">{label}</span>
      {active && ai.detail && <span className="ai-chip__detail">{ai.detail}</span>}
      {ai.accel && <span className="ai-chip__accel mono">{ai.accel === 'vulkan' ? t('GPU') : t('CPU')}</span>}
    </div>
  );
}

/** Closes at once; with the close sound on, the launcher stays alive (hidden) until the sound ends. */
function closeWindow() {
  if (sound.play('quit', { pan: 0.6 })) api.windowControl(`close-sound:${Math.min(3000, sound.closeSoundMs())}`);
  else api.windowControl('close');
}

export function TitleBar() {
  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <img className="titlebar__logo" src={appIcon} alt="" aria-hidden="true" draggable={false} />
        <span className="titlebar__name">{t('Cool Games Launcher')}</span>
      </div>
      <AiStatusChip />
      <div className="titlebar__controls">
        <button className="winbtn winbtn--couch" onClick={() => setState({ couch: true })} aria-label={t('Couch mode (full screen, controller)')} title={t('Couch mode — full screen, for controllers (Start / Menu)')}>
          <Icon name="gamepad" size={18} />
        </button>
        <button className="winbtn" onClick={() => api.windowControl('minimize')} aria-label={t('Minimize window')}>
          <Icon name="minimize" size={16} />
        </button>
        <button className="winbtn" onClick={() => api.windowControl('maximize')} aria-label={t('Maximize window')}>
          <Icon name="maximize" size={14} />
        </button>
        <button className="winbtn winbtn--close" onClick={closeWindow} aria-label={t('Close window')}>
          <Icon name="close" size={16} />
        </button>
      </div>
    </header>
  );
}

export function Dock() {
  const tab = useApp((s) => s.tab);
  const downloads = useApp((s) => s.downloads);
  const storeJobs = useApp((s) => s.stores.jobs);
  const { reduced } = useMotionPrefs();
  const activeDownloads = downloads.filter((d) => d.state === 'active' || d.state === 'queued' || d.state === 'resolving').length + storeJobs.filter((j) => j.state === 'active' || j.state === 'queued').length;
  const needsUser = downloads.some((d) => d.state === 'needs-user' || d.state === 'needs-resolution') || storeJobs.some((j) => j.state === 'failed');
  return (
    <nav className="dock" aria-label={t('Main')}>
      <div className="dock__inner" role="tablist" aria-orientation="horizontal">
        {TABS.map((entry) => {
          const selected = tab === entry.id;
          return (
            <button
              key={entry.id}
              role="tab"
              id={`tab-${entry.id}`}
              aria-selected={selected}
              aria-controls={`panel-${entry.id}`}
              tabIndex={selected ? 0 : -1}
              className={`dock__tab ${selected ? 'is-selected' : ''}`}
              onClick={() => setTab(entry.id)}
              onKeyDown={(e) => {
                const i = TABS.findIndex((x) => x.id === entry.id);
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
                  setTab(next.id);
                  document.getElementById(`tab-${next.id}`)?.focus();
                }
              }}
              title={`${t(entry.label)} (Ctrl+${entry.key})`}
            >
              {selected && (
                <motion.span
                  layoutId="dock-indicator"
                  className="dock__indicator"
                  transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 36 }}
                />
              )}
              <span className="dock__icon">
                <Icon name={entry.icon} size={21} />
                {entry.id === 'downloads' && (activeDownloads > 0 || needsUser) && (
                  <span className={`dock__badge ${needsUser ? 'is-alert' : ''}`} aria-label={needsUser ? t('Needs attention') : t('{n} active', { n: activeDownloads })}>
                    {needsUser ? '!' : activeDownloads}
                  </span>
                )}
              </span>
              <span className="dock__label">{t(entry.label)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
