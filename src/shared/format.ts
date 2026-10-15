export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatSpeed(bps: number): string {
  return bps > 0 ? `${formatBytes(bps)}/s` : '—';
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatPlaytime(seconds: number): string {
  if (seconds <= 0) return 'Not played yet';
  if (seconds < 60) return 'Played under a minute';
  const h = seconds / 3600;
  return h < 1 ? `${Math.round(seconds / 60)} min played` : `${h.toFixed(1)} h played`;
}

export function platformLabel(p: string): string {
  return { linux: 'Linux', windows: 'Windows', macos: 'macOS', android: 'Android', web: 'Browser' }[p] ?? p;
}
