-- The schema as a deployed database had it just before migration 005, for
-- test/migration.test.ts. Not applied anywhere else.
--
-- It is src/db/schema.sql at that point with one deliberate difference:
-- invoice_item.net_amount and .excluded sit at the end of the table, because
-- migrations 001 and 003 added them with ALTER TABLE, and that is where a real
-- deployed database has them. A migration that copied columns by position
-- would pass against schema.sql's order and scramble a real database.

PRAGMA foreign_keys = ON;

CREATE TABLE carrier (
    id            INTEGER PRIMARY KEY,
    card_type     TEXT NOT NULL DEFAULT '3J0002',
    card_no       TEXT NOT NULL UNIQUE,
    label         TEXT,
    created_at    INTEGER NOT NULL
);

CREATE TABLE invoice (
    inv_num           TEXT PRIMARY KEY,
    carrier_id        INTEGER NOT NULL REFERENCES carrier(id),
    inv_date          TEXT NOT NULL,
    inv_period        TEXT,
    seller_ban        TEXT,
    seller_name       TEXT,
    amount            INTEGER NOT NULL,
    inv_status        TEXT,
    donatable         INTEGER NOT NULL DEFAULT 0,
    detail_fetched_at INTEGER,
    detail_attempts   INTEGER NOT NULL DEFAULT 0,
    detail_error      TEXT,
    first_seen_at     INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_invoice_date    ON invoice(inv_date DESC);
CREATE INDEX idx_invoice_seller  ON invoice(seller_ban);
CREATE INDEX idx_invoice_period  ON invoice(inv_period);
CREATE INDEX idx_invoice_pending ON invoice(inv_date DESC)
    WHERE detail_fetched_at IS NULL;

CREATE TABLE invoice_item (
    id              INTEGER PRIMARY KEY,
    inv_num         TEXT NOT NULL REFERENCES invoice(inv_num) ON DELETE CASCADE,
    row_num         INTEGER NOT NULL,
    description     TEXT NOT NULL,
    item_key        TEXT NOT NULL,
    quantity        REAL,
    unit_price      INTEGER,
    amount          INTEGER NOT NULL,
    category_id     INTEGER REFERENCES category(id),
    category_source TEXT,
    categorized_at  INTEGER,
    net_amount      INTEGER,
    excluded        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (inv_num, row_num)
);

CREATE INDEX idx_item_key      ON invoice_item(item_key);
CREATE INDEX idx_item_category ON invoice_item(category_id);
CREATE INDEX idx_item_uncat    ON invoice_item(id) WHERE category_id IS NULL;

CREATE TABLE category (
    id        INTEGER PRIMARY KEY,
    key       TEXT NOT NULL UNIQUE,
    label_zh  TEXT NOT NULL,
    label_en  TEXT NOT NULL,
    color     TEXT,
    sort      INTEGER NOT NULL DEFAULT 0
);

INSERT INTO category (key, label_zh, label_en, color, sort) VALUES
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

CREATE TABLE merchant_rule (
    id          INTEGER PRIMARY KEY,
    match_type  TEXT NOT NULL CHECK (match_type IN ('ban','name_prefix','name_contains')),
    pattern     TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES category(id),
    priority    INTEGER NOT NULL DEFAULT 100,
    note        TEXT,
    UNIQUE (match_type, pattern)
);

CREATE INDEX idx_rule_lookup ON merchant_rule(match_type, priority);

CREATE TABLE item_rule (
    id          INTEGER PRIMARY KEY,
    pattern     TEXT NOT NULL UNIQUE,
    category_id INTEGER NOT NULL REFERENCES category(id),
    priority    INTEGER NOT NULL DEFAULT 100,
    note        TEXT
);

CREATE INDEX idx_item_rule_lookup ON item_rule(priority);

CREATE TABLE user_override (
    id          INTEGER PRIMARY KEY,
    scope       TEXT NOT NULL CHECK (scope IN ('item','merchant')),
    key         TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES category(id),
    created_at  INTEGER NOT NULL,
    UNIQUE (scope, key)
);

CREATE TABLE item_category_cache (
    item_key    TEXT PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES category(id),
    confidence  REAL,
    model       TEXT,
    sample_desc TEXT,
    created_at  INTEGER NOT NULL,
    hits        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_state (
    carrier_id       INTEGER PRIMARY KEY REFERENCES carrier(id),
    synced_through   TEXT,
    last_run_at      INTEGER,
    last_success_at  INTEGER
);

CREATE TABLE sync_run (
    id                INTEGER PRIMARY KEY,
    started_at        INTEGER NOT NULL,
    finished_at       INTEGER,
    trigger           TEXT NOT NULL,
    status            TEXT,
    window_start      TEXT,
    window_end        TEXT,
    headers_seen      INTEGER NOT NULL DEFAULT 0,
    headers_new       INTEGER NOT NULL DEFAULT 0,
    details_fetched   INTEGER NOT NULL DEFAULT 0,
    items_new         INTEGER NOT NULL DEFAULT 0,
    llm_calls         INTEGER NOT NULL DEFAULT 0,
    llm_items         INTEGER NOT NULL DEFAULT 0,
    cache_hits        INTEGER NOT NULL DEFAULT 0,
    error             TEXT
);

CREATE INDEX idx_sync_run_time ON sync_run(started_at DESC);

CREATE TABLE winning_number (
    inv_period  TEXT NOT NULL,
    prize_class TEXT NOT NULL,
    number      TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (inv_period, prize_class, number)
);

CREATE TABLE prize_hit (
    inv_num      TEXT PRIMARY KEY REFERENCES invoice(inv_num) ON DELETE CASCADE,
    inv_period   TEXT NOT NULL,
    prize_class  TEXT NOT NULL,
    amount       INTEGER NOT NULL,
    matched_at   INTEGER NOT NULL,
    notified_at  INTEGER
);

CREATE TABLE income (
    id          INTEGER PRIMARY KEY,
    date        TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    source      TEXT NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL
);

CREATE INDEX idx_income_date ON income(date DESC);

CREATE TABLE budget (
    month       TEXT PRIMARY KEY,
    amount      INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE VIEW v_monthly_category AS
SELECT substr(i.inv_date, 1, 7) AS month,
       c.key                    AS category_key,
       c.label_en               AS category_en,
       c.label_zh               AS category_zh,
       COUNT(*)                 AS item_count,
       SUM(COALESCE(it.net_amount, it.amount)) AS total
FROM invoice_item it
JOIN invoice i ON i.inv_num = it.inv_num
LEFT JOIN category c ON c.id = it.category_id
WHERE (i.inv_status IS NULL OR i.inv_status <> '作廢')
  AND it.amount >= 0
  AND it.excluded = 0
GROUP BY month, c.key;
