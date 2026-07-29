-- Defense-in-depth: one review per order at the DB layer.
-- request_id may become NULL when a terminal request is archived (ON DELETE SET NULL);
-- PostgreSQL UNIQUE allows multiple NULLs, so archived reviews do not conflict.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_reviews_request_id_key
  ON public.vendor_reviews (request_id)
  WHERE request_id IS NOT NULL;

-- Make submit_vendor_review atomic: rely on the unique index instead of a
-- separate EXISTS check that races under concurrent inserts.
CREATE OR REPLACE FUNCTION public.submit_vendor_review(
  p_vendor_id uuid,
  p_request_id uuid,
  p_user_phone text,
  p_device_id text,
  p_rating int,
  p_review_text text,
  p_service_mode text
)
RETURNS public.vendor_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_device text;
  v_req_vendor_id uuid;
  v_req_status text;
  v_req_user_phone text;
  v_req_device_id text;
  v_row public.vendor_reviews;
BEGIN
  v_phone := NULLIF(TRIM(p_user_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'user_phone_required';
  END IF;

  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'invalid_rating';
  END IF;

  v_device := NULLIF(TRIM(p_device_id), '');

  SELECT r.vendor_id, r.status, r.user_phone, r.device_id
  INTO v_req_vendor_id, v_req_status, v_req_user_phone, v_req_device_id
  FROM public.requests r
  WHERE r.id = p_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;

  IF v_req_vendor_id IS DISTINCT FROM p_vendor_id THEN
    RAISE EXCEPTION 'vendor_mismatch';
  END IF;

  IF v_req_status IS DISTINCT FROM 'fulfilled' THEN
    RAISE EXCEPTION 'order_not_fulfilled';
  END IF;

  -- Dual-identity: phone customers and device-only customers (see claim_customer_payment).
  IF NOT (
    (v_phone IS NOT NULL AND v_req_user_phone = v_phone)
    OR (v_device IS NOT NULL AND v_req_device_id = v_device)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  BEGIN
    INSERT INTO public.vendor_reviews (
      vendor_id,
      request_id,
      user_phone,
      device_id,
      rating,
      review_text,
      service_mode
    )
    VALUES (
      p_vendor_id,
      p_request_id,
      v_phone,
      v_device,
      p_rating,
      NULLIF(TRIM(p_review_text), ''),
      NULLIF(TRIM(p_service_mode), '')
    )
    RETURNING * INTO v_row;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'review_already_exists';
  END;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.submit_vendor_review(uuid, uuid, text, text, int, text, text) IS
  'Inserts a vendor review only for a fulfilled request that matches vendor + caller phone/device. One review per request_id (unique index).';

REVOKE ALL ON FUNCTION public.submit_vendor_review(uuid, uuid, text, text, int, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_vendor_review(uuid, uuid, text, text, int, text, text) TO anon, authenticated;
