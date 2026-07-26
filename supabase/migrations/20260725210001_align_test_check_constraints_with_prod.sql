-- Align TEST CHECK constraints with PROD (drift report). Idempotent via IF NOT EXISTS.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_bills_payment_mode_check'
  ) THEN
    ALTER TABLE public.order_bills
      ADD CONSTRAINT order_bills_payment_mode_check
      CHECK (payment_mode = ANY (ARRAY['cash'::text, 'upi'::text, 'khata'::text]));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'categories_service_mode_check'
  ) THEN
    ALTER TABLE public.categories
      ADD CONSTRAINT categories_service_mode_check
      CHECK (service_mode = ANY (ARRAY['help'::text, 'delivery'::text, 'appointment'::text]));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_credits_disbursement_month_check'
  ) THEN
    ALTER TABLE public.vendor_credits
      ADD CONSTRAINT vendor_credits_disbursement_month_check
      CHECK (disbursement_month = ANY (ARRAY[1, 2, 3]));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_reviews_rating_check'
  ) THEN
    ALTER TABLE public.vendor_reviews
      ADD CONSTRAINT vendor_reviews_rating_check
      CHECK ((rating >= 1) AND (rating <= 5));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referrals_status_check'
  ) THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_status_check
      CHECK (status = ANY (ARRAY['pending'::text, 'active'::text]));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referrals_trigger_rule_check'
  ) THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_trigger_rule_check
      CHECK (trigger_rule = ANY (ARRAY['active_once'::text, 'first_payment'::text]));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referrals_referee_type_check'
  ) THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_referee_type_check
      CHECK (referee_type = ANY (ARRAY['vendor'::text, 'user'::text]));
  END IF;
END $$;
