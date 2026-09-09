# EINVOICE-API — 財政部電子發票整合服務平台

> **Superseded.** The MOF stopped issuing App IDs to individual developers,
> so the API this document describes is not reachable. Invoice data now
> arrives through a CSV export — see [`IMPORT.md`](IMPORT.md). This file is
> kept because the reasoning in it still explains the schema, and because the
> constraints it describes were real.


> **Read this warning first.** Nothing below was tested against the live API
> while writing this bundle. Claims are tagged **[verified]** where they are
> stable, publicly documented facts, and **[assumed]** where the exact spelling
> of a parameter or field is from memory and must be confirmed. Milestone 0
> exists to resolve every **[assumed]** tag. Do not build the sync on top of
> unverified field names — one successful curl first.

Docs and registration: <https://www.einvoice.nat.gov.tw> → 應用API → 申請/下載規格

## Getting access **[verified]**

1. Register a citizen account on the 電子發票整合服務平台.
2. Apply for an **App ID** under the API section. Free, individuals eligible,
   approval is not instant — **apply on day one of the project**, since
   everything else is blocked behind it.
3. Register a **手機條碼 (mobile barcode carrier)** if you do not have one, and
   set its **驗證碼 (verification code)**. The barcode looks like `/ABC+123`
   (8 characters starting with `/`); the verification code is a separate
   password you set yourself.
4. Aggregate your invoices to the carrier (載具歸戶) so purchases actually land
   there. Invoices not on the carrier are invisible to this API.

## Transport **[verified]**

- Base host: `https://api.einvoice.nat.gov.tw`
- `POST`, body `application/x-www-form-urlencoded`
- Response: JSON, with a status code field in the body — **an HTTP 200 does not
  mean success**. Check the body code before parsing. `200` in the body means
  OK; anything else is an error with a human-readable `msg`, frequently in
  Chinese, frequently about the timestamp or the carrier credentials.

## Endpoints

### Invoice headers for a carrier **[assumed field names]**

```
POST /PB2CAPIVAN/invServ/InvServ
  version=1.0
  cardType=3J0002            # 手機條碼 carrier type
  cardNo=<手機條碼>
  cardEncrypt=<驗證碼>
  expTimeStamp=<future unix seconds>
  timeStamp=<current unix seconds>
  action=carrierInvChk
  startDate=YYYY/MM/DD
  endDate=YYYY/MM/DD
  onlyWinningInv=N
  uuid=<any stable client id>
  appID=<App ID>
```

Returns a list of invoice headers. Fields to expect (confirm spelling):
`invNum`, `invDate`, `amount`, `sellerName`, `sellerBan`, `invStatus`,
`invPeriod`, `donatable`, `cardType`, `cardNo`.

### Line items for one invoice **[assumed field names]**

```
POST /PB2CAPIVAN/invServ/InvServ
  ... same auth params ...
  action=carrierInvDetail
  invNum=<invoice number>
  invDate=YYYY/MM/DD
  amount=<header amount>
  sellerName / sellerBan as returned by the header call
```

Returns `details[]` with `rowNum`, `description`, `quantity`, `unitPrice`,
`amount`.

**This is per-invoice.** There is no bulk detail endpoint. That single fact is
what forces the whole queued, budgeted detail-fetch design in `SYNC.md` — do
not design as though details come back with the headers.

### Winning numbers **[verified shape, assumed field names]**

```
POST /PB2CAPIVAN/invapp/InvApp
  version=0.2
  action=qryWinningList
  invTerm=<ROC period, e.g. 11304 for 113年3-4月>
  UUID=<client id>
  appID=<App ID>
```

Public data, no carrier credentials needed. Returns the special/grand/first
prize numbers plus additional prize numbers for the period. Cache it — it
changes six times a year.

Note the period encoding is **ROC calendar** and identifies a two-month period
by its *even* month: 11304 = March–April of ROC year 113.

## Quirks to design around

**Timestamp validation [verified behavior, exact tolerance assumed].** The
server rejects requests whose `timeStamp` is too far from its own clock, and
requires `expTimeStamp` to be in the future. Compute both at call time from
`Date.now()`; never reuse a timestamp across retries — regenerate per attempt,
or a retry of a slow request fails for a reason unrelated to the original.

**Quotas exist; the number is unknown [verified that limits exist].** Do not
hardcode a guess. Design so the daily budget is a config value, treat a quota
error as a normal outcome that ends the run cleanly rather than an exception,
and record it in `sync_run`. The system must degrade to "catches up tomorrow",
never to "loses data".

**Upload lag.** A merchant can file an invoice days after the purchase. A
window that ends at today and never looks back will permanently miss those.
This is the entire reason for the overlap re-scan in `SYNC.md`.

**Late-arriving details.** A header can exist before its details are
retrievable. A detail call returning empty is not proof the invoice has no
items — do not mark it permanently fetched. Retry with backoff, and cap the
attempts so one broken invoice cannot wedge the queue forever.

**Description strings are raw merchant POS text.** Expect full-width
characters, missing spaces, truncation at some byte limit, product codes,
inconsistent casing, and the same product spelled two ways by the same chain.
`CATEGORIZATION.md` handles this; the point here is that they are not clean and
no amount of parsing will make them clean.

**Amounts.** Treat as integers (NT$ has no minor unit in practice here). Store
as INTEGER. Do not let a float near this data.

**Carrier credentials are a real secret.** The verification code guards access
to the complete purchase history of a national-ID-linked account. Worker
secrets only, never logged — scrub `cardNo` and `cardEncrypt` from any error
message before it reaches a log line or a `sync_run` row.

## Milestone 0 checklist

Before writing sync code, prove each of these with a real call and paste the
actual response into `docs/api-samples/`:

- [ ] App ID issued and a `qryWinningList` call succeeds (no carrier needed —
      the cheapest possible proof the credentials and transport work)
- [ ] `carrierInvChk` returns headers for a known date range
- [ ] Exact field names and types of a header, recorded
- [ ] `carrierInvDetail` returns items for one known invoice
- [ ] Exact field names and types of a detail row, recorded
- [ ] Behavior on a bad date range and on a wrong verification code, recorded —
      the error path is what the sync will actually spend its life handling
