/**
 * The dashboard's only channel to the server. There is no path by which the
 * client holds a credential — the session cookie is HttpOnly, and the carrier
 * code, App ID and Anthropic key are Worker secrets it never sees.
 */

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text === '' ? null : (JSON.parse(text) as unknown);

  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiCallError(response.status, error?.code ?? 'unknown', error?.message ?? text);
  }
  return body as T;
}

export const api = {
  session: () => request<{ authenticated: boolean }>('/api/session'),
  login: (password: string) =>
    request<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),

  summary: (from: string, to: string, group: 'category' | 'merchant' | 'month') =>
    request<SummaryResponse>(`/api/summary?from=${from}&to=${to}&group=${group}`),

  invoices: (params: { from?: string; to?: string; q?: string; cursor?: string }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
    return request<InvoiceListResponse>(`/api/invoices?${query}`);
  },

  invoice: (invNum: string) => request<InvoiceDetailResponse>(`/api/invoices/${invNum}`),

  reviewItems: () => request<ReviewResponse>('/api/items?limit=100'),

  categories: () => request<{ categories: Category[] }>('/api/categories'),

  stats: () => request<StatsResponse>('/api/stats'),

  categorize: (scope: 'item' | 'merchant', key: string, category: string) =>
    request<{ items_updated: number }>('/api/categorize', {
      method: 'POST',
      body: JSON.stringify({ scope, key, category }),
    }),

  importCsv: (csv: string) =>
    request<ImportResponse>('/api/import', {
      method: 'POST',
      headers: { 'content-type': 'text/csv; charset=utf-8' },
      body: csv,
    }),

  importStatus: () => request<ImportStatus>('/api/import/status'),
};

// ------------------------------------------------------------------- shapes

export interface Category {
  id: number;
  key: string;
  label_zh: string;
  label_en: string;
  color: string | null;
}

export interface SummaryRow {
  key: string;
  label_en: string;
  label_zh?: string;
  color?: string | null;
  total: number;
  item_count: number;
}

export interface SummaryResponse {
  from: string;
  to: string;
  group: string;
  totals: {
    invoice_count: number;
    invoice_total: number;
    discount_total: number;
    item_total: number;
  };
  breakdown: SummaryRow[];
}

export interface InvoiceSummary {
  inv_num: string;
  inv_date: string;
  seller_name: string | null;
  seller_ban: string | null;
  amount: number;
  status: string | null;
  details_pending: boolean;
  item_count: number;
}

export interface InvoiceListResponse {
  items: InvoiceSummary[];
  next_cursor: string | null;
}

export interface InvoiceItem {
  id: number;
  row_num: number;
  description: string;
  item_key: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
  net_amount: number;
  category: string | null;
  category_source: string | null;
}

export interface InvoiceDetailResponse {
  invoice: InvoiceSummary;
  items: InvoiceItem[];
}

export interface ReviewItem {
  id: number;
  inv_num: string;
  description: string;
  item_key: string;
  amount: number;
  category_key: string | null;
  category_source: string | null;
  confidence: number | null;
  inv_date: string;
  seller_name: string | null;
  seller_ban: string | null;
}

export interface ReviewResponse {
  items: ReviewItem[];
  low_confidence_threshold: number;
}

export interface SyncRun {
  id: number;
  status: string | null;
  headers_new: number;
  details_fetched: number;
  items_new: number;
  llm_calls: number;
  cache_hits: number;
  error: string | null;
}

export interface ImportResponse {
  run: SyncRun;
  invoices_seen: number;
  masked_invoice_numbers: string[];
  skipped_rows: { line: number; reason: string }[];
}

export interface ImportStatus {
  covered_through: string | null;
  last_success_at: number | null;
  age_days: number | null;
  stale_after_days: number;
  stale: boolean;
  runs: SyncRun[];
}

export interface StatsResponse {
  model: string;
  cache: {
    hit_rate: number | null;
    hits: number;
    llm_items: number;
    entries: number;
    lifetime_hits: number;
  };
  batching: { llm_calls: number; items_per_call: number | null };
  coverage: {
    item_count: number;
    item_total: number;
    uncategorized_count: number;
    uncategorized_total: number;
    uncategorized_share_by_value: number | null;
    by_source: { source: string; n: number }[];
  };
  spend: { estimated_usd_cents: number; input_tokens: number; output_tokens: number };
  sync: {
    synced_through: string | null;
    last_run_at: number | null;
    last_success_at: number | null;
    recent_runs: SyncRun[];
  };
  rule_candidates: { seller_ban: string | null; seller_name: string | null; n: number }[];
}
