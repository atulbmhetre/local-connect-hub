-- related_id on user_notifications FK → requests; use route_params for vendor_category_id.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE OR REPLACE FUNCTION public.admin_reject_vendor_business(
  p_admin_phone text,
  p_vendor_category_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_id uuid;
  v_phone text;
  v_reason text;
  v_title text;
  v_body text;
BEGIN
  IF NOT public.is_admin_session() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  PERFORM set_config('app.via_admin_rpc', 'true', true);

  v_reason := NULLIF(left(btrim(COALESCE(p_reason, '')), 280), '');

  UPDATE public.vendor_categories
  SET
    status = 'rejected',
    needs_review = false,
    review_reason = v_reason
  WHERE id = p_vendor_category_id
    AND status = 'pending_review'
  RETURNING vendor_id INTO v_vendor_id;

  IF v_vendor_id IS NULL THEN
    RAISE EXCEPTION 'vendor_business_not_pending';
  END IF;

  SELECT NULLIF(btrim(phone), '') INTO v_phone
  FROM public.vendors
  WHERE id = v_vendor_id;

  SELECT f.title, f.body INTO v_title, v_body
  FROM public.notification_i18n_format(
    'vendor_business_rejected',
    COALESCE(v_phone, 'en'),
    jsonb_build_object(
      'reason',
      COALESCE(v_reason, 'Your business was not approved at this time.')
    )
  ) f;

  PERFORM public._vendor_inbox_and_fcm(
    v_vendor_id,
    v_title,
    v_body,
    'vendor_business_rejected',
    'settings',
    jsonb_build_object(
      'vendor_id', v_vendor_id,
      'vendor_category_id', p_vendor_category_id
    ),
    NULL,
    NULL,
    NULL,
    true
  );
END;
$$;
