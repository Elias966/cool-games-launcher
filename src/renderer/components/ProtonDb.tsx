// ProtonDB's community rating for a Windows game on Linux, with a link to the reports.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { attempt } from '../state';
import type { ProtonDbSummary } from '@shared/types';
import { t, tk } from '../i18n';

const LABEL: Record<string, string> = { platinum: tk('Platinum'), gold: tk('Gold'), silver: tk('Silver'), bronze: tk('Bronze'), borked: tk('Borked'), native: tk('Native'), pending: tk('Pending') };
const HINT: Record<string, string> = {
  platinum: tk('Runs perfectly out of the box'),
  gold: tk('Runs perfectly after small tweaks'),
  silver: tk('Runs with minor issues'),
  bronze: tk('Runs, but often crashes or has issues'),
  borked: tk('Does not run or is unplayable'),
  native: tk('Has a native Linux version'),
};

export function ProtonDbBadge({ appid }: { appid: number }) {
  const [summary, setSummary] = useState<ProtonDbSummary | null>(null);
  useEffect(() => {
    let live = true;
    void api.invoke('compat:protondb', { appid }).then((s) => { if (live) setSummary(s); }).catch(() => undefined);
    return () => { live = false; };
  }, [appid]);
  if (!summary) return null;
  const tier = summary.trendingTier ?? summary.tier;
  return (
    <button className={`protondb protondb--${tier}`} title={t('{hint} — {n} reports on ProtonDB. Open the reports.', { hint: t(HINT[tier] ?? ''), n: summary.total })}
      onClick={() => void attempt(() => api.invoke('app:openExternal', { url: `https://www.protondb.com/app/${appid}` }))}>
      <span className="protondb__label">{t('ProtonDB')}</span>
      <span className="protondb__tier">{t(LABEL[tier] ?? tier)}</span>
      <span className="protondb__count">{t('{n} reports', { n: summary.total })}</span>
    </button>
  );
}
