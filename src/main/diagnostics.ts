// "Create diagnostics file": one readable text file with what is needed to
// understand a problem — versions, system, settings, websites, recent
// downloads and their errors, games, and the end of the logs. The home folder
// is shortened to "~"; nothing is sent anywhere.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus, homedir, release, totalmem } from 'node:os';
import { join } from 'node:path';
import type { StoreJob } from '@shared/types';
import type { DownloadsRepo, GamesRepo, SettingsRepo, SourcesRepo } from './repos';

function tail(file: string, lines: number): string {
  try {
    const text = readFileSync(file, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch { return '(not available)'; }
}

function downloadsFolder(): string {
  try {
    const dir = execFileSync('xdg-user-dir', ['DOWNLOAD'], { encoding: 'utf8' }).trim();
    if (dir && existsSync(dir)) return dir;
  } catch { /* fall back */ }
  const d = join(homedir(), 'Downloads');
  return existsSync(d) ? d : homedir();
}

export function writeDiagnostics(p: {
  version: string; logsDir: string; ai: unknown; settings: SettingsRepo; sources: SourcesRepo; downloads: DownloadsRepo; games: GamesRepo; storeJobs?: StoreJob[];
}): string {
  const osName = (() => { try { return /PRETTY_NAME="?([^"\n]+)/.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? 'Linux'; } catch { return 'Linux'; } })();
  const section = (title: string, body: unknown) => `\n===== ${title} =====\n${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}\n`;
  const games = p.games.list();
  const recentLogs = existsSync(p.logsDir)
    ? readdirSync(p.logsDir).filter((f) => /^game-\d+.*\.log$/.test(f)).map((f) => ({ f, t: statSync(join(p.logsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 3)
    : [];
  let text = `Cool Games Launcher diagnostics — ${new Date().toISOString()}\n`;
  text += section('Launcher and system', { version: p.version, os: osName, kernel: release(), cpu: `${cpus()[0]?.model} × ${cpus().length}`, memoryGb: Math.round(totalmem() / 1024 ** 3), appImage: !!process.env.APPIMAGE, ai: p.ai });
  text += section('Settings', p.settings.get());
  text += section('Websites', p.sources.list().map((s) => ({ name: s.name, url: s.url, enabled: s.enabled, status: s.status, detail: s.statusDetail, lastCrawlAt: s.lastCrawlAt, recipe: p.sources.recipe(s.id) })));
  text += section('Recent downloads', p.downloads.list().slice(-40).map((d) => ({
    id: d.id, title: d.title, state: d.state, error: d.errorCode, errorDetail: d.errorDetail, install: d.installState, installDetail: d.installDetail,
    file: d.fileName, bytes: d.totalBytes, received: d.receivedBytes, part: d.groupId ? `${d.partIndex}/${d.partTotal ?? '?'} of ${d.groupId}` : null, resolution: d.resolution ? { page: d.resolution.pageUrl, steps: d.resolution.steps, last: d.resolution.history.slice(-8) } : null,
  })));
  text += section('Games', games.map((g) => ({ id: g.id, title: g.title, kind: g.kind, runner: g.runner, status: g.status, store: g.store, storeId: g.storeId, storeBuild: g.storeBuild, installDir: g.installDir, executable: g.executable, launch: g.launch, runtimes: g.redistDone, update: g.update, playtimeSeconds: g.playtimeSeconds })));
  text += section('Store transfers', p.storeJobs ?? []);
  for (const l of recentLogs) text += section(`Game log ${l.f} (last 120 lines)`, tail(join(p.logsDir, l.f), 120));
  text += section('Launcher log (last 1500 lines)', tail(join(p.logsDir, 'launcher.log'), 1500));
  const home = homedir();
  text = text.split(home).join('~');
  const out = join(downloadsFolder(), `cool-games-launcher-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`);
  writeFileSync(out, text);
  return out;
}
