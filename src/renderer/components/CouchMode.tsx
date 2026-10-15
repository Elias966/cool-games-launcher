// Couch mode: a full-screen, controller-first view (like Steam's Big Picture).
// Rows of big artwork — keep playing, games on the way, trending, popular and
// the wishlist — with the focused game shown large above them. D-pad/stick
// or arrow keys move, A/Enter plays or opens, Y wishlists, B/Esc goes back,
// Start/Menu leaves.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { attempt, setState, useApp } from '../state';
import { onPad, type PadAction } from '../gamepad';
import { sound } from '../sound';
import { Icon } from './Icon';
import { placeholderStyle } from './GameCard';
import { pendingStatus } from '../tabs/LibraryTab';
import type { CatalogEntry, DownloadItem, Game } from '@shared/types';
import { t, locale } from '../i18n';

type Tile =
  | { kind: 'game'; key: string; game: Game }
  | { kind: 'pending'; key: string; d: DownloadItem; parts: DownloadItem[] }
  | { kind: 'store'; key: string; entry: CatalogEntry };

interface Row { title: string; tiles: Tile[] }

const art = (t: Tile): { tile: string | null; hero: string | null; logo: string | null; title: string } => {
  if (t.kind === 'game') return { tile: t.game.art?.capsule ?? t.game.artwork, hero: t.game.art?.hero ?? t.game.artwork, logo: t.game.art?.logo ?? null, title: t.game.title };
  if (t.kind === 'pending') return { tile: t.d.artwork, hero: t.d.artwork, logo: null, title: t.d.title };
  const s = t.entry.rating === 'safe' ? t.entry.steam : null;
  return { tile: s?.capsule ?? t.entry.artwork, hero: s?.hero ?? s?.capsule ?? t.entry.artwork, logo: s?.logo ?? null, title: t.entry.title };
};

/** A missing image leaves the tile's own gradient instead of a broken-image icon. */
const hideBroken = (e: { currentTarget: HTMLImageElement }) => { e.currentTarget.style.display = 'none'; };

export function CouchMode() {
  const library = useApp((s) => s.library);
  const downloads = useApp((s) => s.downloads);
  const catalogVersion = useApp((s) => s.catalogVersion);
  const policy = useApp((s) => s.policy);
  const [lists, setLists] = useState<{ trending: CatalogEntry[]; popular: CatalogEntry[]; wishlist: CatalogEntry[] }>({ trending: [], popular: [], wishlist: [] });
  const [pos, setPos] = useState({ row: 0, col: 0 });
  const [detail, setDetail] = useState<CatalogEntry | null>(null);
  const [logoFailed, setLogoFailed] = useState<Record<string, boolean>>({});
  const rowsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.windowControl('fullscreen-on');
    sound.play('warp');
    return () => api.windowControl('fullscreen-off');
  }, []);

  useEffect(() => {
    let live = true;
    const list = (q: Parameters<typeof api.invoke<'catalog:list'>>[1]) => api.invoke('catalog:list', q).then((p) => (p.policyRevision === policy.revision ? p.entries : [])).catch(() => []);
    void Promise.all([list({ sort: 'trending', limit: 24 }), list({ sort: 'popular', limit: 24 }), list({ wishlist: true, sort: 'popular', limit: 24 })]).then(([trending, popular, wishlist]) => {
      if (live) setLists({ trending, popular, wishlist });
    });
    return () => { live = false; };
  }, [catalogVersion, policy.revision]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const installed = library.filter((g) => g.status === 'installed').sort((a, b) => (b.lastPlayedAt ?? b.addedAt).localeCompare(a.lastPlayedAt ?? a.addedAt));
    if (installed.length) out.push({ title: t('Continue playing'), tiles: installed.map((game) => ({ kind: 'game', key: `g${game.id}`, game })) });
    const pending = downloads.filter((d) => d.catalogId !== null && !d.updateFor && (!d.groupId || d.groupId === d.id) && d.state !== 'cancelled' && !(d.state === 'completed' && d.installState === 'installed') && !library.some((g) => g.catalogId === d.catalogId));
    if (pending.length) out.push({ title: t('On the way'), tiles: pending.map((d) => ({ kind: 'pending', key: `d${d.id}`, d, parts: d.groupId ? downloads.filter((x) => x.groupId === d.groupId) : [] })) });
    if (lists.trending.length) out.push({ title: t('Trending'), tiles: lists.trending.map((entry) => ({ kind: 'store', key: `t${entry.id}`, entry })) });
    if (lists.popular.length) out.push({ title: t('Popular'), tiles: lists.popular.map((entry) => ({ kind: 'store', key: `p${entry.id}`, entry })) });
    if (lists.wishlist.length) out.push({ title: t('Your wishlist'), tiles: lists.wishlist.map((entry) => ({ kind: 'store', key: `w${entry.id}`, entry })) });
    return out;
  }, [library, downloads, lists]);

  const row = rows[Math.min(pos.row, rows.length - 1)];
  const focused = row?.tiles[Math.min(pos.col, row.tiles.length - 1)] ?? null;
  const exit = useCallback(() => setState({ couch: false }), []);

  // Keep the focused tile in view.
  useEffect(() => {
    rowsRef.current?.querySelector('.couch__tile.is-focused')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [pos]);

  const act = useCallback((a: PadAction): boolean => {
    if (detail) {
      if (a === 'back') { setDetail(null); sound.play('close'); }
      if (a === 'accept') { sound.play('download'); void attempt(() => api.invoke('download:start', { catalogId: detail.id }), t('{title} is on its way — it appears under “On the way”.', { title: detail.title })).then(() => setDetail(null)); }
      if (a === 'secondary') void attempt(async () => { if (detail.wishlisted) await api.invoke('wishlist:remove', { catalogId: detail.id }); else await api.invoke('wishlist:add', { catalogId: detail.id }); }).then(() => setDetail({ ...detail, wishlisted: !detail.wishlisted }));
      if (a === 'menu') exit();
      return true;
    }
    const move = (row: number, col: number) => { setPos({ row, col }); sound.play('hover'); };
    if (a === 'left') move(pos.row, Math.max(0, pos.col - 1));
    if (a === 'right') move(pos.row, Math.min((row?.tiles.length ?? 1) - 1, pos.col + 1));
    if (a === 'up') move(Math.max(0, pos.row - 1), 0);
    if (a === 'down') move(Math.min(rows.length - 1, pos.row + 1), 0);
    if (a === 'back' || a === 'menu') exit();
    if (a === 'accept' && focused) {
      sound.play('click');
      if (focused.kind === 'game') void attempt(() => api.invoke('library:launch', { id: focused.game.id }), t('Starting {title}…', { title: focused.game.title }));
      if (focused.kind === 'store') setDetail(focused.entry);
    }
    if (a === 'secondary' && focused?.kind === 'store') {
      const e = focused.entry;
      void attempt(async () => { if (e.wishlisted) await api.invoke('wishlist:remove', { catalogId: e.id }); else await api.invoke('wishlist:add', { catalogId: e.id }); }, e.wishlisted ? t('Removed from your wishlist.') : t('Added to your wishlist.'));
    }
    return true;
  }, [detail, pos, row, rows.length, focused, exit]);

  useEffect(() => onPad(act), [act]);
  useEffect(() => {
    const keys: Record<string, PadAction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'accept', Escape: 'back', Backspace: 'back', y: 'secondary', Y: 'secondary' };
    const onKey = (e: KeyboardEvent) => { const a = keys[e.key]; if (!a) return; e.preventDefault(); e.stopPropagation(); act(a); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [act]);

  const show = detail ? ({ kind: 'store', key: 'detail', entry: detail } as Tile) : focused;
  const a = show ? art(show) : null;
  const steam = show?.kind === 'store' && show.entry.rating === 'safe' ? show.entry.steam : null;
  const pending = show?.kind === 'pending' ? pendingStatus(show.d, show.parts) : null;
  const logoOk = a?.logo && !logoFailed[a.logo];
  return (
    <div className="couch" role="application" aria-label={t('Couch mode')}>
      <div className="couch__hero" key={show?.key ?? 'none'} style={placeholderStyle(a?.title ?? 'couch')}>
        {a?.hero && <img className="couch__hero-art" src={a.hero} alt="" onError={hideBroken} />}
        <div className="couch__hero-shade" />
        <div className="couch__hero-info">
          {logoOk ? <img className="couch__logo" src={a!.logo!} alt={a!.title} onError={() => setLogoFailed((f) => ({ ...f, [a!.logo!]: true }))} /> : <h1 className="couch__title">{a?.title ?? t('Nothing here yet')}</h1>}
          <p className="couch__meta">
            {show?.kind === 'game' && <>{show.game.version ?? t('Installed')} · {show.game.kind === 'windows' ? t('Windows · Proton') : t('Native Linux')}{show.game.update?.state === 'available' ? t(' · Update available') : ''}</>}
            {pending && <>{pending.label}{pending.pct !== null ? ` · ${Math.round(pending.pct * 100)}%` : ''}</>}
            {show?.kind === 'store' && [
              steam?.reviews ? `${steam.reviews.label ? t(steam.reviews.label) : t('{p}% positive', { p: steam.reviews.percent })} · ${t('{p}% of {n}', { p: steam.reviews.percent, n: steam.reviews.count.toLocaleString(locale()) })}` : null,
              steam?.released ? String(new Date(steam.released).getFullYear()) : null,
              show.entry.installedGameId ? t('In your Library') : null,
              show.entry.wishlisted ? t('♥ Wishlisted') : null,
            ].filter(Boolean).join(' · ')}
          </p>
          {show?.kind === 'store' && show.entry.description && <p className="couch__desc">{show.entry.description}</p>}
          <div className="couch__hints">
            {show?.kind === 'game' && <span><b>A</b> {' '}{t('Play')}</span>}
            {show?.kind === 'store' && <span><b>A</b> {detail ? (show.entry.installedGameId ? t('Download again') : t('Download')) : t('Open')}</span>}
            {show?.kind === 'store' && <span><b>Y</b> {show.entry.wishlisted ? t('Remove from wishlist') : t('Wishlist')}</span>}
            <span><b>B</b> {detail ? t('Back') : t('Leave couch mode')}</span>
          </div>
        </div>
      </div>
      <div className="couch__rows" ref={rowsRef}>
        {rows.map((r, ri) => (
          <section key={r.title} className={`couch__row ${ri === pos.row ? 'is-active' : ''}`} aria-label={r.title}>
            <h2 className="couch__row-title">{r.title}</h2>
            <div className="couch__strip">
              {r.tiles.map((tile, ci) => {
                const ta = art(tile);
                const focusedTile = ri === pos.row && ci === Math.min(pos.col, r.tiles.length - 1);
                const st = tile.kind === 'pending' ? pendingStatus(tile.d, tile.parts) : null;
                return (
                  <button key={tile.key} className={`couch__tile ${focusedTile ? 'is-focused' : ''} ${tile.kind === 'pending' ? 'is-pending' : ''}`} style={placeholderStyle(ta.title)}
                    onClick={() => { setPos({ row: ri, col: ci }); act('accept'); }} onMouseEnter={() => setPos({ row: ri, col: ci })} tabIndex={-1}>
                    {ta.tile && <img src={ta.tile} alt="" loading="lazy" onError={hideBroken} />}
                    {st && <span className="couch__tile-progress"><span style={{ width: `${(st.pct ?? 0) * 100}%` }} /></span>}
                    <span className="couch__tile-name">{ta.title}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {!rows.length && <p className="couch__empty">{t('Add websites in Settings to fill couch mode with games.')}</p>}
      </div>
      <button className="couch__exit" onClick={exit} aria-label={t('Leave couch mode')}><Icon name="close" size={22} /></button>
    </div>
  );
}
