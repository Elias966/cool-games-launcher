// Window chrome: frameless title bar, AI status, and the floating navigation dock.
import { motion } from 'motion/react';
import { api } from '../api';
import { setTab, useApp, setState } from '../state';
import { Icon, type IconName } from './Icon';
import type { TabId } from '@shared/types';
import { useMotionPrefs } from '../hooks/useMotion';

export const TABS: Array<{ id: TabId; label: string; icon: IconName; key: string }> = [
  { id: 'library', label: 'Library', icon: 'library', key: '1' },
  { id: 'store', label: 'Store', icon: 'store', key: '2' },
  { id: 'downloads', label: 'Downloads', icon: 'downloads', key: '3' },
  { id: 'settings', label: 'Settings', icon: 'settings', key: '4' },
];

const PHASE_LABEL: Record<string, string> = {
  idle: 'AI idle',
  loading: 'Loading model',
  thinking: 'AI thinking',
  navigating: 'AI browsing',
  classifying: 'Checking content',
  paused: 'Waiting for you',
};

export function AiStatusChip() {
  const ai = useApp((s) => s.ai);
  const tab = useApp((s) => s.tab);
  const active = ai.phase !== 'idle' && ai.storeActive;
  // Idle with the model loaded is "ready", not a stall.
  // Outside the Store the AI still works on downloads; only indexing pauses.
  const label = !ai.storeActive ? (tab === 'store' ? 'AI ready' : 'Indexing paused outside Store') : ai.phase === 'idle' ? (ai.modelLoaded ? 'AI ready' : 'AI idle') : PHASE_LABEL[ai.phase] ?? ai.phase;
  return (
    <div className={`ai-chip ${active ? 'is-active' : ''} phase-${ai.phase}`} role="status" aria-live="polite" title={ai.detail ?? label}>
      <span className="ai-chip__dot" aria-hidden="true" />
      <span className="ai-chip__label">{label}</span>
      {active && ai.detail && <span className="ai-chip__detail">{ai.detail}</span>}
      {ai.accel && <span className="ai-chip__accel mono">{ai.accel === 'vulkan' ? 'GPU' : 'CPU'}</span>}
    </div>
  );
}

export function TitleBar() {
  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <svg className="titlebar__logo" viewBox="0 0 32 32" aria-hidden="true">
          <defs>
            <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#48e1ff" />
              <stop offset="1" stopColor="#a084ff" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="16" r="5" fill="url(#lg)" />
          <ellipse cx="16" cy="16" rx="13" ry="5.5" fill="none" stroke="url(#lg)" strokeWidth="1.6" transform="rotate(-24 16 16)" />
        </svg>
        <span className="titlebar__name">Cool Games Launcher</span>
      </div>
      <AiStatusChip />
      <div className="titlebar__controls">
        <button className="winbtn winbtn--couch" onClick={() => setState({ couch: true })} aria-label="Couch mode (full screen, controller)" title="Couch mode — full screen, for controllers (Start / Menu)">
          <Icon name="gamepad" size={18} />
        </button>
        <button className="winbtn" onClick={() => api.windowControl('minimize')} aria-label="Minimize window">
          <Icon name="minimize" size={16} />
        </button>
        <button className="winbtn" onClick={() => api.windowControl('maximize')} aria-label="Maximize window">
          <Icon name="maximize" size={14} />
        </button>
        <button className="winbtn winbtn--close" onClick={() => api.windowControl('close')} aria-label="Close window">
          <Icon name="close" size={16} />
        </button>
      </div>
    </header>
  );
}

export function Dock() {
  const tab = useApp((s) => s.tab);
  const downloads = useApp((s) => s.downloads);
  const { reduced } = useMotionPrefs();
  const activeDownloads = downloads.filter((d) => d.state === 'active' || d.state === 'queued' || d.state === 'resolving').length;
  const needsUser = downloads.some((d) => d.state === 'needs-user' || d.state === 'needs-resolution');
  return (
    <nav className="dock" aria-label="Main">
      <div className="dock__inner" role="tablist" aria-orientation="horizontal">
        {TABS.map((t) => {
          const selected = tab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              className={`dock__tab ${selected ? 'is-selected' : ''}`}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                const i = TABS.findIndex((x) => x.id === t.id);
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
                  setTab(next.id);
                  document.getElementById(`tab-${next.id}`)?.focus();
                }
              }}
              title={`${t.label} (Ctrl+${t.key})`}
            >
              {selected && (
                <motion.span
                  layoutId="dock-indicator"
                  className="dock__indicator"
                  transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 36 }}
                />
              )}
              <span className="dock__icon">
                <Icon name={t.icon} size={21} />
                {t.id === 'downloads' && (activeDownloads > 0 || needsUser) && (
                  <span className={`dock__badge ${needsUser ? 'is-alert' : ''}`} aria-label={needsUser ? 'Needs attention' : `${activeDownloads} active`}>
                    {needsUser ? '!' : activeDownloads}
                  </span>
                )}
              </span>
              <span className="dock__label">{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
