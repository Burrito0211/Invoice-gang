-- Optional seed rules for local development.
--
-- Do NOT treat this as the starting rule table for the real database.
-- docs/CATEGORIZATION.md is explicit about the order: sync a month of real
-- data first, then run the top-merchants query and write rules for what is
-- actually at the top of *your* list. Rules written before the data exists
-- are guesses about someone else's spending.
--
-- Apply with:  npm run db:seed:local

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note)
SELECT 'name_contains', '超商', id, 100, 'convenience stores: mostly groceries'
FROM category WHERE key = 'groceries';

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note)
SELECT 'name_contains', '全聯', id, 90, 'PX Mart'
FROM category WHERE key = 'groceries';

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note)
SELECT 'name_contains', '藥局', id, 90, 'pharmacies'
FROM category WHERE key = 'health';

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note)
SELECT 'name_contains', '加油', id, 90, 'petrol stations'
FROM category WHERE key = 'transport';

INSERT OR IGNORE INTO merchant_rule (match_type, pattern, category_id, priority, note)
SELECT 'name_contains', '書店', id, 90, 'bookshops'
FROM category WHERE key = 'education';
