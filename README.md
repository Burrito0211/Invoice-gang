# Invoice Gang

A personal accounting system built on Taiwan's 電子發票 (e-invoice) API.

Every purchase in Taiwan already produces a structured, itemized record filed
with the Ministry of Finance and carried on a 手機條碼 barcode. That record is
complete and completely unused. Manual expense apps fail because they require
typing; this data requires nobody to type anything, and it is already mine.

A Cloudflare Worker wakes on a cron trigger, pulls new invoices for one carrier
from the MOF API, stores headers and line items in D1, and assigns each line
item a spending category — using a deterministic rule table first and a model
only for merchandise it has never seen, caching that answer forever against the
raw product string. A small dashboard charts the result and lets the owner
correct any categorization, which persists as a rule that outranks everything
else. Once per invoice period it checks the official prize numbers against
stored invoices.

The unit of analysis is the **item**, not the invoice. "I spent NT$4,200 at
7-ELEVEN this month" is useless; "NT$1,800 of it was coffee" is the product.

---

## Status

Milestones M1–M6 are implemented; **Milestone 0 is not done.** No call has ever
been made against the live MOF API from this repository. Every field name in
`docs/EINVOICE-API.md` is still tagged `[assumed]`, which is why
`src/einvoice/parse.ts` probes a list of candidate spellings per field instead
of indexing the response directly — see `docs/api-samples/README.md` for what
finishing M0 involves and what it changes.

Everything downstream of the parser is tested and does not depend on those
names being right.

---

## The sync design

This is the interesting part of the project, so it is explained here rather
than left in the source. Two facts about the data source force the entire
design:

**Invoices arrive late.** A merchant may file days after the purchase. A window
that always ends at "today" and starts at "wherever I finished last time" will
skip anything that lands behind the watermark — permanently and silently.

**Details are per-invoice and rate limited.** There is no bulk endpoint for
line items: one HTTP call per invoice, against a daily quota whose size is not
published. A month of ordinary spending is a few hundred invoices, so details
cannot be fetched inline with the headers, and a year of history cannot be
backfilled in one run.

Both are solved the same way: **a run is never treated as authoritative and
complete.** A run makes progress, and the invariants hold no matter where it
stops.

### Phase 1 — headers, with an overlap re-scan

```
start = (synced_through ?? carrier.created_at) − SYNC_OVERLAP_DAYS
end   = min(start + SYNC_WINDOW_DAYS, today)
```

Every run re-reads the last week of already-synced dates. A late-filed invoice
in that period gets picked up; an already-known one collides on the primary key
and updates harmlessly. The upsert touches `inv_status`, `amount`,
`seller_name` and `updated_at` — and deliberately *not* `detail_fetched_at` or
`first_seen_at`, which is what stops the re-scan from re-queueing details for
every invoice in the window on every single run.

The watermark advances only after a chunk's headers are committed, never before
the call that produced them.

### Phase 2 — the detail queue

The queue is not a table. It is a query:

```sql
SELECT ... FROM invoice
WHERE detail_fetched_at IS NULL AND detail_attempts < 5
ORDER BY inv_date DESC LIMIT :budget;
```

Newest first, because recent spending is what the dashboard is asked about and
a long backfill should not delay this month's data. Per invoice:

- **rows returned** → insert items (`INSERT OR IGNORE` on `(inv_num, row_num)`),
  mark fetched
- **zero rows** → *do not* mark fetched. Details can lag behind headers, so
  marking it complete would make the miss permanent. Count the attempt; the cap
  of five is what stops a genuinely empty invoice from being retried forever
- **error** → count the attempt, store a scrubbed message, continue. One bad
  invoice never aborts a run
- **quota** → stop the phase, commit, return status `quota`. Not an error

### Phase 3 — categorization

A cascade, in which every step but the last is free:

| # | Source | Cost |
|---|---|---|
| 1 | `user_override` on the item key | free |
| 2 | `user_override` on the merchant's 統一編號 | free |
| 3 | `merchant_rule` (BAN → name prefix → name contains) | free |
| 4 | the item→category cache, keyed by normalized description | free |
| 5 | batched model call, written straight back to the cache | the only cost |
| 6 | uncategorized | free |

Item-level rules beat merchant-level ones on purpose: a phone charger bought at
7-ELEVEN is `electronics`, not `groceries`.

### Phase 4 — prizes

Cheap and occasional: the winning numbers change six times a year, so they are
fetched once per period and cached. A hit writes `prize_hit`, notifies, and
stamps `notified_at`, so a re-run cannot notify twice.

---

## The five invariants

Any change to `src/sync/` must keep all five holding, and
`test/sync-invariants.test.ts` asserts each one directly:

1. **Idempotent** — running twice back to back produces no duplicate invoices
   and no duplicate items. Enforced structurally by `invoice.inv_num` as the
   primary key and `UNIQUE (inv_num, row_num)` on items, not by checking before
   inserting.
2. **Resumable** — killing a run at any point loses nothing. The watermark
   advances only after committed headers.
3. **Monotone** — a stored invoice is never deleted or blanked by a later run.
   Header fields may update; items are only added.
4. **Bounded** — at most `DETAIL_BUDGET_PER_RUN` detail calls and
   `SYNC_HEADER_CALL_BUDGET` header calls per run, however far behind it is. A
   year-long backfill is many small runs, not one large one.
5. **Quota-safe** — hitting the quota ends the run with status `quota`, commits
   what was done, and is not an error. Tomorrow continues.

The single most important test is the **late-arriving invoice** case: an
invoice filed inside the overlap window *after* that window was already synced
must be picked up on the next run. That test is why the overlap re-scan exists,
and it is written first in the file.

---

## Cost control

Classification uses `claude-haiku-4-5-20251001`. Short strings, a fixed
13-bucket output, high volume, no reasoning required — the cheap model is the
correct model, and a larger one would be paying for capability the task does
not use.

Three things keep the bill negligible:

- **The model is the last resort, not the first.** Steps 1–4 of the cascade are
  pure database lookups. In steady state almost every item resolves at step 3
  or 4.
- **Every model answer is cached forever**, keyed by the normalized description,
  so the same product is never classified twice.
- **Requests are batched.** Per-item cost is dominated by prompt overhead, so a
  batch of `LLM_BATCH_SIZE` items is roughly 20–40× cheaper per item than
  single-item calls, with no accuracy benefit.

`GET /api/stats` and the dashboard's Stats tab report the four numbers that
make this legible — cache hit rate (target >90% in steady state), items per
model call, uncategorized share by value, and cumulative estimated spend. They
are on the dashboard rather than only in this README because the claim is worth
nothing without the counter.

Every key the model returns is validated against the `category` table. An
unrecognized key is a bug, not a new category: it maps to `uncategorized` and
is logged.

---

## The correction loop

Clicking a category on an item writes a `user_override` and **re-resolves every
affected existing item immediately** — a correction that only applied going
forward would feel broken, because the chart being stared at would not change.
The response is the number of rows updated, which is what the UI shows. The
override also poisons the cache entry for that key in both KV and the table, so
a wrong model answer is not still sitting there for a future rebuild.

---

## Architecture

```
   Cron (04:00 Taipei) ──▶ sync worker ──▶ MOF e-invoice API
                              │      └───▶ Anthropic API (unseen items only)
                              ▼
                        D1  ◀────────────  app worker (/api/* + assets) ◀── browser
                        KV: item→category cache
```

One Worker script with two entry points: `scheduled()` for the cron and
`fetch()` for HTTP. A manual sync is the same code path with different config —
there is no separate backfill mode to rot.

```
src/
  index.ts             fetch() + scheduled()
  einvoice/            MOF transport and parsing. Never touches the database.
  sync/                headers, detail queue, orchestration. Never calls HTTP
                       directly — it takes the client as a parameter.
  categorize/          normalize → rules (pure) → llm (the one impure step)
  prizes/              winning numbers, matching by prize class
  api/                 HTTP handlers, one file per resource
  db/queries.ts        every SQL statement in the project
web/                   dashboard, built by Vite into dist/
```

Four boundaries hold this together:

- **All SQL is in `db/queries.ts`.** No query string exists anywhere else.
- **`einvoice/` never touches the database; `sync/` never makes HTTP calls
  directly.** This is what makes the sync testable without a network, which is
  the point of the entire test suite.
- **`categorize/rules.ts` is pure.** Only `llm.ts` calls a model, only on a
  cache miss, and it writes its answer back to the cache in the same code path.
- **Credentials are scrubbed at the boundary in `einvoice/client.ts`**, not at
  each log site, so there is one place to get it right. `cardNo` and
  `cardEncrypt` must never appear in a log line, a `sync_run.error`, or an API
  response — the verification code guards the complete purchase history of a
  national-ID-linked account.

Money is `INTEGER` everywhere — schema, payloads, arithmetic. No float touches
an amount.

---

## Setup

Requires Node 20+ and a Cloudflare account.

```bash
npm install

# 1. Create the D1 database and KV namespace, then paste the ids into
#    wrangler.jsonc where it says REPLACE_WITH_*.
npx wrangler d1 create invoice-gang
npx wrangler kv namespace create CACHE

# 2. Apply the schema.
npm run db:apply          # add --local for the dev database

# 3. Secrets. Never in wrangler.jsonc, never in the client bundle.
npx wrangler secret put EINVOICE_APP_ID
npx wrangler secret put EINVOICE_CARD_NO        # the /XXXXXXX barcode
npx wrangler secret put EINVOICE_CARD_ENCRYPT   # the 驗證碼
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SESSION_SECRET          # any long random string
npm run hash-password 'your password'           # → OWNER_PASSWORD_HASH
npx wrangler secret put OWNER_PASSWORD_HASH

npm run deploy
```

Getting the credentials themselves is Milestone 0 in `docs/MILESTONES.md`:
register on the 電子發票整合服務平台, apply for an App ID (**do this first** —
approval is not instant and everything else is blocked on it), register a
手機條碼, set its verification code, and aggregate your invoices to the carrier.

To backfill history, set the `EINVOICE_CARRIER_SINCE` var to the date you want
to start from *before the first sync* — it becomes the carrier's creation date,
which is where the first window starts. The run budget then spreads the
backfill over several nights on its own.

### Development

```bash
npm run dev            # wrangler dev against local D1
npm run dev:web        # Vite dev server, proxying /api to :8787
npm test               # vitest — the invariant suite
npm run typecheck
```

Never run a sync against production D1 from a local dev session: it advances
the real watermark and burns real API quota.

### Tuning

Plain vars in `wrangler.jsonc`:

| Var | Default | What it controls |
|---|---|---|
| `SYNC_OVERLAP_DAYS` | 7 | How far back each run re-scans for late filings |
| `SYNC_WINDOW_DAYS` | 30 | Size of one header call's date range |
| `SYNC_HEADER_CALL_BUDGET` | 6 | Header calls per run |
| `DETAIL_BUDGET_PER_RUN` | 200 | Detail calls per run |
| `LLM_BATCH_SIZE` | 50 | Items per model call |

Seven days of overlap is a guess. After a month of real data, set it from the
observed distribution instead:

```sql
SELECT MAX(julianday(date(first_seen_at,'unixepoch')) - julianday(inv_date))
FROM invoice;
```

If that number ever approaches `SYNC_OVERLAP_DAYS`, the overlap is too small
and invoices are being missed.

---

## Deliberately not built

Multi-user (the verification code is tied to a national ID — accepting other
people's is a larger security problem than the rest of this project combined),
bank and credit-card import, budgets and goals and overspend alerts, manual
expense entry, a native mobile app, and paper invoices not on the carrier.
`docs/SPEC.md` explains each; they are decisions, not a backlog.

## Documents

| File | What it settles |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | What v1 is and what it deliberately is not |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, data flow, stack decisions |
| [`docs/SCHEMA.sql`](docs/SCHEMA.sql) | The D1 schema, annotated |
| [`docs/EINVOICE-API.md`](docs/EINVOICE-API.md) | The government API and its quirks |
| [`docs/SYNC.md`](docs/SYNC.md) | The sync algorithm |
| [`docs/CATEGORIZATION.md`](docs/CATEGORIZATION.md) | The cascade and the correction loop |
| [`docs/HTTP-API.md`](docs/HTTP-API.md) | The app's own endpoints |
| [`docs/MILESTONES.md`](docs/MILESTONES.md) | Build order with done-when criteria |
