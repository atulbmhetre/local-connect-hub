-- Vendor ban fields
ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS is_banned boolean NOT NULL DEFAULT false;

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS ban_reason text;

-- Persisted user warnings
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS warn_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_warned_at timestamptz;
