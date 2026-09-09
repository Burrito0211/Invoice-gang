-- Invoice Gang — D1 (SQLite) schema
-- Runnable as-is:  wrangler d1 execute invoice-gang --file=./src/db/schema.sql
--
-- Mirrors docs/SCHEMA.sql. The only difference: IF NOT EXISTS / INSERT OR
-- IGNORE, so `npm run db:apply` is safe to re-run against an existing database.
--
-- Conventions:
--   * money is INTEGER new taiwan dollars, never REAL
--   * timestamps are INTEGER unix seconds, UTC
--   * dates from the MOF API are stored as TEXT YYYY-MM-DD (normalized from
--     the API YYYY/MM/DD form) so lexical order equals chronological order

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- carriers --
-- One row in v1. Modeled as a table anyway so the sync code is written against
-- "a carrier" rather than an implicit global, which is what makes the
-- single-user decision reversible later without a rewrite.
CREATE TABLE IF NOT EXISTS carrier (
    id            INTEGER PRIMARY KEY,
    card_type     TEXT NOT NULL DEFAULT '3J0002',
    card_no       TEXT NOT NULL UNIQUE,   -- 手機條碼; the secret lives in env
    label         TEXT,
    created_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------- invoices --
CREATE TABLE IF NOT EXISTS invoice (
    inv_num           TEXT PRIMARY KEY,   -- AB12345678, globally unique
    carrier_id        INTEGER NOT NULL REFERENCES carrier(id),
    inv_date          TEXT NOT NULL,      -- YYYY-MM-DD
    inv_period        TEXT,               -- ROC period, e.g. 11304
    seller_ban        TEXT,               -- 統一編號
    seller_name       TEXT,
    amount            INTEGER NOT NULL,
    inv_status        TEXT,               -- as returned by the API
    donatable         INTEGER NOT NULL DEFAULT 0,

    -- detail-queue state. NULL detail_fetched_at means still queued.
    detail_fetched_at INTEGER,
    detail_attempts   INTEGER NOT NULL DEFAULT 0,
    detail_error      TEXT,

    first_seen_at     INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoice_date    ON invoice(inv_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_seller  ON invoice(seller_ban);
CREATE INDEX IF NOT EXISTS idx_invoice_period  ON invoice(inv_period);
-- the detail queue: newest first. Partial index stays small once most
-- invoices have been fetched.
CREATE INDEX IF NOT EXISTS idx_invoice_pending ON invoice(inv_date DESC)
    WHERE detail_fetched_at IS NULL;

-- ------------------------------------------------------------------- items --
CREATE TABLE IF NOT EXISTS invoice_item (
    id              INTEGER PRIMARY KEY,
    inv_num         TEXT NOT NULL REFERENCES invoice(inv_num) ON DELETE CASCADE,
    row_num         INTEGER NOT NULL,
    description     TEXT NOT NULL,        -- raw merchant text, never edited
    item_key        TEXT NOT NULL,        -- normalized; see CATEGORIZATION.md
    quantity        REAL,
    unit_price      INTEGER,
    amount          INTEGER NOT NULL,

    category_id     INTEGER REFERENCES category(id),
    category_source TEXT,                 -- override|merchant|cache|llm|none
    categorized_at  INTEGER,

    UNIQUE (inv_num, row_num)             -- makes detail re-fetch idempotent
);

CREATE INDEX IF NOT EXISTS idx_item_key      ON invoice_item(item_key);
CREATE INDEX IF NOT EXISTS idx_item_category ON invoice_item(category_id);
CREATE INDEX IF NOT EXISTS idx_item_uncat    ON invoice_item(id) WHERE category_id IS NULL;

-- -------------------------------------------------------------- categories --
CREATE TABLE IF NOT EXISTS category (
    id        INTEGER PRIMARY KEY,
    key       TEXT NOT NULL UNIQUE,       -- stable id used in prompts and code
    label_zh  TEXT NOT NULL,
    label_en  TEXT NOT NULL,
    color     TEXT,
    sort      INTEGER NOT NULL DEFAULT 0
);

-- The taxonomy is fixed and small on purpose: it is pasted verbatim into the
-- LLM prompt, and a large taxonomy makes classification less consistent, not
-- more useful. Add a category only when a real month of data demands it.
INSERT OR IGNORE INTO category (key, label_zh, label_en, color, sort) VALUES
    ('groceries',     '食品雜貨',  'Groceries',        '#6aa84f',  1),
    ('dining',        '餐飲外食',  'Dining out',       '#e06666',  2),
    ('drinks',        '飲料',      'Drinks',           '#f6b26b',  3),
    ('transport',     '交通',      'Transport',        '#3d85c6',  4),
    ('household',     '居家日用',  'Household',        '#8e7cc3',  5),
    ('personal',      '個人護理',  'Personal care',    '#c27ba0',  6),
    ('health',        '醫療保健',  'Health',           '#45818e',  7),
    ('clothing',      '服飾',      'Clothing',         '#a64d79',  8),
    ('electronics',   '3C電子',    'Electronics',      '#674ea7',  9),
    ('entertainment', '娛樂',      'Entertainment',    '#e69138', 10),
    ('education',     '書籍學習',  'Books & learning', '#16537e', 11),
    ('services',      '服務費用',  'Services',         '#999999', 12),
    ('uncategorized', '未分類',    'Uncategorized',    '#cccccc', 99);

-- ---------------------------------------------------------- merchant rules --
-- Deterministic, hand-maintainable, checked before any cache or model.
-- match_type: ban (exact 統一編號) | name_prefix | name_contains
CREATE TABLE IF NOT EXISTS merchant_rule (
    id          INTEGER PRIMARY KEY,
    match_type  TEXT NOT NULL CHECK (match_type IN ('ban','name_prefix','name_contains')),
    pattern     TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES category(id),
    priority    INTEGER NOT NULL DEFAULT 100,  -- lower wins
    note        TEXT,
    UNIQUE (match_type, pattern)
);

CREATE INDEX IF NOT EXISTS idx_rule_lookup ON merchant_rule(match_type, priority);

-- --------------------------------------------------------------- overrides --
-- The correction loop. Outranks everything else. Scope item keys on item_key,
-- scope merchant keys on seller_ban.
CREATE TABLE IF NOT EXISTS user_override (
    id          INTEGER PRIMARY KEY,
    scope       TEXT NOT NULL CHECK (scope IN ('item','merchant')),
    key         TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES category(id),
    created_at  INTEGER NOT NULL,
    UNIQUE (scope, key)
);

-- -------------------------------------------------------- classifier cache --
-- Mirrors the KV cache. KV is the hot read path; this table exists so the
-- cache is inspectable, exportable and rebuildable — and so hit-rate stats
-- can be computed with SQL instead of a KV scan.
CREATE TABLE IF NOT EXISTS item_category_cache (
    item_key    TEXT PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES category(id),
    confidence  REAL,
    model       TEXT,
    sample_desc TEXT,                     -- one raw description that produced it
    created_at  INTEGER NOT NULL,
    hits        INTEGER NOT NULL DEFAULT 0
);

-- -------------------------------------------------------------- sync state --
CREATE TABLE IF NOT EXISTS sync_state (
    carrier_id       INTEGER PRIMARY KEY REFERENCES carrier(id),
    synced_through   TEXT,                -- YYYY-MM-DD watermark; see SYNC.md
    last_run_at      INTEGER,
    last_success_at  INTEGER
);

CREATE TABLE IF NOT EXISTS sync_run (
    id                INTEGER PRIMARY KEY,
    started_at        INTEGER NOT NULL,
    finished_at       INTEGER,
    trigger           TEXT NOT NULL,      -- cron|manual|backfill
    status            TEXT,               -- ok|partial|quota|error
    window_start      TEXT,
    window_end        TEXT,
    headers_seen      INTEGER NOT NULL DEFAULT 0,
    headers_new       INTEGER NOT NULL DEFAULT 0,
    details_fetched   INTEGER NOT NULL DEFAULT 0,
    items_new         INTEGER NOT NULL DEFAULT 0,
    llm_calls         INTEGER NOT NULL DEFAULT 0,
    llm_items         INTEGER NOT NULL DEFAULT 0,
    cache_hits        INTEGER NOT NULL DEFAULT 0,
    error             TEXT                -- credential values must be scrubbed
);

CREATE INDEX IF NOT EXISTS idx_sync_run_time ON sync_run(started_at DESC);

-- ----------------------------------------------------------------- prizes --
CREATE TABLE IF NOT EXISTS winning_number (
    inv_period  TEXT NOT NULL,            -- 11304
    prize_class TEXT NOT NULL,            -- special|grand|first|additional
    number      TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (inv_period, prize_class, number)
);

CREATE TABLE IF NOT EXISTS prize_hit (
    inv_num      TEXT PRIMARY KEY REFERENCES invoice(inv_num) ON DELETE CASCADE,
    inv_period   TEXT NOT NULL,
    prize_class  TEXT NOT NULL,
    amount       INTEGER NOT NULL,
    matched_at   INTEGER NOT NULL,
    notified_at  INTEGER
);

-- -------------------------------------------------------------- dashboard --
-- Monthly spend by category. Defined here so the API layer has no aggregation
-- SQL of its own to drift out of sync.
CREATE VIEW IF NOT EXISTS v_monthly_category AS
SELECT substr(i.inv_date, 1, 7) AS month,
       c.key                    AS category_key,
       c.label_en               AS category_en,
       c.label_zh               AS category_zh,
       COUNT(*)                 AS item_count,
       SUM(it.amount)           AS total
FROM invoice_item it
JOIN invoice i ON i.inv_num = it.inv_num
LEFT JOIN category c ON c.id = it.category_id
WHERE i.inv_status IS NULL OR i.inv_status <> '作廢'
GROUP BY month, c.key;
