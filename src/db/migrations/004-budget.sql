-- A monthly spending budget.
--
--   npx wrangler d1 execute invoice-gang --remote --file=./src/db/migrations/004-budget.sql
--
-- One row per month, but a month without a row is not unbudgeted: the
-- effective budget for a month is the newest row at or before it. Setting
-- NT$20,000 for 2026-09 budgets every later month at NT$20,000 until another
-- row supersedes it.
--
-- That carry-forward is the whole reason this is keyed by month rather than
-- being a single settings row. A single row cannot answer "what was August's
-- budget" once you have changed it, so every past month would silently be
-- judged against today's number. Storing the change points keeps history
-- honest and still means you set the figure once.
CREATE TABLE IF NOT EXISTS budget (
    month       TEXT PRIMARY KEY,     -- YYYY-MM, the month it takes effect
    amount      INTEGER NOT NULL,     -- NT$, positive; money is INTEGER as everywhere
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
