/**
 * The dictionaries, checked against each other and against the markup.
 *
 * A missing translation does not throw — it falls back to English so the page
 * still works — which is the right runtime behaviour and exactly why it needs
 * a test: the failure is a Chinese screen with one English sentence on it, and
 * nobody notices until they are looking at it.
 *
 * These are the three ways that happens: a key in one language and not the
 * other, a key used in the markup or the code that no dictionary has, and a
 * translation that quietly drops one of the numbers the sentence was carrying.
 *
 * This imports `strings.ts` rather than `i18n.ts` — the phrases are pure data,
 * and keeping them out of the module that touches `document` is what makes
 * them reachable from a test suite running in node.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DICT, resolve } from '../web/src/strings.js';
import type { Phrase } from '../web/src/strings.js';

const here = dirname(fileURLToPath(import.meta.url));
const web = (...parts: string[]) => join(here, '..', 'web', ...parts);

const INDEX_HTML = readFileSync(web('index.html'), 'utf8');
const MAIN_TS = readFileSync(web('src', 'main.ts'), 'utf8');

/**
 * Resolves a phrase to its template, plural functions included, so the
 * `{placeholders}` inside can be compared across languages. The params are a
 * superset — the functions only read a count to pick a word.
 */
function template(phrase: Phrase): string {
  return typeof phrase === 'function' ? phrase({ n: 2, total: 2 }) : phrase;
}

function placeholders(phrase: Phrase): string[] {
  return [...template(phrase).matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
}

describe('the two dictionaries', () => {
  it('have exactly the same keys', () => {
    const zh = Object.keys(DICT.zh).sort();
    const en = Object.keys(DICT.en).sort();

    expect(zh.filter((k) => !DICT.en[k])).toEqual([]); // translated but never used
    expect(en.filter((k) => !DICT.zh[k])).toEqual([]); // used but never translated
    expect(zh).toEqual(en);
  });

  it('carry the same values through each sentence', () => {
    for (const key of Object.keys(DICT.en)) {
      expect(
        placeholders(DICT.zh[key] as Phrase),
        `${key} does not use the same values in both languages`,
      ).toEqual(placeholders(DICT.en[key] as Phrase));
    }
  });

  it('leave no phrase empty', () => {
    for (const [language, dict] of Object.entries(DICT)) {
      for (const [key, phrase] of Object.entries(dict)) {
        expect(template(phrase).trim(), `${language}.${key} is empty`).not.toBe('');
      }
    }
  });
});

describe('keys used by the app', () => {
  it('are all defined for every key in the markup', () => {
    const used = [...INDEX_HTML.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)].map(
      (m) => m[1] as string,
    );

    expect(used.length).toBeGreaterThan(20); // the markup really was scanned
    for (const key of used) {
      expect(DICT.zh[key], `index.html uses ${key}, which zh does not define`).toBeDefined();
      expect(DICT.en[key], `index.html uses ${key}, which en does not define`).toBeDefined();
    }
  });

  it('are all defined for every literal t() call in the dashboard', () => {
    const used = [...MAIN_TS.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1] as string);

    expect(used.length).toBeGreaterThan(40);
    for (const key of used) {
      expect(DICT.zh[key], `main.ts calls t('${key}'), which zh does not define`).toBeDefined();
      expect(DICT.en[key], `main.ts calls t('${key}'), which en does not define`).toBeDefined();
    }
  });

  /**
   * `sourceLabel` builds its key from a `category_source` column value, so no
   * literal appears in the source for the check above to find. The set is
   * fixed by the schema comment on `invoice_item.category_source`.
   */
  it('cover every category_source the schema can produce', () => {
    for (const source of ['override', 'merchant', 'cache', 'llm', 'none']) {
      expect(DICT.zh[`source.${source}`]).toBeDefined();
      expect(DICT.en[`source.${source}`]).toBeDefined();
    }
  });
});

describe('resolve', () => {
  it('substitutes named values', () => {
    expect(resolve('en', 'budget.of', { amount: 'NT$20,000' })).toBe('of NT$20,000');
    expect(resolve('zh', 'budget.of', { amount: 'NT$20,000' })).toBe('共 NT$20,000');
  });

  it('picks the English plural from the count, and Chinese needs none', () => {
    expect(resolve('en', 'bars.items', { n: 1 })).toBe('1 item');
    expect(resolve('en', 'bars.items', { n: 9 })).toBe('9 items');
    expect(resolve('zh', 'bars.items', { n: 1 })).toBe('1 筆');
    expect(resolve('zh', 'bars.items', { n: 9 })).toBe('9 筆');
  });

  it('returns the key rather than nothing when one is missing', () => {
    expect(resolve('zh', 'nope.not.a.key')).toBe('nope.not.a.key');
  });

  it('leaves an unsupplied placeholder visible instead of blanking it', () => {
    // Better a visible {amount} in one sentence than a sentence that reads as
    // though the number were genuinely nothing.
    expect(resolve('en', 'budget.of')).toBe('of {amount}');
  });
});
