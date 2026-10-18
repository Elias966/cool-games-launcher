// Store browser drawer: shows content-filtered snapshots of the bundled
// Firefox and forwards clicks, scrolling and typing to it.
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { attempt, setState, useApp } from '../state';
import { Icon } from './Icon';
import { Button } from './ui';
import { useMotionPrefs } from '../hooks/useMotion';
import { hostOf } from '@shared/urls';
import { browserPoint } from '@shared/browser-input';
import { t, platformName } from '../i18n';

function AddressBar({ url, loading, disabled }: { url: string | null; loading: boolean; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const isPage = !!url && /^https?:/.test(url);
  const submit = () => {
    let v = value.trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
    setEditing(false);
    void attempt(() => api.invoke('browser:open', { url: v }));
  };
  if (editing || !isPage) {
    return (
      <form
        className="drawer__url is-editing"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Icon name="globe" size={14} />
        <label className="sr-only" htmlFor="drawer-address">
          {t('Web address')}</label>
        <input
          id="drawer-address"
          autoFocus={editing}
          value={value}
          placeholder={t('Enter a web address')}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => isPage && setEditing(false)}
          onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
        />
      </form>
    );
  }
  return (
    <button
      className="drawer__url"
      title={url ?? undefined}
      disabled={disabled}
      onClick={() => {
        setValue(url ?? '');
        setEditing(true);
      }}
      aria-label={t('Address: {url}. Activate to edit.', { url })}
    >
      <Icon name={url!.startsWith('https:') ? 'lock' : 'globe'} size={14} />
      <span className="drawer__host">{hostOf(url!)}</span>
      <span className="drawer__path">{url!.replace(/^https?:\/\/[^/]+/, '')}</span>
      {loading && <span className="drawer__loading" aria-label={t('Loading')} />}
    </button>
  );
}

const SPECIAL_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Delete']);

export function BrowserDrawer() {
  const browser = useApp((s) => s.browser);
  const ai = useApp((s) => s.ai);
  const prompt = useApp((s) => s.downloads.find((d) => d.state === 'needs-user' && d.userPrompt) ?? null);
  const { reduced } = useMotionPrefs();
  const surface = useRef<HTMLDivElement>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const typeBuffer = useRef('');
  const typeTimer = useRef<number | null>(null);

  const snap = browser.snapshot;
  // During website verification discovery is paused and this page is user-controlled.
  const aiDriving = ai.context === 'interactive' && (ai.phase === 'navigating' || ai.phase === 'thinking' || ai.phase === 'loading');
  const emptyPage = !!snap && !/^https?:/i.test(snap.url);
  const masked = browser.stale || !snap || snap.masked || emptyPage;

  // Keep the previous frame visible until the next one has decoded (no flicker).
  useEffect(() => {
    if (!snap?.image || browser.stale) {
      setImgSrc(null);
      return;
    }
    const img = new Image();
    let active = true;
    img.onload = () => { if (active) setImgSrc(snap.image); };
    img.onerror = () => { if (active) setImgSrc(null); };
    img.src = snap.image;
    return () => { active = false; };
  }, [snap?.image, browser.stale]);

  const flushTyping = () => {
    if (typeTimer.current) window.clearTimeout(typeTimer.current);
    typeTimer.current = null;
    const text = typeBuffer.current;
    typeBuffer.current = '';
    if (text) void attempt(() => api.invoke('browser:type', { text }));
  };

  const close = () => {
    void api.invoke('browser:close');
    setState((s) => ({ browser: { ...s.browser, open: false, snapshot: null, attention: null } }));
  };

  const rel = (e: { clientX: number; clientY: number }) => {
    const r = surface.current!.querySelector('img')?.getBoundingClientRect() ?? surface.current!.getBoundingClientRect();
    return browserPoint(e.clientX, e.clientY, r, { width: snap?.width ?? 1280, height: snap?.height ?? 800 });
  };

  const inputLocked = aiDriving || masked || !!browser.humanMode;

  return (
    <motion.aside
      className="drawer"
      aria-label={t('Store browser')}
      initial={reduced ? false : { x: '100%', opacity: 0.6 }}
      animate={{ x: 0, opacity: 1 }}
      exit={reduced ? { opacity: 0 } : { x: '100%', opacity: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 34 }}
    >
      <div className="drawer__bar">
        <div className="drawer__nav">
          <button className="icon-btn" aria-label={t('Back')} onClick={() => void attempt(() => api.invoke('browser:navigate', { action: 'back' }))} disabled={aiDriving || !!browser.humanMode}>
            <Icon name="back" size={17} />
          </button>
          <button className="icon-btn" aria-label={t('Forward')} onClick={() => void attempt(() => api.invoke('browser:navigate', { action: 'forward' }))} disabled={aiDriving || !!browser.humanMode}>
            <Icon name="forward" size={17} />
          </button>
          <button className="icon-btn" aria-label={t('Reload')} onClick={() => void attempt(() => api.invoke('browser:navigate', { action: 'reload' }))} disabled={aiDriving || !!browser.humanMode}>
            <Icon name="reload" size={16} />
          </button>
        </div>
        <AddressBar url={snap?.url ?? null} loading={!!snap?.loading} disabled={aiDriving || !!browser.humanMode} />
        <span className="drawer__ublock" title={t('uBlock Origin is active in this browser')}>
          <Icon name="shield" size={14} /> {' '}{t('uBlock')}</span>
        <button className="icon-btn" aria-label={t('Close browser')} onClick={close}>
          <Icon name="close" size={17} />
        </button>
      </div>

      <div className="drawer__prompt" role="status">
        <div className="drawer__prompt-body"><p>{browser.humanMode ? browser.automaticReturn ? t('Complete the website check in Firefox. The window hides and work resumes automatically after verification.') : t('Firefox is open for direct, full-speed browsing. AI is paused.') : t('Take control of the live Firefox page for smooth browsing and website verification. Your page and form input stay in place.')}</p></div>
        <Button variant="primary" size="sm" onClick={() => void attempt(() => api.invoke(browser.humanMode ? 'browser:humanFinish' : 'browser:humanStart'))}>
          {browser.humanMode ? t('Return control to launcher') : t('Take control of Firefox')}
        </Button>
      </div>

      {browser.attention && browser.attentionSourceId != null && !prompt && (
        <div className="drawer__prompt" role="status">
          <Icon name="alert" size={18} />
          <div className="drawer__prompt-body"><p>{browser.attention}</p><p>{t('Indexing continues by itself when the check clears, or skip this page and keep going.')}</p></div>
          <Button variant="primary" size="sm" onClick={() => void attempt(async () => {
            await api.invoke('sources:resume', { id: browser.attentionSourceId! });
            setState((s) => ({ browser: { ...s.browser, attention: null, attentionSourceId: null } }));
          })}>{t('Resume discovery')}</Button>
          <Button variant="ghost" size="sm" onClick={() => void attempt(async () => {
            await api.invoke('sources:skipCheck', { id: browser.attentionSourceId! });
            setState((s) => ({ browser: { ...s.browser, attention: null, attentionSourceId: null } }));
          })}>{t('Skip this page')}</Button>
        </div>
      )}

      {prompt?.userPrompt && (
        <div className={`drawer__prompt drawer__prompt--${prompt.userPrompt.kind}`} role="alert">
          <Icon name={prompt.userPrompt.kind === 'choose-file' ? 'downloads' : 'alert'} size={18} />
          <div className="drawer__prompt-body">
            <p>
              <strong>{prompt.title}:</strong> {prompt.userPrompt.message}
            </p>
            {prompt.userPrompt.choices && (
              <ul className="drawer__choices">
                {prompt.userPrompt.choices.map((c) => (
                  <li key={c.url}>
                    <button className="choice" onClick={() => void attempt(() => api.invoke('download:chooseFile', { id: prompt.id, url: c.url }))}>
                      <span className="choice__name">{c.fileName ?? c.label}</span>
                      <span className="choice__meta">
                        {c.platform ? platformName(c.platform) : t('Unknown platform')}
                        {c.sizeText ? ` · ${c.sizeText}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {prompt.userPrompt.kind !== 'choose-file' && (
            <div className="drawer__prompt-actions">
              <Button variant="primary" size="sm" onClick={() => void attempt(() => api.invoke('download:continueResolution', { id: prompt.id }))}>
                {t('Continue')}</Button>
              <Button variant="ghost" size="sm" onClick={() => void attempt(() => api.invoke('download:cancel', { id: prompt.id }))}>
                {t('Cancel download')}</Button>
            </div>
          )}
        </div>
      )}

      <div
        ref={surface}
        className={`drawer__surface ${focused ? 'is-focused' : ''} ${inputLocked ? 'is-locked' : ''}`}
        tabIndex={0}
        role="application"
        aria-label={masked ? t('Page preview hidden') : t('Web page: {title}. Click to interact; typing is sent to the page.', { title: snap?.title ?? '' })}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          flushTyping();
        }}
        onMouseDown={(e) => {
          if (inputLocked || !surface.current) return;
          e.preventDefault();
          surface.current.focus();
          flushTyping();
          const p = rel(e);
          if (!p) return;
          const button = e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left';
          void attempt(() => api.invoke('browser:click', { ...p, button }));
        }}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => {
          if (inputLocked) return;
          const p = rel(e);
          if (!p) return;
          void api.invoke('browser:scroll', { ...p, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) }).catch(() => undefined);
        }}
        onKeyDown={(e) => {
          if (inputLocked) return;
          if (e.key === 'Escape') {
            surface.current?.blur();
            return;
          }
          if (e.ctrlKey || e.altKey || e.metaKey) return;
          if (SPECIAL_KEYS.has(e.key)) {
            e.preventDefault();
            flushTyping();
            void attempt(() => api.invoke('browser:key', { key: e.key as never }));
          } else if (e.key.length === 1) {
            e.preventDefault();
            typeBuffer.current += e.key;
            if (typeTimer.current) window.clearTimeout(typeTimer.current);
            typeTimer.current = window.setTimeout(flushTyping, 160);
          }
        }}
      >
        {imgSrc && !masked && !browser.humanMode && <img src={imgSrc} alt="" draggable={false} className="drawer__frame" />}
        {(masked || browser.humanMode) && (
          <div className="drawer__mask">
            <Icon name="eyeOff" size={34} />
            <p className="drawer__mask-title">{browser.humanMode ? t('Use the Firefox window, then return here') : !snap ? t('Opening the page…') : browser.stale ? t('Re-checking the page for your content settings…') : emptyPage ? t('Enter a website address to start browsing') : t('Preview hidden')}</p>
            {snap?.masked && snap.maskReason && <p className="drawer__mask-reason">{snap.maskReason}</p>}
          </div>
        )}
        {aiDriving && (
          <div className="drawer__ai" role="status">
            <span className="drawer__ai-orbit" aria-hidden="true" />
            <span>{ai.detail ?? t('The AI is navigating…')}</span>
          </div>
        )}
      </div>
      <p className="drawer__hint">
        <Icon name="keyboard" size={14} /> {' '}{t('Click the page to interact. Typing goes to the page; Esc returns focus to the launcher. The AI can only navigate — it never purchases, signs in, or touches your files.')}</p>
    </motion.aside>
  );
}
