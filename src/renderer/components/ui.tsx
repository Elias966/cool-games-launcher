// Shared UI primitives: dialog, toggle, progress ring, badges, toasts.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dismissToast, useApp } from '../state';
import { Icon, type IconName } from './Icon';
import { useMotionPrefs } from '../hooks/useMotion';
import { platformLabel } from '@shared/format';
import type { Platform } from '@shared/types';
import { t } from '../i18n';

/** Accessible modal dialog with focus trap; Escape cancels. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
  tone = 'default',
  initialFocus,
  labelledBy,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
  tone?: 'default' | 'warning';
  initialFocus?: string;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { reduced } = useMotionPrefs();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = (initialFocus && ref.current?.querySelector<HTMLElement>(initialFocus)) || ref.current?.querySelector<HTMLElement>('button, [href], input, select, textarea');
      el?.focus();
    }, 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && ref.current) {
        const focusables = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose, initialFocus]);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.18 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy ?? titleId}
            className={`dialog dialog--${tone}`}
            initial={reduced ? false : { opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: reduced ? 0 : 0.26, ease: [0.16, 1, 0.3, 1] }}
          >
            <h2 id={titleId} className="dialog__title">
              {title}
            </h2>
            <div className="dialog__body">{children}</div>
            <div className="dialog__actions">{actions}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Renders overlays at the document root so transformed tab panels never become their containing block. */
export function Overlay({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className={`field field--toggle ${disabled ? 'is-disabled' : ''}`}>
      <div className="field__text">
        <label htmlFor={id} className="field__label">
          {label}
        </label>
        {description && (
          <p className="field__desc" id={`${id}-desc`}>
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-desc` : undefined}
        className={`switch ${checked ? 'is-on' : ''}`}
        onClick={() => onChange(!checked)}
        disabled={disabled}
      >
        <span className="switch__thumb" />
      </button>
    </div>
  );
}

export function ProgressRing({ value, size = 56, stroke = 4, indeterminate, children, tone = 'cyan' }: { value: number | null; size?: number; stroke?: number; indeterminate?: boolean; children?: ReactNode; tone?: 'cyan' | 'violet' | 'warn' | 'ok' | 'danger' }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value === null ? 0.25 : Math.max(0, Math.min(1, value));
  const gid = useId();
  return (
    <div className={`ring ring--${tone} ${indeterminate || value === null ? 'is-indeterminate' : ''}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--ring-a)" />
            <stop offset="1" stopColor="var(--ring-b)" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} className="ring__track" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="ring__value"
          strokeWidth={stroke}
          fill="none"
          stroke={`url(#${gid})`}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children && <div className="ring__content">{children}</div>}
    </div>
  );
}

export function NsfwBadge({ small }: { small?: boolean }) {
  return (
    <span className={`badge badge--nsfw ${small ? 'badge--sm' : ''}`} title={t('Adult content')}>
      {t('NSFW')}</span>
  );
}

const PLATFORM_ICON: Record<Platform, IconName> = { linux: 'linux', windows: 'windows', macos: 'macos', android: 'android', web: 'web' };

export function PlatformIcons({ platforms, size = 15 }: { platforms: Platform[]; size?: number }) {
  if (!platforms.length) return null;
  return (
    <span className="platforms" aria-label={t('Platforms: {list}', { list: platforms.map(platformLabel).join(', ') })}>
      {platforms.map((p) => (
        <span key={p} className={`platforms__item platforms__item--${p}`} title={platformLabel(p)}>
          <Icon name={PLATFORM_ICON[p]} size={size} />
        </span>
      ))}
    </span>
  );
}

export function Button({
  children,
  icon,
  variant = 'secondary',
  size = 'md',
  ...rest
}: { icon?: IconName; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`btn btn--${variant} btn--${size}`} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 18} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon, label, ...rest }: { icon: IconName; label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className="icon-btn" aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={17} />
    </button>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const { reduced } = useMotionPrefs();
  return (
    <div className="toasts" role="region" aria-label={t('Notifications')} aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout={!reduced}
            className={`toast toast--${toast.kind}`}
            initial={reduced ? false : { opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduced ? 0 : 30 }}
            transition={{ duration: reduced ? 0 : 0.25 }}
            role={toast.kind === 'error' ? 'alert' : 'status'}
          >
            <Icon name={toast.kind === 'success' ? 'check' : toast.kind === 'info' ? 'info' : 'alert'} size={18} />
            <p>{toast.message}</p>
            <button className="toast__close" onClick={() => dismissToast(toast.id)} aria-label={t('Dismiss notification')}>
              <Icon name="close" size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__orb" aria-hidden="true">
        <Icon name={icon} size={30} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
