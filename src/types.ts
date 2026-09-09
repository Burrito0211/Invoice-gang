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
  EINVOICE_APP_ID: string;
  EINVOICE_CARD_NO: string;
  EINVOICE_CARD_ENCRYPT: string;
  ANTHROPIC_API_KEY: string;
  SESSION_SECRET: string;
  OWNER_PASSWORD_HASH: string;
  /**
   * Optional. When set, enables bearer-token auth on `POST /api/import` so
   * the local crawler can upload without a login cookie. Absent means
   * cookie-only — the token path never opens by accident.
   */
  IMPORT_TOKEN?: string;

  // Plain vars. Arrive as strings; parsed by loadConfig().
  SYNC_OVERLAP_DAYS?: string;
  SYNC_WINDOW_DAYS?: string;
  SYNC_HEADER_CALL_BUDGET?: string;
  DETAIL_BUDGET_PER_RUN?: string;
  LLM_BATCH_SIZE?: string;
  EINVOICE_BASE_URL?: string;
  EINVOICE_UUID?: string;
  /**
   * `YYYY-MM-DD` the first sync should start from, stored as the carrier's
   * `created_at`. Defaults to today, which means "no history" — set it back to
   * backfill, since the window plan starts at the carrier's creation date.
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

/** What the e-invoice client needs to authenticate. Never logged, never echoed. */
export interface CarrierCredentials {
  cardType: string;
  cardNo: string;
  cardEncrypt: string;
}

// ----------------------------------------------------------------- invoices

/** A header as returned by `carrierInvChk`, already parsed and normalized. */
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

/** A line item as returned by `carrierInvDetail`. */
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

/** One row of the detail queue — everything the detail call needs. */
export interface PendingInvoice {
  inv_num: string;
  inv_date: IsoDate;
  amount: number;
  seller_name: string | null;
  seller_ban: string | null;
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

export interface WinningNumbers {
  invPeriod: string;
  /** Every published number for the period, tagged with its class. */
  numbers: { prizeClass: PrizeClass; number: string }[];
}
