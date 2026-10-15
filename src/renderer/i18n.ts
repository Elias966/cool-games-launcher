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
