import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { Component, Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { boot, pushToast, setState, setTab, useApp } from './state';
import { Dock, TABS, TitleBar } from './components/Chrome';
import { Toasts } from './components/ui';
import { useMotionAttributes, useMotionPrefs } from './hooks/useMotion';
import { attachInterfaceSounds, sound } from './sound';
import { emitScene } from './scene/events';
import { CouchMode } from './components/CouchMode';
import { moveFocus, onPad, startGamepad } from './gamepad';
import { StoreTab } from './tabs/StoreTab';
import { LibraryTab } from './tabs/LibraryTab';
import { DownloadsTab } from './tabs/DownloadsTab';
import { SettingsTab } from './tabs/SettingsTab';
import { language, setLanguage, t } from './i18n';

const OrbitalScene = lazy(() => import('./scene/OrbitalScene').then((m) => ({ default: m.OrbitalScene })));

// Decorative WebGL must never take the controls down on unsupported GPUs.
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? null : this.props.children; }
}

/** Whether this GPU/driver offers WebGL 2 (headless or blocklisted GPUs do not). */
function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const ok = !!c.getContext('webgl2'); // three.js needs WebGL 2
    c.width = c.height = 0;
    return ok;
  } catch {
    return false;
  }
}
const WEBGL = webglAvailable();

const ACTIVITY: Record<string, number> = { idle: 0, loading: 0.5, thinking: 1, navigating: 0.6, classifying: 0.4, paused: 0.2 };

export function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tab = useApp((s) => s.tab);
  const ai = useApp((s) => s.ai);
  const downloads = useApp((s) => s.downloads);
  const appVisible = useApp((s) => s.appVisible);
  const { reduced, low, animate } = useMotionPrefs();
  useMotionAttributes();

  useEffect(() => {
    boot()
      .then(() => setReady(true))
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.altKey) && !e.shiftKey) {
        const hit = TABS.find((x) => x.key === e.key);
        if (hit) {
          e.preventDefault();
          setTab(hit.id);
          document.getElementById(`tab-${hit.id}`)?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Interface sounds follow the user's setting; one delegated listener covers every control.
  // Applied during render so every text below is drawn in the chosen language.
  const lang = useApp((s) => s.settings?.language ?? 'en');
  if (language() !== lang) setLanguage(lang);
  const uiSounds = useApp((s) => s.settings?.uiSounds ?? true);
  const uiVolume = useApp((s) => s.settings?.uiVolume ?? 0.5);
  const uiSoundGroups = useApp((s) => s.settings?.uiSoundGroups);
  useEffect(() => sound.configure(uiSounds, uiVolume, uiSoundGroups), [uiSounds, uiVolume, uiSoundGroups]);
  // While a game runs, the 3D scene stops drawing.
  const gaming = useApp((s) => s.library.some((g) => g.running));
  useEffect(() => attachInterfaceSounds(), []);
  const firstTab = useRef(true);
  useEffect(() => {
    if (firstTab.current) { firstTab.current = false; return; }
    sound.play('warp');
  }, [tab]);
  const toasts = useApp((s) => s.toasts);
  const lastToast = useRef(0);
  useEffect(() => {
    const t = toasts.at(-1);
    if (!t || t.id === lastToast.current) return;
    lastToast.current = t.id;
    sound.play(t.kind === 'success' ? 'success' : t.kind === 'error' ? 'error' : 'notify');
    if (t.kind === 'success') emitScene('burst');
  }, [toasts]);
  const downloadIds = useRef<Set<number> | null>(null);
  useEffect(() => {
    const ids = new Set(downloads.map((d) => d.id));
    if (downloadIds.current && downloads.some((d) => !downloadIds.current!.has(d.id))) { sound.play('download'); emitScene('shockwave'); }
    downloadIds.current = ids;
  }, [downloads]);

  // Cursor spotlight, throttled to animation frames. The position lives on the
  // spotlight itself: a variable on the root would restyle the whole page per move.
  const spotlight = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reduced || low) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        spotlight.current?.style.setProperty('--sx', `${e.clientX}px`);
        spotlight.current?.style.setProperty('--sy', `${e.clientY}px`);
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { window.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, [reduced, low]);

  // Controllers: Start/Menu toggles couch mode; elsewhere the pad moves focus like arrow keys.
  const couch = useApp((s) => s.couch);
  useEffect(() => {
    let hinted = false;
    const stop = startGamepad(() => {
      if (hinted) return;
      hinted = true;
      pushToast('info', t('Controller connected — press Start (Menu) for couch mode.'));
    });
    const off = onPad((a) => {
      if (a === 'menu') { setState((s) => ({ couch: !s.couch })); return true; }
      if (a === 'up' || a === 'down' || a === 'left' || a === 'right') { moveFocus(a); return true; }
      if (a === 'accept') { (document.activeElement as HTMLElement | null)?.click(); return true; }
      if (a === 'back') { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; }
      return false;
    });
    return () => { stop(); off(); };
  }, []);

  // While a page scrolls, glass panels floating over it drop their live blur
  // (re-blurring moving content every frame is the most expensive effect).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const root = document.documentElement;
    const onScroll = () => {
      if (!timer) root.classList.add('is-scrolling');
      else clearTimeout(timer);
      timer = setTimeout(() => { timer = null; root.classList.remove('is-scrolling'); }, 160);
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => { window.removeEventListener('scroll', onScroll, { capture: true }); if (timer) clearTimeout(timer); };
  }, []);

  const flow = useMemo(() => {
    const bps = downloads.filter((d) => d.state === 'active').reduce((n, d) => n + d.speedBps, 0);
    return Math.min(1, bps / (25 * 1024 * 1024));
  }, [downloads]);

  const activity = ai.storeActive ? (ACTIVITY[ai.phase] ?? 0) : 0;

  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <div className="app">
        <div className="atmosphere" aria-hidden="true" />
        {WEBGL && (
          <SceneBoundary>
            <Suspense fallback={null}>
              <OrbitalScene tab={tab} activity={activity} flow={flow} animate={animate} low={low} visible={appVisible && !gaming} />
            </Suspense>
          </SceneBoundary>
        )}
        <div className="vignette" aria-hidden="true" />
        <div className="spotlight" aria-hidden="true" ref={spotlight} />
        <Fragment key={lang}>
        <TitleBar />
        <main className="stage">
          {error ? (
            <div className="boot-error" role="alert">
              <h1>{t('Something went wrong while starting')}</h1>
              <p>{error}</p>
            </div>
          ) : !ready ? (
            <div className="boot" role="status" aria-label={t('Starting')}>
              <span className="boot__orbit" />
            </div>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab}
                id={`panel-${tab}`}
                role="tabpanel"
                aria-labelledby={`tab-${tab}`}
                className="panel"
                style={{ transformPerspective: 1400 }}
                initial={reduced ? false : { opacity: 0, y: 26, scale: 0.975, rotateX: 4, filter: low ? 'none' : 'blur(10px)' }}
                animate={{ opacity: 1, y: 0, scale: 1, rotateX: 0, filter: 'blur(0px)' }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, y: -16, scale: 1.015, filter: low ? 'none' : 'blur(8px)' }}
                transition={{ duration: reduced ? 0 : 0.45, ease: [0.16, 1, 0.3, 1] }}
              >
                {tab === 'store' && <StoreTab />}
                {tab === 'library' && <LibraryTab />}
                {tab === 'downloads' && <DownloadsTab />}
                {tab === 'settings' && <SettingsTab />}
              </motion.div>
            </AnimatePresence>
          )}
        </main>
        <Dock />
        {couch && ready && <CouchMode />}
        <Toasts />
        </Fragment>
      </div>
    </MotionConfig>
  );
}
