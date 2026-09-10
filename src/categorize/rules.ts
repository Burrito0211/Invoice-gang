/**
 * The free part of the cascade — steps 1 to 4.
 *
 *   1. user_override (scope=item,     key=item_key)   → source 'override'
 *   2. user_override (scope=merchant, key=seller_ban) → source 'override'
 *   3. item_rule (substring of item_key)              → source 'merchant'
 *   4. merchant_rule (ban → name_prefix → name_contains) → source 'merchant'
 *   5. item_category_cache / KV (key=item_key)        → source 'cache'
 *
 * This module is pure: it makes no network calls and takes everything it
 * needs as data. Only `llm.ts` costs anything, and only on a miss here.
 *
 * Item-level rules beat merchant-level ones on purpose — a phone charger
 * bought at 7-ELEVEN is `electronics`, not `groceries`. That ordering is what
 * lets a merchant rule exist for a shop that sells several categories: it
 * only ever catches what no item rule recognised.
 */
import type { CategorySource } from '../types.js';

export interface MerchantRule {
  match_type: 'ban' | 'name_prefix' | 'name_contains';
  pattern: string;
  category_id: number;
  priority: number;
}

/** Matches a substring of the normalized `item_key`. */
export interface ItemRule {
  pattern: string;
  category_id: number;
  priority: number;
}

export interface ResolutionInput {
  itemKey: string;
  sellerBan: string | null;
  sellerName: string | null;
}

export interface RuleContext {
  /** `${scope}:${key}` → category id. */
  overrides: Map<string, number>;
  /** Pre-sorted by priority, then longest pattern — the more specific wins. */
  itemRules: ItemRule[];
  /** Pre-sorted: ban, then name_prefix, then name_contains; `priority` breaks ties. */
  rules: MerchantRule[];
  /** item_key → category id. The cache half that lives in SQL or KV. */
  cache: Map<string, number>;
}

export interface Resolution {
  categoryId: number;
  source: CategorySource;
}

/**
 * First hit wins. Returns `null` when nothing free matched — that is the set
 * the LLM step is handed, and nothing else calls a model.
 */
export function resolve(input: ResolutionInput, ctx: RuleContext): Resolution | null {
  const itemOverride = ctx.overrides.get(`item:${input.itemKey}`);
  if (itemOverride !== undefined) return { categoryId: itemOverride, source: 'override' };

  if (input.sellerBan) {
    const merchantOverride = ctx.overrides.get(`merchant:${input.sellerBan}`);
    if (merchantOverride !== undefined) return { categoryId: merchantOverride, source: 'override' };
  }

  const itemRule = matchItemRule(input.itemKey, ctx.itemRules);
  if (itemRule !== null) return { categoryId: itemRule, source: 'merchant' };

  const rule = matchRule(input, ctx.rules);
  if (rule !== null) return { categoryId: rule, source: 'merchant' };

  const cached = ctx.cache.get(input.itemKey);
  if (cached !== undefined) return { categoryId: cached, source: 'cache' };

  return null;
}

/**
 * `rules` arrives already ordered by specificity (see
 * `listMerchantRules` in db/queries.ts), so the first match is the answer and
 * this loop does no sorting of its own.
 */
export function matchRule(input: ResolutionInput, rules: MerchantRule[]): number | null {
  const name = input.sellerName?.normalize('NFKC').toLowerCase() ?? null;

  for (const rule of rules) {
    const pattern = rule.pattern.normalize('NFKC').toLowerCase();
    switch (rule.match_type) {
      case 'ban':
        if (input.sellerBan !== null && input.sellerBan === rule.pattern) return rule.category_id;
        break;
      case 'name_prefix':
        if (name !== null && name.startsWith(pattern)) return rule.category_id;
        break;
      case 'name_contains':
        if (name !== null && name.includes(pattern)) return rule.category_id;
        break;
    }
  }
  return null;
}

/**
 * First match wins; `itemRules` arrives ordered by priority then by pattern
 * length descending, so `蒸氣眼罩` is consulted before `眼罩` and the more
 * specific rule is the one that answers.
 *
 * `itemKey` is already NFKC-normalized and lowercased, and patterns are
 * normalized here so a rule typed with full-width characters still matches.
 */
export function matchItemRule(itemKey: string, rules: ItemRule[]): number | null {
  const key = itemKey.normalize('NFKC').toLowerCase();
  for (const rule of rules) {
    if (key.includes(rule.pattern.normalize('NFKC').toLowerCase())) return rule.category_id;
  }
  return null;
}

export function overrideKey(scope: 'item' | 'merchant', key: string): string {
  return `${scope}:${key}`;
}
