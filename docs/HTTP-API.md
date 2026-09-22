# HTTP-API

The app's own surface. Small, JSON, one account per session. Everything except
sign-up and sign-in needs a session cookie, and everything behind it answers
about the signed-in account only: another account's invoice, item or income
row is a 404, exactly like one that does not exist.

## Auth

```
POST /api/register  { "username": "alice", "password": "…" }
POST /api/login     { "username": "alice", "password": "…" }
POST /api/logout
GET  /api/session   → { authenticated, username? }
```

Sign-up is open. Usernames are 3–32 characters of lowercase letters, digits
and `_ . -`, compared case-insensitively; passwords are 8–256 characters,
stored as PBKDF2-SHA256. Register answers 409 `username_taken`. A wrong
password and an unknown username both answer 401 `bad_credentials`, and both
pay for a hash so the timing does not tell them apart.

Both set an HttpOnly, Secure, SameSite=Strict cookie carrying the account id
and an expiry, HMAC-signed with `SESSION_SECRET`. There is no session table and
no password reset: rotating the secret signs everyone out, and a password is
reset by hand with `npm run hash-password` and an `UPDATE`.

A database upgraded by migration 005 has an `owner` account with no hash. Its
first sign-in is checked against `OWNER_PASSWORD_HASH` and copies it in.

## Account

```
GET    /api/account
PUT    /api/account               { "notify_webhook": "https://…" | null }
POST   /api/account/import-token  → { token, created_at }
DELETE /api/account/import-token
```

`GET` returns the username, `notify_webhook`, and whether an import token
exists with when it was created and last used — never the token, never the
password hash. `PUT` answers with the same shape; the webhook must be https.
Creating a token replaces the old one. The token appears in that one response
and nowhere else; only its SHA-256 is stored.

## Read

```
GET /api/summary?from=&to=&group=category|merchant|month
```
Aggregates for the dashboard. `from`/`to` are `YYYY-MM-DD`, default to the
current month. Returns totals plus an ordered breakdown by the requested
grouping. Backed by `v_monthly_category` where the grouping allows.

```
GET /api/invoices?from=&to=&category=&q=&cursor=&limit=
```
Invoice list, newest first. `q` matches merchant name and item description.
Keyset pagination on `(inv_date, inv_num)` — not OFFSET, which degrades and
skips rows when new invoices land mid-scroll. Returns `{ items, next_cursor }`.

```
GET /api/invoices/:invNum
```
One invoice with all its line items, each carrying its category and
`category_source` so the UI can show *why* it was classified that way.

```
GET /api/items?uncategorized=true&low_confidence=true&limit=
```
The review queue. Sorted by amount descending — correcting the expensive
mistakes first is the fastest route to an accurate chart.

```
GET /api/stats
```
The numbers from `CATEGORIZATION.md`: cache hit rate, items per model call,
uncategorized share by value, cumulative model spend, plus last sync time and
status.

```
GET /api/prizes?period=
```
Winning numbers for the period and any `prize_hit` rows against them.

```
GET /api/budget?month=YYYY-MM
```
The month's budget and what it implies: `amount`, `spent`, `remaining`,
`days_elapsed`, `days_left`, `pace_per_day`, `remaining_per_day`, `projected`,
`over_by`, and a `status` of `unset` | `on_track` | `projected_over` | `over`.
Defaults to the current month.

`amount` is `null` when no budget has ever been set at or before this month —
distinct from zero, which would be a budget of nothing. `effective_from` names
the month whose row supplied the figure; different from `month` means it was
carried forward rather than set deliberately, and the UI says so.

`status` separates `over` from `projected_over` because they ask for different
things: one is a stop, the other is a slow down.

## Write

```
POST /api/categorize
  { "scope": "item" | "merchant", "key": "...", "category": "drinks" }
```
Creates or replaces this account's `user_override` and re-resolves this
account's affected items; the shared classifier cache is left alone. Returns
the number of items updated — the UI shows "recategorized 47 items", which is
the moment the correction loop feels worth having.

```
DELETE /api/categorize
  { "scope": "...", "key": "..." }
```
Removes an override and re-resolves the affected items back down the cascade.

```
PUT /api/budget
  { "amount": 20000, "month": "2026-09" }
```
Sets the monthly budget. `month` defaults to the current one. Writing a month
creates the change point that every later month inherits from, so setting it
once in September also budgets October — a month with no row of its own is not
unbudgeted, it looks backwards for the newest row at or before it.

Answers with the same shape as the GET, so setting a figure immediately shows
what it implies without a second call. `DELETE /api/budget?month=` removes one
change point, and the month falls back to the row before it.

```
POST /api/import/preview
  body: the carrier CSV export, as text/csv
```
A dry run: parses and categorizes the file and writes nothing. Returns each
invoice with its proposed category per item, which invoices are already
imported into this account, and any skipped rows — what the review screen
renders. Session only; never accepts an import token, since a headless upload
has no screen.

```
POST /api/import
  body: the carrier CSV export, as text/csv       (imports the whole file)
   or:  application/json { csv, include[], overrides[] }  (from the preview)
```
Parses, stores and categorizes an export into the caller's account. Accepts a
session cookie, or `Authorization: Bearer <import token>` so the watch-folder
script can upload without a login cookie; the token decides the account. Returns the `sync_run` row plus the invoice count, any
masked invoice numbers, and any skipped rows. A malformed file is a failed run
with a reason, not a thrown error — status 422. Reject a concurrent run: if one
started within the last 10 minutes and has no `finished_at`, return 409.

```
GET /api/import/status
```
Last few `sync_run` rows, the date the imports cover through, and how old the
data is. This is the "is it actually still working" page, and it matters more
than it did under a cron: the failure mode of a manual-import system is
silence, so `stale` is part of the payload and the dashboard shows a banner
for it.

## Conventions

- Errors: `{ "error": { "code": "...", "message": "..." } }` with a real HTTP
  status. `code` is stable and machine-readable, `message` is for a human.
- Money is an integer in every payload. No formatted currency strings from the
  server; the client formats.
- Dates are `YYYY-MM-DD`, timestamps are unix seconds. No locale-dependent
  formats cross the wire.
- **No credential ever appears in a response**, including inside an error
  message from the MOF client. Scrub at the boundary in `einvoice/client.ts`,
  not at the point of logging, so there is one place to get it right.
