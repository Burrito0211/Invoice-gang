# MILESTONES

Ordered so that every milestone ends with something that runs. Nothing here is
"build the whole backend, then the whole frontend" — each step produces a
thing that can be looked at, which is what keeps a side project alive.

Estimates assume evenings and weekends, not full days.

---

## M0 — Prove the API. **Do this before anything else.**

*~1 evening, plus waiting on approval*

- [ ] Apply for the MOF App ID **today** — approval is not instant and every
      other milestone is blocked on it
- [ ] Register the 手機條碼, set the verification code, confirm invoices are
      actually landing on the carrier
- [ ] One successful `qryWinningList` call (needs no carrier — cheapest proof
      the App ID and transport work)
- [ ] One successful `carrierInvChk` call
- [ ] One successful `carrierInvDetail` call
- [ ] Save every raw response to `docs/api-samples/*.json` — these become the
      test fixtures for the entire project
- [ ] Update `EINVOICE-API.md`, converting every **[assumed]** tag to a
      verified field name or correcting it

**Done when:** real JSON from all three endpoints is committed, and no
assumption about the API remains unverified.

**If this milestone fails** — registration blocked, API unusable — stop and
reconsider the project rather than building around it. Better to lose one
evening than three weekends.

---

## M1 — Skeleton and headers

*~1 weekend*

- [ ] Worker + Vite scaffold, TypeScript strict, Vitest running
- [ ] D1 created, `SCHEMA.sql` applied, carrier row seeded
- [ ] `einvoice/client.ts` with signing, timestamps, retries, credential
      scrubbing
- [ ] Header sync phase, watermark, overlap re-scan
- [ ] `GET /api/invoices` and a plain HTML table of them
- [ ] Owner login

**Done when:** a manual sync pulls a month of real invoice headers and they
render in a browser. Ugly is fine.

---

## M2 — Details and the queue

*~1 weekend*

- [ ] Detail queue drain with budget, attempt cap and backoff
- [ ] Item insert, idempotent on `(inv_num, row_num)`
- [ ] `sync_run` bookkeeping and `GET /api/sync/status`
- [ ] Invariant tests from `SYNC.md` — all five, against fixtures
- [ ] Cron trigger enabled

**Done when:** the sync runs unattended on schedule, the invariant tests pass,
and the status page shows a history of runs. **This is the milestone that makes
the project worth putting in a portfolio** — everything after it is value on
top of a system that already works.

---

## M3 — Rules and the dashboard

*~1 weekend*

- [ ] Rule cascade steps 1–4 (no model yet)
- [ ] Seed rules from the top-merchants query in `CATEGORIZATION.md`
- [ ] Dashboard: monthly total, category breakdown, merchant breakdown,
      drill-down to invoice
- [ ] Search across item descriptions

**Done when:** a real month of spending is charted and the top ~20 merchants
categorize themselves without a model.

---

## M4 — The classifier

*~1 weekend*

- [ ] `item_key` normalization + tests over the messiest real descriptions in
      the data
- [ ] Batched Haiku classification with structured output and key validation
- [ ] KV + table cache, written on every model answer
- [ ] `GET /api/stats` and the stats panel

**Done when:** uncategorized share is under 10% by value and the cache hit rate
climbs visibly across successive runs.

---

## M5 — The correction loop

*~2 evenings*

- [ ] `POST /api/categorize` with immediate re-resolution and cache
      invalidation
- [ ] Click-to-recategorize in the UI, both scopes
- [ ] Low-confidence review queue sorted by amount

**Done when:** a misclassification can be fixed in two clicks and the chart
updates without a re-sync.

---

## M6 — Prizes

*~1 evening*

- [ ] Winning-number fetch and cache
- [ ] Matching by prize class
- [ ] Notification on a hit, idempotent via `notified_at`

**Done when:** it correctly identifies a past winning invoice you already know
about — test against history, not by waiting two months for a draw.

---

## M7 — Make it presentable

*~1 weekend*

- [ ] README with the architecture diagram, the sync design explained in prose,
      and the four measured numbers from M4
- [ ] Dark mode and a phone-sized layout (it will live on a home screen)
- [ ] `docs/` covering the setup another person would need
- [ ] Add to the portfolio's `Projects.mdx` / `Projects.en.mdx`

**Done when:** someone who has never seen it understands the sync design
without opening `src/`.

---

## Cut list

If time runs short, cut in this order: M6, then M7's dark mode, then M5's
merchant scope. **Never cut M2's tests** — they are the part of this project
that is actually worth showing.

## The failure mode to watch for

The temptation after M3 is to add budgets, then goals, then multi-account, then
a bank import. Every one of those is a month of work that adds nothing to what
makes this project interesting, and the half-built version of them is what
turns a finished project into an abandoned one. The scope in `SPEC.md` is a
commitment, not an opening offer.
