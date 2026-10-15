// ProtonDB's community rating for a Windows game on Linux, with a link to the reports.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { attempt } from '../state';
import type { ProtonDbSummary } from '@shared/types';

const LABEL: Record<string, string> = { platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked', native: 'Native', pending: 'Pending' };
const HINT: Record<string, string> = {
  platinum: 'Runs perfectly out of the box',
  gold: 'Runs perfectly after small tweaks',
  silver: 'Runs with minor issues',
  bronze: 'Runs, but often crashes or has issues',
  borked: 'Does not run or is unplayable',
  native: 'Has a native Linux version',
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
    <button className={`protondb protondb--${tier}`} title={`${HINT[tier] ?? ''} — ${summary.total} reports on ProtonDB. Open the reports.`}
      onClick={() => void attempt(() => api.invoke('app:openExternal', { url: `https://www.protondb.com/app/${appid}` }))}>
      <span className="protondb__label">ProtonDB</span>
      <span className="protondb__tier">{LABEL[tier] ?? tier}</span>
      <span className="protondb__count">{summary.total} reports</span>
    </button>
  );
}
