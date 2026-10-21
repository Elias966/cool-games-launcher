import { describe, expect, it } from 'vitest';
import { ProtonAdvisor, deckStatus, newest, verdictFor } from '../src/main/proton-advice';
import type { ProtonInstall, ProtonRelease } from '../src/shared/types';

const install = (name: string, provider: ProtonInstall['provider']): ProtonInstall => ({ path: `/p/${name}`, name, provider, source: 'launcher', removable: true });
const release = (name: string): ProtonRelease => ({ id: `ge:${name}`, provider: 'ge', version: name, name, publishedAt: null, prerelease: false, pageUrl: '', url: 'https://x', sha256: 'a', size: 1, unavailableReason: null });

describe('Proton advice', () => {
  it('compares Proton versions by their numbers', () => {
    expect(newest([install('GE-Proton9-27', 'ge'), install('GE-Proton10-4', 'ge'), install('GE-Proton10-25', 'ge')])?.name).toBe('GE-Proton10-25');
  });

  it('turns the sources into a verdict', () => {
    expect(deckStatus(3)).toBe('verified');
    expect(verdictFor({ protondb: { tier: 'silver', trendingTier: 'gold', bestReportedTier: null, total: 3 }, deck: null, antiCheat: null })).toBe('great');
    expect(verdictFor({ protondb: { tier: 'bronze', trendingTier: null, bestReportedTier: null, total: 3 }, deck: null, antiCheat: null })).toBe('risky');
    expect(verdictFor({ protondb: { tier: 'platinum', trendingTier: null, bestReportedTier: null, total: 3 }, deck: 'verified', antiCheat: { status: 'Denied', anticheats: ['BattlEye'] } })).toBe('blocked');
  });

  function advisor(responses: Record<string, unknown>, installed: ProtonInstall[], releases: ProtonRelease[]) {
    const asked: string[] = [];
    const store = new Map<string, unknown>();
    const a = new ProtonAdvisor({
      fetch: async (url) => { asked.push(url); const hit = Object.entries(responses).find(([k]) => url.includes(k)); return new Response(JSON.stringify(hit ? hit[1] : null), { status: hit ? 200 : 404 }); },
      cache: { get: (k) => (store.get(k) ?? null) as never, set: (k, v) => { store.set(k, v); } },
      steamAppFor: async () => null,
      installed: () => installed,
      releases: async () => releases,
    });
    return { a, asked };
  }

  it('names builds by their version, not their folder or release title', async () => {
    const titled = { ...release('GE-Proton11-11'), name: 'GE-Proton11-11 Released' };
    const { a } = advisor({ 'summaries/10': { tier: 'gold', total: 5 } }, [install('ge-GE-Proton11-9', 'ge')], [titled]);
    const advice = await a.advise({ title: 'Game', appid: 10 });
    expect(advice).toMatchObject({ recommended: { name: 'GE-Proton11-9' }, installRelease: { id: 'ge:GE-Proton11-11', name: 'GE-Proton11-11' } });
  });

  it('finds the Steam id through umu, reads ProtonDB, Deck and anti-cheat, and suggests the newest GE-Proton', async () => {
    const { a, asked } = advisor({
      'umu_api.php': [{ umu_id: 'umu-1091500' }],
      'summaries/1091500': { tier: 'gold', trendingTier: 'platinum', bestReportedTier: 'platinum', total: 2743 },
      'nAppID=1091500': { results: { resolved_category: 3 } },
      'games.json': [{ name: 'Other', status: 'Denied', anticheats: ['X'], storeIds: { steam: '1' } }],
    }, [install('GE-Proton9-27', 'ge'), install('Proton 10.0', 'valve')], [release('GE-Proton10-25')]);
    const advice = await a.advise({ title: 'Cyberpunk 2077', appid: null, store: 'gog', storeId: '1423049311' });
    expect(advice).toMatchObject({ appid: 1091500, deck: 'verified', verdict: 'great', antiCheat: null, recommended: { name: 'GE-Proton9-27' }, installRelease: { name: 'GE-Proton10-25' } });
    expect(advice.protondb?.total).toBe(2743);
    // Cached: a second look asks nothing again.
    const n = asked.length;
    await a.advise({ title: 'Cyberpunk 2077', appid: null });
    expect(asked.length).toBe(n);
  });

  it('warns about anti-cheat that blocks Linux, and needs no install when the newest GE is there', async () => {
    const { a } = advisor({ 'summaries/359550': { tier: 'borderline', total: 900 }, 'games.json': [{ name: "Tom Clancy's Rainbow Six Siege", status: 'Denied', anticheats: ['BattlEye'], storeIds: { steam: '359550' } }] }, [install('GE-Proton10-25', 'ge')], [release('GE-Proton10-25')]);
    const advice = await a.advise({ title: 'Rainbow Six Siege', appid: 359550 });
    expect(advice).toMatchObject({ verdict: 'blocked', antiCheat: { status: 'Denied' }, recommended: { name: 'GE-Proton10-25' }, installRelease: null });
  });
});
