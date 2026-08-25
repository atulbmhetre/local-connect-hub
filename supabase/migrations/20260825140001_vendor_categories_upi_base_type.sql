-- Phase 1: per-business UPI + base_type columns on vendor_categories.
-- Types/nullability match vendors (no NOT NULL, no UPI-format CHECK).
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz
-- Uniqueness (vendor_id, category_id) already exists: vendor_categories_vendor_category_uidx.

ALTER TABLE public.vendor_categories
  ADD COLUMN IF NOT EXISTS upi_id text,
  ADD COLUMN IF NOT EXISTS upi_qr_url text,
  ADD COLUMN IF NOT EXISTS upi_qr_payee_id text,
  ADD COLUMN IF NOT EXISTS base_type text;

ALTER TABLE public.vendor_categories
  DROP CONSTRAINT IF EXISTS vendor_categories_base_type_chk;

ALTER TABLE public.vendor_categories
  ADD CONSTRAINT vendor_categories_base_type_chk
  CHECK (base_type IS NULL OR base_type IN ('shop', 'home', 'none'));

COMMENT ON COLUMN public.vendor_categories.upi_id IS
  'Per-business UPI VPA. Phase 1 column only; live reads still use vendors.upi_id.';
COMMENT ON COLUMN public.vendor_categories.upi_qr_url IS
  'Per-business UPI QR image URL. Phase 1 column only; live reads still use vendors.upi_qr_url.';
COMMENT ON COLUMN public.vendor_categories.upi_qr_payee_id IS
  'Per-business decoded QR payee. Phase 1 column only; live reads still use vendors.upi_qr_payee_id.';
COMMENT ON COLUMN public.vendor_categories.base_type IS
  'Per-business base: shop | home | none. Matches vendors.base_type CHECK.';
