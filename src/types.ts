/**
 * Domain types and the Worker environment.
 *
 * Money is `number` but always an integer of New Taiwan dollars. Dates are
 * `YYYY-MM-DD` strings, timestamps are unix seconds. Both hold across the
 * wire and in the database — see docs/SCHEMA.sql.
 */

/** `YYYY-MM-DD`. */
export type IsoDate = string;

/** Unix seconds. */
export type Unix = number;

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS?: Fetcher;

  // Secrets — `wrangler secret put`, never wrangler.jsonc, never the bundle.
  /**
   * Labels the carrier row. Not a credential any more — nothing logs in — and
   * optional: unset just means the row is named `default`. Resolve it through
   * `carrierKey()` so every lookup agrees with what `ensureCarrier` created.
   */
  EINVOICE_CARD_NO?: string;
  ANTHROPIC_API_KEY: string;
  SESSION_SECRET: string;
  OWNER_PASSWORD_HASH: string;
  /**
   * Optional. When set, enables bearer-token auth on `POST /api/import` so
   * the local crawler can upload without a login cookie. Absent means
   * cookie-only — the token path never opens by accident.
   */
  IMPORT_TOKEN?: string;
  /**
   * Optional webhook the staleness and prize notifications POST to — ntfy,
   * Discord, Slack, anything that accepts a plain-text body. Unset means log
   * only, still visible through `wrangler tail`.
   */
  NOTIFY_WEBHOOK?: string;

  // Plain vars. Arrive as strings; parsed by loadConfig().
  LLM_BATCH_SIZE?: string;
  /**
   * `YYYY-MM-DD` recorded as the carrier's creation date on first import.
   * Cosmetic now — the export decides how much history arrives, not a window.
   */
  EINVOICE_CARRIER_SINCE?: string;
}

// ------------------------------------------------------------------ carrier

export interface Carrier {
  id: number;
  card_type: string;
  card_no: string;
  label: string | null;
  created_at: Unix;
}

// ----------------------------------------------------------------- invoices

/** An invoice header, parsed from the carrier CSV export. */
export interface InvoiceHeader {
  invNum: string;
  invDate: IsoDate;
  invPeriod: string | null;
  sellerBan: string | null;
  sellerName: string | null;
  amount: number;
  invStatus: string | null;
  donatable: boolean;
}

/** One line item from the carrier CSV export. */
export interface InvoiceDetailRow {
  rowNum: number;
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
}

export interface InvoiceRow {
  inv_num: string;
  carrier_id: number;
  inv_date: IsoDate;
  inv_period: string | null;
  seller_ban: string | null;
  seller_name: string | null;
  amount: number;
  inv_status: string | null;
  donatable: number;
  detail_fetched_at: Unix | null;
  detail_attempts: number;
  detail_error: string | null;
  first_seen_at: Unix;
  updated_at: Unix;
}

export type CategorySource = 'override' | 'merchant' | 'cache' | 'llm' | 'none';

export interface ItemRow {
  id: number;
  inv_num: string;
  row_num: number;
  description: string;
  item_key: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
  /** Derived: amount after invoice-level discounts are allocated across lines. */
  net_amount: number | null;
  /** 1 when this item is not the owner's spending; left out of every total. */
  excluded: number;
  category_id: number | null;
  category_source: CategorySource | null;
  categorized_at: Unix | null;
}

export interface Category {
  id: number;
  key: string;
  label_zh: string;
  label_en: string;
  color: string | null;
  sort: number;
}

// -------------------------------------------------------------------- sync

export type SyncTrigger = 'cron' | 'manual' | 'backfill';
export type SyncStatus = 'ok' | 'partial' | 'quota' | 'error';

export interface SyncRunTotals {
  headers_seen: number;
  headers_new: number;
  details_fetched: number;
  items_new: number;
  llm_calls: number;
  llm_items: number;
  cache_hits: number;
}

export interface SyncRunRow extends SyncRunTotals {
  id: number;
  started_at: Unix;
  finished_at: Unix | null;
  trigger: SyncTrigger;
  status: SyncStatus | null;
  window_start: IsoDate | null;
  window_end: IsoDate | null;
  error: string | null;
}

// ------------------------------------------------------------------ prizes

export type PrizeClass = 'special' | 'grand' | 'first' | 'additional';

