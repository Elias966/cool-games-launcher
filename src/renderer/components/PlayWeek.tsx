// Play statistics: how long you played each day of the last week.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../state';
import type { PlayStats } from '@shared/types';
import { hours, locale, t } from '../i18n';

/** The last seven days of play, refreshed whenever a play session ends. */
export function usePlayStats(): PlayStats | null {
  const games = useApp((s) => s.library);
  const [stats, setStats] = useState<PlayStats | null>(null);
  // Total play time changes exactly when a session was recorded.
  const played = games.reduce((n, g) => n + g.playtimeSeconds, 0);
  useEffect(() => {
    let live = true;
    void api.invoke('library:stats').then((s) => { if (live) setStats(s); }).catch(() => undefined);
    return () => { live = false; };
  }, [played, games.length]);
  return stats;
}

export function PlayWeek({ stats }: { stats: PlayStats }) {
  const games = useApp((s) => s.library);
  const max = Math.max(3600, ...stats.days.map((d) => d.seconds));
  const top = stats.games[0] ? games.find((g) => g.id === stats.games[0].gameId) : null;
  const day = (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  return (
    <section className="play-week" aria-label={t('Play time this week')}>
      <div className="play-week__head">
        <span className="eyebrow">{t('This week')}</span>
        <strong>{stats.weekSeconds ? hours(stats.weekSeconds) : t('No play yet')}</strong>
        {top && <span className="play-week__top">{t('Most played: {title}', { title: top.title })}</span>}
      </div>
      <ol className="play-week__bars">
        {stats.days.map((d, i) => {
          const date = day(d.date);
          const label = date.toLocaleDateString(locale(), { weekday: 'long' });
          return (
            <li key={d.date} className={i === stats.days.length - 1 ? 'is-today' : ''} title={`${label} · ${d.seconds ? hours(d.seconds) : t('not played')}`}>
              <span className="play-week__bar" style={{ height: `${d.seconds ? Math.max(8, (d.seconds / max) * 100) : 0}%` }} />
              <span className="play-week__day" aria-hidden="true">{date.toLocaleDateString(locale(), { weekday: 'narrow' })}</span>
              <span className="sr-only">{label}: {d.seconds ? hours(d.seconds) : t('not played')}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
