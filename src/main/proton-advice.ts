// Which Proton to use for a Windows game, from public sources: ProtonDB's
// rating for the game, Valve's Steam Deck verification, AreWeAntiCheatYet
// (anti-cheat that blocks Linux) and umu's database (it gives games without a
// Steam id one, so umu applies the community's fixes for that game). The
// advice names the Proton build to pick; the person applies it with one click.
import type { ProtonAdvice, ProtonInstall, ProtonRelease } from '@shared/types';

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface AdviceDeps {
  fetch: Fetch;
  cache: { get<T>(key: string, maxAgeHours?: number): T | null; set(key: string, value: unknown): void };
  /** The Steam app for a title, when it is clearly the same game. */
  steamAppFor: (title: string) => Promise<number | null>;
  installed: () => ProtonInstall[];
  releases: () => Promise<ProtonRelease[]>;
}

const DAY = 24;
const tierRank: Record<string, number> = { platinum: 5, native: 5, gold: 4, silver: 3, bronze: 2, borderline: 1, pending: 0 };

/** GE-Proton10-25 → [10, 25]; Proton 9.0-4 → [9, 0, 4]: compared part by part. */
export function versionParts(name: string): number[] {
  return (name.match(/\d+/g) ?? []).map(Number);
}

export function newest<T extends { name: string }>(items: T[]): T | null {
  return [...items].sort((a, b) => {
    const x = versionParts(a.name), y = versionParts(b.name);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  })[0] ?? null;
}

/** Steam's Deck compatibility category: 3 verified, 2 playable, 1 unsupported. */
export function deckStatus(category: number | undefined): ProtonAdvice['deck'] {
  return category === 3 ? 'verified' : category === 2 ? 'playable' : category === 1 ? 'unsupported' : 'unknown';
}

/** The overall verdict from what the sources say. */
export function verdictFor(a: Pick<ProtonAdvice, 'protondb' | 'deck' | 'antiCheat'>): ProtonAdvice['verdict'] {
  if (a.antiCheat && ['Denied', 'Broken'].includes(a.antiCheat.status)) return 'blocked';
  const rank = Math.max(tierRank[a.protondb?.tier ?? ''] ?? -1, tierRank[a.protondb?.trendingTier ?? ''] ?? -1);
  if (a.deck === 'verified' || rank >= 4) return 'great';
  if (a.deck === 'playable' || rank === 3) return 'good';
  if (rank >= 1) return 'risky';
  return 'unknown';
}

interface AwacyGame { name: string; status: string; anticheats?: string[]; storeIds?: { steam?: string; epic?: { slug?: string; namespace?: string } } }
const norm = (s: string) => s.toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, '');

export class ProtonAdvisor {
  constructor(private deps: AdviceDeps) {}

  private async json<T>(url: string, key: string, hours: number): Promise<T | null> {
    const hit = this.deps.cache.get<{ v: T | null }>(key, hours);
    if (hit) return hit.v;
    let v: T | null = null;
    try {
      const res = await this.deps.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      v = res.ok ? ((await res.json()) as T) : null;
    } catch { v = null; }
    this.deps.cache.set(key, { v });
    return v;
  }

  /** The game's Steam id: known already, from umu's database by title, or from a Steam search. */
  async steamId(title: string, known: number | null): Promise<number | null> {
    if (known) return known;
    const umu = await this.json<Array<{ umu_id?: string }>>(`https://umu.openwinecomponents.org/umu_api.php?title=${encodeURIComponent(title)}`, `umu-title:${norm(title)}`, 7 * DAY);
    const id = umu?.map((x) => /^umu-(\d+)$/.exec(x.umu_id ?? '')?.[1]).find(Boolean);
    if (id) return Number(id);
    return this.deps.steamAppFor(title).catch(() => null);
  }

  async advise(game: { title: string; appid: number | null; store?: string | null; storeId?: string | null }): Promise<ProtonAdvice> {
    const appid = await this.steamId(game.title, game.appid);
    const [summary, deck, awacy] = await Promise.all([
      appid ? this.json<{ tier?: string; trendingTier?: string; bestReportedTier?: string; total?: number; confidence?: string }>(`https://www.protondb.com/api/v1/reports/summaries/${appid}.json`, `protondb:${appid}`, 2 * DAY) : null,
      appid ? this.json<{ results?: { resolved_category?: number } }>(`https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appid}`, `deck:${appid}`, 7 * DAY) : null,
      this.json<AwacyGame[]>('https://raw.githubusercontent.com/AreWeAntiCheatYet/AreWeAntiCheatYet/master/games.json', 'awacy', DAY),
    ]);
    const ac = (awacy ?? []).find((g) => (appid && g.storeIds?.steam === String(appid)) || (game.store === 'epic' && game.storeId && g.storeIds?.epic?.slug === game.storeId) || norm(g.name) === norm(game.title)) ?? null;
    const advice: ProtonAdvice = {
      appid,
      protondb: summary?.tier ? { tier: summary.tier, trendingTier: summary.trendingTier ?? null, bestReportedTier: summary.bestReportedTier ?? null, total: summary.total ?? 0 } : null,
      deck: deck?.results ? deckStatus(deck.results.resolved_category) : null,
      antiCheat: ac && ac.anticheats?.length ? { status: ac.status, anticheats: ac.anticheats } : null,
      verdict: 'unknown',
      recommended: null,
      installRelease: null,
    };
    advice.verdict = verdictFor(advice);
    // GE-Proton is what non-Steam launchers (Heroic, Lutris, umu) recommend: Valve's Proton
    // plus media codecs and the community's per-game fixes, applied through umu.
    const installed = this.deps.installed();
    const ge = newest(installed.filter((p) => p.provider === 'ge'));
    const valve = newest(installed.filter((p) => p.provider === 'valve'));
    const latestGe = newest((await this.deps.releases().catch(() => [])).filter((r) => r.provider === 'ge' && !r.prerelease && !r.unavailableReason && r.url));
    const pick = ge ?? valve;
    // Builds the launcher installed are named after their folder (ge-GE-Proton11-9): show the version.
    if (pick) advice.recommended = { path: pick.path, name: pick.name.replace(/^(ge|cachyos|valve)-/, '') };
    // A newer GE-Proton than the one installed (or none installed): offer to install it.
    if (latestGe && (!ge || versionParts(latestGe.name).join('.') !== versionParts(ge.name).join('.')) && (!ge || newest([latestGe, ge]) === latestGe)) advice.installRelease = { id: latestGe.id, name: latestGe.version || latestGe.name };
    return advice;
  }
}
