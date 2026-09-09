# SYNC

> **Superseded.** The MOF stopped issuing App IDs to individual developers,
> so the API this document describes is not reachable. Invoice data now
> arrives through a CSV export — see [`IMPORT.md`](IMPORT.md). This file is
> kept because the reasoning in it still explains the schema, and because the
> constraints it describes were real.


The core of the project. Everything else is a view over what this produces.

## The two problems

**Invoices arrive late.** A merchant may file days after the purchase. A window
that always ends at "today" and starts at "wherever I finished last time" will
skip anything that lands behind the watermark, permanently and silently.

**Details are per-invoice and rate-limited.** One HTTP call per invoice, against
an unknown daily quota. A month of ordinary spending is a few hundred invoices,
so details cannot be fetched inline with the headers, and a backfill of a year
of history cannot happen in one run.

Both are solved the same way: never treat a run as authoritative and complete.
A run makes progress; the invariants hold no matter where it stops.

## Invariants

These are the properties the tests should assert, and they are the actual
deliverable of this module:

1. **Idempotent.** Running the sync twice back to back produces no duplicate
   invoices and no duplicate items. Enforced structurally by `invoice.inv_num`
   as the primary key and `UNIQUE (inv_num, row_num)` on items, not by checking
   before inserting.
2. **Resumable.** Killing a run at any point and starting a new one loses
   nothing. Consequence: the watermark advances only after the headers for that
   window are committed, never before the call that produces them.
3. **Monotone.** A stored invoice is never deleted or blanked by a later run.
   Header fields may be updated (status can change to 作廢); items are only
   added.
4. **Bounded.** A run makes at most `DETAIL_BUDGET_PER_RUN` detail calls and at
   most `ceil(window / SYNC_WINDOW_DAYS)` header calls, regardless of how far
   behind it is. A year-long backfill is many small runs, not one large one.
5. **Quota-safe.** Hitting the quota ends the run with status `quota`, commits
   what was done, and is not an error. Tomorrow continues.

## Phase 1 — headers

```
overlap  = SYNC_OVERLAP_DAYS      (default 7)
window   = SYNC_WINDOW_DAYS       (default 30)

start = (sync_state.synced_through ?? carrier.created_at) - overlap
end   = min(start + window, today)

for each [start, end] chunk up to the header-call budget:
    rows = einvoice.carrierInvChk(carrier, chunk)
    upsert each row into invoice
    sync_state.synced_through = chunk.end        # only after the upsert commits
```

**The overlap re-scan is the whole trick.** Every run re-reads the last
`SYNC_OVERLAP_DAYS` of already-synced dates. Late-filed invoices in that period
get picked up; already-known ones collide on the primary key and update
harmlessly. Seven days is a guess — after a month of real data, look at the
observed gap between `inv_date` and `first_seen_at` and set it from the actual
distribution:

```sql
SELECT MAX(julianday(date(first_seen_at,'unixepoch')) - julianday(inv_date))
FROM invoice;
```

If that number ever approaches `SYNC_OVERLAP_DAYS`, the overlap is too small
and invoices are being missed.

**Upsert semantics.** On conflict, update `inv_status`, `amount`, `seller_name`,
`updated_at` and nothing else. Never touch `detail_fetched_at` or
`first_seen_at` — that is what stops the re-scan from re-queueing details for
every invoice in the overlap window on every single run.

## Phase 2 — the detail queue

The queue is not a separate table; it is a query:

```sql
SELECT inv_num, inv_date, amount, seller_name, seller_ban
FROM invoice
WHERE detail_fetched_at IS NULL
  AND detail_attempts < 5
ORDER BY inv_date DESC
LIMIT :budget;
```

Newest first, because recent spending is what the dashboard is asked about, and
a long backfill should not delay this month's data.

Per invoice:

- success with rows → insert items (`INSERT OR IGNORE` on the unique key), set
  `detail_fetched_at`
- success with zero rows → **do not** mark fetched. Increment `detail_attempts`,
  record why. Details can lag behind headers, and marking it complete makes the
  miss permanent. The `attempts < 5` cap is what stops a genuinely empty
  invoice from being retried forever.
- transport or API error → increment `detail_attempts`, store a scrubbed
  message, continue to the next invoice. One bad invoice never aborts a run.
- quota error → stop the phase immediately, status `quota`, commit, return.

Each successful detail fetch feeds its new items straight into categorization
(next phase) in the same run, so an item is never left uncategorized once its
row exists.

## Phase 3 — categorize

See `CATEGORIZATION.md`. From the sync's point of view: collect the newly
inserted items, resolve as many as possible without a network call, batch the
remainder into as few model calls as the batch size allows, write results back.
Record `llm_calls`, `llm_items`, `cache_hits` on the `sync_run` row — those
three numbers are the cost story and they belong in the dashboard.

## Phase 4 — prizes

Cheap and only worth doing occasionally. If the current ROC period has closed
and `winning_number` has no rows for it, fetch the list, store it, then:

```sql
-- match by trailing digits per prize class; the exact rules for each class
-- (special = all 8 digits, grand = all 8, first = all 8, and the additional
-- prizes matching progressively shorter suffixes) go in prizes/match.ts
```

A hit writes `prize_hit` and, if unnotified, sends the notification and stamps
`notified_at` — so a re-run cannot notify twice.

## Scheduling

```jsonc
// wrangler.jsonc
"triggers": { "crons": ["0 20 * * *"] }   // 04:00 Taipei = 20:00 UTC
```

Once a day is enough — the data source updates on merchant filing lag measured
in hours to days, so polling more often buys nothing and burns quota.

For a backfill, run manually against a longer window with a larger detail
budget; the same code path, different config, no special backfill mode.

## Local development

The MOF API cannot be called from a test suite. Split the boundary so it does
not need to be:

```ts
export async function runSync(deps: { api: EInvoiceApi; db: D1Database; now: () => number })
```

Tests pass a fake `api` that replays the JSON samples captured in Milestone 0
and an in-memory D1 (`wrangler d1 execute --local`, or better-sqlite3 against
`SCHEMA.sql`). Then assert the five invariants above directly:

- run twice → identical row counts
- kill after phase 1 → watermark did not advance past committed headers
- header re-scan of the overlap window → `detail_fetched_at` unchanged
- quota error mid-detail-phase → status `quota`, prior items still committed
- late-arriving invoice inside the overlap window → picked up on the next run

That last one is the test that justifies the whole design, so write it first.
