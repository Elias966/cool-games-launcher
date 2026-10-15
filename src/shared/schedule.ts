// Download hours: a daily time window in local time, which may cross midnight
// ("23:00"–"07:00"). Equal start and end mean the whole day.

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h % 24) * 60 + (m % 60);
};

export function inWindow(now: Date, start: string, end: string): boolean {
  const s = minutes(start), e = minutes(end), m = now.getHours() * 60 + now.getMinutes();
  if (s === e) return true;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** The next time the window opens, at or after `now`. */
export function nextOpening(now: Date, start: string): Date {
  const s = minutes(start);
  const at = new Date(now);
  at.setHours(Math.floor(s / 60), s % 60, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** The next time the window closes, after `now`. */
export function nextClosing(now: Date, end: string): Date {
  return nextOpening(now, end);
}
