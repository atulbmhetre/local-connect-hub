-- Backfill vendor_category_modes for approved vendor_categories missing modes.
-- Uses the same helper as register_vendor / attach_pending_category so seed-
-- and wipe-orphaned rows follow the real registration code path.
-- Idempotent: only touches approved VCs with zero mode rows.

DO $$
DECLARE
  r record;
  v_catalog_mode text;
  v_mode text;
  v_fixed integer := 0;
BEGIN
  FOR r IN
    SELECT vc.id, vc.service_mode, vc.category_id
    FROM public.vendor_categories vc
    WHERE vc.status = 'approved'
      AND NOT EXISTS (
        SELECT 1
        FROM public.vendor_category_modes m
        WHERE m.vendor_category_id = vc.id
      )
  LOOP
    SELECT c.service_mode
    INTO v_catalog_mode
    FROM public.categories c
    WHERE c.id = r.category_id;

    v_mode := lower(trim(COALESCE(NULLIF(trim(r.service_mode), ''), v_catalog_mode, 'help')));
    IF v_mode NOT IN ('help', 'delivery', 'appointment') THEN
      v_mode := 'help';
    END IF;

    PERFORM public._rewrite_vendor_category_modes(
      r.id,
      ARRAY[v_mode]::text[],
      v_catalog_mode
    );
    v_fixed := v_fixed + 1;
  END LOOP;

  RAISE NOTICE 'backfill_vendor_category_modes: fixed % approved vendor_categories', v_fixed;
END $$;
