/**
 * The browser half of translation: which language is current, how that is
 * remembered, and filling the static markup.
 *
 * The phrases themselves are in `strings.ts`, which is pure and knows nothing
 * about the DOM — that split is what lets the dictionaries be tested without a
 * browser, and a half-translated screen is exactly the kind of bug that only a
 * test catches, because at runtime a missing key falls back to English and the
 * page keeps working.
 */
import { labelIn, monthNameIn, resolve } from './strings.js';
import type { Locale, Params } from './strings.js';

export type { Locale, Params } from './strings.js';

const STORAGE_KEY = 'invoice-gang.locale';

/**
 * Traditional Chinese is the default when the browser asks for any Chinese —
 * the data is Taiwanese, the merchant names and product descriptions arrive in
 * Chinese regardless, and an English chrome around Chinese content reads worse
 * than either language on its own.
 */
function detect(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') return stored;
  } catch {
    // Private windows and blocked site data both throw here; the default is
    // still correct, so this is not worth surfacing.
  }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let current: Locale = detect();

export function locale(): Locale {
  return current;
}

export function setLocale(next: Locale): void {
  current = next;
  document.documentElement.lang = next === 'zh' ? 'zh-Hant' : 'en';
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The choice still applies to this page; it just will not survive a reload.
  }
}

export const t = (key: string, params: Params = {}): string => resolve(current, key, params);

export const label = (row: { label_en: string; label_zh?: string }): string =>
  labelIn(current, row);

export const monthName = (month: string): string => monthNameIn(current, month);

/**
 * Fills every element carrying a `data-i18n` key. Static markup keeps its
 * strings in the HTML as keys rather than as English, so there is exactly one
 * place a phrase can live and no screen is half-translated.
 */
export function applyStaticStrings(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n ?? '');
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
    (el as HTMLInputElement).placeholder = t(el.dataset.i18nPlaceholder ?? '');
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle ?? '');
  }
}
