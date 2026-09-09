# CLAUDE.md

> Copy this file to the root of the new project repo. It is the project
> instructions for the build session.

Personal accounting system over Taiwan's 電子發票 API. Design documents live in
`docs/` (the spec bundle) — read `SPEC.md` and `ARCHITECTURE.md` before writing
code, and treat `SYNC.md` and `CATEGORIZATION.md` as the specification of those
two modules rather than as background reading.

## Development

```bash
npm run dev            # wrangler dev, local D1
npm run test           # vitest
npm run db:apply       # wrangler d1 execute invoice-gang --file=./src/db/schema.sql
npm run deploy         # wrangler deploy
```

Never run a sync against production D1 from a local dev session — it will
advance the real watermark and burn real API quota. Local runs use
`--local` D1 and the fixture-backed fake client.

## Architecture rules

These exist because breaking them is what makes this project hard to work on
later:

- **All SQL lives in `src/db/queries.ts`.** No query strings anywhere else.
- **`einvoice/` never touches the database. `sync/` never makes HTTP calls
  directly** — it takes the client as a parameter. This is what makes the sync
  testable without a network, which is the point of the whole test suite.
- **`categorize/rules.ts` is pure** — no network. Only `categorize/llm.ts`
  calls a model, only on a cache miss, and it writes its answer back to the
  cache in the same code path.
- **Money is `INTEGER` everywhere** — schema, API payloads, arithmetic. No
  floats touch an amount.
- **Credentials are scrubbed at the boundary** in `einvoice/client.ts`, not at
  each log site. `cardNo` and `cardEncrypt` must never appear in a log line, a
  `sync_run.error`, or an API response.

## The sync invariants

Any change to `src/sync/` must keep all five properties in `docs/SYNC.md`
holding, and the tests asserting them must still pass: idempotent, resumable,
monotone, bounded, quota-safe. If a change makes one of them harder to state,
that is a signal the change is wrong.

The single most important test is the late-arriving-invoice case — an invoice
filed inside the overlap window after that window was already synced must be
picked up on the next run. That test is why the overlap re-scan exists.

## Model usage

Classification uses `claude-haiku-4-5-20251001`. Do not upgrade the model to
improve accuracy without first checking whether the failing items are actually
a prompt or taxonomy problem — the task is short-string classification into 13
fixed buckets and a larger model is usually paying for reasoning it does not
need. Always validate returned category keys against the `category` table; an
unknown key is a bug, never a new category.

Batch classification requests. A per-item model call is roughly 20–40x the cost
of a batched one and there is no accuracy benefit.

## Conventions

- TypeScript strict. No `any` in `sync/` or `einvoice/`.
- No ORM. The schema is small and raw SQL is clearer than a mapping layer.
- Dates `YYYY-MM-DD`, timestamps unix seconds, both across the wire and in the
  database.
- Secrets via `wrangler secret put`, never in `wrangler.jsonc`, never in the
  client bundle.

## Commit convention

Subject line is `type/ description` — type, forward slash, **space**, then a
lowercase description of what changed. Not `type:` and not `/type`.

Types: `feat`, `fix`, `refactor`, `docs`, `test`.

Then a blank line, a prose body wrapped at ~76 columns explaining what changed
and why (not a bullet list of files), a blank line, and the co-author trailer.

```
feat/ add the detail queue with a per-run call budget

Invoice line items come back one HTTP call per invoice against an unknown
daily quota, so details cannot be fetched inline with the headers. Queue them
instead: a NULL detail_fetched_at is the queue, newest invoices drain first,
and a run stops after DETAIL_BUDGET_PER_RUN calls. A zero-row response does
not mark the invoice fetched, because details can lag behind headers and
marking it complete would make the miss permanent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Anything touching `sync/` or `categorize/` gets a body.

Commits go directly on `main`. No feature branches, no PRs.
