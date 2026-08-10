-- Fix the function overloading issue by removing the 3-parameter version
-- and updating the main function to properly handle NULL parameters

-- Drop the problematic 3-parameter version
DROP FUNCTION IF EXISTS public._resolve_booking_category(uuid, uuid, text);

-- Update the main function to have proper defaults
DROP FUNCTION IF EXISTS public._resolve_booking_category(uuid, uuid, text, text, timestamptz);

CREATE OR REPLACE FUNCTION public._resolve_booking_category(
  p_vendor_id uuid,
  p_hint_category_id uuid DEFAULT NULL,
  p_hint_service_mode text DEFAULT NULL,
  p_delivery_slot text DEFAULT NULL,
  p_appointment_time timestamptz DEFAULT NULL
)
RETURNS TABLE(category_id uuid, service_mode text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category_id uuid;
  v_service_mode text;
  v_category_scalar text;
  v_vendor_scalar text;
  v_category_modes text[];
BEGIN
  -- EXACT LOGIC FROM 20260728150001_hide_pending_location_review_from_radar.sql lines 123-218
  
  -- Customer-visible categories only (approved, not pending location review).
  IF p_hint_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_hint_category_id
      AND vc.status = 'approved'
      AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
  ) THEN
    v_category_id := p_hint_category_id;
  ELSIF p_hint_category_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.category_id = p_hint_category_id
      AND vc.status = 'approved'
      AND vc.verification_status = 'pending_location_review'
  ) THEN
    RAISE EXCEPTION 'category_location_review_pending';
  ELSE
    SELECT vc.category_id
    INTO v_category_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.status = 'approved'
      AND COALESCE(vc.verification_status, '') IS DISTINCT FROM 'pending_location_review'
    ORDER BY vc.is_primary DESC NULLS LAST, vc.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_category_id IS NULL THEN
      SELECT c.id
      INTO v_category_id
      FROM public.vendors v
      JOIN public.categories c ON c.label = v.category
      WHERE v.id = p_vendor_id
      LIMIT 1;
    END IF;
  END IF;

  SELECT COALESCE(array_agg(vcm.mode), ARRAY[]::text[])
  INTO v_category_modes
  FROM public.vendor_categories vc
  JOIN public.vendor_category_modes vcm ON vcm.vendor_category_id = vc.id
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = v_category_id;

  IF p_hint_service_mode IS NOT NULL AND trim(p_hint_service_mode) <> '' THEN
    v_service_mode := lower(trim(p_hint_service_mode));
    IF v_service_mode NOT IN ('help', 'delivery', 'appointment') THEN
      RAISE EXCEPTION 'invalid_service_mode';
    END IF;

    IF COALESCE(array_length(v_category_modes, 1), 0) > 0
       AND NOT (v_service_mode = ANY (v_category_modes))
    THEN
      RAISE EXCEPTION 'service_mode_not_available_for_category';
    END IF;
  ELSE
    IF COALESCE(array_length(v_category_modes, 1), 0) > 0 THEN
      IF p_delivery_slot IS NOT NULL AND 'delivery' = ANY (v_category_modes) THEN
        v_service_mode := 'delivery';
      ELSIF p_appointment_time IS NOT NULL AND 'appointment' = ANY (v_category_modes) THEN
        v_service_mode := 'appointment';
      ELSE
        SELECT vc.service_mode
        INTO v_category_scalar
        FROM public.vendor_categories vc
        WHERE vc.vendor_id = p_vendor_id
          AND vc.category_id = v_category_id
        LIMIT 1;

        v_service_mode := COALESCE(v_category_scalar, 'help');
      END IF;
    ELSE
      SELECT vc.service_mode
      INTO v_category_scalar
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND vc.category_id = v_category_id
      LIMIT 1;

      SELECT v.service_mode
      INTO v_vendor_scalar
      FROM public.vendors v
      WHERE v.id = p_vendor_id;

      v_service_mode := COALESCE(
        v_category_scalar,
        v_vendor_scalar,
        CASE
          WHEN p_delivery_slot IS NOT NULL THEN 'delivery'
          WHEN p_appointment_time IS NOT NULL THEN 'appointment'
          ELSE 'help'
        END
      );
    END IF;
  END IF;

  -- Return the resolved category_id and service_mode
  category_id := v_category_id;
  service_mode := v_service_mode;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public._resolve_booking_category(uuid, uuid, text, text, timestamptz) IS
  'Resolve category_id and service_mode for booking based on vendor capabilities and hints. Extracted from create_customer_request for reuse.';

-- Grant permissions to match create_customer_request
REVOKE ALL ON FUNCTION public._resolve_booking_category(uuid, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._resolve_booking_category(uuid, uuid, text, text, timestamptz) TO anon, authenticated;