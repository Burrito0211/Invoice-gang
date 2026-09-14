# SPEC — Invoice Gang v1

## Problem

Every purchase in Taiwan already produces a structured electronic record filed
with the Ministry of Finance, and it is carried on my 手機條碼 barcode. That
record is complete, itemized, and completely unused. Manual expense tracking
apps fail because they require me to type; this data requires nobody to type
anything, and it is already mine.

## Goal

A system that, without any daily interaction from me, knows what I spent money
on and can answer "where did it go this month" with item-level accuracy.

## The user

Originally one — me. Now anyone who signs up, each seeing only their own
invoices; see *Reversed*.

## v1 scope

**Sync.** A scheduled job pulls new invoices from the MOF API for a single
registered carrier and stores them durably. It survives being run twice, run
late, or run after a week of downtime, and it never re-fetches a line item it
already has.

**Itemization.** Each invoice's line items are fetched and stored individually.
The unit of analysis is the item, not the invoice — "I spent NT$4,200 at
7-ELEVEN this month" is useless; "NT$1,800 of it was coffee" is the product.

**Categorization.** Every line item lands in exactly one spending category.
Deterministic rules handle the merchants and products already seen; an LLM
handles genuinely new strings, once, and the answer is cached against the raw
product text so the same item is never classified twice.

**Correction.** Any categorization can be overridden in the UI. An override
becomes a persistent rule that outranks the rule table and the cache, so the
system's accuracy is monotonically non-decreasing with use.

**Dashboard.** One page. Spend over time, breakdown by category, breakdown by
merchant, drill down to the invoice, full-text search across item descriptions.

**Prize check.** After each invoice period the official winning numbers are
fetched and matched against stored invoices; a hit produces a notification.

## Explicit non-goals for v1

These are not "later" — they are decisions to not build:

- **Bank / credit card import.** No usable open-banking API; would mean
  screen-scraping or CSV babysitting, and it dilutes the one genuinely
  interesting data source.
- **Envelopes, per-category caps, goals, overspend alerts.** A single monthly
  total is now in — see *Reversed* below — and the rest of the standard
  personal-finance feature set stays out. Envelopes and goals are where this
  turns into a half-finished Mint clone, and an alert fired on data that is
  two days old by law is a false alarm waiting to happen.
- **Manual expense entry.** If it needs typing, it will not be used, and the
  whole premise was that it does not.
- **Mobile app.** A responsive web page reached from a phone home screen is
  indistinguishable in practice.
- **Receipts without an e-invoice.** Traditional paper 紙本發票 not on the
  carrier are out. Coverage is imperfect and that is acceptable.

## Reversed

- **A single monthly budget** (2026-09-12). Originally ruled out with the rest
  of the personal-finance feature set, on the grounds that none of it needs
  this data pipeline to exist. That was true and beside the point: without a
  budget the app only ever answers what was spent, never what is left, and
  "what is left" is the question the data was being collected to answer.
  Nearly abandoning the project over that gap is what surfaced the mistake.

  One figure per month, carried forward until changed, shown against how far
  through the month you are. `budget/pace.ts` is pure, the table stores change
  points rather than one current value so a past month keeps the budget it was
  actually lived under, and nothing else from that bullet came with it.

- **Multi-user** (2026-09-14). Ruled out because the carrier verification
  code is a credential tied to a national-ID-linked account, and holding
  other people's was a bigger security problem than the rest of the project.
  The move to CSV import removed that premise: nothing in the Worker holds a
  carrier credential for anyone, and an account holds only files its owner
  chose to upload. What was left was isolation, which is enforced where the
  data is read — every query on personal data takes an account id — and
  tested by importing one export into two accounts.

  Sign-up is open. Categories, rules and the classifier cache are shared,
  because they describe products rather than people; invoices, corrections,
  income and budgets are not.

## Success criteria

The project is done when all of the following hold:

1. I have not manually triggered a sync in two weeks and the data is current.
2. Over a full month of my real spending, fewer than 10% of line items by
   value are `uncategorized`, and I fixed the misses by clicking, not by
   editing code.
3. The LLM cache hit rate exceeds 90% in steady state — visible on a stats
   page, because that number is the point.
4. A stranger can read the README and understand the sync design without
   opening the source.

## Why this is worth building

It is genuinely useful daily, it runs unattended, and the hard parts are real:
rate-limited external API with a two-phase fetch, incremental sync that has to
be idempotent, cost-controlled LLM usage, and a feedback loop that improves the
system. That combination is much more interesting than the CRUD app it
superficially resembles.
