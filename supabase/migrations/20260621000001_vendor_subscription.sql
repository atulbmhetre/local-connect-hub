-- Vendor subscription columns
ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'trial'
    CHECK (subscription_status IN ('trial','active','grace','expired','cancelled')),
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS grace_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS waiveoff_percent integer,
  ADD COLUMN IF NOT EXISTS waiveoff_months_remaining integer;

-- subscription_id: rename existing razorpay_customer_id if it serves same purpose,
-- or add new column if not
ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS subscription_id text;

-- Backfill trial_ends_at for all existing vendors using last_updated as proxy
UPDATE public.vendors
SET trial_ends_at = last_updated + interval '30 days'
WHERE trial_ends_at IS NULL;
