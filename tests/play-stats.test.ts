import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/main/db';
import { GamesRepo } from '../src/main/repos';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cgl-stats-'));
  const db = openDb(join(dir, 'db.sqlite'));
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const games = new GamesRepo(db);
  const add = (title: string) => games.create({ catalogId: null, downloadId: null, title, kind: 'linux', installDir: `/tmp/${title}`, executable: `/tmp/${title}/run`, args: '', runner: 'native', prefixDir: null, managed: false, artworkFile: null, sourceHost: null, status: 'installed', candidates: [] });
  return { games, add };
}

describe('play statistics', () => {
  it('counts play time per local day and per game over the last seven days', () => {
    const { games, add } = repo();
    const a = add('Orbit'), b = add('Comet');
    const today = new Date(2026, 9, 15, 20, 0);
    games.recordPlay(a.id, 3600, new Date(2026, 9, 15, 19, 0)); // today
    games.recordPlay(a.id, 1800, new Date(2026, 9, 13, 22, 0)); // two days ago
    games.recordPlay(b.id, 600, new Date(2026, 9, 9, 12, 0)); // six days ago: still this week
    games.recordPlay(b.id, 900, new Date(2026, 9, 7, 12, 0)); // eight days ago: not counted
    games.recordPlay(b.id, 0, new Date(2026, 9, 15, 12, 0)); // no session for zero seconds
    const s = games.playStats(today);
    expect(s.days.map((d) => d.date)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']);
    expect(s.days.map((d) => d.seconds)).toEqual([600, 0, 0, 0, 1800, 0, 3600]);
    expect(s.weekSeconds).toBe(6000);
    expect(s.games).toEqual([{ gameId: a.id, seconds: 5400, sessions: 2 }, { gameId: b.id, seconds: 600, sessions: 1 }]);
    expect(games.get(a.id)!.playtimeSeconds).toBe(5400);
  });

  it('forgets the sessions of a removed game', () => {
    const { games, add } = repo();
    const a = add('Orbit');
    games.recordPlay(a.id, 3600);
    games.remove(a.id);
    expect(games.playStats().weekSeconds).toBe(0);
  });
});

it('keeps calendar days correct across daylight-saving changes and excludes future days', () => {
  const previous = process.env.TZ; process.env.TZ = 'Europe/Berlin';
  try {
    const { games, add } = repo(); const game = add('DST');
    games.recordPlay(game.id, 60, new Date(2026, 2, 30, 12));
    games.recordPlay(game.id, 99, new Date(2026, 3, 2, 12));
    const stats = games.playStats(new Date(2026, 3, 1, 12));
    expect(stats.days.find(d => d.date === '2026-03-30')?.seconds).toBe(60);
    expect(stats.weekSeconds).toBe(60); expect(stats.games[0].seconds).toBe(60);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
