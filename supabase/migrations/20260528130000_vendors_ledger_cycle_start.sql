ALTER TABLE vendors ADD COLUMN IF NOT EXISTS ledger_cycle_start date DEFAULT CURRENT_DATE;

UPDATE vendors SET ledger_cycle_start = created_at::date WHERE ledger_cycle_start IS NULL;
