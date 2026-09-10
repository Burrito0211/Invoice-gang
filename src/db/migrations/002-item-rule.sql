-- Item-text rules.
--
-- merchant_rule matches the seller; this matches the product description, and
-- it outranks the merchant rule for the same reason an item override outranks
-- a merchant override: a phone charger bought at 7-ELEVEN is electronics, not
-- groceries. Convenience stores and drugstores span several categories, so
-- merchant rules alone cannot classify them — item rules are what make the
-- rule table cover a real Taiwanese basket without a model.
--
-- `pattern` is a substring matched against invoice_item.item_key, which is
-- NFKC-normalized and lowercased (see src/categorize/normalize.ts), so
-- patterns must be stored in that same form.
--
--   npx wrangler d1 execute invoice-gang --remote --file=./src/db/migrations/002-item-rule.sql
CREATE TABLE IF NOT EXISTS item_rule (
    id          INTEGER PRIMARY KEY,
    pattern     TEXT NOT NULL UNIQUE,
    category_id INTEGER NOT NULL REFERENCES category(id),
    priority    INTEGER NOT NULL DEFAULT 100,  -- lower wins
    note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_item_rule_lookup ON item_rule(priority);
