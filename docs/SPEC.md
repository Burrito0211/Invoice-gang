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

One. Me. See Non-goals.

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

- **Multi-user.** The carrier verification code is a credential tied to a
  national-ID-linked account. Accepting other people's is a security and
  privacy problem substantially larger than the rest of this project combined.
  Single-user is the honest scope.
- **Bank / credit card import.** No usable open-banking API; would mean
  screen-scraping or CSV babysitting, and it dilutes the one genuinely
  interesting data source.
- **Budgets, envelopes, goals, alerts on overspend.** Standard personal-finance
  app features, none of which need this data pipeline to exist. They are how
  this project turns into a half-finished Mint clone.
- **Manual expense entry.** If it needs typing, it will not be used, and the
  whole premise was that it does not.
- **Mobile app.** A responsive web page reached from a phone home screen is
  indistinguishable in practice.
- **Receipts without an e-invoice.** Traditional paper 紙本發票 not on the
  carrier are out. Coverage is imperfect and that is acceptable.

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
