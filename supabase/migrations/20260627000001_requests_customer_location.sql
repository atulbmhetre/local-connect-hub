-- Customer GPS at order placement (optional; delivery_address text remains fallback).

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS customer_latitude double precision;

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS customer_longitude double precision;
