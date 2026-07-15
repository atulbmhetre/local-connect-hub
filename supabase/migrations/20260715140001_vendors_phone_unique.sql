-- Prevent two live vendors from sharing the same phone.
-- Soft-deleted / anonymized phones (deleted_%) are excluded so account deletion
-- can free a number for re-registration (same allowance as vendors_phone_format_check).

CREATE UNIQUE INDEX IF NOT EXISTS vendors_phone_key
  ON public.vendors (phone)
  WHERE phone IS NOT NULL AND phone NOT LIKE 'deleted_%';

COMMENT ON INDEX public.vendors_phone_key IS
  'Unique live vendor phone; deleted_% anonymized phones are excluded.';
