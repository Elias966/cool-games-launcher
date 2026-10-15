import { forwardRef, memo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { CatalogEntry } from '@shared/types';
import { NsfwBadge, PlatformIcons } from './ui';
import { useMotionPrefs } from '../hooks/useMotion';
import { emitScene } from '../scene/events';
import { Icon } from './Icon';

/** Deterministic gradient art for entries without artwork. */
export function placeholderStyle(seed: string): CSSProperties {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue1 = 185 + (h % 70);
  const hue2 = 245 + ((h >> 8) % 50);
  const x = 20 + ((h >> 4) % 60);
  const y = 15 + ((h >> 12) % 50);
  return {
    background: `radial-gradient(circle at ${x}% ${y}%, hsla(${hue1}, 90%, 62%, 0.55), transparent 42%),
      radial-gradient(circle at ${100 - x}% ${100 - y / 2}%, hsla(${hue2}, 85%, 66%, 0.45), transparent 46%),
      linear-gradient(160deg, #141a27, #0b0e15)`,
  };
}

export function Artwork({ src, title, className, eager, artRef }: { src: string | null; title: string; className?: string; eager?: boolean; artRef?: React.Ref<HTMLDivElement> }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const showImg = src && !failed;
  return (
    <div ref={artRef} className={`artwork ${className ?? ''} ${loaded ? 'is-loaded' : ''}`} style={placeholderStyle(title)}>
      {!showImg && (
        <div className="artwork__placeholder" aria-hidden="true">
          <span>{title.slice(0, 1).toUpperCase()}</span>
        </div>
      )}
      {showImg && (
        <img
          src={src}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

interface Props {
  entry: CatalogEntry;
  index: number;
  onOpen: (id: number, origin: DOMRect) => void;
  onKeyNav: (e: KeyboardEvent<HTMLButtonElement>, index: number) => void;
  downloadState?: string | null;
  /** "#3" in the site's Popular or Trending list, shown when sorting by it. */
  rank?: { kind: 'popular' | 'trending'; n: number } | null;
}

const TILT_VARS = ['--rx', '--ry', '--px', '--py'];

/**
 * A Store card. Tilt, parallax and the holographic light are pure CSS driven
 * by custom properties set on pointer move, so thousands of cards cost nothing
 * while idle (no animation springs, no layers of their own).
 */
export const GameCard = memo(
  forwardRef<HTMLButtonElement, Props>(function GameCard({ entry, index, onOpen, onKeyNav, downloadState, rank }, ref) {
    const { reduced, low, animate } = useMotionPrefs();
    const tilt = !reduced && animate;
    const rect = useRef<DOMRect | null>(null);
    return (
      <div className="card-shell" style={{ ['--i' as string]: index % 24 }}>
        <button
          ref={ref}
          className={`card ${low ? 'is-low' : ''} ${tilt ? 'can-tilt' : ''}`}
          onPointerEnter={(e) => {
            rect.current = e.currentTarget.getBoundingClientRect();
            e.currentTarget.classList.add('is-hover');
            emitScene('focus');
          }}
          onPointerMove={(e) => {
            const r = rect.current ?? e.currentTarget.getBoundingClientRect();
            const x = (e.clientX - r.left) / r.width;
            const y = (e.clientY - r.top) / r.height;
            const st = e.currentTarget.style;
            st.setProperty('--mx', `${x * 100}%`);
            st.setProperty('--my', `${y * 100}%`);
            if (!tilt) return;
            st.setProperty('--rx', `${(0.5 - y) * 14}deg`);
            st.setProperty('--ry', `${(x - 0.5) * 18}deg`);
            st.setProperty('--px', `${(0.5 - x) * 20}px`);
            st.setProperty('--py', `${(0.5 - y) * 16}px`);
          }}
          onPointerLeave={(e) => {
            e.currentTarget.classList.remove('is-hover');
            for (const v of TILT_VARS) e.currentTarget.style.removeProperty(v);
            rect.current = null;
          }}
          onClick={(e) => onOpen(entry.id, e.currentTarget.getBoundingClientRect())}
          onKeyDown={(e) => onKeyNav(e, index)}
          aria-label={`${entry.title}${entry.rating === 'adult' ? ', adult content' : ''}, from ${entry.sourceName}${rank ? `, number ${rank.n} ${rank.kind}` : ''}`}
          data-card-index={index}
          data-card-id={entry.id}
        >
          <div className="card__art">
            <div className="card__parallax">
              <Artwork src={entry.rating === 'safe' && entry.steam?.capsule ? entry.steam.capsule : entry.artwork} title={entry.title} />
            </div>
          </div>
          <span className="card__edge" aria-hidden="true" />
          <span className="card__sheen" aria-hidden="true" />
          <span className="card__holo" aria-hidden="true" />
          {rank && (
            <span className={`card__rank card__rank--${rank.kind}`} aria-hidden="true">
              <Icon name={rank.kind === 'trending' ? 'flame' : 'star'} size={12} />#{rank.n}
            </span>
          )}
          {entry.wishlisted && <span className="card__wish" aria-hidden="true"><Icon name="heart" size={13} /></span>}
          <div className="card__badges">
            {entry.rating === 'adult' && <NsfwBadge small />}
            {entry.installedGameId && (entry.updateAvailable ? <span className="badge badge--info badge--sm">Update available</span> : <span className="badge badge--ok badge--sm">Installed</span>)}
            {!entry.installedGameId && downloadState && <span className="badge badge--info badge--sm">{downloadState}</span>}
            {!entry.installedGameId && !downloadState && entry.verifying && <span className="badge badge--verify badge--sm" title="The local AI found this game; its download is being verified">Verifying</span>}
          </div>
          <div className="card__meta">
            <h3 className="card__title">{entry.title}</h3>
            <div className="card__row">
              <span className="card__source">{entry.sourceHost}</span>
              <PlatformIcons platforms={entry.platforms} size={13} />
            </div>
          </div>
        </button>
      </div>
    );
  }),
  (a, b) =>
    a.index === b.index && a.downloadState === b.downloadState && a.onOpen === b.onOpen && a.onKeyNav === b.onKeyNav &&
    a.rank?.kind === b.rank?.kind && a.rank?.n === b.rank?.n && sameCard(a.entry, b.entry),
);

/** Refetched pages bring new objects; only what a card shows decides a re-render. */
function sameCard(a: CatalogEntry, b: CatalogEntry) {
  return a.id === b.id && a.title === b.title && a.artwork === b.artwork && a.steam?.capsule === b.steam?.capsule && a.rating === b.rating && a.installedGameId === b.installedGameId &&
    a.updateAvailable === b.updateAvailable && a.wishlisted === b.wishlisted && a.verifying === b.verifying && a.sourceHost === b.sourceHost && a.sourceName === b.sourceName &&
    a.platforms.join() === b.platforms.join();
}
