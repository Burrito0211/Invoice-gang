-- Adds invoice_item.net_amount: the line amount after invoice-level discounts
-- have been spread proportionally across the positive lines. See
-- src/import/allocate.ts for why discounts cannot be attributed to one item.
--
-- `amount` stays the untouched raw value from the export. `net_amount` is
-- derived, and a re-import recomputes it.
--
-- Apply once per database:
--   npx wrangler d1 execute invoice-gang --remote --file=./src/db/migrations/001-net-amount.sql
ALTER TABLE invoice_item ADD COLUMN net_amount INTEGER;

-- Backfill: invoices with no discount need no allocation, so their net is the
-- amount. Invoices that do have one are left NULL for the importer to fill on
-- the next import, because the split is integer arithmetic SQL should not do.
UPDATE invoice_item
SET net_amount = amount
WHERE inv_num NOT IN (SELECT inv_num FROM invoice_item WHERE amount < 0);
