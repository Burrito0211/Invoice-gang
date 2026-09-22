-- Accounts: one install, many people, each with their own invoices.
--
-- Apply 001–004 first. Then take a backup, apply this, and deploy the code
-- from the same commit straight afterwards — the old code cannot read these
-- tables and the new code cannot read the old ones:
--
--   npx wrangler d1 export invoice-gang --remote --output=backup-before-005.sql
--   npx wrangler d1 execute invoice-gang --remote --file=./src/db/migrations/005-accounts.sql
--   npm run deploy
--
-- What it does. Every table holding personal data gains `account_id`, and
-- everything already in the database becomes account 1, named `owner`, with
-- no password hash of its own. Sign in as `owner` with today's password: the
-- first successful sign-in is checked against OWNER_PASSWORD_HASH and copies
-- that hash into the row, after which the secret is never read again and can
-- be deleted. Change 'owner' below before applying to pick another username
-- (3–32 characters: lowercase letters, digits, _ . -).
--
-- Why a rebuild rather than ALTER TABLE ADD COLUMN. The keys change —
-- invoice goes from PRIMARY KEY (inv_num) to (account_id, inv_num), and the
-- item, prize, override and budget keys follow — and SQLite cannot change a
-- key in place. So each table is moved aside, recreated under its own name,
-- filled from the old copy, and the old copy dropped.
--
-- The order is load-bearing:
--
--   * The view goes first. Renaming a table that a view reads is an error.
--
--   * Every table is renamed before any new one is created. A rename
--     rewrites the foreign keys that point at it, so the old children follow
--     their old parents to the *_old names, and nothing still refers to
--     `invoice` when the new `invoice` takes that name. The textbook rebuild
--     — create invoice_new, copy, DROP invoice, rename — would be a disaster
--     here: dropping a table is an implicit DELETE, invoice_item cascades on
--     delete, and the items would be gone.
--
--   * Old copies are dropped children first, so no drop has anything left to
--     cascade into.
--
--   * Indexes are created last. The old copies keep the old index names until
--     they are dropped.
--
-- Every copy names its columns. 001 and 003 added columns with ALTER TABLE,
-- which appends them, so a deployed invoice_item does not have its columns in
-- schema.sql's order and a positional copy would scramble them.

PRAGMA defer_foreign_keys = true;

DROP VIEW IF EXISTS v_monthly_category;

ALTER TABLE carrier       RENAME TO carrier_old;
ALTER TABLE invoice       RENAME TO invoice_old;
ALTER TABLE invoice_item  RENAME TO invoice_item_old;
ALTER TABLE prize_hit     RENAME TO prize_hit_old;
ALTER TABLE sync_state    RENAME TO sync_state_old;
ALTER TABLE sync_run      RENAME TO sync_run_old;
ALTER TABLE user_override RENAME TO user_override_old;
ALTER TABLE income        RENAME TO income_old;
ALTER TABLE budget        RENAME TO budget_old;

-- ------------------------------------------------------------ new tables --
-- Identical to src/db/schema.sql; test/migration.test.ts compares the two.

CREATE TABLE account (
    id              INTEGER PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT,
    notify_webhook  TEXT,
    created_at      INTEGER NOT NULL
);

CREATE TABLE import_token (
    account_id    INTEGER PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
);

CREATE TABLE carrier (
    id            INTEGER PRIMARY KEY,
    account_id    INTEGER NOT NULL REFERENCES account(id),
    card_type     TEXT NOT NULL DEFAULT '3J0002',
    card_no       TEXT NOT NULL,
    label         TEXT,
    created_at    INTEGER NOT NULL,
    UNIQUE (account_id, card_no)
);

CREATE TABLE invoice (
    account_id        INTEGER NOT NULL REFERENCES account(id),
    inv_num           TEXT NOT NULL,
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
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (account_id, inv_num)
);

CREATE TABLE invoice_item (
    id              INTEGER PRIMARY KEY,
    account_id      INTEGER NOT NULL,
    inv_num         TEXT NOT NULL,
    row_num         INTEGER NOT NULL,
    description     TEXT NOT NULL,
    item_key        TEXT NOT NULL,
    quantity        REAL,
    unit_price      INTEGER,
    amount          INTEGER NOT NULL,
    net_amount      INTEGER,
    excluded        INTEGER NOT NULL DEFAULT 0,
    category_id     INTEGER REFERENCES category(id),
    category_source TEXT,
    categorized_at  INTEGER,
    FOREIGN KEY (account_id, inv_num)
        REFERENCES invoice(account_id, inv_num) ON DELETE CASCADE,
    UNIQUE (account_id, inv_num, row_num)
);

CREATE TABLE user_override (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES account(id),
    scope       TEXT NOT NULL CHECK (scope IN ('item','merchant')),
    key         TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES category(id),
    created_at  INTEGER NOT NULL,
    UNIQUE (account_id, scope, key)
);

CREATE TABLE sync_state (
    carrier_id       INTEGER PRIMARY KEY REFERENCES carrier(id),
    synced_through   TEXT,
    last_run_at      INTEGER,
    last_success_at  INTEGER
);

CREATE TABLE sync_run (
    id                INTEGER PRIMARY KEY,
    account_id        INTEGER NOT NULL REFERENCES account(id),
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

CREATE TABLE prize_hit (
    account_id   INTEGER NOT NULL,
    inv_num      TEXT NOT NULL,
    inv_period   TEXT NOT NULL,
    prize_class  TEXT NOT NULL,
    amount       INTEGER NOT NULL,
    matched_at   INTEGER NOT NULL,
    notified_at  INTEGER,
    PRIMARY KEY (account_id, inv_num),
    FOREIGN KEY (account_id, inv_num)
        REFERENCES invoice(account_id, inv_num) ON DELETE CASCADE
);

CREATE TABLE income (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES account(id),
    date        TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    source      TEXT NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL
);

CREATE TABLE budget (
    account_id  INTEGER NOT NULL REFERENCES account(id),
    month       TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (account_id, month)
);

-- ----------------------------------------------------------------- copy --

INSERT INTO account (id, username, password_hash, notify_webhook, created_at)
SELECT 1, 'owner', NULL, NULL,
       COALESCE((SELECT MIN(created_at) FROM carrier_old),
                CAST(strftime('%s', 'now') AS INTEGER));

INSERT INTO carrier (id, account_id, card_type, card_no, label, created_at)
SELECT id, 1, card_type, card_no, label, created_at FROM carrier_old;

INSERT INTO invoice (account_id, inv_num, carrier_id, inv_date, inv_period, seller_ban,
                     seller_name, amount, inv_status, donatable, detail_fetched_at,
                     detail_attempts, detail_error, first_seen_at, updated_at)
SELECT 1, inv_num, carrier_id, inv_date, inv_period, seller_ban,
       seller_name, amount, inv_status, donatable, detail_fetched_at,
       detail_attempts, detail_error, first_seen_at, updated_at
FROM invoice_old;

INSERT INTO invoice_item (id, account_id, inv_num, row_num, description, item_key, quantity,
                          unit_price, amount, net_amount, excluded, category_id,
                          category_source, categorized_at)
SELECT id, 1, inv_num, row_num, description, item_key, quantity,
       unit_price, amount, net_amount, excluded, category_id,
       category_source, categorized_at
FROM invoice_item_old;

INSERT INTO user_override (id, account_id, scope, key, category_id, created_at)
SELECT id, 1, scope, key, category_id, created_at FROM user_override_old;

INSERT INTO sync_state (carrier_id, synced_through, last_run_at, last_success_at)
SELECT carrier_id, synced_through, last_run_at, last_success_at FROM sync_state_old;

INSERT INTO sync_run (id, account_id, started_at, finished_at, trigger, status, window_start,
                      window_end, headers_seen, headers_new, details_fetched, items_new,
                      llm_calls, llm_items, cache_hits, error)
SELECT id, 1, started_at, finished_at, trigger, status, window_start,
       window_end, headers_seen, headers_new, details_fetched, items_new,
       llm_calls, llm_items, cache_hits, error
FROM sync_run_old;

INSERT INTO prize_hit (account_id, inv_num, inv_period, prize_class, amount, matched_at, notified_at)
SELECT 1, inv_num, inv_period, prize_class, amount, matched_at, notified_at FROM prize_hit_old;

INSERT INTO income (id, account_id, date, amount, source, note, created_at)
SELECT id, 1, date, amount, source, note, created_at FROM income_old;

INSERT INTO budget (account_id, month, amount, created_at, updated_at)
SELECT 1, month, amount, created_at, updated_at FROM budget_old;

-- ------------------------------------------------- drop, children first --

DROP TABLE prize_hit_old;
DROP TABLE invoice_item_old;
DROP TABLE invoice_old;
DROP TABLE sync_state_old;
DROP TABLE carrier_old;
DROP TABLE sync_run_old;
DROP TABLE user_override_old;
DROP TABLE income_old;
DROP TABLE budget_old;

-- -------------------------------------------------------------- indexes --

CREATE INDEX idx_invoice_date    ON invoice(account_id, inv_date DESC);
CREATE INDEX idx_invoice_seller  ON invoice(account_id, seller_ban);
CREATE INDEX idx_invoice_period  ON invoice(inv_period);
CREATE INDEX idx_invoice_pending ON invoice(inv_date DESC)
    WHERE detail_fetched_at IS NULL;

CREATE INDEX idx_item_key      ON invoice_item(account_id, item_key);
CREATE INDEX idx_item_category ON invoice_item(category_id);
CREATE INDEX idx_item_uncat    ON invoice_item(account_id) WHERE category_id IS NULL;

CREATE INDEX idx_sync_run_time ON sync_run(account_id, started_at DESC);
CREATE INDEX idx_income_date   ON income(account_id, date DESC);

-- ----------------------------------------------------------------- view --

CREATE VIEW v_monthly_category AS
SELECT i.account_id             AS account_id,
       substr(i.inv_date, 1, 7) AS month,
       c.key                    AS category_key,
       c.label_en               AS category_en,
       c.label_zh               AS category_zh,
       COUNT(*)                 AS item_count,
       SUM(COALESCE(it.net_amount, it.amount)) AS total
FROM invoice_item it
JOIN invoice i ON i.account_id = it.account_id AND i.inv_num = it.inv_num
LEFT JOIN category c ON c.id = it.category_id
WHERE (i.inv_status IS NULL OR i.inv_status <> '作廢')
  AND it.amount >= 0
  AND it.excluded = 0
GROUP BY i.account_id, month, c.key;
