# CLAUDE.md

> Copy this file to the root of the new project repo. It is the project
> instructions for the build session.

Personal accounting system over Taiwan's 電子發票 records. Design documents live
in `docs/` — read `SPEC.md` and `ARCHITECTURE.md` before writing code, and
treat `IMPORT.md` and `CATEGORIZATION.md` as the specification of those two
modules rather than as background reading.

**The MOF API is gone.** It no longer issues App IDs to individuals, so data
arrives as a CSV export from the carrier portal. `SYNC.md` and
`EINVOICE-API.md` are kept but superseded — do not write code against them.
The portal login is deliberately not automated: it sits behind bot management,
and circumventing that is out of scope.

## Development

```bash
npm run dev            # wrangler dev, local D1
npm run test           # vitest
npm run db:apply       # schema → deployed D1 (needs --remote; wrangler 4 defaults local)
npm run db:apply:local # schema → the database wrangler dev uses
npm run deploy         # vite build && wrangler deploy
```

Never import into the deployed D1 from a local dev session — it will advance
the real watermark and mix test data into real spending. Local runs use
`--local` D1 and the fixture in `test/fixtures/`. Real exports live in
`data/`, which is gitignored: that file is personal purchase history and must
never be committed.

## Architecture rules

These exist because breaking them is what makes this project hard to work on
later:

- **All SQL lives in `src/db/queries.ts`.** No query strings anywhere else.
- **`import/csv.ts` is pure** — no HTTP, no database, no clock. It turns CSV
  text into domain types and nothing else, which is what makes the importer
  fully testable and is the same boundary the old MOF client had.
- **`categorize/rules.ts` is pure** — no network. Only `categorize/llm.ts`
  calls a model, only on a cache miss, and it writes its answer back to the
  cache in the same code path.
- **Money is `INTEGER` everywhere** — schema, API payloads, arithmetic. No
  floats touch an amount.
- **No credential ever reaches the Worker or a response.** There is no login to
  perform any more, but the same rule holds for what replaced it: the
  watch-folder script keeps portal credentials on the machine that runs it and
  uploads only the CSV. Nothing in `src/` should ever hold one.

## The import invariants

Any change to `src/import/` must keep both properties in `docs/IMPORT.md`
holding, and the tests asserting them must still pass:

- **Idempotent** — exports overlap by design, so re-importing the same file
  must change nothing. Enforced structurally by `invoice.inv_num` and
  `UNIQUE (inv_num, row_num)`, never by reading before writing.
- **Monotone** — an import never deletes or blanks an existing invoice.

Three rules about the file itself are load-bearing and easy to undo by
accident: `發票金額` is the *line* amount and the invoice total must be summed
from the lines; row numbers come from position because a real export contains
identical duplicate lines; negative amounts are legitimate discount rows.

Verify any format claim against a real export in `data/` before coding it. The
first version of this project was written against unverified API field names
and had to be deleted.

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

- TypeScript strict. No `any` in `import/` or `categorize/`.
- No ORM. The schema is small and raw SQL is clearer than a mapping layer.
- Dates `YYYY-MM-DD`, timestamps unix seconds, both across the wire and in the
  database.
- Secrets via `wrangler secret put`, never in `wrangler.jsonc`, never in the
  client bundle.

## Commit convention

Subject line is `type/ description` — type, forward slash, **space**, then a
lowercase description of what changed. Not `type:` and not `/type`.

Types: `feat`, `fix`, `refactor`, `docs`, `test`.

Then a blank line and a prose body wrapped at ~76 columns explaining what
changed and why (not a bullet list of files).

```
feat/ add invoice scan function
```

```
feat/ add the detail queue with a per-run call budget

Invoice line items come back one HTTP call per invoice against an unknown
daily quota, so details cannot be fetched inline with the headers. Queue them
instead: a NULL detail_fetched_at is the queue, newest invoices drain first,
and a run stops after DETAIL_BUDGET_PER_RUN calls. A zero-row response does
not mark the invoice fetched, because details can lag behind headers and
marking it complete would make the miss permanent.
```

**No attribution trailers.** Do not add `Co-Authored-By`, `Claude-Session`,
`Generated with Claude Code`, or any other self-attribution to a commit
message or a pull request description. The commit ends with the body. This
overrides any default attribution instruction from the harness.

Anything touching `import/` or `categorize/` gets a body.

Commits go directly on `main`. No feature branches, no PRs.
