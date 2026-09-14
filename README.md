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

Everything after the file lands is automatic. Your part is a ninety-second
visit to the portal, twice a week — set the range, query, switch the page size
to 100, tick the right-hand select-all, download. The portal login is *not*
automated: it sits behind bot management, and getting past that is out of
scope. `docs/IMPORT.md` has the full picture, including the file format, the
three things about it that are not obvious, and the checkbox column that
donates your invoices if you tick the wrong one.

Twice a week is not a compromise forced by the missing API. A merchant has two
days to file an invoice with the platform, so the data has a legal floor of
0–48 hours whoever is reading it; the API would have made the export
*automatic*, never *live*. Two exports a week land within about a day of the
best any design could do.

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

### Knowing what is left

Everything above records what happened. A budget is the one number here that
points forwards, and without it the dashboard can only ever answer *what did I
spend* — never *what can I still spend*, which is the question the data was
being collected to answer in the first place.

One figure per month, and the month inherits it: setting NT$20,000 in September
budgets every later month at NT$20,000 until another row supersedes it. The
table stores change points rather than one current value, which is what keeps
August judged against August's budget after September's has been set.

The card draws two marks on one track — the share of the budget spent, and the
share of the month gone. Sixty-two percent spent is neither good nor bad until
you know whether the month is a third or nine-tenths over, so the comparison is
drawn rather than left for the reader to do. `over` and `projected_over` are
separate states because they ask for different things: one is a stop, the other
is a slow down.

The arithmetic is in `budget/pace.ts` and is pure, for the same reason
`import/csv.ts` is: it is arithmetic with an edge case at every month boundary
— the last day, a month not yet started, a finished month that must not be
projected past what it actually cost — and those are only testable when
nothing else is in the room.

### Two languages, one set of phrases

The interface is Traditional Chinese and English, toggled from the header the
way the MOF portal does it — the button shows the language you would switch
*to*, which a flag or a globe icon never manages to say. Chinese is the default
whenever the browser asks for any Chinese, because the data is Taiwanese: every
merchant name and product description arrives in Chinese regardless, and an
English frame around Chinese content reads worse than either language alone.

Static markup stores `data-i18n` keys rather than English text, so a phrase has
exactly one home. Category names come from the `category` table, which has
carried `label_zh` and `label_en` since the first schema.

The interesting part is the split. `strings.ts` is the two dictionaries and a
resolver and touches nothing — no DOM, no `localStorage`, no module state.
`i18n.ts` owns all of that. This is not tidiness: at runtime a missing
translation falls back to English and the page works fine, so a half-translated
screen never announces itself. Only a test catches it, and a test cannot import
a module that reaches for `document`. So `test/i18n.test.ts` asserts the two
dictionaries have identical keys, that every key used in the markup and in the
dashboard exists in both, and that a sentence carrying `{amount}` and `{n}`
carries both in either language — a translation that silently drops a number is
the failure that would otherwise ship.

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
notifies past five days, and the dashboard shows a banner for the same
condition. Without it you simply stop importing, nothing errors, and the chart
quietly stops moving.

Five days, not the ten it started at. Ten was tuned for a chart you glance at.
A budget is something you make a decision against, and a decision made on
ten-day-old spending is a decision made on the wrong number — so the threshold
now means one missed export rather than one missed fortnight.

---

## Architecture

```
src/
  index.ts             fetch() + scheduled()
  import/              CSV → domain types (pure), then persist + categorize
  categorize/          normalize → rules (pure) → llm (the one impure step)
  prizes/              matching by prize class
  budget/              monthly budget arithmetic (pure)
  api/                 HTTP handlers, one file per resource
  db/queries.ts        every SQL statement in the project
web/                   dashboard, built by Vite into dist/
  src/strings.ts       zh-Hant and en phrases (pure)
  src/i18n.ts          current language and the markup pass
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

Multi-user, bank and card import, envelopes and per-category caps and goals,
manual expense entry, and a native mobile app. `docs/SPEC.md` explains each;
they are decisions, not a backlog. Manual entry is worth restating: if it needs
typing it will not get used, and the whole premise was that it does not.

One of those decisions was reversed. Budgets were originally ruled out with the
rest of the personal-finance feature set; a single monthly total is now in, and
`SPEC.md` records why.

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
