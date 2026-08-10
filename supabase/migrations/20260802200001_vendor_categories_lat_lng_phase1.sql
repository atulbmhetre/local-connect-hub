-- Phase 1 (per-business location): additive only.
-- Add nullable lat/lng on vendor_categories and backfill from account pin.
-- Does NOT change RPCs, UI, or verification computation.
-- Does NOT touch shop_photo_url, gps_match_distance, accuracies,
-- verification_status, or is_manual_verified.

ALTER TABLE public.vendor_categories
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision;

COMMENT ON COLUMN public.vendor_categories.latitude IS
  'Per-business shop latitude. Phase 1: backfilled from vendors.latitude; writers land in a later phase.';
COMMENT ON COLUMN public.vendor_categories.longitude IS
  'Per-business shop longitude. Phase 1: backfilled from vendors.longitude; writers land in a later phase.';

UPDATE public.vendor_categories vc
SET
  latitude = v.latitude,
  longitude = v.longitude
FROM public.vendors v
WHERE vc.vendor_id = v.id
  AND v.latitude IS NOT NULL
  AND v.longitude IS NOT NULL
  AND (vc.latitude IS NULL OR vc.longitude IS NULL);
