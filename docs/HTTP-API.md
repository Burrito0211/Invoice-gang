# HTTP-API

The app's own surface. Small, single-user, JSON. Everything except the login
route requires the owner session cookie.

## Auth

One owner, no user table. `POST /api/login` takes a password, compares against
`OWNER_PASSWORD_HASH`, and sets an HttpOnly, Secure, SameSite=Strict cookie
carrying an HMAC-signed expiry. Middleware verifies it on every other route.

There is no registration, no password reset, and no session table — for one
user those are liabilities, not features. Rotating the secret logs you out,
which is the intended recovery path.

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

## Write

```
POST /api/categorize
  { "scope": "item" | "merchant", "key": "...", "category": "drinks" }
```
Creates or replaces a `user_override`, re-resolves all affected existing items
in the same transaction, and invalidates the cache entry. Returns the number of
items updated — the UI shows "recategorized 47 items", which is the moment the
correction loop feels worth having.

```
DELETE /api/categorize
  { "scope": "...", "key": "..." }
```
Removes an override and re-resolves the affected items back down the cascade.

```
POST /api/import
  body: the carrier CSV export, as text/csv
```
Parses, stores and categorizes an export. Accepts the owner session cookie, or
`Authorization: Bearer <IMPORT_TOKEN>` so the watch-folder script can upload
without a login cookie. Returns the `sync_run` row plus the invoice count, any
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
