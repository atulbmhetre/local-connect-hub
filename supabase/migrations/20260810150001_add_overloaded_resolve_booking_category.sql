-- Add overloaded version of _resolve_booking_category with 3 parameters
-- This provides backward compatibility for any cached calls

CREATE OR REPLACE FUNCTION public._resolve_booking_category(
  p_vendor_id uuid,
  p_hint_category_id uuid,
  p_hint_service_mode text
)
RETURNS TABLE(category_id uuid, service_mode text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Call the full 5-parameter version with NULLs for delivery_slot and appointment_time
  RETURN QUERY
  SELECT * FROM public._resolve_booking_category(
    p_vendor_id, 
    p_hint_category_id, 
    p_hint_service_mode,
    NULL::text,  -- p_delivery_slot
    NULL::timestamptz  -- p_appointment_time
  );
END;
$$;

COMMENT ON FUNCTION public._resolve_booking_category(uuid, uuid, text) IS
  'Backward compatibility wrapper for 3-parameter _resolve_booking_category calls.';

-- Grant permissions to match the main function
REVOKE ALL ON FUNCTION public._resolve_booking_category(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._resolve_booking_category(uuid, uuid, text) TO anon, authenticated;