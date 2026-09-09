/**
 * `item_key` derivation — the cache key.
 *
 * Getting this wrong is the main way the cache underperforms. Too strict and
 * every trivial spelling variant is a fresh model call; too loose and distinct
 * products collapse into one wrong answer.
 *
 * Deliberately kept: sizes (`M`, `大`, `500ml`) and flavors. They distinguish
 * real products and they cost nothing to keep.
 *
 * Deliberately not attempted: fuzzy matching, stemming, edit distance. If two
 * spellings of the same product both classify correctly, two cache entries is
 * a fine outcome — the cache is not the product.
 *
 * `description` keeps the raw string forever; `item_key` is derived and can be
 * recomputed by a migration if this function changes.
 */

/** Full-width space, and the rest of the Unicode space zoo POS systems emit. */
const WHITESPACE = /[\s　 ​]+/g;

/** A leading POS product code: six or more digits and the space after it. */
const LEADING_PRODUCT_CODE = /^[0-9]{6,}\s+/;

export function itemKey(description: string): string {
  let key = description.normalize('NFKC'); // ＡＢＣ and ABC must agree
  key = key.toLowerCase();
  key = key.replace(WHITESPACE, ' ');
  key = key.trim();
  key = key.replace(LEADING_PRODUCT_CODE, '');
  key = key.trim();
  return key;
}
