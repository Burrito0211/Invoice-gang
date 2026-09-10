# IMPORT

How invoice data gets in, and why it works this way rather than the way
`SYNC.md` describes.

## What happened to the API

`SYNC.md` and `EINVOICE-API.md` describe a scheduled job calling the MOF
e-invoice API. That is no longer reachable: **the Ministry of Finance stopped
issuing App IDs to individual developers.** Without an App ID there is no
authentication, and no client library changes that — the obstacle is a
credential that is not issued, not code.

Those two documents are kept as written. They are an accurate record of a
design that was correct for the constraints at the time, and the reasoning in
them — late-arriving invoices, per-invoice rate limits, why a run must never be
treated as complete — is still the reasoning that shaped the schema.

## What replaced it

The carrier web portal still exports your own invoice records as CSV, and that
export **includes line items**, so the item-level premise of the project
survives. The pipeline is now:

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

Your part is two clicks. Everything after the file lands is automatic.

### Why not automate the login too

The portal sits behind Cloudflare bot management — a plain HTTP request gets a
403 and a Turnstile challenge rather than the login form. Automating past that
is bot-detection circumvention, which is out of scope for this project
regardless of the account being your own. The watch folder gets the same
outcome without touching it.

## The file format

Verified against a real export before any parser was written. 14 columns,
UTF-8 with a BOM, LF line endings, **one row per line item** with the invoice's
own fields repeated on every row, and two prose footer lines that are not data.

| # | Column | Notes |
|---|---|---|
| 0 | `載具自訂名稱` | carrier label |
| 1 | `發票日期` | **packed `YYYYMMDD`** |
| 2 | `發票號碼` | invoice number, `AA12345678` |
| 3 | `發票金額` | **not the invoice total — see below** |
| 4 | `發票狀態` | e.g. `開立已確認` |
| 5 | `折讓` | allowance flag |
| 6–8 | `賣方統一編號` / `賣方名稱` / `賣方地址` | seller |
| 9 | `買方統編` | empty for B2C |
| 10–13 | `消費明細_數量` / `_單價` / `_金額` / `_品名` | the line item |

### Three things that are not obvious

**`發票金額` carries the line amount, not the invoice total.** On a real export
it equals `消費明細_金額` on every single row. Taking it at face value stores
whichever line happened to land last — for one four-line invoice that would
have been −15 instead of 83. The total is summed from the lines.

**There is no row number.** `UNIQUE (inv_num, row_num)` is the idempotency key,
so the row number comes from position within the invoice. This is forced, not
chosen: a real export already contained an invoice with two lines identical in
name, quantity *and* amount, so any content-derived key would silently merge
two genuine purchases into one.

**Negative lines are normal.** Discounts (`折扣（10％）`) arrive as items with
negative amounts and are what make a total add up. They are imported as items.

### Masked invoice numbers

The export's own footer says 「捐贈或作廢之發票，字軌號碼均會隱末3碼」 — voided
and donated invoices arrive with the last three digits of the number masked.
`inv_num` is the primary key, so these are imported with a marker appended to
`inv_status` and reported in the import response, rather than dropped. A
donated invoice is still real spending; losing it silently would put a hole in
the totals that nothing would ever surface.

## Invariants

Two of the five in `SYNC.md` survive, and they matter more than before:

1. **Idempotent.** Exports overlap by design — you download the last few months
   every time — so re-importing must not duplicate. Enforced structurally by
   `invoice.inv_num` and `UNIQUE (inv_num, row_num)`.
2. **Monotone.** An import never deletes or blanks an existing invoice. Header
   fields update; items are only added.

Resumable, bounded and quota-safe described a paginated, rate-limited API.
There is no quota on reading a file and no cursor to resume from, so those
three no longer mean anything and their tests were deleted rather than left
asserting properties of a system that no longer exists.

## Setup

```bash
# A long random string; the watch folder authenticates with it.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put IMPORT_TOKEN
```

Then set the environment for the watcher and run it:

```
INVOICE_GANG_URL=https://invoice-gang.<subdomain>.workers.dev
INVOICE_GANG_TOKEN=<the same value>
INVOICE_GANG_WATCH=C:\Users\you\Downloads        # optional
```

```bash
node scripts/watch-folder.mjs           # runs continuously
node scripts/watch-folder.mjs --once    # one sweep, for Task Scheduler
```

It only picks up files matching the export's naming shape
(`<digits>_<14-digit timestamp>.csv`) whose first column is `載具自訂名稱`, waits
for the size to stop changing so a half-downloaded file is never uploaded, and
archives what it sends. Re-uploading is harmless anyway — the importer is
idempotent — so the archive is tidiness, not safety.

Without the watcher you can drag the CSV into the dashboard instead. Same
endpoint, same code path.

## Review before importing

A file dragged into the dashboard is not committed straight away. It goes to
`/api/import/preview` first — a dry run that parses and categorizes the whole
file **without writing anything** — and the result is shown for review:

- every invoice, with a checkbox; ones already imported start unticked, since
  re-importing is harmless but rarely intended
- every item's proposed category, in a dropdown that can be corrected on the
  spot; a change becomes an item override on commit, outranking the rules
- the net amount per line, discounts already allocated

Only the ticked invoices are committed, and only when *Import selected* is
pressed. The raw CSV is held in the browser between preview and commit, so the
server stays the single parser — the client never re-serializes what it chose.

The watch-folder path skips all of this: a headless upload has no screen to
review onto, so it posts the raw CSV and imports the whole file as before.

## Staleness

The cron trigger no longer fetches anything, because there is nothing to fetch.
It checks how old the data is and notifies when it passes ten days, and the
dashboard shows a banner for the same condition.

This is the honest version of "runs without me": it remembers so you do not
have to. Without it the failure mode of a manual-import system is silence —
you stop importing, nothing errors, and the chart quietly stops moving.

Set `NOTIFY_WEBHOOK` to any URL accepting a plain-text POST (ntfy, Discord,
Slack) to get the nudge somewhere you will see it. Unset means log only.
