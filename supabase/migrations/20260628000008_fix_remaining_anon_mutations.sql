-- SECURITY DEFINER RPCs for anon mutations blocked by Phase C RLS (auth_user_phone() NULL when OTP disabled).

-- ── Customer identity helpers ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._customer_identity_ok(
  p_device_id text,
  p_user_phone text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p_device_id IS NOT NULL OR p_user_phone IS NOT NULL;
$$;

-- ── saved_vendors ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.save_saved_vendor(
  p_vendor_id uuid,
  p_category text,
  p_nickname text,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  INSERT INTO public.saved_vendors (device_id, vendor_id, category, nickname, user_phone)
  VALUES (p_device_id, p_vendor_id, p_category, p_nickname, p_user_phone);
END;
$$;

CREATE OR REPLACE FUNCTION public.unsave_saved_vendor(
  p_vendor_id uuid,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  DELETE FROM public.saved_vendors sv
  WHERE sv.vendor_id = p_vendor_id
    AND (
      (p_user_phone IS NOT NULL AND sv.user_phone = p_user_phone)
      OR (p_device_id IS NOT NULL AND sv.device_id = p_device_id)
    );
END;
$$;

-- ── requests (customer place order) ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_customer_request(
  p_device_id text,
  p_vendor_id uuid,
  p_message text,
  p_user_phone text DEFAULT NULL,
  p_device_id_log text DEFAULT NULL,
  p_delivery_address text DEFAULT NULL,
  p_delivery_slot text DEFAULT NULL,
  p_delivery_slot_deadline timestamptz DEFAULT NULL,
  p_appointment_time timestamptz DEFAULT NULL,
  p_appointment_status text DEFAULT NULL,
  p_customer_latitude double precision DEFAULT NULL,
  p_customer_longitude double precision DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  INSERT INTO public.requests (
    device_id,
    vendor_id,
    message,
    status,
    user_phone,
    device_id_log,
    delivery_address,
    delivery_slot,
    delivery_slot_deadline,
    appointment_time,
    appointment_status,
    customer_latitude,
    customer_longitude
  )
  VALUES (
    p_device_id,
    p_vendor_id,
    p_message,
    'sent',
    p_user_phone,
    p_device_id_log,
    p_delivery_address,
    p_delivery_slot,
    p_delivery_slot_deadline,
    p_appointment_time,
    p_appointment_status,
    p_customer_latitude,
    p_customer_longitude
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── user_addresses ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.insert_user_address(
  p_device_id text,
  p_user_phone text,
  p_label text,
  p_address_text text,
  p_is_default boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  INSERT INTO public.user_addresses (device_id, user_phone, label, address_text, is_default)
  VALUES (p_device_id, p_user_phone, p_label, p_address_text, p_is_default);
END;
$$;

-- ── user_notifications ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_user_notification_read(
  p_user_phone text,
  p_notification_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  UPDATE public.user_notifications
  SET is_read = true, read_at = now()
  WHERE id = p_notification_id
    AND user_phone = p_user_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_user_notifications_read(
  p_user_phone text,
  p_informational_only boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  UPDATE public.user_notifications
  SET is_read = true, read_at = now()
  WHERE user_phone = p_user_phone
    AND is_read = false
    AND (NOT p_informational_only OR is_informational = true);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_user_notification(
  p_user_phone text,
  p_notification_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  DELETE FROM public.user_notifications
  WHERE id = p_notification_id
    AND user_phone = p_user_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_user_notifications(
  p_user_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  DELETE FROM public.user_notifications
  WHERE user_phone = p_user_phone;
END;
$$;

-- ── vendors (owner patch) ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_update_own(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_patch jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF p_patch IS NULL OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'patch_required';
  END IF;

  UPDATE public.vendors v
  SET
    vendor_note = CASE WHEN p_patch ? 'vendor_note' THEN NULLIF(p_patch->>'vendor_note', '') ELSE v.vendor_note END,
    service_radius_km = CASE WHEN p_patch ? 'service_radius_km' THEN (p_patch->>'service_radius_km')::integer ELSE v.service_radius_km END,
    latitude = CASE WHEN p_patch ? 'latitude' THEN (p_patch->>'latitude')::double precision ELSE v.latitude END,
    longitude = CASE WHEN p_patch ? 'longitude' THEN (p_patch->>'longitude')::double precision ELSE v.longitude END,
    profile_status = CASE WHEN p_patch ? 'profile_status' THEN p_patch->>'profile_status' ELSE v.profile_status END,
    ledger_cycle_start = CASE
      WHEN p_patch ? 'ledger_cycle_start' AND p_patch->'ledger_cycle_start' IS NULL THEN NULL
      WHEN p_patch ? 'ledger_cycle_start' THEN (p_patch->>'ledger_cycle_start')::date
      ELSE v.ledger_cycle_start
    END,
    khata_amber_limit = CASE WHEN p_patch ? 'khata_amber_limit' THEN (p_patch->>'khata_amber_limit')::numeric ELSE v.khata_amber_limit END,
    khata_red_limit = CASE WHEN p_patch ? 'khata_red_limit' THEN (p_patch->>'khata_red_limit')::numeric ELSE v.khata_red_limit END,
    cancel_reason_1 = CASE WHEN p_patch ? 'cancel_reason_1' THEN NULLIF(p_patch->>'cancel_reason_1', '') ELSE v.cancel_reason_1 END,
    cancel_reason_2 = CASE WHEN p_patch ? 'cancel_reason_2' THEN NULLIF(p_patch->>'cancel_reason_2', '') ELSE v.cancel_reason_2 END,
    cancel_reason_3 = CASE WHEN p_patch ? 'cancel_reason_3' THEN NULLIF(p_patch->>'cancel_reason_3', '') ELSE v.cancel_reason_3 END,
    cancel_reason_4 = CASE WHEN p_patch ? 'cancel_reason_4' THEN NULLIF(p_patch->>'cancel_reason_4', '') ELSE v.cancel_reason_4 END,
    subscription_status = CASE WHEN p_patch ? 'subscription_status' THEN p_patch->>'subscription_status' ELSE v.subscription_status END,
    subscription_id = CASE WHEN p_patch ? 'subscription_id' THEN NULLIF(p_patch->>'subscription_id', '') ELSE v.subscription_id END,
    grace_ends_at = CASE
      WHEN p_patch ? 'grace_ends_at' AND p_patch->'grace_ends_at' IS NULL THEN NULL
      WHEN p_patch ? 'grace_ends_at' THEN (p_patch->>'grace_ends_at')::timestamptz
      ELSE v.grace_ends_at
    END
  WHERE v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

-- ── vendor_menu_items ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_insert_menu_items(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_items jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
BEGIN
  IF p_vendor_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    INSERT INTO public.vendor_menu_items (
      vendor_id,
      name,
      price,
      unit,
      description,
      sort_order,
      is_available
    )
    VALUES (
      p_vendor_id,
      COALESCE(v_item->>'name', ''),
      COALESCE((v_item->>'price')::numeric, 0),
      NULLIF(v_item->>'unit', ''),
      NULLIF(v_item->>'description', ''),
      COALESCE((v_item->>'sort_order')::integer, 0),
      COALESCE((v_item->>'is_available')::boolean, true)
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_update_menu_item(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_item_id uuid,
  p_name text,
  p_price numeric,
  p_unit text,
  p_description text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.vendor_menu_items mi
  SET
    name = p_name,
    price = p_price,
    unit = NULLIF(p_unit, ''),
    description = NULLIF(p_description, '')
  FROM public.vendors v
  WHERE mi.id = p_item_id
    AND mi.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_delete_menu_item(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_item_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.vendor_menu_items mi
  USING public.vendors v
  WHERE mi.id = p_item_id
    AND mi.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_toggle_menu_item_availability(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_item_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.vendor_menu_items mi
  SET is_available = NOT mi.is_available
  FROM public.vendors v
  WHERE mi.id = p_item_id
    AND mi.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

-- ── order_bills ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_mark_bill_paid(
  p_bill_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.order_bills ob
  SET payment_status = 'paid', paid_at = now()
  FROM public.vendors v
  WHERE ob.id = p_bill_id
    AND ob.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_void_unpaid_bills(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.order_bills ob
  SET payment_status = 'void'
  FROM public.vendors v
  WHERE ob.request_id = p_request_id
    AND ob.vendor_id = p_vendor_id
    AND ob.payment_status <> 'paid'
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;
END;
$$;

-- ── user_flags (vendor flags customer) ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_submit_user_flag(
  p_request_id uuid,
  p_vendor_id uuid,
  p_vendor_phone text,
  p_user_phone text,
  p_flag_type text,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._vendor_owns_request(p_request_id, p_vendor_id, p_vendor_phone) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  INSERT INTO public.user_flags (request_id, vendor_id, user_phone, flag_type, notes)
  VALUES (p_request_id, p_vendor_id, p_user_phone, p_flag_type, p_notes);
END;
$$;

-- ── vendor_reviews ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_reply_to_review(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_review_id uuid,
  p_response text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.vendor_reviews vr
  SET
    vendor_response = p_response,
    vendor_responded_at = now()
  FROM public.vendors v
  WHERE vr.id = p_review_id
    AND vr.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

-- ── feed_posts ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_post_offer(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_content text,
  p_starts_at timestamptz DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND phone = p_vendor_phone
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  INSERT INTO public.feed_posts (
    type,
    vendor_id,
    user_phone,
    content,
    is_hidden,
    starts_at,
    expires_at,
    image_url,
    lat,
    lng
  )
  VALUES (
    'offer',
    p_vendor_id,
    p_vendor_phone,
    p_content,
    false,
    p_starts_at,
    p_expires_at,
    p_image_url,
    p_lat,
    p_lng
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_hide_feed_post(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_post_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.feed_posts fp
  SET is_hidden = true
  FROM public.vendors v
  WHERE fp.id = p_post_id
    AND fp.vendor_id = p_vendor_id
    AND v.id = p_vendor_id
    AND v.phone = p_vendor_phone;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;
END;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public._customer_identity_ok(text, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.save_saved_vendor(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_saved_vendor(uuid, text, text, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.unsave_saved_vendor(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unsave_saved_vendor(uuid, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.create_customer_request(text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_customer_request(text, uuid, text, text, text, text, text, timestamptz, timestamptz, text, double precision, double precision) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.insert_user_address(text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_user_address(text, text, text, text, boolean) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.mark_user_notification_read(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_user_notification_read(text, uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.mark_user_notifications_read(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_user_notifications_read(text, boolean) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.delete_user_notification(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_user_notification(text, uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.clear_user_notifications(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_user_notifications(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_update_own(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_own(uuid, text, jsonb) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_insert_menu_items(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_insert_menu_items(uuid, text, jsonb) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_update_menu_item(uuid, text, uuid, text, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_menu_item(uuid, text, uuid, text, numeric, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_delete_menu_item(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_delete_menu_item(uuid, text, uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_toggle_menu_item_availability(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_toggle_menu_item_availability(uuid, text, uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_mark_bill_paid(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_mark_bill_paid(uuid, uuid, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_void_unpaid_bills(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_void_unpaid_bills(uuid, uuid, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_submit_user_flag(uuid, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_submit_user_flag(uuid, uuid, text, text, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_reply_to_review(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_reply_to_review(uuid, text, uuid, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_post_offer(uuid, text, text, timestamptz, timestamptz, text, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_post_offer(uuid, text, text, timestamptz, timestamptz, text, double precision, double precision) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_hide_feed_post(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_hide_feed_post(uuid, text, uuid) TO anon, authenticated;
