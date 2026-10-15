// Messages from the launcher itself (notifications, AI status, tray menu) in the
// language chosen in Settings → Appearance. Error details from tools and websites stay as they are.
import { translate, type Language } from '@shared/i18n/translate';

let lang: Language = 'en';
const listeners = new Set<() => void>();

export function setMainLanguage(l: Language) {
  if (l === lang) return;
  lang = l;
  for (const fn of listeners) fn();
}

/** Calls `fn` whenever the language changes. */
export function onLanguage(fn: () => void) {
  listeners.add(fn);
}

export function tm(en: string, vars?: Record<string, string | number | null | undefined>): string {
  return translate(lang, en, vars);
}
