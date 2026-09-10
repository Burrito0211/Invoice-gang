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
  bindIncomeForm();
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
  if (view === 'income') void renderIncome();
  if (view === 'review') void renderReview();
  if (view === 'stats') void renderStats();
}

/**
 * Manual income. This is the only screen that takes a typed figure — see the
 * hint in the markup for why it is the exception rather than the rule.
 */
async function renderIncome(): Promise<void> {
  const { income } = await api.income(state.from, state.to);
  const total = income.reduce((sum, row) => sum + row.amount, 0);

  $('income-list').innerHTML =
    income.length === 0
      ? '<p class="muted">No income recorded in this range.</p>'
      : `<p class="muted">${money(total)} across ${income.length} entr${income.length === 1 ? 'y' : 'ies'}.</p>` +
        income
          .map(
            (row) => `<div class="row">
              <span class="muted">${escape(row.date)}</span>
              <span class="grow">${escape(row.source)}${row.note ? ` · ${escape(row.note)}` : ''}</span>
              <span class="amount">${escape(money(row.amount))}</span>
              <button class="del-income" data-id="${row.id}" title="Delete">✕</button>
            </div>`,
          )
          .join('');

  for (const btn of document.querySelectorAll<HTMLButtonElement>('.del-income')) {
    btn.addEventListener('click', async () => {
      await api.deleteIncome(Number(btn.dataset.id));
      await renderIncome();
      await renderDashboard();
    });
  }
}

function bindIncomeForm(): void {
  const form = $<HTMLFormElement>('income-form');
  $<HTMLInputElement>('income-date').value = today();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const amount = Number($<HTMLInputElement>('income-amount').value);
    if (!Number.isInteger(amount) || amount <= 0) {
      flash('Amount must be a whole number of NT$.');
      return;
    }
    try {
      await api.addIncome({
        date: $<HTMLInputElement>('income-date').value,
        amount,
        source: $<HTMLInputElement>('income-source').value.trim(),
        note: $<HTMLInputElement>('income-note').value.trim() || undefined,
      });
      $<HTMLInputElement>('income-amount').value = '';
      $<HTMLInputElement>('income-source').value = '';
      $<HTMLInputElement>('income-note').value = '';
      flash('Income added.');
      await renderIncome();
      await renderDashboard();
    } catch (err) {
      flash(err instanceof ApiCallError ? err.message : 'could not add income');
    }
  });
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

  const t = byCategory.totals;

  $('totals').innerHTML = [
    // Already net of discounts and of items marked not-mine.
    tile('Spent', money(t.invoice_total)),
    t.income_total > 0 ? tile('Income', money(t.income_total)) : '',
    // Net only means something once there is income to net against.
    t.income_total > 0
      ? tile('Net', `${t.net_total < 0 ? '-' : ''}${money(Math.abs(t.net_total))}`)
      : tile('Invoices', String(t.invoice_count)),
    t.discount_total > 0 ? tile('Discounts', `-${money(t.discount_total)}`) : '',
    tile('Uncategorized', itemTotal === 0 ? '—' : percent((uncategorized?.total ?? 0) / itemTotal)),
  ]
    .filter((x) => x !== '')
    .join('');

  $('chart-category').innerHTML = bars(byCategory.breakdown, { color: (row) => categoryColor(row.key) });
  $('chart-month').innerHTML = bars(byMonth.breakdown);
  $('chart-merchant').innerHTML = bars(byMerchant.breakdown.slice(0, 12));
}

function tile(label: string, value: string): string {
  return `<div class="tile"><div class="label">${escape(label)}</div><div class="value">${escape(value)}</div></div>`;
}

/**
 * A bar chart is two divs and a percentage. This is the whole charting layer.
 *
 * Every row carries its share of the total alongside the value, because
 * "NT$1,913" only becomes an answer once you know it is 84% of the month.
 *
 * **The bar length is that same share.** Scaling against the largest row
 * instead makes the biggest bar always full-width, so a row reading 71.9%
 * appears completely filled and the picture contradicts the number printed
 * beside it. One denominator, used for both.
 *
 * `format` exists because not every panel counts money — "how items were
 * classified" counts items, and running those through the currency formatter
 * turned 9 items into "NT$9".
 */
interface BarOptions {
  color?: (row: SummaryRow) => string;
  format?: 'money' | 'count';
  /** Singular noun for count rows, e.g. "item" → "9 items". */
  unit?: string;
}

function bars(rows: SummaryRow[], options: BarOptions = {}): string {
  if (rows.length === 0) return '<p class="muted">Nothing in this range yet.</p>';

  const values = rows.map((r) => Number(r.total) || 0);
  const total = values.reduce((sum, v) => sum + v, 0);
  const unit = options.unit ?? 'item';

  return `<div class="bars">${rows
    .map((row, index) => {
      const value = values[index] ?? 0;
      const share = total === 0 ? 0 : value / total;
      // A non-zero row always shows something, or a 0.3% slice looks like 0.
      const width = value === 0 ? 0 : Math.max(1.5, share * 100);
      const fill = options.color ? options.color(row) : 'var(--accent)';
      const label =
        options.format === 'count'
          ? `${value} ${unit}${value === 1 ? '' : 's'}`
          : money(value);
      return `<div class="bar-row">
          <span class="bar-label" title="${escape(row.label_en)}">${escape(row.label_en)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${width.toFixed(1)}%;background:${escape(fill)}"></span></span>
          <span class="bar-value">
            <span class="bar-amount">${escape(label)}</span>
            <span class="bar-share">${escape(percent(share))}</span>
          </span>
        </div>`;
    })
    .join('')}</div>`;
}

/** `category_source` values are internal; these are what a person reads. */
const SOURCE_LABELS: Record<string, string> = {
  override: 'Your correction',
  merchant: 'Merchant rule',
  cache: 'Cached answer',
  llm: 'Model',
  none: 'Not yet classified',
};

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
    <p class="hint">Untick an item that is not yours — bought for someone else on a shared receipt. It stays on the invoice but drops out of your totals.</p>
    <table>
      <thead><tr><th>Mine</th><th>Item</th><th>Category</th><th class="num">Amount</th></tr></thead>
      <tbody>
        ${purchases
          .map(
            (item) => `<tr class="${item.mine ? '' : 'excluded'}" data-item="${item.id}">
              <td><input type="checkbox" class="mine" data-item="${item.id}" ${item.mine ? 'checked' : ''} /></td>
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

  // Ticking "Mine" on or off marks the item excluded and refreshes the chart,
  // so the effect on the totals is visible immediately.
  for (const box of document.querySelectorAll<HTMLInputElement>('#detail-body input.mine')) {
    box.addEventListener('change', async () => {
      const id = Number(box.dataset.item);
      box.closest('tr')?.classList.toggle('excluded', !box.checked);
      try {
        await api.setItemMine(id, box.checked);
        await renderDashboard();
      } catch (err) {
        box.checked = !box.checked; // roll the UI back if the write failed
        box.closest('tr')?.classList.toggle('excluded', !box.checked);
        flash(err instanceof ApiCallError ? err.message : 'could not update the item');
      }
    });
  }

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
            label_en: SOURCE_LABELS[s.source] ?? s.source,
            total: s.n,
            item_count: s.n,
          })),
          { format: 'count' },
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
          { format: 'count' },
        )}
      </div>
    </div>`;
}

/**
 * Import a carrier CSV export — but never straight in. The file is previewed
 * first: parsed and categorized server-side without a single write, then shown
 * for the owner to pick which invoices to keep and correct any category before
 * anything is committed. The raw CSV is held in the browser between the two
 * steps so the server stays the single parser.
 */
async function handleUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const label = document.querySelector<HTMLLabelElement>('.upload');
  const original = label?.textContent ?? 'Import CSV';
  if (label) label.textContent = 'Reading…';

  try {
    const csv = await file.text();
    const preview = await api.importPreview(csv);
    openPreview(csv, preview);
  } catch (err) {
    flash(err instanceof ApiCallError ? err.message : 'could not read the file');
  } finally {
    if (label) label.textContent = original;
    input.value = ''; // reset so re-selecting the same file fires `change` again
  }
}

/** Per-item category the owner has changed in the preview: item_key → category key. */
const previewEdits = new Map<string, string>();

/**
 * The review screen. Each invoice is a checkbox; already-imported ones start
 * unticked, because re-importing is harmless but rarely what was meant. Every
 * item shows its proposed category in an editable dropdown — changing one
 * queues an override that is written on commit.
 */
function openPreview(csv: string, preview: import('./api.js').ImportPreview): void {
  previewEdits.clear();

  const total = preview.invoices.length;
  const fresh = preview.invoices.filter((i) => !i.already_imported).length;
  $('preview-summary').textContent =
    `${total} invoice${total === 1 ? '' : 's'} in the file — ${fresh} new, ` +
    `${total - fresh} already imported.` +
    (preview.skipped_rows.length > 0 ? ` ${preview.skipped_rows.length} row(s) skipped.` : '');

  $('preview-body').innerHTML = preview.invoices
    .map((inv) => {
      const items = inv.items
        .map(
          (item) => `<tr>
            <td>${escape(item.description)}</td>
            <td>${categorySelect(item.item_key, item.category)}</td>
            <td class="num">${escape(money(item.net_amount))}</td>
          </tr>`,
        )
        .join('');
      return `<section class="preview-invoice">
          <label class="preview-invoice-head">
            <input type="checkbox" class="pick" data-inv="${escape(inv.inv_num)}" ${inv.already_imported ? '' : 'checked'} />
            <span class="grow">${escape(inv.seller_name ?? inv.inv_num)}</span>
            <span class="muted">${escape(inv.inv_date)}</span>
            <span class="amount">${escape(money(inv.amount))}</span>
            ${inv.already_imported ? '<span class="tag">already imported</span>' : ''}
            ${inv.masked ? '<span class="tag">masked number</span>' : ''}
          </label>
          <table><tbody>${items}</tbody></table>
        </section>`;
    })
    .join('');

  // A changed dropdown in the preview edits the pending import, not the
  // database — nothing here writes until Import selected is pressed.
  for (const select of document.querySelectorAll<HTMLSelectElement>('#preview-body select.cat')) {
    select.addEventListener('change', () => {
      const key = select.dataset.key ?? '';
      if (key !== '' && select.value !== '') previewEdits.set(key, select.value);
      else previewEdits.delete(key);
    });
  }

  const confirm = $<HTMLButtonElement>('preview-confirm');
  confirm.onclick = () => void commitPreview(csv);
  $<HTMLButtonElement>('preview-cancel').onclick = () => $<HTMLDialogElement>('preview').close();
  $<HTMLDialogElement>('preview').showModal();
}

async function commitPreview(csv: string): Promise<void> {
  const include = [...document.querySelectorAll<HTMLInputElement>('#preview-body input.pick:checked')]
    .map((box) => box.dataset.inv ?? '')
    .filter((n) => n !== '');

  if (include.length === 0) {
    flash('Tick at least one invoice to import.');
    return;
  }

  const overrides = [...previewEdits].map(([item_key, category]) => ({ item_key, category }));
  const confirm = $<HTMLButtonElement>('preview-confirm');
  confirm.disabled = true;
  confirm.textContent = 'Importing…';

  try {
    const result = await api.importCommit({ csv, include, overrides });
    const run = result.run;
    flash(
      `Imported ${include.length} invoice${include.length === 1 ? '' : 's'} — ` +
        `${run.headers_new} new, ${run.items_new} items` +
        (result.items_corrected ? `, ${result.items_corrected} corrected` : ''),
    );
    $<HTMLDialogElement>('preview').close();
    await renderDashboard();
    await renderStaleness();
  } catch (err) {
    flash(err instanceof ApiCallError ? err.message : 'import failed');
  } finally {
    confirm.disabled = false;
    confirm.textContent = 'Import selected';
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
