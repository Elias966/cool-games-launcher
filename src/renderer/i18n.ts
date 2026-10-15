// Interface language. Texts are written in English and looked up in the
// Arabic dictionary when Arabic is chosen (Settings → Appearance); the layout
// then runs right to left. Text that comes from websites stays as it is.
import { translate, type Language } from '@shared/i18n/translate';

export type { Language };
let lang: Language = 'en';

export function setLanguage(l: Language) {
  lang = l;
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
}

export function language(): Language {
  return lang;
}

/** The text in the chosen language; `{name}` placeholders are filled from `vars`. */
export function t(en: string, vars?: Record<string, string | number | null | undefined>): string {
  return translate(lang, en, vars);
}

/** Numbers and dates in the chosen language's format (Arabic keeps Western digits). */
export function locale(): string {
  return lang === 'ar' ? 'ar-u-nu-latn' : 'en';
}

/** Marks a text kept in a table as translatable; t() translates it where it is shown. */
export const tk = (en: string) => en;

/** "2.5 h played", "Not played yet" … in the chosen language. */
export function playtime(seconds: number): string {
  if (seconds <= 0) return t('Not played yet');
  if (seconds < 60) return t('Played under a minute');
  const h = seconds / 3600;
  return h < 1 ? t('{n} min played', { n: Math.round(seconds / 60) }) : t('{n} h played', { n: h.toFixed(1) });
}

/** A short span of time: "45 min", "2.5 h". */
export function hours(seconds: number): string {
  if (seconds < 3600) return t('{n} min', { n: Math.max(seconds > 0 ? 1 : 0, Math.round(seconds / 60)) });
  return t('{n} h', { n: (seconds / 3600).toFixed(1).replace(/\.0$/, '') });
}

/** Time left on a transfer: "45 s", "3 min 20 s", "1 h 5 min". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return t('{s} s', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('{m} min {s} s', { m, s: s % 60 });
  return t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 });
}

const PLATFORM: Record<string, string> = { linux: tk('Linux'), windows: tk('Windows'), macos: tk('macOS'), android: tk('Android'), web: tk('Browser') };

export function platformName(p: string): string {
  return PLATFORM[p] ? t(PLATFORM[p]) : p;
}
