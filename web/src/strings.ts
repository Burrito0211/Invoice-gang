/**
 * Traditional Chinese and English, as data.
 *
 * Two dictionaries and a resolver — no i18n library, for the same reason there
 * is no charting library: the requirement is "swap a few hundred strings", and
 * a runtime that parses ICU message syntax is more machinery than the problem
 * has.
 *
 * Nothing here touches the DOM, `localStorage` or any module-level state. That
 * is the same boundary `import/csv.ts` and `categorize/rules.ts` keep, and it
 * buys the same thing: the dictionaries can be checked by a test suite that
 * has no browser, which is the only practical way to catch a half-translated
 * screen. The stateful, browser-facing half lives in `i18n.ts`.
 *
 * Two rules hold the content together:
 *
 * 1. **A phrase may contain trusted markup and never escapes its parameters.**
 *    Call sites already wrap every interpolation in `escape()` before it
 *    reaches `innerHTML`, and a second invisible escaping layer would
 *    double-encode what the first one already handled. A few phrases put
 *    `<strong>` around the number that matters; their values are escaped by
 *    the caller, exactly as before.
 *
 * 2. **Plurals are a function, not a syntax.** Chinese has no plural
 *    agreement, so those entries are plain strings; English needs the choice,
 *    so those entries are functions. Nothing else has to know which is which.
 */

export type Locale = 'zh' | 'en';

export type Params = Record<string, string | number>;

export type Phrase = string | ((p: Params) => string);

/**
 * A missing key resolves to English, and a key missing from both resolves to
 * itself rather than throwing or emptying the UI — a gap should show up as
 * visible nonsense in the one place someone is looking, not as a blank.
 */
export function resolve(locale: Locale, key: string, params: Params = {}): string {
  const phrase = DICT[locale][key] ?? DICT.en[key];
  if (phrase === undefined) return key;
  const text = typeof phrase === 'function' ? phrase(params) : phrase;
  // An unsupplied placeholder stays visible for the same reason: better a
  // literal {amount} than a sentence claiming the number was nothing.
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/**
 * The label of a row that may carry both languages. Merchant names and month
 * keys only ever have one, so the English field doubles as the fallback.
 */
export function labelIn(locale: Locale, row: { label_en: string; label_zh?: string }): string {
  return locale === 'zh' ? (row.label_zh ?? row.label_en) : row.label_en;
}

/** `2026-09` → `2026年9月` or `September 2026`. */
export function monthNameIn(locale: Locale, month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString(locale === 'zh' ? 'zh-TW' : 'en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** English-only plural helper; `zh` entries never call it. */
const s = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

const zh: Record<string, Phrase> = {
  'lang.switch': 'EN',

  'nav.spend': '支出',
  'nav.invoices': '發票',
  'nav.income': '收入',
  'nav.review': '待分類',
  'nav.stats': '統計',
  'nav.account': '帳號',

  'action.importCsv': '匯入 CSV',
  'action.reading': '讀取中…',
  'action.close': '關閉',
  'action.cancel': '取消',
  'action.importSelected': '匯入已勾選',
  'action.importing': '匯入中…',
  'action.signIn': '登入',
  'action.addIncome': '新增收入',
  'action.edit': '編輯',
  'action.save': '儲存',
  'action.setBudget': '設定預算',
  'action.loadMore': '載入更多',
  'action.delete': '刪除',
  'action.createAccount': '建立帳號',
  'action.signOut': '登出',
  'action.createToken': '產生匯入金鑰',
  'action.replaceToken': '重新產生金鑰',
  'action.revoke': '撤銷',

  'login.password': '密碼',
  'login.failed': '登入失敗',
  'login.username': '帳號名稱',
  'login.registerFailed': '無法建立帳號',
  'login.toRegister': '還沒有帳號？建立一個',
  'login.toSignIn': '已經有帳號了？登入',
  'login.registerHint': '帳號名稱 3–32 個字元，限英文小寫、數字與 _ . -；密碼至少 8 個字元。',

  'search.placeholder': '搜尋商家與品名…',

  'income.hint':
    '這是唯一需要手動輸入金額的地方。其他數字都從發票讀取，收入沒有發票，所以直接輸入。',
  'income.amount': '金額 NT$',
  'income.source': '來源，例如 薪資',
  'income.note': '備註（選填）',
  'income.none': '這段期間沒有收入紀錄。',
  'income.summary': '共 {n} 筆，合計 {total}。',
  'income.added': '已新增收入。',
  'income.badAmount': '金額必須是整數新台幣。',
  'income.failed': '無法新增收入',

  'review.hint': '未分類與低信心的品項，金額由高到低 — 先修這些，圖表最快變準。',
  'review.empty': '沒有需要確認的品項，這代表系統正常運作。',
  'review.lowConfidence': '低信心 {score}',

  'panel.byCategory': '依類別',
  'panel.byMonth': '依月份',
  'panel.topMerchants': '主要商家',

  'bars.empty': '這段期間還沒有資料。',
  'bars.items': '{n} 筆',

  'totals.spent': '已花費',
  'totals.income': '收入',
  'totals.net': '淨額',
  'totals.invoices': '發票數',
  'totals.discounts': '折扣',
  'totals.uncategorized': '未分類',

  'budget.none': '{month}尚未設定預算',
  'budget.spentSoFar': '目前已花 {amount}',
  'budget.setOnce': '設定一次就好 — 之後每個月都沿用，直到你改為止。',
  'budget.title': '{month}預算',
  'budget.carried': '沿用自 {month}',
  'budget.monthOver': '本月已結束',
  'budget.daysLeft': '剩 {n} 天',
  'budget.of': '共 {amount}',
  'budget.placeholder': '每月預算 NT$',
  'budget.daysGone': '{total} 天中已過 {elapsed} 天',
  'budget.finishedOver': '最後超支 {amount}。',
  'budget.finishedUnder': '最後剩下 {amount}。',
  'budget.overBudget': '<strong>超出預算 {amount}</strong>，而且還有 {n} 天。',
  'budget.perDay': '每天還可以花 <strong>{amount}</strong>，目前平均每天 {pace}。',
  'budget.atThisRate': '照這個速度，月底會到 {projected} — 超支 {over}。',
  'budget.onTrack': '照這個速度，月底約 {projected}，在預算內。',
  'budget.badAmount': '預算必須是整數新台幣。',
  'budget.set': '{month}預算設為 {amount}。',
  'budget.failed': '無法設定預算',

  'invoice.none': '沒有符合的發票。',
  'invoice.detailHint':
    '取消勾選不是你的品項 — 例如在同一張發票上幫別人買的東西。它會留在發票上，但不計入你的總額。',
  'invoice.colMine': '我的',
  'invoice.colItem': '品項',
  'invoice.colCategory': '類別',
  'invoice.colAmount': '金額',
  'invoice.was': '原為 {amount}',
  'invoice.discountNote': '含 {amount} 的發票折扣，已分攤到上列各項。',
  'invoice.updateFailed': '無法更新此品項',

  'preview.title': '匯入前確認',
  'preview.summary': '檔案中有 {total} 張發票 — {fresh} 張是新的，{dup} 張已匯入。',
  'preview.skipped': ' 略過 {n} 列。',
  'preview.alreadyImported': '已匯入',
  'preview.maskedNumber': '號碼遮蔽',
  'preview.pickOne': '至少勾選一張發票。',
  'preview.imported': '已匯入 {n} 張發票 — 新增 {headers} 張、{items} 個品項',
  'preview.notCounted': '，{n} 項不計入',
  'preview.corrected': '，{n} 項已修正',
  'preview.failed': '匯入失敗',
  'preview.readFailed': '無法讀取檔案',

  'stats.cacheHitRate': '快取命中率',
  'stats.itemsPerCall': '每次模型呼叫品項數',
  'stats.uncatByValue': '未分類金額占比',
  'stats.modelSpend': '模型花費',
  'stats.howClassified': '品項如何被分類',
  'stats.recentRuns': '最近的匯入',
  'stats.merchantsWorthRule': '值得建規則的商家',
  'stats.colStatus': '狀態',
  'stats.colNew': '新增',
  'stats.colItems': '品項',
  'stats.syncedThrough': '資料涵蓋至 {date} · 模型 {model}',
  'stats.never': '尚未匯入',
  'stats.unknown': '（不明）',

  'account.since': '{date} 加入',
  'account.tokenTitle': '資料夾自動匯入',
  'account.tokenHint':
    'scripts/watch-folder.mjs 用這把金鑰把 CSV 上傳到你的帳號。金鑰只會顯示一次；重新產生後，舊的立即失效。',
  'account.tokenNone': '尚未產生金鑰。',
  'account.tokenSet': '金鑰建立於 {date}，最後使用：{used}。',
  'account.never': '從未使用',
  'account.tokenCopyNow': '請現在複製金鑰 — 之後不會再顯示。',
  'account.tokenRevoked': '金鑰已撤銷。',
  'account.tokenFailed': '無法變更金鑰',
  'account.webhookTitle': '通知',
  'account.webhookHint':
    '資料太久沒更新或發票中獎時，會以純文字 POST 到這個 https 網址（ntfy、Discord、Slack 都可以）。留空代表不通知。',
  'account.webhookSaved': '通知網址已儲存。',
  'account.webhookFailed': '無法儲存通知網址',

  'source.override': '你的修正',
  'source.merchant': '商家規則',
  'source.cache': '快取結果',
  'source.llm': '模型',
  'source.none': '尚未分類',

  'categorize.done': '已重新分類 {n} 個品項',

  'stale.never':
    '<strong>還沒有匯入任何發票。</strong>從載具匯出 CSV，再用上方的「匯入 CSV」上傳。',
  'stale.old': '<strong>資料已經 {n} 天沒更新。</strong>目前涵蓋到 {date} — 匯出新的 CSV 再匯入。',
};

const en: Record<string, Phrase> = {
  'lang.switch': '中文',

  'nav.spend': 'Spend',
  'nav.invoices': 'Invoices',
  'nav.income': 'Income',
  'nav.review': 'Review',
  'nav.stats': 'Stats',
  'nav.account': 'Account',

  'action.importCsv': 'Import CSV',
  'action.reading': 'Reading…',
  'action.close': 'Close',
  'action.cancel': 'Cancel',
  'action.importSelected': 'Import selected',
  'action.importing': 'Importing…',
  'action.signIn': 'Sign in',
  'action.addIncome': 'Add income',
  'action.edit': 'Edit',
  'action.save': 'Save',
  'action.setBudget': 'Set budget',
  'action.loadMore': 'Load more',
  'action.delete': 'Delete',
  'action.createAccount': 'Create account',
  'action.signOut': 'Sign out',
  'action.createToken': 'Create import token',
  'action.replaceToken': 'Replace token',
  'action.revoke': 'Revoke',

  'login.password': 'Password',
  'login.failed': 'sign in failed',
  'login.username': 'Username',
  'login.registerFailed': 'could not create the account',
  'login.toRegister': 'No account? Create one',
  'login.toSignIn': 'Already have an account? Sign in',
  'login.registerHint':
    'Usernames are 3–32 characters: lowercase letters, digits and _ . -. Passwords need at least 8 characters.',

  'search.placeholder': 'Search merchants and item descriptions…',

  'income.hint':
    'The one place here you type a number by hand. Everything else is read from your invoices; income has no invoice, so it is entered directly.',
  'income.amount': 'Amount NT$',
  'income.source': 'Source, e.g. 薪資',
  'income.note': 'Note (optional)',
  'income.none': 'No income recorded in this range.',
  'income.summary': (p) => `{total} across {n} ${s(Number(p.n), 'entry', 'entries')}.`,
  'income.added': 'Income added.',
  'income.badAmount': 'Amount must be a whole number of NT$.',
  'income.failed': 'could not add income',

  'review.hint':
    'Uncategorized and low-confidence items, most expensive first — fixing these is the fastest route to an accurate chart.',
  'review.empty': 'Nothing needs review. That is the system working.',
  'review.lowConfidence': 'low confidence {score}',

  'panel.byCategory': 'By category',
  'panel.byMonth': 'By month',
  'panel.topMerchants': 'Top merchants',

  'bars.empty': 'Nothing in this range yet.',
  'bars.items': (p) => `{n} ${s(Number(p.n), 'item')}`,

  'totals.spent': 'Spent',
  'totals.income': 'Income',
  'totals.net': 'Net',
  'totals.invoices': 'Invoices',
  'totals.discounts': 'Discounts',
  'totals.uncategorized': 'Uncategorized',

  'budget.none': 'No budget for {month}',
  'budget.spentSoFar': '{amount} spent so far',
  'budget.setOnce': 'Set it once — it carries forward to every later month until you change it.',
  'budget.title': '{month} budget',
  'budget.carried': 'carried forward from {month}',
  'budget.monthOver': 'month over',
  'budget.daysLeft': (p) => `{n} ${s(Number(p.n), 'day')} left`,
  'budget.of': 'of {amount}',
  'budget.placeholder': 'Monthly budget NT$',
  'budget.daysGone': '{elapsed} of {total} days gone',
  'budget.finishedOver': 'Finished {amount} over.',
  'budget.finishedUnder': 'Finished {amount} under.',
  'budget.overBudget': (p) =>
    `<strong>{amount} over budget</strong> with {n} ${s(Number(p.n), 'day')} still to go.`,
  'budget.perDay': '<strong>{amount} a day</strong> left to spend, against {pace} a day so far.',
  'budget.atThisRate': 'At this rate {projected} by month end — {over} over.',
  'budget.onTrack': 'On track for {projected}.',
  'budget.badAmount': 'Budget must be a whole number of NT$.',
  'budget.set': 'Budget for {month} set to {amount}.',
  'budget.failed': 'could not set the budget',

  'invoice.none': 'No invoices match.',
  'invoice.detailHint':
    'Untick an item that is not yours — bought for someone else on a shared receipt. It stays on the invoice but drops out of your totals.',
  'invoice.colMine': 'Mine',
  'invoice.colItem': 'Item',
  'invoice.colCategory': 'Category',
  'invoice.colAmount': 'Amount',
  'invoice.was': 'was {amount}',
  'invoice.discountNote': 'Includes {amount} of invoice discounts, spread across the lines above.',
  'invoice.updateFailed': 'could not update the item',

  'preview.title': 'Review before importing',
  'preview.summary': (p) =>
    `{total} ${s(Number(p.total), 'invoice')} in the file — {fresh} new, {dup} already imported.`,
  'preview.skipped': (p) => ` {n} ${s(Number(p.n), 'row')} skipped.`,
  'preview.alreadyImported': 'already imported',
  'preview.maskedNumber': 'masked number',
  'preview.pickOne': 'Tick at least one invoice to import.',
  'preview.imported': (p) =>
    `Imported {n} ${s(Number(p.n), 'invoice')} — {headers} new, {items} items`,
  'preview.notCounted': ', {n} not counted',
  'preview.corrected': ', {n} corrected',
  'preview.failed': 'import failed',
  'preview.readFailed': 'could not read the file',

  'stats.cacheHitRate': 'Cache hit rate',
  'stats.itemsPerCall': 'Items per model call',
  'stats.uncatByValue': 'Uncategorized by value',
  'stats.modelSpend': 'Model spend',
  'stats.howClassified': 'How items were classified',
  'stats.recentRuns': 'Recent runs',
  'stats.merchantsWorthRule': 'Merchants worth a rule',
  'stats.colStatus': 'Status',
  'stats.colNew': 'New',
  'stats.colItems': 'Items',
  'stats.syncedThrough': 'Synced through {date} · model {model}',
  'stats.never': 'never',
  'stats.unknown': '(unknown)',

  'account.since': 'Joined {date}',
  'account.tokenTitle': 'Watch-folder import',
  'account.tokenHint':
    'scripts/watch-folder.mjs uses this token to upload CSVs into your account. It is shown once, and replacing it stops the old one working immediately.',
  'account.tokenNone': 'No token yet.',
  'account.tokenSet': 'Token created {date}, last used {used}.',
  'account.never': 'never',
  'account.tokenCopyNow': 'Copy the token now — it will not be shown again.',
  'account.tokenRevoked': 'Token revoked.',
  'account.tokenFailed': 'could not change the token',
  'account.webhookTitle': 'Notifications',
  'account.webhookHint':
    'When your data goes stale or an invoice wins a prize, a plain-text message is POSTed to this https URL (ntfy, Discord, Slack). Leave it empty for none.',
  'account.webhookSaved': 'Notification URL saved.',
  'account.webhookFailed': 'could not save the notification URL',

  'source.override': 'Your correction',
  'source.merchant': 'Merchant rule',
  'source.cache': 'Cached answer',
  'source.llm': 'Model',
  'source.none': 'Not yet classified',

  'categorize.done': (p) => `Recategorized {n} ${s(Number(p.n), 'item')}`,

  'stale.never':
    '<strong>No invoices imported yet.</strong> Export your carrier CSV and use Import CSV above.',
  'stale.old':
    '<strong>Data is {n} days old.</strong> Covered through {date} — export a fresh CSV and import it.',
};

export const DICT: Record<Locale, Record<string, Phrase>> = { zh, en };

