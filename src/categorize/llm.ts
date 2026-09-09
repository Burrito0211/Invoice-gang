/**
 * Step 5 of the cascade: the only part that costs money.
 *
 * `claude-haiku-4-5-20251001`. Short input, fixed small output, high volume,
 * no reasoning required — the cheap model is the correct model here, and
 * reaching for a larger one is paying for capability the task does not use.
 * Before upgrading the model to chase accuracy, check whether the misses are
 * a prompt or a taxonomy problem; they usually are.
 *
 * Two things are non-negotiable in this file:
 *
 *   - **Batch.** Per-item cost is dominated by prompt overhead, so a batched
 *     call is roughly 20–40x cheaper per item with no accuracy benefit.
 *   - **Validate every returned key against the `category` table.** An
 *     unrecognized key is a bug, not a new category. This is the boundary
 *     that stops a model response from writing arbitrary strings into the
 *     data.
 *
 * Failure is not fatal. A model error leaves the items uncategorized with
 * source `none` and the next run retries them; categorization never blocks
 * the sync.
 */
import { upsertCacheStatement } from '../db/queries.js';
import type { Category, Unix } from '../types.js';

export const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** One distinct unseen key, with the merchant it was bought from as context. */
export interface UnseenItem {
  itemKey: string;
  /** A raw description that produced this key — what the model actually reads. */
  sampleDesc: string;
  sellerName: string | null;
}

export interface Classification {
  itemKey: string;
  categoryKey: string;
  confidence: number;
}

export interface ClassifyResult {
  classifications: Classification[];
  /** Model calls made. Recorded on `sync_run` — this is the cost story. */
  calls: number;
  /** Items sent to the model. `calls` vs this is the batching evidence. */
  itemsSent: number;
  /** Keys the model returned that are not in the taxonomy. A bug, logged. */
  invalidKeys: string[];
  error: string | null;
}

export interface ClassifyOptions {
  apiKey: string;
  batchSize: number;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Structured output via tool use. `strict: true` (which requires
 * `additionalProperties: false` and a `required` list at every level)
 * guarantees the arguments validate against this schema, so the only
 * validation left to do here is the one the schema cannot express: whether
 * `category` is a key that actually exists in the `category` table.
 */
const TOOL = {
  name: 'classify_items',
  description: 'Assign every supplied purchase line item to exactly one spending category.',
  strict: true,
  input_schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'integer', description: 'The id of the input item being classified.' },
            category: { type: 'string', description: 'One category key from the taxonomy.' },
            confidence: { type: 'number', description: '0 to 1.' },
          },
          required: ['id', 'category', 'confidence'],
        },
      },
    },
    required: ['items'],
  },
};

export async function classifyItems(
  unseen: UnseenItem[],
  categories: Category[],
  options: ClassifyOptions,
): Promise<ClassifyResult> {
  const result: ClassifyResult = {
    classifications: [],
    calls: 0,
    itemsSent: 0,
    invalidKeys: [],
    error: null,
  };
  if (unseen.length === 0) return result;

  const valid = new Set(categories.map((c) => c.key));
  const model = options.model ?? CLASSIFIER_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const system = buildSystemPrompt(categories);

  for (const batch of chunk(unseen, Math.max(1, options.batchSize))) {
    try {
      const raw = await callModel(batch, system, model, options.apiKey, fetchImpl);
      result.calls += 1;
      result.itemsSent += batch.length;

      for (const answer of raw) {
        const item = batch[answer.id];
        if (!item) continue; // an id we did not send is not an answer to anything

        if (!valid.has(answer.category)) {
          // Never invent a category. Fall back and record it as the bug it is.
          result.invalidKeys.push(answer.category);
          result.classifications.push({
            itemKey: item.itemKey,
            categoryKey: 'uncategorized',
            confidence: 0,
          });
          continue;
        }

        result.classifications.push({
          itemKey: item.itemKey,
          categoryKey: answer.category,
          confidence: clamp01(answer.confidence),
        });
      }
    } catch (err) {
      // One failed batch does not abandon the others, and no failure here is
      // allowed to reach the sync as an exception.
      result.error = err instanceof Error ? err.message : String(err);
    }
  }

  return result;
}

function buildSystemPrompt(categories: Category[]): string {
  // The taxonomy is pasted from the `category` table, keys first. The model
  // returns keys; no code anywhere string-matches on a display label.
  const taxonomy = categories
    .map((c) => `- ${c.key}: ${c.label_en} / ${c.label_zh}`)
    .join('\n');

  return [
    'You classify line items from Taiwanese electronic invoices (電子發票) into',
    'spending categories.',
    '',
    'The text is raw merchant point-of-sale output. Expect full-width characters,',
    'missing spaces, truncation, product codes, and inconsistent casing. Classify',
    'what the item most likely is; do not try to clean the text up.',
    '',
    'Categories — return the key on the left, never the label:',
    taxonomy,
    '',
    'Rules:',
    '- Return exactly one category per input item, and one entry per input id.',
    '- Use the merchant name as a signal: 咖啡 at a bookstore and at a café differ.',
    '- Use "uncategorized" only when the text carries no usable signal at all.',
    '- confidence is 0 to 1: how sure you are, not how common the item is.',
  ].join('\n');
}

interface ModelAnswer {
  id: number;
  category: string;
  confidence: number;
}

async function callModel(
  batch: UnseenItem[],
  system: string,
  model: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<ModelAnswer[]> {
  const payload = batch.map((item, id) => ({
    id,
    item: item.sampleDesc,
    merchant: item.sellerName ?? '',
  }));

  const response = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model,
      // ~25 output tokens per item; this clears a full batch with room to
      // spare, and truncation here would silently drop the tail of a batch.
      max_tokens: 8192,
      system,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }),
  });

  if (!response.ok) {
    throw new Error(`anthropic HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const body = (await response.json()) as {
    content?: { type: string; name?: string; input?: unknown }[];
  };
  const toolUse = body.content?.find((c) => c.type === 'tool_use' && c.name === TOOL.name);
  if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
    throw new Error('model returned no tool_use block');
  }

  const items = (toolUse.input as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error('model returned no items array');

  const answers: ModelAnswer[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const id = Number(row.id);
    const category = typeof row.category === 'string' ? row.category.trim() : '';
    if (!Number.isInteger(id) || category === '') continue;
    answers.push({ id, category, confidence: Number(row.confidence) });
  }
  return answers;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// ------------------------------------------------------------ cache write

/**
 * The model call and the cache write are one code path on purpose. Every
 * answer this file produces is immediately demoted to a step-4 answer for
 * every future occurrence of the same key, so no string is ever classified
 * twice. Splitting these apart is how a cache quietly stops being written to.
 *
 * Both halves are written: KV is the hot read path, the table exists so the
 * cache is inspectable, rebuildable, and countable in SQL.
 */
export async function classifyAndCache(
  db: D1Database,
  kv: KVNamespace,
  unseen: UnseenItem[],
  categories: Category[],
  options: ClassifyOptions,
  now: Unix,
): Promise<ClassifyResult & { assignments: Map<string, { categoryId: number; confidence: number }> }> {
  const result = await classifyItems(unseen, categories, options);
  const byKey = new Map(categories.map((c) => [c.key, c]));
  const sampleByKey = new Map(unseen.map((u) => [u.itemKey, u.sampleDesc]));
  const model = options.model ?? CLASSIFIER_MODEL;

  const assignments = new Map<string, { categoryId: number; confidence: number }>();
  const writes: D1PreparedStatement[] = [];

  for (const c of result.classifications) {
    const category = byKey.get(c.categoryKey);
    if (!category) continue; // already counted as invalid above
    assignments.set(c.itemKey, { categoryId: category.id, confidence: c.confidence });
    writes.push(
      upsertCacheStatement(db, {
        itemKey: c.itemKey,
        categoryId: category.id,
        confidence: c.confidence,
        model,
        sampleDesc: sampleByKey.get(c.itemKey) ?? c.itemKey,
        now,
      }),
    );
  }

  if (writes.length > 0) await db.batch(writes);
  await Promise.all(
    result.classifications.map((c) => kv.put(kvKey(c.itemKey), c.categoryKey)),
  );

  return { ...result, assignments };
}

/** KV holds the category *key*, not the id, so it survives a database rebuild. */
export function kvKey(itemKey: string): string {
  return `itemcat:${itemKey}`;
}
