// Shared by the window and the main process: texts are written in English and
// looked up in the chosen language's dictionary, keyed by the English text.
import { ar } from './ar';

export type Language = 'en' | 'ar';

/** The text in `lang`; `{name}` placeholders are filled from `vars`. */
export function translate(lang: Language, en: string, vars?: Record<string, string | number | null | undefined>): string {
  const rtl = lang === 'ar';
  let s = rtl ? ar[en] ?? en : en;
  // In right-to-left text each value keeps its own direction ("319 KB", not "KB 319").
  const fill = (v: string) => (rtl && v ? `\u2068${v}\u2069` : v);
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? fill(String(vars[k] ?? '')) : `{${k}}`));
  return s;
}
