-- Two additions.
--
--   npx wrangler d1 execute invoice-gang --remote --file=./src/db/migrations/003-exclude-and-income.sql
--
-- 1. invoice_item.excluded — an item that is on your carrier but is not your
--    spending: something bought for someone else on a shared receipt. It stays
--    in the invoice (the invoice total must still reconcile against the paper)
--    but is left out of every spend aggregation. Default 0, so nothing already
--    imported changes.
ALTER TABLE invoice_item ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;

-- 2. income — manually entered, the one place in this system where a number is
--    typed rather than derived from an invoice. Kept in its own table and
--    never mixed into invoice_item, so the invoice pipeline stays exactly what
--    it was and income is a clean addition beside it rather than inside it.
CREATE TABLE IF NOT EXISTS income (
    id          INTEGER PRIMARY KEY,
    date        TEXT NOT NULL,        -- YYYY-MM-DD
    amount      INTEGER NOT NULL,     -- NT$, positive; money is INTEGER as everywhere
    source      TEXT NOT NULL,        -- e.g. 薪資, 接案, 利息
    note        TEXT,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_income_date ON income(date DESC);

-- The monthly view predates the excluded column, and CREATE VIEW IF NOT EXISTS
-- will not replace one that already exists — so drop and recreate it to fold
-- the exclusion in. Kept byte-identical to src/db/schema.sql.
DROP VIEW IF EXISTS v_monthly_category;
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
