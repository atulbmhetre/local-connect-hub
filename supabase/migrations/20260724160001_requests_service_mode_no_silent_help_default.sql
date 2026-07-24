-- Fix silent requests.service_mode DEFAULT 'help' that poisoned order-mode UI/RPCs
-- when inserts omitted the column (tests and some clients).
--
-- Strategy:
--   1) Drop the silent DEFAULT so omission yields NULL, not 'help'.
--   2) BEFORE INSERT: if service_mode is NULL, copy vendors.service_mode.
--   3) Keep COALESCE(r.service_mode, v.service_mode) in read RPCs as fallback.
-- Explicit inserts (including service_mode = 'help') are unchanged.

ALTER TABLE public.requests
  ALTER COLUMN service_mode DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.requests_set_service_mode_from_vendor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.service_mode IS NULL OR btrim(NEW.service_mode) = '' THEN
    IF NEW.vendor_id IS NOT NULL THEN
      SELECT v.service_mode
        INTO NEW.service_mode
      FROM public.vendors v
      WHERE v.id = NEW.vendor_id;
    END IF;
  END IF;

  IF NEW.service_mode IS NOT NULL THEN
    NEW.service_mode := lower(btrim(NEW.service_mode));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_requests_set_service_mode_from_vendor ON public.requests;
CREATE TRIGGER trg_requests_set_service_mode_from_vendor
  BEFORE INSERT ON public.requests
  FOR EACH ROW
  EXECUTE FUNCTION public.requests_set_service_mode_from_vendor();

COMMENT ON FUNCTION public.requests_set_service_mode_from_vendor() IS
  'When requests.service_mode is omitted/blank, copy vendors.service_mode so UI/RPCs do not silently treat the order as help.';
