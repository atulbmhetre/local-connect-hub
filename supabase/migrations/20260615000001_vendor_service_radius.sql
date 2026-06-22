-- Per-vendor service/delivery radius for radar visibility (Prompt 1 of 2).
-- Pan-India is stored as 9999 km in application code.

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS service_radius_km integer NOT NULL DEFAULT 15;

COMMENT ON COLUMN public.vendors.service_radius_km IS
  'Max distance (km) vendor serves customers. 9999 = pan-India.';
