-- Recalculate vendor avg_rating / review_count inside admin_delete_review (SECURITY DEFINER).

CREATE OR REPLACE FUNCTION public.admin_delete_review(
  p_admin_phone text,
  p_review_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_id uuid;
  v_review_count integer;
  v_avg_rating numeric;
BEGIN
  IF NOT public.is_admin_phone(p_admin_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  SELECT vendor_id INTO v_vendor_id
  FROM public.vendor_reviews
  WHERE id = p_review_id;
  IF v_vendor_id IS NULL THEN
    RAISE EXCEPTION 'review not found';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);
  DELETE FROM public.vendor_reviews WHERE id = p_review_id;

  SELECT COUNT(*)::integer, ROUND(AVG(rating)::numeric, 1)
  INTO v_review_count, v_avg_rating
  FROM public.vendor_reviews
  WHERE vendor_id = v_vendor_id;

  IF v_review_count = 0 THEN
    UPDATE public.vendors
    SET avg_rating = NULL,
        review_count = 0,
        low_rating_admin_notified = false
    WHERE id = v_vendor_id;
  ELSE
    UPDATE public.vendors
    SET avg_rating = v_avg_rating,
        review_count = v_review_count,
        low_rating_admin_notified = CASE
          WHEN v_avg_rating > 3.5 THEN false
          ELSE low_rating_admin_notified
        END
    WHERE id = v_vendor_id;
  END IF;

  RETURN v_vendor_id;
END;
$$;
