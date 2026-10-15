// Interface language. Texts are written in English and looked up in the
// Arabic dictionary when Arabic is chosen (Settings → Appearance); the layout
// then runs right to left. Text that comes from websites stays as it is.
import { ar } from './i18n/ar';

export type Language = 'en' | 'ar';
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
export function t(en: string, vars?: Record<string, string | number>): string {
  let s = lang === 'ar' ? ar[en] ?? en : en;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
  return s;
}

/** Numbers and dates in the chosen language's format. */
export function locale(): string {
  return lang === 'ar' ? 'ar' : 'en';
}
