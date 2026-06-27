-- Payment tracking on customer requests (UTR claim / vendor confirm flow).

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'claimed', 'confirmed', 'disputed'));

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS payment_utr text;

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS payment_amount integer;

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS payment_claimed_at timestamptz;

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS payment_confirmed_at timestamptz;
