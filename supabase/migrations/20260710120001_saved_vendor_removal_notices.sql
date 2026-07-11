-- Neighbourhood cleanup notices when a vendor drops a category or is anonymised.
-- Trigger points:
--   1) vendor_update_categories — removed categories purge matching saved_vendors
--   2) anonymise_deleted_accounts (vendor branch, post–30-day) — purge all saves for vendor
-- Notices are Home-screen only (no push/FCM).

CREATE TABLE IF NOT EXISTS public.saved_vendor_removal_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_phone text NOT NULL,
  shop_name text NOT NULL,
  category_label text,
  reason text NOT NULL
    CHECK (reason IN ('category_removed', 'account_deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  shown_at timestamptz
);

CREATE INDEX IF NOT EXISTS saved_vendor_removal_notices_user_unshown_idx
  ON public.saved_vendor_removal_notices (user_phone)
  WHERE shown_at IS NULL;

COMMENT ON TABLE public.saved_vendor_removal_notices IS
  'One-time Home flash when a saved neighbour is removed due to category drop or vendor account anonymisation.';

ALTER TABLE public.saved_vendor_removal_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "saved_vendor_removal_notices_select" ON public.saved_vendor_removal_notices;
CREATE POLICY "saved_vendor_removal_notices_select"
  ON public.saved_vendor_removal_notices
  FOR SELECT
  USING (true);

-- Inserts/updates go through SECURITY DEFINER helpers only.
REVOKE INSERT, UPDATE, DELETE ON public.saved_vendor_removal_notices FROM anon, authenticated;

-- ── Helpers ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._purge_saved_vendors_for_removed_categories(
  p_vendor_id uuid,
  p_removed_category_ids uuid[],
  p_shop_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label text;
BEGIN
  IF p_vendor_id IS NULL
    OR p_removed_category_ids IS NULL
    OR COALESCE(array_length(p_removed_category_ids, 1), 0) = 0
  THEN
    RETURN;
  END IF;

  FOR v_label IN
    SELECT c.label
    FROM public.categories c
    WHERE c.id = ANY (p_removed_category_ids)
  LOOP
    INSERT INTO public.saved_vendor_removal_notices (
      user_phone,
      shop_name,
      category_label,
      reason
    )
    SELECT DISTINCT
      btrim(sv.user_phone),
      COALESCE(NULLIF(btrim(p_shop_name), ''), 'Shop'),
      v_label,
      'category_removed'
    FROM public.saved_vendors sv
    WHERE sv.vendor_id = p_vendor_id
      AND sv.category = v_label
      AND sv.user_phone IS NOT NULL
      AND btrim(sv.user_phone) <> '';

    DELETE FROM public.saved_vendors
    WHERE vendor_id = p_vendor_id
      AND category = v_label;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public._purge_saved_vendors_for_account_deletion(
  p_vendor_id uuid,
  p_shop_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_id IS NULL THEN
    RETURN;
  END IF;

  -- category_label left NULL — Home copy is "[Shop] — account closed".
  INSERT INTO public.saved_vendor_removal_notices (
    user_phone,
    shop_name,
    category_label,
    reason
  )
  SELECT DISTINCT
    btrim(sv.user_phone),
    COALESCE(NULLIF(btrim(p_shop_name), ''), 'Shop'),
    NULL,
    'account_deleted'
  FROM public.saved_vendors sv
  WHERE sv.vendor_id = p_vendor_id
    AND sv.user_phone IS NOT NULL
    AND btrim(sv.user_phone) <> '';

  DELETE FROM public.saved_vendors
  WHERE vendor_id = p_vendor_id;
END;
$$;

REVOKE ALL ON FUNCTION public._purge_saved_vendors_for_removed_categories(uuid, uuid[], text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public._purge_saved_vendors_for_account_deletion(uuid, text)
  FROM PUBLIC;

-- ── Mark notices shown (Home dismiss) ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_saved_vendor_removal_notices_shown(
  p_user_phone text,
  p_notice_ids uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_phone IS NULL OR btrim(p_user_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  UPDATE public.saved_vendor_removal_notices
  SET shown_at = now()
  WHERE user_phone = btrim(p_user_phone)
    AND shown_at IS NULL
    AND (
      p_notice_ids IS NULL
      OR id = ANY (p_notice_ids)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_saved_vendor_removal_notices_shown(text, uuid[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_saved_vendor_removal_notices_shown(text, uuid[])
  TO anon, authenticated;

-- ── vendor_update_categories: purge saves for removed categories ─────────────

CREATE OR REPLACE FUNCTION public.vendor_update_categories(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_ids uuid[],
  p_category_service_modes text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cat_count integer;
  v_needs_review boolean;
  i integer;
  v_old_ids uuid[];
  v_removed uuid[];
  v_shop_name text;
BEGIN
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vendors
    WHERE id = p_vendor_id
      AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  v_cat_count := COALESCE(array_length(p_category_ids, 1), 0);
  IF v_cat_count = 0 THEN
    RAISE EXCEPTION 'category_ids_required';
  END IF;

  IF p_category_service_modes IS NULL
    OR COALESCE(array_length(p_category_service_modes, 1), 0) <> v_cat_count
  THEN
    RAISE EXCEPTION 'category_service_modes length must match category_ids length';
  END IF;

  SELECT COALESCE(array_agg(vc.category_id), ARRAY[]::uuid[])
  INTO v_old_ids
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id;

  SELECT COALESCE(array_agg(old_id), ARRAY[]::uuid[])
  INTO v_removed
  FROM unnest(v_old_ids) AS old_id
  WHERE NOT (old_id = ANY (p_category_ids));

  SELECT v.shop_name
  INTO v_shop_name
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  v_needs_review := v_cat_count >= 3;

  DELETE FROM public.vendor_categories
  WHERE vendor_id = p_vendor_id;

  FOR i IN 1..v_cat_count LOOP
    INSERT INTO public.vendor_categories (
      vendor_id,
      category_id,
      is_primary,
      status,
      needs_review,
      service_mode
    )
    VALUES (
      p_vendor_id,
      p_category_ids[i],
      i = 1,
      'approved',
      v_needs_review,
      COALESCE(NULLIF(trim(p_category_service_modes[i]), ''), 'help')
    );
  END LOOP;

  IF COALESCE(array_length(v_removed, 1), 0) > 0 THEN
    PERFORM public._purge_saved_vendors_for_removed_categories(
      p_vendor_id,
      v_removed,
      v_shop_name
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_update_categories(uuid, text, uuid[], text[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_categories(uuid, text, uuid[], text[])
  TO anon, authenticated;

COMMENT ON FUNCTION public.vendor_update_categories(uuid, text, uuid[], text[]) IS
  'Replaces vendor_categories after phone ownership check. Purges matching saved_vendors + queues Home notices for removed categories.';

-- ── anonymise_deleted_accounts: purge neighbour saves at final anonymisation ─

CREATE OR REPLACE FUNCTION public.anonymise_deleted_accounts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  original_phone text;
  anon_tag text;
  v_vendor_id uuid;
  v_shop_name text;
BEGIN
  FOR rec IN
    SELECT u.phone
    FROM public.users u
    WHERE u.deletion_requested_at IS NOT NULL
      AND NOT starts_with(u.phone, 'deleted_')
  LOOP
    original_phone := rec.phone;
    anon_tag := 'deleted_' || substr(gen_random_uuid()::text, 1, 5);

    PERFORM public._anonymise_customer_phone(original_phone, anon_tag);

    UPDATE public.users
    SET deletion_requested_at = NULL
    WHERE phone = anon_tag;
  END LOOP;

  FOR rec IN
    SELECT v.id, v.phone, v.shop_name
    FROM public.vendors v
    WHERE v.deletion_requested_at IS NOT NULL
      AND NOT starts_with(v.phone, 'deleted_')
      AND v.deletion_requested_at < now() - interval '30 days'
  LOOP
    original_phone := rec.phone;
    anon_tag := 'deleted_' || substr(gen_random_uuid()::text, 1, 5);
    v_vendor_id := rec.id;
    v_shop_name := rec.shop_name;

    -- Snapshot shop_name + purge neighbour bookmarks BEFORE scrubbing the vendor row.
    IF v_vendor_id IS NOT NULL THEN
      PERFORM public._purge_saved_vendors_for_account_deletion(v_vendor_id, v_shop_name);
    END IF;

    PERFORM set_config('app.via_system_rpc', 'true', true);

    UPDATE public.vendors
    SET
      phone = anon_tag,
      name = 'Deleted Vendor',
      shop_name = 'Deleted Shop',
      upi_id = NULL,
      fcm_token = NULL,
      latitude = NULL,
      longitude = NULL,
      is_active = false,
      is_banned = true,
      ban_reason = 'Account deleted',
      shop_photo_url = NULL,
      photo_selfie = NULL,
      vendor_note = NULL,
      cancel_reason_1 = NULL,
      cancel_reason_2 = NULL,
      cancel_reason_3 = NULL,
      cancel_reason_4 = NULL,
      referral_code = NULL,
      ledger_cycle_start = NULL
    WHERE phone = original_phone;

    SELECT v.id
    INTO v_vendor_id
    FROM public.vendors v
    WHERE v.phone = anon_tag;

    IF v_vendor_id IS NOT NULL THEN
      DELETE FROM public.vendor_menu_items WHERE vendor_id = v_vendor_id;
      DELETE FROM public.vendor_credits WHERE vendor_id = v_vendor_id;
      DELETE FROM public.vendor_categories WHERE vendor_id = v_vendor_id;
      DELETE FROM public.vendor_verification WHERE vendor_id = v_vendor_id;

      UPDATE public.categories
      SET suggested_by_vendor_id = NULL
      WHERE suggested_by_vendor_id = v_vendor_id;
    END IF;

    PERFORM public._anonymise_customer_phone(original_phone, anon_tag);

    DELETE FROM public.user_devices
    WHERE user_phone = original_phone;

    UPDATE public.users
    SET deletion_requested_at = NULL
    WHERE phone = anon_tag;

    UPDATE public.vendors
    SET deletion_requested_at = NULL
    WHERE phone = anon_tag;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.anonymise_deleted_accounts() IS
  'Anonymises customer PII immediately on deletion request; vendor profiles after 30 days. On vendor anonymisation, purges other users'' saved_vendors and queues Home removal notices.';
