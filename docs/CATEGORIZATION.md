# CATEGORIZATION

Turning `茶?綠 M` into `drinks`, cheaply, and getting better over time.

## The cascade

Resolution order for one item. First hit wins, and every step before the last
is free:

```
1. user_override (scope=item,     key=item_key)        → source 'override'
2. user_override (scope=merchant, key=seller_ban)      → source 'override'
3. merchant_rule (ban → name_prefix → name_contains)   → source 'merchant'
4. item_category_cache / KV (key=item_key)             → source 'cache'
5. LLM batch classify → write to cache                 → source 'llm'
6. uncategorized                                       → source 'none'
```

Steps 1–4 are a pure function of the database and never touch the network.
Only step 5 costs anything, and its result is immediately demoted to a step-4
answer for every future occurrence. **In steady state almost every item is
resolved by step 3 or 4** — that is the design working, and the hit rate on the
stats page is the evidence.

Note that item-level rules (1) beat merchant-level ones (2, 3): buying a phone
charger at 7-ELEVEN should be `electronics`, not `groceries`. Merchant rules
are the fallback for merchants whose entire inventory is one category, which is
most of them.

## `item_key` normalization

The cache key. Getting this wrong is the main way the cache underperforms —
too strict and every trivial spelling variant is a fresh model call; too loose
and distinct products collapse into one wrong answer.

```
NFKC normalize          full-width → half-width, so ＡＢＣ and ABC agree
lowercase
collapse whitespace     including the full-width space U+3000
trim
strip a leading POS product code:  /^[0-9]{6,}\s+/
```

Deliberately **not** stripped: sizes (`M`, `大`, `500ml`) and flavors. They
distinguish real products and they cost nothing to keep. Deliberately not
attempted: fuzzy matching, stemming, edit distance. If two spellings of the
same product both get classified correctly, having two cache entries is fine —
the cache is not the product.

Store both: `description` keeps the raw string forever (it is the source of
truth and what gets displayed), `item_key` is derived and can be recomputed by
a migration if the normalizer changes.

## The LLM step

Model `claude-haiku-4-5-20251001`. Short input, fixed small output, high
volume, no reasoning required — the cheap model is the correct model here, and
reaching for a larger one is paying for capability the task does not use.

**Batch.** Collect all distinct unseen `item_key`s from the run and classify up
to `LLM_BATCH_SIZE` (start at 50) per call. The per-item cost of a single-item
call is dominated by the prompt overhead, so batching is roughly a 20–40x cost
reduction — call it out in the README with the measured number.

**Prompt shape.** System prompt states the task and pastes the taxonomy from
the `category` table (keys, not labels — the model returns keys, the code never
string-matches on a display label). Provide the merchant name alongside each
item, since `咖啡` at a bookstore and at a café are different signals. Use tool
use / structured output for a JSON array of `{item, category, confidence}`.

**Validate every returned key against the `category` table.** An unrecognized
key is a bug, not a new category — map it to `uncategorized` and log it. This
is the boundary that keeps a model response from writing arbitrary strings into
the data.

**Confidence.** Store it. Anything below ~0.6 still gets applied but is what the
"review low-confidence items" list in the dashboard is sorted by — the fastest
path to correcting the system is to look at what it was unsure about.

**Failure is not fatal.** A model error leaves items uncategorized with source
`none`; the next run retries them. Categorization never blocks the sync.

## The correction loop

The feature that makes this a system rather than a demo.

Clicking a category on an item offers two scopes:

- **this item everywhere** → `user_override(scope='item', key=item_key)`
- **everything from this merchant** → `user_override(scope='merchant', key=seller_ban)`

Writing an override must **re-resolve every affected existing item immediately**,
not just future ones. A correction that only applies going forward feels broken,
because the chart the user is staring at does not change.

```sql
UPDATE invoice_item
SET category_id = :cat, category_source = 'override', categorized_at = :now
WHERE item_key = :key;
```

Overrides also poison the cache entry for that key — delete it from KV and the
cache table, so the model's wrong answer is not still sitting there for a
future rebuild.

## Seeding the rule table

Do not hand-write rules up front. Sync a month of real data first, then:

```sql
SELECT i.seller_ban, i.seller_name, COUNT(*) n, SUM(it.amount) total
FROM invoice_item it JOIN invoice i ON i.inv_num = it.inv_num
WHERE it.category_source IN ('llm','none')
GROUP BY i.seller_ban ORDER BY n DESC LIMIT 30;
```

Write rules for the top of that list. Twenty rules will cover the large
majority of items, because personal spending is extremely concentrated in a
handful of merchants. Re-run the query monthly; it is the maintenance loop.

## Measuring it

Surface on a stats page, computed from `sync_run` totals and the item table:

- **cache hit rate** = `cache_hits / (cache_hits + llm_items)` — the headline
  number, target > 90% in steady state
- **items per model call** — shows the batching is working
- **uncategorized share by value** — the accuracy number that actually matters
- **cumulative model spend** — small, and the point is that it is small

These four numbers are what makes the design legible to someone reading the
repo. Put them on the dashboard, not just in the README.
