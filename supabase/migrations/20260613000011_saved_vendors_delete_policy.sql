-- RS-05: unsave neighbours (RadarVendorCard / NeighbourSheet delete on saved_vendors).
-- RS-17: align schema with app (user_phone, saved_at) while keeping device_id + created_at.
--
-- Existing policies (20260509140000_saved_vendors_requests.sql) are permissive anon
-- patterns with no JWT — app filters by device_id / user_phone client-side:
--   saved_vendors_select  FOR SELECT USING (true)
--   saved_vendors_insert  FOR INSERT WITH CHECK (true)
-- Mirror the same pattern for DELETE (not JWT claims).

ALTER TABLE public.saved_vendors
  ADD COLUMN IF NOT EXISTS user_phone text,
  ADD COLUMN IF NOT EXISTS saved_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Hosted TEST may have saved_at without created_at (or vice versa); keep both in sync.
UPDATE public.saved_vendors
SET saved_at = COALESCE(saved_at, created_at, now())
WHERE saved_at IS NULL;

UPDATE public.saved_vendors
SET created_at = COALESCE(created_at, saved_at, now())
WHERE created_at IS NULL;

CREATE INDEX IF NOT EXISTS saved_vendors_user_phone_idx
  ON public.saved_vendors (user_phone)
  WHERE user_phone IS NOT NULL;

DROP POLICY IF EXISTS "saved_vendors_delete" ON public.saved_vendors;
CREATE POLICY "saved_vendors_delete"
  ON public.saved_vendors
  FOR DELETE
  USING (true);
