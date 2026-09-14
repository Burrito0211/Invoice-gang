/**
 * The dashboard. One page: spend over time, breakdown by category and
 * merchant, drill-down to the invoice, search across item descriptions, and
 * click-to-recategorize.
 *
 * No framework and no charting library — the charts here are horizontal bars,
 * which is the honest shape for "category totals for a month", and a bar is
 * two divs. Money arrives as an integer and is formatted here, never by the
 * server.
 *
 * Every string a person reads comes from `i18n.ts`. The interpolations are
 * still escaped at the call site, because `t()` deliberately does not escape —
 * see the note at the top of that file.
 */
import { api, ApiCallError } from './api.js';
import { applyStaticStrings, label, locale, monthName, setLocale, t } from './i18n.js';
import type { BudgetPace, Category, InvoiceSummary, ReviewItem, SummaryRow } from './api.js';

type AuthMode = 'signIn' | 'register';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const state = {
  from: firstOfMonth(),
  to: today(),
  categories: [] as Category[],
  cursor: null as string | null,
  invoices: [] as InvoiceSummary[],
  search: '',
  /** Tracked so a language change can re-render whatever is on screen. */
  view: 'dashboard',
  username: '',
  authMode: 'signIn' as AuthMode,
};

// --------------------------------------------------------------------- boot

void start();

async function start(): Promise<void> {
  setLocale(locale()); // stamps <html lang> from the stored or detected choice
  applyStaticStrings();
  const session = await api.session();
  if (!session.authenticated) return showLogin();
  state.username = session.username ?? '';
  await showApp();
}

/**
 * Sign-in and sign-up share one form — the same two fields, a different
 * button and endpoint. Sign-up is open, so this is also the front door for
 * someone who has never been here, and it says how to get in.
 */
function showLogin(): void {
  $('login').hidden = false;
  renderLoginMode();

  $('login-switch').addEventListener('click', () => {
    state.authMode = state.authMode === 'signIn' ? 'register' : 'signIn';
    renderLoginMode();
  });

  $<HTMLFormElement>('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('login-error');
    error.hidden = true;
    const username = $<HTMLInputElement>('username').value.trim();
    const password = $<HTMLInputElement>('password').value;
    const registering = state.authMode === 'register';
    try {
      const result = registering
        ? await api.register(username, password)
        : await api.login(username, password);
      state.username = result.username;
      $('login').hidden = true;
      await showApp();
    } catch (err) {
      error.textContent =
        err instanceof ApiCallError
          ? err.message
          : registering
            ? t('login.registerFailed')
            : t('login.failed');
      error.hidden = false;
    }
  });
}

function renderLoginMode(): void {
  const registering = state.authMode === 'register';
  $('login-submit').textContent = registering ? t('action.createAccount') : t('action.signIn');
  $('login-switch').textContent = registering ? t('login.toSignIn') : t('login.toRegister');
  $('login-hint').hidden = !registering;
  // Lets a password manager offer to generate one, rather than fill an old one.
  $<HTMLInputElement>('password').autocomplete = registering ? 'new-password' : 'current-password';
  $('login-error').hidden = true;
}

async function showApp(): Promise<void> {
  $('app').hidden = false;
  // Never an empty, invisible button: without a name the dialog would be unreachable.
  $('account').textContent = state.username || t('nav.account');
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
  $('lang').addEventListener('click', () => void toggleLanguage());
  bindAccount();
  bindGuide();
  bindIncomeForm();
  $('search').addEventListener('input', debounce(() => void runSearch(), 250));
  $('load-more').addEventListener('click', () => void loadInvoices(false));
  $('detail-close').addEventListener('click', () => $<HTMLDialogElement>('detail').close());

  await renderDashboard();
  await renderStaleness();
}

/**
 * Switching language re-renders rather than reloading. Every view builds its
 * markup from scratch on each render anyway, so redrawing is both cheaper than
 * a reload and keeps the date range you had chosen.
 */
async function toggleLanguage(): Promise<void> {
  setLocale(locale() === 'zh' ? 'en' : 'zh');
  applyStaticStrings();
  await renderDashboard();
  await renderStaleness();
  if (state.view !== 'dashboard') await renderView(state.view);
  if ($<HTMLDialogElement>('account-dialog').open) await renderAccount();
}

/**
 * The export guide. Getting the file out of the carrier portal is the one step
 * this system cannot do for you — the login sits behind bot management — so it
 * is written down beside the button that needs the file, with pictures, and
 * says plainly which checkbox column gives your invoices away.
 */
function bindGuide(): void {
  const dialog = $<HTMLDialogElement>('guide');
  $('csv-help').addEventListener('click', () => dialog.showModal());
  $('guide-close').addEventListener('click', () => dialog.close());
}

function switchView(view: string): void {
  state.view = view;
  for (const button of document.querySelectorAll<HTMLButtonElement>('nav button')) {
    button.classList.toggle('active', button.dataset.view === view);
  }
  for (const section of document.querySelectorAll<HTMLElement>('.view')) {
    section.hidden = section.id !== `view-${view}`;
  }
  // The invoice list is the one view worth keeping between visits — it pages,
  // and re-fetching would throw away everything already scrolled past.
  if (view === 'invoices' && state.invoices.length > 0) return;
  void renderView(view);
}

function renderView(view: string): Promise<void> {
  if (view === 'invoices') return loadInvoices(true);
  if (view === 'income') return renderIncome();
  if (view === 'review') return renderReview();
  if (view === 'stats') return renderStats();
  return renderDashboard();
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
      ? `<p class="muted">${t('income.none')}</p>`
      : `<p class="muted">${escape(t('income.summary', { n: income.length, total: money(total) }))}</p>` +
        income
          .map(
            (row) => `<div class="row">
              <span class="muted">${escape(row.date)}</span>
              <span class="grow">${escape(row.source)}${row.note ? ` · ${escape(row.note)}` : ''}</span>
              <span class="amount">${escape(money(row.amount))}</span>
              <button class="del-income" data-id="${row.id}" title="${escape(t('action.delete'))}">✕</button>
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
      flash(t('income.badAmount'));
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
      flash(t('income.added'));
      await renderIncome();
      await renderDashboard();
    } catch (err) {
      flash(err instanceof ApiCallError ? err.message : t('income.failed'));
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

  const totals = byCategory.totals;

  $('totals').innerHTML = [
    // Already net of discounts and of items marked not-mine.
    tile(t('totals.spent'), money(totals.invoice_total)),
    totals.income_total > 0 ? tile(t('totals.income'), money(totals.income_total)) : '',
    // Net only means something once there is income to net against.
    totals.income_total > 0
      ? tile(
          t('totals.net'),
          `${totals.net_total < 0 ? '-' : ''}${money(Math.abs(totals.net_total))}`,
        )
      : tile(t('totals.invoices'), String(totals.invoice_count)),
    totals.discount_total > 0 ? tile(t('totals.discounts'), `-${money(totals.discount_total)}`) : '',
    tile(
      t('totals.uncategorized'),
      itemTotal === 0 ? '—' : percent((uncategorized?.total ?? 0) / itemTotal),
    ),
  ]
    .filter((x) => x !== '')
    .join('');

  $('chart-category').innerHTML = bars(byCategory.breakdown, {
    color: (row) => categoryColor(row.key),
  });
  $('chart-month').innerHTML = bars(byMonth.breakdown, { labelFormat: 'month' });
  $('chart-merchant').innerHTML = bars(byMerchant.breakdown.slice(0, 12));

  await renderBudget();
}

/**
 * The budget card.
 *
 * The bar carries two marks rather than one: how much of the budget is gone,
 * and how far through the month you are. Sixty-two percent spent is neither
 * good nor bad until you know whether the month is a third or nine-tenths
 * over, so the comparison is drawn instead of being left for the reader to do.
 *
 * A budget is a property of a month, not of the dashboard's arbitrary range,
 * so the card follows the month of the range's end date and says which month
 * it is showing.
 */
async function renderBudget(): Promise<void> {
  const month = state.to.slice(0, 7);
  const card = $('budget');

  let budget: BudgetPace;
  try {
    budget = await api.budget(month);
  } catch {
    card.hidden = true; // a budget failure must not take the charts with it
    return;
  }

  card.hidden = false;
  card.innerHTML = budget.amount === null ? budgetPrompt(budget) : budgetCard(budget);
  bindBudget(month);
}

function budgetPrompt(budget: BudgetPace): string {
  return `<div class="budget-head">
      <h2>${escape(t('budget.none', { month: monthName(budget.month) }))}</h2>
      <span class="muted">${escape(t('budget.spentSoFar', { amount: money(budget.spent) }))}</span>
    </div>
    <p class="hint">${escape(t('budget.setOnce'))}</p>
    ${budgetForm(null)}`;
}

function budgetCard(budget: BudgetPace): string {
  const amount = budget.amount ?? 0;
  const share = amount === 0 ? 0 : budget.spent / amount;
  const monthShare = budget.days_elapsed / budget.days_in_month;

  const carried =
    budget.effective_from !== null && budget.effective_from !== budget.month
      ? `<span class="tag">${escape(
          t('budget.carried', { month: monthName(budget.effective_from) }),
        )}</span>`
      : '';

  return `<div class="budget-head">
      <h2>${escape(t('budget.title', { month: monthName(budget.month) }))} ${carried}</h2>
      <span class="muted">${escape(
        budget.days_left === 0
          ? t('budget.monthOver')
          : t('budget.daysLeft', { n: budget.days_left }),
      )}</span>
    </div>
    <div class="budget-figures">
      <strong>${escape(money(budget.spent))}</strong>
      <span class="muted">${escape(t('budget.of', { amount: money(amount) }))}</span>
      <span class="grow"></span>
      <button id="budget-edit" class="linky">${escape(t('action.edit'))}</button>
    </div>
    <div class="budget-track ${escape(budget.status)}">
      <span class="budget-fill" style="width:${(Math.min(share, 1) * 100).toFixed(1)}%"></span>
      <span class="budget-today" style="left:${(monthShare * 100).toFixed(1)}%"
            title="${escape(
              t('budget.daysGone', {
                elapsed: budget.days_elapsed,
                total: budget.days_in_month,
              }),
            )}"></span>
    </div>
    <p class="budget-lines ${escape(budget.status)}">${budgetSentence(budget)}</p>
    ${budgetForm(amount)}`;
}

/**
 * One sentence, and which one depends on the only distinction that changes
 * what you would do: already over the budget, heading over it, or fine.
 *
 * These few phrases carry `<strong>` around the number that matters, so they
 * are interpolated rather than escaped — the values going in are escaped here
 * and the markup is ours.
 */
function budgetSentence(budget: BudgetPace): string {
  if (budget.days_left === 0) {
    const remaining = budget.remaining ?? 0;
    return remaining < 0
      ? t('budget.finishedOver', { amount: escape(money(-remaining)) })
      : t('budget.finishedUnder', { amount: escape(money(remaining)) });
  }

  if (budget.status === 'over') {
    return t('budget.overBudget', {
      amount: escape(money(-(budget.remaining ?? 0))),
      n: budget.days_left,
    });
  }

  const perDay =
    budget.remaining_per_day === null
      ? ''
      : `${t('budget.perDay', {
          amount: escape(money(budget.remaining_per_day)),
          pace: escape(money(budget.pace_per_day)),
        })} `;

  return (
    perDay +
    (budget.status === 'projected_over'
      ? t('budget.atThisRate', {
          projected: escape(money(budget.projected)),
          over: escape(money(budget.over_by ?? 0)),
        })
      : t('budget.onTrack', { projected: escape(money(budget.projected)) }))
  );
}

/** Hidden until Edit is pressed once a figure exists; the only way in when it does not. */
function budgetForm(amount: number | null): string {
  return `<form class="budget-form" id="budget-form"${amount === null ? '' : ' hidden'}>
      <input id="budget-amount" type="number" min="1" step="1" inputmode="numeric"
             placeholder="${escape(t('budget.placeholder'))}" value="${amount ?? ''}" required />
      <button type="submit" class="upload">${escape(
        amount === null ? t('action.setBudget') : t('action.save'),
      )}</button>
    </form>`;
}

function bindBudget(month: string): void {
  document.getElementById('budget-edit')?.addEventListener('click', () => {
    const form = $('budget-form');
    form.hidden = !form.hidden;
    if (!form.hidden) $<HTMLInputElement>('budget-amount').focus();
  });

  $<HTMLFormElement>('budget-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const amount = Number($<HTMLInputElement>('budget-amount').value);
    if (!Number.isInteger(amount) || amount <= 0) {
      flash(t('budget.badAmount'));
      return;
    }
    try {
      await api.setBudget(month, amount);
      flash(t('budget.set', { month: monthName(month), amount: money(amount) }));
      await renderBudget();
    } catch (err) {
      flash(err instanceof ApiCallError ? err.message : t('budget.failed'));
    }
  });
}

function tile(labelText: string, value: string): string {
  return `<div class="tile"><div class="label">${escape(labelText)}</div><div class="value">${escape(value)}</div></div>`;
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
  /** Month rows key on `YYYY-MM`, which is not what a person wants to read. */
  labelFormat?: 'month';
}

function bars(rows: SummaryRow[], options: BarOptions = {}): string {
  if (rows.length === 0) return `<p class="muted">${t('bars.empty')}</p>`;

  const values = rows.map((r) => Number(r.total) || 0);
  const total = values.reduce((sum, v) => sum + v, 0);

  return `<div class="bars">${rows
    .map((row, index) => {
      const value = values[index] ?? 0;
      const share = total === 0 ? 0 : value / total;
      // A non-zero row always shows something, or a 0.3% slice looks like 0.
      const width = value === 0 ? 0 : Math.max(1.5, share * 100);
      const fill = options.color ? options.color(row) : 'var(--accent)';
      const text =
        options.format === 'count' ? t('bars.items', { n: value }) : money(value);
      const name = options.labelFormat === 'month' ? monthName(row.key) : label(row);
      return `<div class="bar-row">
          <span class="bar-label" title="${escape(name)}">${escape(name)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${width.toFixed(1)}%;background:${escape(fill)}"></span></span>
          <span class="bar-value">
            <span class="bar-amount">${escape(text)}</span>
            <span class="bar-share">${escape(percent(share))}</span>
          </span>
        </div>`;
    })
    .join('')}</div>`;
}

/** `category_source` values are internal; these are what a person reads. */
function sourceLabel(source: string | null): string {
  return t(`source.${source ?? 'none'}`);
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
      ? `<p class="muted">${t('invoice.none')}</p>`
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
    <p class="hint">${escape(t('invoice.detailHint'))}</p>
    <table>
      <thead><tr>
        <th>${escape(t('invoice.colMine'))}</th>
        <th>${escape(t('invoice.colItem'))}</th>
        <th>${escape(t('invoice.colCategory'))}</th>
        <th class="num">${escape(t('invoice.colAmount'))}</th>
      </tr></thead>
      <tbody>
        ${purchases
          .map(
            (item) => `<tr class="${item.mine ? '' : 'excluded'}" data-item="${item.id}">
              <td><input type="checkbox" class="mine" data-item="${item.id}" ${item.mine ? 'checked' : ''} /></td>
              <td>${escape(item.description)}</td>
              <td>${categorySelect(item.item_key, item.category)}
                  <span class="tag">${escape(sourceLabel(item.category_source))}</span></td>
              <td class="num">${escape(money(item.net_amount))}${
                item.net_amount !== item.amount
                  ? `<span class="muted"> ${escape(
                      t('invoice.was', { amount: money(item.amount) }),
                    )}</span>`
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
        : `<p class="muted">${escape(
            t('invoice.discountNote', { amount: money(discount) }),
          )}</p>`
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
      } catch (err) {
        // Roll the tick back only when the write itself failed. Refreshing the
        // chart afterwards is a separate concern: reverting on *its* failure
        // would undo a change the server had already accepted.
        box.checked = !box.checked;
        box.closest('tr')?.classList.toggle('excluded', !box.checked);
        flash(err instanceof ApiCallError ? err.message : t('invoice.updateFailed'));
        return;
      }
      await renderDashboard();
    });
  }

  $<HTMLDialogElement>('detail').showModal();
}

// ------------------------------------------------------------------- review

async function renderReview(): Promise<void> {
  const { items, low_confidence_threshold } = await api.reviewItems();
  $('review-list').innerHTML =
    items.length === 0
      ? `<p class="muted">${t('review.empty')}</p>`
      : items.map((item) => reviewRow(item, low_confidence_threshold)).join('');
  bindCategorySelects();
}

function reviewRow(item: ReviewItem, threshold: number): string {
  const flag =
    item.confidence !== null && item.confidence < threshold
      ? `<span class="tag">${escape(
          t('review.lowConfidence', { score: item.confidence.toFixed(2) }),
        )}</span>`
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
        `<option value="${escape(c.key)}"${c.key === current ? ' selected' : ''}>${escape(label(c))}</option>`,
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
      flash(t('categorize.done', { n: result.items_updated }));
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
      ${tile(t('stats.cacheHitRate'), stats.cache.hit_rate === null ? '—' : percent(stats.cache.hit_rate))}
      ${tile(t('stats.itemsPerCall'), stats.batching.items_per_call?.toFixed(1) ?? '—')}
      ${tile(
        t('stats.uncatByValue'),
        coverage.uncategorized_share_by_value === null
          ? '—'
          : percent(coverage.uncategorized_share_by_value),
      )}
      ${tile(t('stats.modelSpend'), `US$${(stats.spend.estimated_usd_cents / 100).toFixed(2)}`)}
    </div>
    <div class="panels">
      <div class="panel">
        <h2>${escape(t('stats.howClassified'))}</h2>
        ${bars(
          coverage.by_source.map((source) => ({
            key: source.source,
            label_en: sourceLabel(source.source),
            total: source.n,
            item_count: source.n,
          })),
          { format: 'count' },
        )}
      </div>
      <div class="panel">
        <h2>${escape(t('stats.recentRuns'))}</h2>
        <table>
          <thead><tr>
            <th>#</th>
            <th>${escape(t('stats.colStatus'))}</th>
            <th class="num">${escape(t('stats.colNew'))}</th>
            <th class="num">${escape(t('stats.colItems'))}</th>
          </tr></thead>
          <tbody>${stats.sync.recent_runs
            .map(
              (run) => `<tr><td>${run.id}</td><td>${escape(run.status ?? '—')}</td>
                 <td class="num">${run.headers_new}</td><td class="num">${run.items_new}</td></tr>`,
            )
            .join('')}</tbody>
        </table>
        <p class="muted">${escape(
          t('stats.syncedThrough', {
            date: stats.sync.synced_through ?? t('stats.never'),
            model: stats.model,
          }),
        )}</p>
      </div>
      <div class="panel">
        <h2>${escape(t('stats.merchantsWorthRule'))}</h2>
        ${bars(
          stats.rule_candidates.map((m) => ({
            key: m.seller_ban ?? '',
            label_en: m.seller_name ?? m.seller_ban ?? t('stats.unknown'),
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

  // By id, not by `.upload` — that class is on the income and budget buttons
  // too, and a document-order query would eventually grab the wrong one.
  const csvLabel = $<HTMLLabelElement>('csv-label');
  const original = csvLabel.textContent ?? t('action.importCsv');
  csvLabel.textContent = t('action.reading');

  try {
    const csv = await file.text();
    const preview = await api.importPreview(csv);
    openPreview(csv, preview);
  } catch (err) {
    flash(err instanceof ApiCallError ? err.message : t('preview.readFailed'));
  } finally {
    csvLabel.textContent = original;
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
    t('preview.summary', { total, fresh, dup: total - fresh }) +
    (preview.skipped_rows.length > 0
      ? t('preview.skipped', { n: preview.skipped_rows.length })
      : '');

  $('preview-body').innerHTML = preview.invoices
    .map((inv) => {
      const items = inv.items
        .map(
          (item) => `<tr>
            <td><input type="checkbox" class="pick-item" checked
                       data-inv="${escape(inv.inv_num)}" data-row="${item.row_num}" /></td>
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
            ${inv.already_imported ? `<span class="tag">${escape(t('preview.alreadyImported'))}</span>` : ''}
            ${inv.masked ? `<span class="tag">${escape(t('preview.maskedNumber'))}</span>` : ''}
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

  for (const box of document.querySelectorAll<HTMLInputElement>('#preview-body input.pick-item')) {
    box.addEventListener('change', () => {
      box.closest('tr')?.classList.toggle('excluded', !box.checked);
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
    flash(t('preview.pickOne'));
    return;
  }

  // Lines left unticked are imported but flagged as not the owner's, so the
  // invoice still reconciles while the spending total ignores them.
  const excludeItems = [
    ...document.querySelectorAll<HTMLInputElement>('#preview-body input.pick-item:not(:checked)'),
  ].map((box) => ({ inv_num: box.dataset.inv ?? '', row_num: Number(box.dataset.row) }));

  const overrides = [...previewEdits].map(([item_key, category]) => ({ item_key, category }));
  const confirm = $<HTMLButtonElement>('preview-confirm');
  confirm.disabled = true;
  confirm.textContent = t('action.importing');

  try {
    const result = await api.importCommit({ csv, include, exclude_items: excludeItems, overrides });
    const run = result.run;
    flash(
      t('preview.imported', {
        n: include.length,
        headers: run.headers_new,
        items: run.items_new,
      }) +
        (excludeItems.length > 0 ? t('preview.notCounted', { n: excludeItems.length }) : '') +
        (result.items_corrected ? t('preview.corrected', { n: result.items_corrected }) : ''),
    );
    $<HTMLDialogElement>('preview').close();
    await renderDashboard();
    await renderStaleness();
  } catch (err) {
    flash(err instanceof ApiCallError ? err.message : t('preview.failed'));
  } finally {
    confirm.disabled = false;
    confirm.textContent = t('action.importSelected');
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
        ? t('stale.never')
        : t('stale.old', {
            n: status.age_days,
            date: escape(status.covered_through ?? '—'),
          });
    banner.hidden = false;
  } catch {
    banner.hidden = true; // a status failure must not break the dashboard
  }
}

// ------------------------------------------------------------------ account

/**
 * The account dialog: who is signed in, the watch-folder token, the
 * notification webhook, and signing out.
 *
 * The import token is shown in exactly one render — the one straight after it
 * is created. The server keeps only a hash and could not show it again if
 * asked, so closing the dialog or switching language hides it for good.
 */
function bindAccount(): void {
  const dialog = $<HTMLDialogElement>('account-dialog');
  $('account').addEventListener('click', () => void openAccount());
  $('account-close').addEventListener('click', () => dialog.close());
  $('sign-out').addEventListener('click', () => void signOut());
  $('sign-out-top').addEventListener('click', () => void signOut());
  $('token-create').addEventListener('click', () => void createToken());
  $('token-revoke').addEventListener('click', () => void revokeToken());
  $<HTMLFormElement>('webhook-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void saveWebhook();
  });
}

async function openAccount(): Promise<void> {
  await renderAccount();
  $<HTMLDialogElement>('account-dialog').showModal();
}

async function renderAccount(freshToken?: string): Promise<void> {
  const account = await api.account();
  $('account-name').textContent = account.username;
  $('account-since').textContent = t('account.since', { date: dateOf(account.created_at) });

  const token = account.import_token;
  $('token-status').textContent =
    token === null
      ? t('account.tokenNone')
      : t('account.tokenSet', {
          date: dateOf(token.created_at),
          used: token.last_used_at === null ? t('account.never') : dateOf(token.last_used_at),
        });

  const value = $('token-value');
  value.textContent = freshToken ?? '';
  value.hidden = freshToken === undefined;
  $('token-create').textContent =
    token === null ? t('action.createToken') : t('action.replaceToken');
  $('token-revoke').hidden = token === null;

  $<HTMLInputElement>('webhook-url').value = account.notify_webhook ?? '';
}

async function createToken(): Promise<void> {
  try {
    const { token } = await api.createImportToken();
    await renderAccount(token);
    flash(t('account.tokenCopyNow'));
  } catch (err) {
    flash(err instanceof ApiCallError ? err.message : t('account.tokenFailed'));
  }
}

async function revokeToken(): Promise<void> {
  try {
    await api.revokeImportToken();
    await renderAccount();
    flash(t('account.tokenRevoked'));
  } catch (err) {
    flash(err instanceof ApiCallError ? err.message : t('account.tokenFailed'));
  }
}

async function saveWebhook(): Promise<void> {
  const value = $<HTMLInputElement>('webhook-url').value.trim();
  try {
    await api.updateAccount({ notify_webhook: value === '' ? null : value });
    flash(t('account.webhookSaved'));
  } catch (err) {
    flash(err instanceof ApiCallError ? err.message : t('account.webhookFailed'));
  }
}

/**
 * A reload rather than tearing the page down by hand: the dashboard holds the
 * last account's invoices in `state` and in the DOM, and a reload is the one
 * way to be sure none of it is still on screen for whoever signs in next.
 */
async function signOut(): Promise<void> {
  try {
    await api.logout();
  } finally {
    // Reload even if the request failed, so a sign-out is never a dead button.
    location.reload();
  }
}

// ------------------------------------------------------------------ helpers

/** Unix seconds → `YYYY-MM-DD`, the one date format this app shows. */
function dateOf(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

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
