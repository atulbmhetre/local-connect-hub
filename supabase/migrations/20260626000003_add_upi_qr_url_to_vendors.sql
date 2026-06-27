ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS upi_qr_url text;
