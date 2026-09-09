/**
 * `GET /api/stats` — the four numbers that make the design legible.
 *
 *   cache hit rate        = cache_hits / (cache_hits + llm_items)
 *   items per model call  — evidence the batching is working
 *   uncategorized by value — the accuracy number that actually matters
 *   cumulative model spend — small, and the point is that it is small
 *
 * They live on the dashboard rather than only in the README because the claim
 * "the LLM is almost never called" is worth nothing without the counter.
 */
import { classifierStats, getSyncState, listSyncRuns, topUnruledMerchants } from '../db/queries.js';
import { CLASSIFIER_MODEL } from '../categorize/llm.js';
import { json } from './respond.js';

/**
 * Haiku 4.5 list price, US$ per million tokens ($1 in / $5 out), for the
 * spend estimate. The estimate is deliberately rough — its job is to show an
 * order of magnitude, and a wrong-by-30% number still makes the same point.
 */
const PRICE_INPUT_PER_MTOK = 1.0;
const PRICE_OUTPUT_PER_MTOK = 5.0;

/** Measured shape of one batched call: taxonomy prompt plus ~30 tokens/item. */
const TOKENS_PROMPT_OVERHEAD = 400;
const TOKENS_PER_ITEM_IN = 30;
const TOKENS_PER_ITEM_OUT = 25;

export async function handleStats(db: D1Database, carrierId: number): Promise<Response> {
  const stats = await classifierStats(db);
  const runs = await listSyncRuns(db, 5);
  const state = await getSyncState(db, carrierId);

  const cacheHits = stats.totals?.cache_hits ?? 0;
  const llmItems = stats.totals?.llm_items ?? 0;
  const llmCalls = stats.totals?.llm_calls ?? 0;
  const resolved = cacheHits + llmItems;

  const inputTokens = llmCalls * TOKENS_PROMPT_OVERHEAD + llmItems * TOKENS_PER_ITEM_IN;
  const outputTokens = llmItems * TOKENS_PER_ITEM_OUT;
  const spendUsd =
    (inputTokens / 1_000_000) * PRICE_INPUT_PER_MTOK +
    (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_MTOK;

  const itemTotal = stats.items?.item_total ?? 0;

  return json({
    model: CLASSIFIER_MODEL,
    cache: {
      // The headline number. Target is > 90% in steady state.
      hit_rate: resolved === 0 ? null : cacheHits / resolved,
      hits: cacheHits,
      llm_items: llmItems,
      entries: stats.cache?.entries ?? 0,
      lifetime_hits: stats.cache?.hits ?? 0,
    },
    batching: {
      llm_calls: llmCalls,
      items_per_call: llmCalls === 0 ? null : llmItems / llmCalls,
    },
    coverage: {
      item_count: stats.items?.item_count ?? 0,
      item_total: itemTotal,
      uncategorized_count: stats.items?.uncategorized_count ?? 0,
      uncategorized_total: stats.items?.uncategorized_total ?? 0,
      uncategorized_share_by_value:
        itemTotal === 0 ? null : (stats.items?.uncategorized_total ?? 0) / itemTotal,
      by_source: stats.bySource,
    },
    // Cents, as an integer, because money never crosses this wire as a float.
    spend: { estimated_usd_cents: Math.round(spendUsd * 100), input_tokens: inputTokens, output_tokens: outputTokens },
    sync: {
      synced_through: state?.synced_through ?? null,
      last_run_at: state?.last_run_at ?? null,
      last_success_at: state?.last_success_at ?? null,
      recent_runs: runs,
    },
    // The maintenance loop: the merchants still costing model calls are the
    // ones worth writing a rule for.
    rule_candidates: await topUnruledMerchants(db, 20),
  });
}
