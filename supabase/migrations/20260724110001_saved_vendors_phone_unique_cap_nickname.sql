-- saved_vendors: phone+vendor uniqueness, server-side max-20 on save,
-- and nickname update RPC (OTP-off). Nickname column already exists (NOT NULL);
-- empty string means "no custom nickname" (UI falls back to shop_name).

-- ── 1. Dedup before unique (user_phone, vendor_id) ──────────────────────────
-- Keep the newest row per (phone, vendor); drop older duplicates.
DELETE FROM public.saved_vendors a
USING public.saved_vendors b
WHERE a.user_phone IS NOT NULL
  AND btrim(a.user_phone) <> ''
  AND a.user_phone = b.user_phone
  AND a.vendor_id = b.vendor_id
  AND a.id <> b.id
  AND COALESCE(a.saved_at, a.created_at, '-infinity'::timestamptz)
    < COALESCE(b.saved_at, b.created_at, '-infinity'::timestamptz);

-- Tie-break on equal timestamps: keep higher id.
DELETE FROM public.saved_vendors a
USING public.saved_vendors b
WHERE a.user_phone IS NOT NULL
  AND btrim(a.user_phone) <> ''
  AND a.user_phone = b.user_phone
  AND a.vendor_id = b.vendor_id
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS saved_vendors_user_phone_vendor_uidx
  ON public.saved_vendors (user_phone, vendor_id)
  WHERE user_phone IS NOT NULL AND btrim(user_phone) <> '';

COMMENT ON INDEX public.saved_vendors_user_phone_vendor_uidx IS
  'One saved row per customer phone + vendor (alongside unique(device_id, vendor_id)).';

-- ── 2. save_saved_vendor — advisory lock + max 20 + upsert-ish on conflict ──

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
DECLARE
  v_rl_type text;
  v_rl_id text;
  v_phone text;
  v_device text;
  v_nick text;
  v_count integer;
  v_existing uuid;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_phone := NULLIF(btrim(COALESCE(p_user_phone, '')), '');
  v_device := NULLIF(btrim(COALESCE(p_device_id, '')), '');
  -- Empty / whitespace nickname = no custom label (UI falls back to shop_name).
  v_nick := COALESCE(btrim(COALESCE(p_nickname, '')), '');

  IF v_phone IS NOT NULL THEN
    v_rl_type := 'phone';
    v_rl_id := v_phone;
  ELSE
    v_rl_type := 'device_id';
    v_rl_id := v_device;
  END IF;

  IF NOT public.check_and_log_rate_limit('save_saved_vendor', v_rl_type, v_rl_id, 30, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- Serialize concurrent saves for this identity (same pattern class as khata FOR UPDATE).
  PERFORM pg_advisory_xact_lock(
    hashtext('save_saved_vendor:' || COALESCE(v_phone, v_device))
  );

  -- Already saved for this phone or this device?
  SELECT sv.id INTO v_existing
  FROM public.saved_vendors sv
  WHERE sv.vendor_id = p_vendor_id
    AND (
      (v_phone IS NOT NULL AND sv.user_phone = v_phone)
      OR (v_device IS NOT NULL AND sv.device_id = v_device)
    )
  ORDER BY COALESCE(sv.saved_at, sv.created_at) DESC NULLS LAST
  LIMIT 1
  FOR UPDATE;

  IF v_existing IS NOT NULL THEN
    UPDATE public.saved_vendors
    SET
      nickname = v_nick,
      category = COALESCE(NULLIF(btrim(COALESCE(p_category, '')), ''), category),
      user_phone = COALESCE(v_phone, user_phone),
      device_id = COALESCE(v_device, device_id),
      saved_at = now()
    WHERE id = v_existing;
    RETURN;
  END IF;

  -- Cap matches client MAX_SAVED_NEIGHBOURS / get_saved_vendors_count scope.
  SELECT count(*)::integer INTO v_count
  FROM public.saved_vendors sv
  WHERE (
    CASE
      WHEN v_phone IS NOT NULL
        THEN (sv.user_phone = v_phone OR (v_device IS NOT NULL AND sv.device_id = v_device))
      ELSE sv.device_id = v_device
    END
  );

  IF v_count >= 20 THEN
    RAISE EXCEPTION 'saved_vendors_limit_exceeded';
  END IF;

  IF v_device IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  INSERT INTO public.saved_vendors (device_id, vendor_id, category, nickname, user_phone)
  VALUES (
    v_device,
    p_vendor_id,
    COALESCE(NULLIF(btrim(COALESCE(p_category, '')), ''), 'Vendor'),
    v_nick,
    v_phone
  );
END;
$$;

COMMENT ON FUNCTION public.save_saved_vendor(uuid, text, text, text, text) IS
  'Save neighbour under OTP-off identity. Advisory-locked; max 20 rows; empty nickname = no custom label. Upserts if already saved for phone or device.';

REVOKE ALL ON FUNCTION public.save_saved_vendor(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_saved_vendor(uuid, text, text, text, text)
  TO anon, authenticated, service_role;

-- ── 3. update_saved_vendor_nickname ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_saved_vendor_nickname(
  p_vendor_id uuid,
  p_nickname text,
  p_device_id text DEFAULT NULL,
  p_user_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rl_type text;
  v_rl_id text;
  v_phone text;
  v_device text;
  v_nick text;
  v_updated integer;
BEGIN
  IF NOT public._customer_identity_ok(p_device_id, p_user_phone) THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  v_phone := NULLIF(btrim(COALESCE(p_user_phone, '')), '');
  v_device := NULLIF(btrim(COALESCE(p_device_id, '')), '');
  v_nick := COALESCE(btrim(COALESCE(p_nickname, '')), '');

  IF v_phone IS NOT NULL THEN
    v_rl_type := 'phone';
    v_rl_id := v_phone;
  ELSE
    v_rl_type := 'device_id';
    v_rl_id := v_device;
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'update_saved_vendor_nickname', v_rl_type, v_rl_id, 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  UPDATE public.saved_vendors sv
  SET nickname = v_nick, saved_at = now()
  WHERE sv.vendor_id = p_vendor_id
    AND (
      (v_phone IS NOT NULL AND sv.user_phone = v_phone)
      OR (v_device IS NOT NULL AND sv.device_id = v_device)
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'not_found';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.update_saved_vendor_nickname(uuid, text, text, text) IS
  'Set or clear (empty string) a saved-neighbour nickname for the caller identity.';

REVOKE ALL ON FUNCTION public.update_saved_vendor_nickname(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_saved_vendor_nickname(uuid, text, text, text)
  TO anon, authenticated, service_role;
