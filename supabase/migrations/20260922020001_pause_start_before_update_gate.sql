-- Direct REST PATCH of vendor_categories.is_paused must hit the same open-work
-- and subscription gate as the RPC. One enforcement function, called from a
-- BEFORE UPDATE trigger on false->true. Resume (true->false) is never blocked.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE OR REPLACE FUNCTION public._vendor_categories_pause_start_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.is_paused, false) = true
     AND COALESCE(OLD.is_paused, false) = false THEN
    PERFORM public._vendor_assert_can_start_pause(NEW.vendor_id, NEW.category_id);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public._vendor_categories_pause_start_gate() IS
  'BEFORE UPDATE OF is_paused: enforce pause-start gate. Resume is a no-op here.';

DROP TRIGGER IF EXISTS vendor_categories_pause_block_trg ON public.vendor_categories;
CREATE TRIGGER vendor_categories_pause_block_trg
  BEFORE UPDATE OF is_paused ON public.vendor_categories
  FOR EACH ROW
  EXECUTE FUNCTION public._vendor_categories_pause_start_gate();
