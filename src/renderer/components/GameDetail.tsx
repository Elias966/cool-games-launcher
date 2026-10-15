import { latestCatalogDownload } from '@shared/download-state';
// Cinematic detail scene for a Store entry: large artwork, platforms, source
// attribution and the Download action.
import { motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { attempt, setState, setTab, useApp } from '../state';
import type { CatalogEntry, SteamMedia } from '@shared/types';
import { Artwork } from './GameCard';
import { Button, NsfwBadge, PlatformIcons, ProgressRing } from './ui';
import { Icon } from './Icon';
import { ProtonDbBadge } from './ProtonDb';
import { formatBytes, formatSpeed, platformLabel } from '@shared/format';
import { useMotionPrefs } from '../hooks/useMotion';

const STATE_TEXT: Record<string, string> = {
  queued: 'Queued',
  resolving: 'Finding the download…',
  'needs-user': 'Waiting for you in the browser',
  'needs-resolution': 'Needs the Store to continue',
  active: 'Downloading',
  paused: 'Paused',
  failed: 'Failed',
  completed: 'Downloaded',
};

/** Flies a copy of the card artwork from the grid into the detail scene. */
function ArtGhost({ src, title, from, to, onDone }: { src: string | null; title: string; from: DOMRect; to: DOMRect; onDone: () => void }) {
  return (
    <motion.div
      className="detail__ghost"
      aria-hidden="true"
      initial={{ left: from.left, top: from.top, width: from.width, height: from.height, borderRadius: 18, rotateY: 0 }}
      animate={{ left: to.left, top: to.top, width: to.width, height: to.height, borderRadius: 18, rotateY: 6 }}
      transition={{ type: 'spring', stiffness: 170, damping: 24, mass: 0.9 }}
      onAnimationComplete={onDone}
    >
      <Artwork src={src} title={title} className="detail__ghost-art" eager />
    </motion.div>
  );
}

export function GameDetail({ entry, origin, onClose }: { entry: CatalogEntry; origin: DOMRect | null; onClose: () => void }) {
  const { reduced } = useMotionPrefs();
  const artRef = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<{ from: DOMRect; to: DOMRect } | null>(null);
  const [flown, setFlown] = useState(reduced || !origin);
  useLayoutEffect(() => {
    if (reduced || !origin || !artRef.current) return;
    setGhost({ from: origin, to: artRef.current.getBoundingClientRect() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const download = useApp((s) => latestCatalogDownload(s.downloads,entry.id));
  const game = useApp((s) => s.library.find((g) => g.catalogId === entry.id) ?? null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.dialog')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  const startDownload = async () => {
    setBusy(true);
    await attempt(() => api.invoke('download:start', { catalogId: entry.id }));
    setBusy(false);
  };

  const progress = download?.totalBytes ? download.receivedBytes / download.totalBytes : null;
  // Steam's all-ages media, shown only for games that passed the content check.
  const steam = entry.rating === 'safe' ? entry.steam ?? null : null;
  const art = steam?.capsule ?? entry.artwork;

  return (
    <motion.section
      className="detail"
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      // Adult content must vanish at once when hidden, so it gets no exit animation.
      exit={{ opacity: 0, transition: { duration: reduced || entry.rating === 'adult' ? 0 : 0.3 } }}
      transition={{ duration: reduced ? 0 : 0.3 }}
    >
      <div className={`detail__backdrop ${steam?.hero ? 'is-steam' : ''}`} aria-hidden="true">
        {(steam?.hero ?? steam?.background ?? entry.artwork) && <img src={steam?.hero ?? steam?.background ?? entry.artwork!} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
      </div>
      <motion.div
        className="detail__frame"
        initial={reduced ? false : { opacity: 0, scale: 0.965, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduced || entry.rating === 'adult' ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.97, y: 8 }}
        transition={{ duration: reduced ? 0 : 0.42, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="detail__hero">
          <div className="detail__art-wrap">
            <Artwork src={art} title={entry.title} className={`detail__art ${flown ? '' : 'is-hidden'}`} eager artRef={artRef} />
            <span className="detail__art-glow" aria-hidden="true" />
          </div>
          {steam && (steam.trailers.length > 0 || steam.screenshots.length > 0) ? <SteamGallery steam={steam} /> : entry.screenshots.length > 0 && (
            <div className="detail__shots" aria-label="Screenshots">
              {entry.screenshots.slice(0, 4).map((s, i) => (
                <ScreenshotThumb key={s} url={s} index={i} />
              ))}
            </div>
          )}
        </div>

        <motion.div
          className="detail__info"
          initial={reduced ? false : { opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: reduced ? 0 : 0.5, delay: reduced ? 0 : 0.12, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="detail__eyebrow">
            <span className="detail__source">
              <Icon name="globe" size={14} /> {entry.sourceName}
              <span className="detail__host">· {entry.sourceHost}</span>
            </span>
            {entry.rating === 'adult' && <NsfwBadge />}
          </div>
          <h1 id="detail-title" className="detail__title">
            {entry.title}
          </h1>
          {entry.author && <p className="detail__author">by {entry.author}</p>}

          <div className="detail__cta">
            {game?.update?.state === 'available' ? (
              <Button variant="primary" size="lg" icon="downloads" onClick={() => void attempt(() => api.invoke('library:update', { id: game.id }))}>
                Update{game.update.from && game.update.to ? ` ${game.update.from} → ${game.update.to}` : ''}
              </Button>
            ) : game ? (
              <Button
                variant="primary"
                size="lg"
                icon="play"
                onClick={() => {
                  setState({ detailId: null });
                  setTab('library');
                }}
              >
                {game.update && ['downloading', 'preparing', 'waiting'].includes(game.update.state) ? 'Updating — open Library' : 'In your Library'}
              </Button>
            ) : download && !['failed', 'cancelled'].includes(download.state) ? (
              <div className="detail__progress">
                <ProgressRing value={progress} indeterminate={download.state === 'resolving' || download.state === 'queued'} size={52}>
                  <span className="mono">{progress !== null ? `${Math.round(progress * 100)}%` : ''}</span>
                </ProgressRing>
                <div>
                  <p className="detail__progress-state">{download.installState === 'installing' ? 'Preparing your Library' : STATE_TEXT[download.state] ?? download.state}</p>
                  <p className="detail__progress-sub mono">
                    {download.state === 'active'
                      ? `${formatBytes(download.receivedBytes)} of ${formatBytes(download.totalBytes)} · ${formatSpeed(download.speedBps)}`
                      : download.installState === 'installing' ? download.installDetail ?? 'Extracting…' : download.userPrompt?.message ?? download.errorDetail ?? ''}
                  </p>
                </div>
                <Button variant="ghost" size="sm" icon="downloads" onClick={() => setTab('downloads')}>
                  Downloads
                </Button>
              </div>
            ) : (
              <Button variant="primary" size="lg" icon="downloads" onClick={startDownload} disabled={busy}>
                {download?.state === 'failed' ? 'Try download again' : 'Download & add to Library'}
              </Button>
            )}
            <Button variant="ghost" size="md" icon="heart" aria-pressed={!!entry.wishlisted} className={entry.wishlisted ? 'is-wished' : ''}
              onClick={() => void attempt(async () => { if (entry.wishlisted) await api.invoke('wishlist:remove', { catalogId: entry.id }); else await api.invoke('wishlist:add', { catalogId: entry.id }); }, entry.wishlisted ? 'Removed from your wishlist.' : 'On your wishlist — you’ll be notified when a new version appears.')}>
              {entry.wishlisted ? 'On your wishlist' : 'Wishlist'}
            </Button>
            {!entry.detailFetched && (
              <Button variant="ghost" size="md" icon="reload" onClick={() => void attempt(() => api.invoke('catalog:refreshDetail', { id: entry.id }))}>
                Fetch details
              </Button>
            )}
          </div>

          <dl className="detail__facts">
            {steam?.reviews && (
              <div>
                <dt>Steam reviews</dt>
                <dd className={`detail__reviews detail__reviews--${steam.reviews.percent >= 80 ? 'good' : steam.reviews.percent >= 60 ? 'mixed' : 'bad'}`}>
                  {steam.reviews.label || `${steam.reviews.percent}% positive`} · {steam.reviews.percent}% of {compact(steam.reviews.count)}
                </dd>
              </div>
            )}
            {steam && entry.platforms.includes('windows') && !entry.platforms.includes('linux') && (
              <div>
                <dt>On Linux (Proton)</dt>
                <dd><ProtonDbBadge appid={steam.appid} /></dd>
              </div>
            )}
            {steam?.released && (
              <div>
                <dt>Released</dt>
                <dd>{new Date(steam.released).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</dd>
              </div>
            )}
            <div>
              <dt>Platforms</dt>
              <dd>
                {entry.platforms.length ? (
                  <span className="detail__platforms">
                    <PlatformIcons platforms={entry.platforms} size={16} />
                    {entry.platforms.map(platformLabel).join(' · ')}
                  </span>
                ) : (
                  'Not listed'
                )}
              </dd>
            </div>
            {entry.priceText && (
              <div>
                <dt>Price</dt>
                <dd>{entry.priceText}</dd>
              </div>
            )}
            <div>
              <dt>Source</dt>
              <dd>
                <button className="link-btn" onClick={() => void attempt(() => api.invoke('browser:open', { url: entry.pageUrl }))}>
                  Open page in browser <Icon name="external" size={13} />
                </button>
              </dd>
            </div>
          </dl>

          {entry.description && !/\bfree download\b|pc game for free|pre-?installed/i.test(entry.description) ? (
            <>
              <p className="detail__desc">{entry.description}</p>
              {entry.descriptionSource === 'steam' && <p className="detail__desc-source muted">Description from the game’s Steam store page.</p>}
            </>
          ) : (
            <p className="detail__desc muted">The website only has an advertising blurb for this game. The launcher checks the game’s page and Steam for a real description; it appears here when found.</p>
          )}
          {entry.popularity && (entry.popularity.downloads || entry.popularity.views || entry.popularity.ratings) ? (
            <p className="detail__popularity mono">
              {[
                entry.popularity.downloads ? `${compact(entry.popularity.downloads)} downloads` : null,
                entry.popularity.views ? `${compact(entry.popularity.views)} views` : null,
                entry.popularity.rating ? `${entry.popularity.rating.toFixed(1)}★${entry.popularity.ratings ? ` (${compact(entry.popularity.ratings)})` : ''}` : entry.popularity.ratings ? `${compact(entry.popularity.ratings)} ratings` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          ) : null}
          {(entry.rankPopular || entry.rankTrending) ? (
            <p className="detail__popularity">
              {entry.rankTrending ? <span className="card__rank card__rank--trending detail__rank"><Icon name="flame" size={12} />#{entry.rankTrending} trending</span> : null}
              {entry.rankPopular ? <span className="card__rank detail__rank"><Icon name="star" size={12} />#{entry.rankPopular} popular</span> : null}
            </p>
          ) : null}
          {entry.tags.length > 0 && (
            <ul className="detail__tags" aria-label="Tags">
              {entry.tags.slice(0, 8).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}

          <SimilarGames id={entry.id} />

          <p className="detail__note">
            The launcher finds the download, unpacks the game and adds it to your Library — you can use other tabs meanwhile. Start the game with Play when it is ready.
          </p>
        </motion.div>

        <button ref={closeRef} className="detail__close" onClick={onClose} aria-label="Close game details">
          <Icon name="close" size={20} />
        </button>
      </motion.div>
      {ghost && !flown && (
        <ArtGhost
          src={art}
          title={entry.title}
          from={ghost.from}
          to={ghost.to}
          onDone={() => {
            setFlown(true);
            setGhost(null);
          }}
        />
      )}
    </motion.section>
  );
}

/** Games sharing genres and tags with this one. */
function SimilarGames({ id }: { id: number }) {
  const [games, setGames] = useState<CatalogEntry[]>([]);
  const revision = useApp((s) => s.policy.revision);
  useEffect(() => {
    let live = true;
    void api.invoke('catalog:similar', { id }).then((r) => { if (live && r.policyRevision === revision) setGames(r.entries); }).catch(() => undefined);
    return () => { live = false; };
  }, [id, revision]);
  if (!games.length) return null;
  return (
    <section className="similar" aria-label="Similar games">
      <h2 className="similar__title">Similar games</h2>
      <div className="similar__row">
        {games.map((g) => (
          <button key={g.id} className="similar__item" onClick={() => setState({ detailId: g.id })}>
            <Artwork src={g.rating === 'safe' && g.steam?.capsule ? g.steam.capsule : g.artwork} title={g.title} className="similar__art" />
            <span className="similar__name">{g.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Trailer (silent preview until played, then the full HLS stream) and a screenshot strip with a viewer. */
function SteamGallery({ steam }: { steam: SteamMedia }) {
  const [shot, setShot] = useState<number | null>(null);
  const trailer = steam.trailers[0];
  useEffect(() => {
    if (shot === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setShot(null); }
      if (e.key === 'ArrowRight') setShot((n) => (n === null ? n : (n + 1) % steam.screenshots.length));
      if (e.key === 'ArrowLeft') setShot((n) => (n === null ? n : (n - 1 + steam.screenshots.length) % steam.screenshots.length));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shot, steam.screenshots.length]);
  return (
    <div className="detail__media">
      {trailer && <TrailerPlayer key={trailer.hls ?? trailer.preview ?? trailer.name} trailer={trailer} />}
      {steam.screenshots.length > 0 && (
        <div className="detail__shots detail__shots--steam" aria-label="Screenshots">
          {steam.screenshots.slice(0, 8).map((s, i) => (
            <button key={s} className="detail__shot-btn" onClick={() => setShot(i)} aria-label={`Screenshot ${i + 1}`}>
              <img className="detail__shot" src={s.replace(/\.jpg(\?|$)/, '.600x338.jpg$1')} onError={(e) => { if (!e.currentTarget.src.endsWith(s)) e.currentTarget.src = s; }} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {shot !== null && (
        <div className="shot-viewer" role="dialog" aria-label="Screenshot" onClick={() => setShot(null)}>
          <img src={steam.screenshots[shot]} alt="" />
          <span className="shot-viewer__count">{shot + 1} / {steam.screenshots.length} · ← → to browse · Esc to close</span>
        </div>
      )}
    </div>
  );
}

function TrailerPlayer({ trailer }: { trailer: SteamMedia['trailers'][number] }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!playing || !trailer.hls || !video.current) return;
    let hls: { destroy: () => void } | null = null;
    let live = true;
    void import('hls.js').then(({ default: Hls }) => {
      const el = video.current;
      if (!live || !el) return;
      if (Hls.isSupported()) {
        const h = new Hls({ capLevelToPlayerSize: true });
        hls = h;
        h.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean }) => { if (data.fatal) setFailed(true); });
        h.loadSource(trailer.hls!);
        h.attachMedia(el);
        h.on(Hls.Events.MANIFEST_PARSED, () => { void el.play().catch(() => undefined); });
      } else setFailed(true);
    });
    return () => { live = false; hls?.destroy(); };
  }, [playing, trailer.hls]);
  if (playing && !failed && trailer.hls) {
    return <video ref={video} className="detail__trailer" controls poster={trailer.poster ?? undefined} aria-label={trailer.name} />;
  }
  return (
    <button className="detail__trailer detail__trailer--preview" onClick={() => trailer.hls && setPlaying(true)} aria-label={`Play ${trailer.name}`} disabled={!trailer.hls}>
      {trailer.preview ? <video src={trailer.preview} poster={trailer.poster ?? undefined} autoPlay muted loop playsInline /> : trailer.poster && <img src={trailer.poster} alt="" />}
      {trailer.hls && <span className="detail__trailer-play"><Icon name="play" size={30} /></span>}
      <span className="detail__trailer-name">{failed ? 'The trailer could not be played' : trailer.name}</span>
    </button>
  );
}

function ScreenshotThumb({ url }: { url: string; index: number }) {
  // Site screenshots are only shown after they were content-checked and cached as artwork.
  if (!url.startsWith('cgl-media://')) return null;
  return <img className="detail__shot" src={url} alt="" />;
}

const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
function compact(n: number) {
  return compactFormat.format(n);
}
