/**
 * The dashboard. One page: spend over time, breakdown by category and
 * merchant, drill-down to the invoice, search across item descriptions, and
 * click-to-recategorize.
 *
 * No framework and no charting library — the charts here are horizontal bars,
 * which is the honest shape for "category totals for a month", and a bar is
 * two divs. Money arrives as an integer and is formatted here, never by the
 * server.
 */
import { api, ApiCallError } from './api.js';
import type { Category, InvoiceSummary, ReviewItem, SummaryRow } from './api.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const state = {
  from: firstOfMonth(),
  to: today(),
  categories: [] as Category[],
  cursor: null as string | null,
  invoices: [] as InvoiceSummary[],
  search: '',
};

// --------------------------------------------------------------------- boot

void start();

async function start(): Promise<void> {
  const { authenticated } = await api.session();
  if (!authenticated) return showLogin();
  await showApp();
}

function showLogin(): void {
  $('login').hidden = false;
  $<HTMLFormElement>('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('login-error');
    error.hidden = true;
    try {
      await api.login($<HTMLInputElement>('password').value);
      $('login').hidden = true;
      await showApp();
    } catch (err) {
      error.textContent = err instanceof ApiCallError ? err.message : 'sign in failed';
      error.hidden = false;
    }
  });
}

async function showApp(): Promise<void> {
  $('app').hidden = false;
  $<HTMLInputElement>('from').value = state.from;
  $<HTMLInputElement>('to').value = state.to;

  state.categories = (await api.categories()).categories;

  for (const button of document.querySelectorAll<HTMLButtonElement>('nav button')) {
    button.addEventListener('click', () => switchView(button.dataset.view ?? 'dashboard'));
  }
  for (const id of ['from', 'to']) {
    $(id).addEventListener('change', () => {
      state.from = $<HTMLInputElement>('from').value;
      state.to = $<HTMLInputElement>('to').value;
      void renderDashboard();
    });
  }
  $('csv').addEventListener('change', (event) => void handleUpload(event));
  $('search').addEventListener('input', debounce(() => void runSearch(), 250));
  $('load-more').addEventListener('click', () => void loadInvoices(false));
  $('detail-close').addEventListener('click', () => $<HTMLDialogElement>('detail').close());

  await renderDashboard();
  await renderStaleness();
}

function switchView(view: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('nav button')) {
    button.classList.toggle('active', button.dataset.view === view);
  }
  for (const section of document.querySelectorAll<HTMLElement>('.view')) {
    section.hidden = section.id !== `view-${view}`;
  }
  if (view === 'invoices' && state.invoices.length === 0) void loadInvoices(true);
  if (view === 'review') void renderReview();
  if (view === 'stats') void renderStats();
}

// ---------------------------------------------------------------- dashboard

async function renderDashboard(): Promise<void> {
  const [byCategory, byMonth, byMerchant] = await Promise.all([
    api.summary(state.from, state.to, 'category'),
    api.summary(state.from, state.to, 'month'),
    api.summary(state.from, state.to, 'merchant'),
  ]);

  const uncategorized = byCategory.breakdown.find((r) => r.key === 'uncategorized');
  const itemTotal = byCategory.totals.item_total;

  $('totals').innerHTML = [
    tile('Spent', money(byCategory.totals.invoice_total)),
    tile('Invoices', String(byCategory.totals.invoice_count)),
    tile(
      'Uncategorized',
      itemTotal === 0 ? '—' : percent((uncategorized?.total ?? 0) / itemTotal),
    ),
  ].join('');

  $('chart-category').innerHTML = bars(byCategory.breakdown, (row) => categoryColor(row.key));
  $('chart-month').innerHTML = bars(byMonth.breakdown);
  $('chart-merchant').innerHTML = bars(byMerchant.breakdown.slice(0, 12));
}

function tile(label: string, value: string): string {
  return `<div class="tile"><div class="label">${escape(label)}</div><div class="value">${escape(value)}</div></div>`;
}

/** A bar chart is two divs and a percentage. This is the whole charting layer. */
function bars(rows: SummaryRow[], color?: (row: SummaryRow) => string): string {
  if (rows.length === 0) return '<p class="muted">Nothing in this range yet.</p>';
  const max = Math.max(...rows.map((r) => Number(r.total) || 0), 1);

  return `<div class="bars">${rows
    .map((row) => {
      const total = Number(row.total) || 0;
      const width = Math.max(1, Math.round((total / max) * 100));
      const fill = color ? color(row) : 'var(--accent)';
      return `<div class="bar-row">
          <span class="bar-label" title="${escape(row.label_en)}">${escape(row.label_en)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${width}%;background:${escape(fill)}"></span></span>
          <span class="bar-value">${escape(money(total))}</span>
        </div>`;
    })
    .join('')}</div>`;
}

function categoryColor(key: string): string {
  return state.categories.find((c) => c.key === key)?.color ?? 'var(--accent)';
}

// ----------------------------------------------------------------- invoices

async function runSearch(): Promise<void> {
  state.search = $<HTMLInputElement>('search').value.trim();
  await loadInvoices(true);
}

async function loadInvoices(reset: boolean): Promise<void> {
  if (reset) {
    state.cursor = null;
    state.invoices = [];
  }
  const page = await api.invoices({
    from: state.from,
    to: state.to,
    q: state.search || undefined,
    cursor: state.cursor ?? undefined,
  });
  state.invoices.push(...page.items);
  state.cursor = page.next_cursor;
  $('load-more').hidden = page.next_cursor === null;

  $('invoice-list').innerHTML =
    state.invoices.length === 0
      ? '<p class="muted">No invoices match.</p>'
      : state.invoices
          .map(
            (inv) => `<div class="row" data-inv="${escape(inv.inv_num)}">
              <span class="muted">${escape(inv.inv_date)}</span>
              <span class="grow">${escape(inv.seller_name ?? inv.inv_num)}</span>
              <span class="amount">${escape(money(inv.amount))}</span>
            </div>`,
          )
          .join('');

  for (const row of document.querySelectorAll<HTMLElement>('#invoice-list .row')) {
    row.addEventListener('click', () => void openInvoice(row.dataset.inv ?? ''));
  }
}

async function openInvoice(invNum: string): Promise<void> {
  const detail = await api.invoice(invNum);

  // Discount rows are folded into the lines they discount rather than listed
  // separately: the export files them as their own negative rows, but they
  // apply to the whole invoice, so showing one row per product at its real
  // price is what actually answers "what did this cost me".
  const purchases = detail.items.filter((item) => item.amount >= 0);
  const discount = detail.items
    .filter((item) => item.amount < 0)
    .reduce((sum, item) => sum + item.amount, 0);
  $('detail-body').innerHTML = `
    <h2>${escape(detail.invoice.seller_name ?? invNum)}</h2>
    <p class="muted">${escape(detail.invoice.inv_date)} · ${escape(invNum)} · ${escape(money(detail.invoice.amount))}</p>
    <table>
      <thead><tr><th>Item</th><th>Category</th><th class="num">Amount</th></tr></thead>
      <tbody>
        ${purchases
          .map(
            (item) => `<tr>
              <td>${escape(item.description)}</td>
              <td>${categorySelect(item.item_key, item.category)}
                  <span class="tag">${escape(item.category_source ?? 'none')}</span></td>
              <td class="num">${escape(money(item.net_amount))}${
                item.net_amount !== item.amount
                  ? `<span class="muted"> was ${escape(money(item.amount))}</span>`
                  : ''
              }</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    ${
      discount === 0
        ? ''
        : `<p class="muted">Includes ${escape(money(discount))} of invoice discounts, spread across the lines above.</p>`
    }`;

  bindCategorySelects();
  $<HTMLDialogElement>('detail').showModal();
}

// ------------------------------------------------------------------- review

async function renderReview(): Promise<void> {
  const { items, low_confidence_threshold } = await api.reviewItems();
  $('review-list').innerHTML =
    items.length === 0
      ? '<p class="muted">Nothing needs review. That is the system working.</p>'
      : items.map((item) => reviewRow(item, low_confidence_threshold)).join('');
  bindCategorySelects();
}

function reviewRow(item: ReviewItem, threshold: number): string {
  const flag =
    item.confidence !== null && item.confidence < threshold
      ? `<span class="tag">low confidence ${item.confidence.toFixed(2)}</span>`
      : '';
  return `<div class="row">
      <span class="muted">${escape(item.inv_date)}</span>
      <span class="grow">${escape(item.description)}
        <span class="muted">· ${escape(item.seller_name ?? '')}</span></span>
      ${flag}
      ${categorySelect(item.item_key, item.category_key)}
      <span class="amount">${escape(money(item.amount))}</span>
    </div>`;
}

/**
 * Correcting a category writes an override, which re-resolves every existing
 * item with that key — so the number in the confirmation is the point.
 */
function categorySelect(itemKey: string, current: string | null): string {
  const options = state.categories
    .map(
      (c) =>
        `<option value="${escape(c.key)}"${c.key === current ? ' selected' : ''}>${escape(c.label_en)}</option>`,
    )
    .join('');
  return `<select class="cat" data-key="${escape(itemKey)}">
      <option value=""${current === null ? ' selected' : ''}>—</option>${options}
    </select>`;
}

function bindCategorySelects(): void {
  for (const select of document.querySelectorAll<HTMLSelectElement>('select.cat')) {
    select.addEventListener('change', async () => {
      const key = select.dataset.key ?? '';
      if (key === '' || select.value === '') return;
      const result = await api.categorize('item', key, select.value);
      flash(`Recategorized ${result.items_updated} item${result.items_updated === 1 ? '' : 's'}`);
      await renderDashboard();
    });
  }
}

// -------------------------------------------------------------------- stats

async function renderStats(): Promise<void> {
  const stats = await api.stats();
  const coverage = stats.coverage;

  $('stats').innerHTML = `
    <div class="totals">
      ${tile('Cache hit rate', stats.cache.hit_rate === null ? '—' : percent(stats.cache.hit_rate))}
      ${tile('Items per model call', stats.batching.items_per_call?.toFixed(1) ?? '—')}
      ${tile(
        'Uncategorized by value',
        coverage.uncategorized_share_by_value === null
          ? '—'
          : percent(coverage.uncategorized_share_by_value),
      )}
      ${tile('Model spend', `US$${(stats.spend.estimated_usd_cents / 100).toFixed(2)}`)}
    </div>
    <div class="panels">
      <div class="panel">
        <h2>How items were classified</h2>
        ${bars(
          coverage.by_source.map((s) => ({
            key: s.source,
            label_en: s.source,
            total: s.n,
            item_count: s.n,
          })),
        )}
      </div>
      <div class="panel">
        <h2>Recent runs</h2>
        <table>
          <thead><tr><th>#</th><th>Status</th><th class="num">New</th><th class="num">Items</th></tr></thead>
          <tbody>${stats.sync.recent_runs
            .map(
              (run) => `<tr><td>${run.id}</td><td>${escape(run.status ?? '—')}</td>
                 <td class="num">${run.headers_new}</td><td class="num">${run.items_new}</td></tr>`,
            )
            .join('')}</tbody>
        </table>
        <p class="muted">Synced through ${escape(stats.sync.synced_through ?? 'never')} · model ${escape(stats.model)}</p>
      </div>
      <div class="panel">
        <h2>Merchants worth a rule</h2>
        ${bars(
          stats.rule_candidates.map((m) => ({
            key: m.seller_ban ?? '',
            label_en: m.seller_name ?? m.seller_ban ?? '(unknown)',
            total: m.n,
            item_count: m.n,
          })),
        )}
      </div>
    </div>`;
}

/**
 * Import a carrier CSV export. The file is read in the browser and posted as
 * text — the same endpoint the watch-folder script uses, so there is one
 * import path and not two that drift apart.
 */
async function handleUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const label = document.querySelector<HTMLLabelElement>('.upload');
  const original = label?.textContent ?? 'Import CSV';
  if (label) label.textContent = 'Importing…';

  try {
    const result = await api.importCsv(await file.text());
    const run = result.run;
    flash(
      `${result.invoices_seen} invoices read — ${run.headers_new} new, ` +
        `${run.items_new} items, ${run.llm_calls} model call(s)`,
    );
    if (result.masked_invoice_numbers.length > 0) {
      flash(`${result.masked_invoice_numbers.length} invoice number(s) were masked by the export`);
    }
    await renderDashboard();
    await renderStaleness();
  } catch (err) {
    flash(err instanceof ApiCallError ? err.message : 'import failed');
  } finally {
    if (label) label.textContent = original;
    // Reset so re-selecting the same file fires `change` again.
    input.value = '';
  }
}

/**
 * The failure mode of a manual-import system is silence: you stop importing,
 * nothing errors, and the chart quietly stops moving. So how old the data is
 * gets said out loud rather than buried on a stats tab.
 */
async function renderStaleness(): Promise<void> {
  const banner = $('stale');
  try {
    const status = await api.importStatus();
    if (!status.stale) {
      banner.hidden = true;
      return;
    }
    banner.innerHTML =
      status.age_days === null
        ? '<strong>No invoices imported yet.</strong> Export your carrier CSV and use Import CSV above.'
        : `<strong>Data is ${status.age_days} days old.</strong> Covered through ${escape(
            status.covered_through ?? 'nothing',
          )} — export a fresh CSV and import it.`;
    banner.hidden = false;
  } catch {
    banner.hidden = true; // a status failure must not break the dashboard
  }
}

// ------------------------------------------------------------------ helpers

/** NT$ has no minor unit in practice; the integer from the server is the value. */
function money(value: number): string {
  return `NT$${Math.round(value).toLocaleString('en-US')}`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth(): string {
  return `${today().slice(0, 7)}-01`;
}

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}

function flash(message: string): void {
  const el = document.createElement('div');
  el.className = 'tag';
  el.style.cssText = 'position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);background:var(--surface);padding:.6rem 1rem;z-index:9';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: number | undefined;
  return () => {
    clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };
}
