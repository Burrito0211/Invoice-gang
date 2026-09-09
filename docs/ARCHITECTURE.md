# ARCHITECTURE

## Shape

```
                    ┌──────────────────────────────┐
   Cron Trigger ───▶│  sync worker                 │
   (daily 04:00)    │   1. fetch new headers       │──▶ MOF e-invoice API
                    │   2. drain detail queue      │◀──
                    │   3. categorize new items    │
                    └───────────┬──────────────────┘
                                │                  └──▶ Anthropic API
                                ▼                        (unseen items only)
                    ┌──────────────────────────────┐
                    │  D1  (invoices, items,       │
                    │       rules, overrides)      │
                    └───────────┬──────────────────┘
                                │
   Browser ────────▶┌───────────▼──────────────────┐
                    │  app worker (same script)    │
                    │   /api/*  +  static assets   │
                    └──────────────────────────────┘

   KV: item→category cache, winning-number cache
```

One Worker script, two entry points: `scheduled()` for the cron and `fetch()`
for HTTP. They share the same modules; the sync can also be invoked over HTTP
by the owner for manual runs and for local development.

## Stack, and why each piece

| Choice | Reason |
|---|---|
| **Cloudflare Workers** | Already known from the portfolio site, so the time goes into the actual problem. Crucially this uses the parts *not* exercised there: Cron Triggers, D1, KV. |
| **Cron Triggers** | The "runs without me" requirement. This is the single feature that separates this project from every client-side toy. |
| **D1 (SQLite)** | The data is relational and query-shaped: items join invoices join categories, grouped by month. A document store would fight this. Also a deliberately different muscle from the Supabase/Postgres usage on the portfolio. |
| **KV** | The item→category cache is a pure key-value lookup on a hot path, read far more than written. Correct tool; also keeps the cache cheap to reason about separately from the relational data. |
| **Anthropic API, `claude-haiku-4-5-20251001`** | Item classification is a short, high-volume, low-difficulty task with a fixed output schema — exactly the Haiku case. Escalating to a larger model here would be paying for reasoning the task does not need. |
| **Vanilla TS + Vite for the frontend** | Small enough not to need a framework; a build step and type checking are the parts worth adding relative to the portfolio site. |
| **Vitest** | The sync logic (watermarks, overlap, dedupe, queue draining) is genuinely test-worthy and is the one place tests pay for themselves. |

Deliberately not used: Supabase (nothing here needs it — auth is one owner and
can be a signed cookie), any ORM (the schema is nine tables and raw SQL is
clearer), any charting framework heavier than a small SVG helper.

## Modules

```
src/
  index.ts             fetch() + scheduled() entry points
  einvoice/
    client.ts          MOF API transport: signing, params, retries
    parse.ts           response → domain types, tolerant of shape drift
  sync/
    headers.ts         window calculation, header upsert
    details.ts         detail queue drain
    run.ts             orchestration, sync_run bookkeeping
  categorize/
    rules.ts           override → merchant rule → cache lookup
    llm.ts             batched Anthropic call, JSON schema, cache write
    normalize.ts       item_key derivation (see CATEGORIZATION.md)
  prizes/
    fetch.ts           winning number list
    match.ts           number matching by prize class
  api/                 HTTP handlers, one file per resource
  db/
    schema.sql         mirrors SCHEMA.sql in this bundle
    queries.ts         all SQL lives here, nowhere else
web/                   dashboard, built by Vite into dist/
```

## Boundaries that matter

**All SQL in `db/queries.ts`.** No query strings anywhere else. It makes the
data access auditable in one file and it is the thing that rots fastest if
allowed to spread.

**The MOF client never touches the database, and the sync never talks HTTP.**
`einvoice/client.ts` returns parsed domain objects and knows nothing about
storage; `sync/` orchestrates and persists but takes the client as a parameter.
This is what makes the sync algorithm testable without a network — the
non-negotiable design constraint, because the sync logic is the part most
likely to be subtly wrong.

**Categorization is a pure function of (item, rules, cache) plus one impure
escape hatch.** `rules.ts` never calls the network. Only `llm.ts` does, only on
a cache miss, and its result is written straight back to the cache. Anything
that blurs this makes the cost behavior unpredictable.

**Secrets never reach the browser.** Carrier code, App ID, and Anthropic key
are Worker secrets. The dashboard talks only to `/api/*`. There is no path by
which the client holds a credential — worth stating because the credential in
question is attached to a real identity.

## Configuration

Worker secrets (`wrangler secret put`):

```
EINVOICE_APP_ID        MOF-issued App ID
EINVOICE_CARD_NO       手機條碼 (the /XXXXXXX barcode)
EINVOICE_CARD_ENCRYPT  the carrier's verification code
ANTHROPIC_API_KEY
SESSION_SECRET         HMAC key for the owner's session cookie
OWNER_PASSWORD_HASH    argon2/scrypt hash; single owner, no user table
```

Plain vars in `wrangler.jsonc`: `SYNC_OVERLAP_DAYS`, `SYNC_WINDOW_DAYS`,
`DETAIL_BUDGET_PER_RUN`, `LLM_BATCH_SIZE`.

None of these are optional at boot — validate all of them on first use and fail
the sync run loudly rather than silently syncing nothing.
