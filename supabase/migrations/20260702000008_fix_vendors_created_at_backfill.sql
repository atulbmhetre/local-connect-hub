-- Fix vendors.created_at backfill: ADD COLUMN DEFAULT now() stamped all rows as today.

UPDATE public.vendors
SET created_at = COALESCE(last_updated, '2024-06-01'::timestamptz);

ALTER TABLE public.vendors
  ALTER COLUMN created_at SET DEFAULT now();
