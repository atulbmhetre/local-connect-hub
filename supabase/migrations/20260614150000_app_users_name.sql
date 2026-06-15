-- Optional customer display name (vendor-entered in LedgerView).
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS name text;
