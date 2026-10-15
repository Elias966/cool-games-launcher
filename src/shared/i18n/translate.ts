// Shared by the window and the main process: texts are written in English and
// looked up in the chosen language's dictionary, keyed by the English text.
import { ar } from './ar';

export type Language = 'en' | 'ar';

/** The text in `lang`; `{name}` placeholders are filled from `vars`. */
export function translate(lang: Language, en: string, vars?: Record<string, string | number | null | undefined>): string {
  let s = lang === 'ar' ? ar[en] ?? en : en;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k] ?? '') : `{${k}}`));
  return s;
}
