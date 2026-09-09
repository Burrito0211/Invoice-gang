# Invoice Gang

Item-level personal accounting built on Taiwan's 電子發票 (e-invoice) records.

Every purchase in Taiwan already produces a structured, itemized record filed
with the Ministry of Finance and carried on a 手機條碼 barcode. That record is
complete and completely unused. Manual expense apps fail because they require
typing; this data requires nobody to type anything, and it is already mine.

You export your invoice records from the carrier portal as CSV. A Cloudflare
Worker parses it, stores headers and line items in D1, and assigns each line
item a spending category — using a deterministic rule table first and a model
only for merchandise it has never seen, caching that answer forever against the
raw product string. A dashboard charts the result and lets you correct any
categorization, which persists as a rule that outranks everything else.

The unit of analysis is the **item**, not the invoice. "I spent NT$4,200 at
7-ELEVEN this month" is useless; "NT$1,800 of it was coffee" is the product.

---

## How data gets in

This project was designed against the MOF's e-invoice API. **That API is no
longer available to individual developers** — the Ministry stopped issuing App
IDs to them, and no client library changes that, because the obstacle is a
credential that is not issued rather than code.

The carrier portal still exports your own records as CSV, and that export
includes line items, so the item-level premise survives:

```
you                     your PC                    Cloudflare
───                     ───────                    ──────────
log in, click export ─▶ Downloads/
                          │
                          ▼
                        watch-folder.mjs ────────▶ POST /api/import
                                                     │
                                                     ▼
                                                   parse → dedupe →
                                                   categorize → D1
                                                     │
                                                     ▼
                                                   dashboard
```

Your part is two clicks; everything after the file lands is automatic. The
portal login is *not* automated — it sits behind bot management, and getting
past that is out of scope. `docs/IMPORT.md` has the full picture, including
the file format and the three things about it that are not obvious.

`docs/SYNC.md` and `docs/EINVOICE-API.md` describe the original API design.
They are kept, marked superseded, because the reasoning in them still explains
why the schema looks the way it does.

---

## The parts worth reading about

### Parsing an export you did not design

Three findings from a real export drove the parser, and each would have been a
silent data bug if guessed:

- **`發票金額` is not the invoice total.** It repeats the *line* amount on every
  row. Trusting it stores whichever line landed last — for one four-line
  invoice, −15 instead of 83. Totals are summed from the lines.
- **There is no row number.** `UNIQUE (inv_num, row_num)` is the idempotency
  key, so it comes from position. That is forced, not chosen: a real export
  already had an invoice with two lines identical in name, quantity *and*
  amount, and any content-derived key would have merged two real purchases.
- **Negative lines are normal.** Discounts are items with negative amounts, and
  they are what make a total add up.

The first version of this project had a whole module written against API field
names nobody had verified. That module is gone. The lesson stuck: the CSV
format was checked against a real file before a line of the parser was written.

### The categorization cascade

Every step but the last is free:

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

Classification uses `claude-haiku-4-5-20251001`. Short strings, a fixed
13-bucket output, high volume, no reasoning required — the cheap model is the
correct model, and a larger one would be paying for capability the task does
not use. Three things keep the bill negligible: the model is the last resort
rather than the first, every answer is cached forever against the normalized
description, and requests are batched (per-item cost is dominated by prompt
overhead, so a batch of 50 is roughly 20–40× cheaper per item).

Every key the model returns is validated against the `category` table. An
unrecognized key is a bug, not a new category.

### The correction loop

Clicking a category writes a `user_override` and **re-resolves every affected
existing item immediately** — a correction that only applied going forward
would feel broken, because the chart you are staring at would not change. The
response is the number of rows updated. The override also poisons the cache
entry for that key in both KV and the table, so a wrong answer is not still
sitting there for a future rebuild.

### Two invariants, not five

`docs/SYNC.md` defined five properties for the API sync. Two survive the move
to file import, and they matter more than they did:

1. **Idempotent.** Exports overlap by design — you download the last few months
   every time — so re-importing must not duplicate anything. Enforced
   structurally by `invoice.inv_num` and `UNIQUE (inv_num, row_num)`, not by
   checking before inserting.
2. **Monotone.** An import never deletes or blanks an existing invoice. Header
   fields update; items are only added.

Resumable, bounded and quota-safe described a paginated rate-limited API. Their
tests were deleted rather than left asserting properties of a system that no
longer exists.

### Staleness, because silence is the failure mode

The cron trigger no longer fetches anything. It checks how old the data is and
notifies past ten days, and the dashboard shows a banner for the same
condition. Without it you simply stop importing, nothing errors, and the chart
quietly stops moving.

---

## Architecture

```
src/
  index.ts             fetch() + scheduled()
  import/              CSV → domain types (pure), then persist + categorize
  categorize/          normalize → rules (pure) → llm (the one impure step)
  prizes/              matching by prize class
  api/                 HTTP handlers, one file per resource
  db/queries.ts        every SQL statement in the project
web/                   dashboard, built by Vite into dist/
scripts/               watch-folder uploader, password hasher
```

Boundaries that hold it together:

- **All SQL is in `db/queries.ts`.** No query string exists anywhere else.
- **`import/csv.ts` is pure** — no HTTP, no database. Same boundary the old
  MOF client had, and the reason the importer is fully testable.
- **`categorize/rules.ts` is pure.** Only `llm.ts` calls a model, only on a
  cache miss, and it writes its answer back to the cache in the same path.
- Money is `INTEGER` everywhere — schema, payloads, arithmetic.

`/api/*` is a plain JSON API with cookie auth; the dashboard is just its first
client, so a native app later would consume the same endpoints.

---

## Setup

Requires Node 20+ and a Cloudflare account.

```bash
npm install

npx wrangler d1 create invoice-gang
npx wrangler kv namespace create CACHE
# paste both ids into wrangler.jsonc

npm run db:apply          # the deployed database
npm run db:apply:local    # the one `wrangler dev` uses

npx wrangler secret put SESSION_SECRET        # any long random string
npm run hash-password 'your password'         # → OWNER_PASSWORD_HASH
npx wrangler secret put OWNER_PASSWORD_HASH
npx wrangler secret put ANTHROPIC_API_KEY     # optional; without it, no step 5
npx wrangler secret put IMPORT_TOKEN          # optional; for the watch folder
npx wrangler secret put NOTIFY_WEBHOOK        # optional; staleness nudges

npm run deploy
```

Then export a CSV from the carrier portal and drag it into the dashboard, or
set up the watch folder — see `docs/IMPORT.md`.

### Development

```bash
npm run dev            # wrangler dev against local D1
npm run dev:web        # Vite dev server, proxying /api to :8787
npm test               # vitest
npm run typecheck
```

---

## Deliberately not built

Multi-user, bank and card import, budgets and goals, manual expense entry, and
a native mobile app. `docs/SPEC.md` explains each; they are decisions, not a
backlog. Manual entry is worth restating: if it needs typing it will not get
used, and the whole premise was that it does not.

## Documents

| File | What it settles |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | What v1 is and what it deliberately is not |
| [`docs/IMPORT.md`](docs/IMPORT.md) | **How data gets in today** |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, data flow, stack decisions |
| [`docs/SCHEMA.sql`](docs/SCHEMA.sql) | The D1 schema, annotated |
| [`docs/CATEGORIZATION.md`](docs/CATEGORIZATION.md) | The cascade and the correction loop |
| [`docs/HTTP-API.md`](docs/HTTP-API.md) | The app's own endpoints |
| [`docs/SYNC.md`](docs/SYNC.md) | *Superseded* — the original API sync design |
| [`docs/EINVOICE-API.md`](docs/EINVOICE-API.md) | *Superseded* — the government API |
| [`docs/MILESTONES.md`](docs/MILESTONES.md) | Build order with done-when criteria |
