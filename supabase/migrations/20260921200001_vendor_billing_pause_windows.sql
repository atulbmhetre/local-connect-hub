-- Account billing-freeze windows + trial pause credit.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz
-- Requires Phase 1 (20260921180001). Days use timestamptz elapsed / 86400, not calendar dates.

-- ── 1. vendors.pause_credit_days ─────────────────────────────────────────────

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS pause_credit_days integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.vendors.pause_credit_days IS
  'Accumulated qualifying fully-paused days added to the trial length. Not vendor-writable.';

-- Block vendor_update_own self-patch (same list as subscription_status / grace_ends_at).
DO $guard$
DECLARE
  def text;
  oid_found oid;
  updated text;
BEGIN
  SELECT p.oid
  INTO oid_found
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'vendor_update_own'
    AND p.pronargs = 3
  ORDER BY p.oid
  LIMIT 1;

  IF oid_found IS NULL THEN
    RAISE EXCEPTION 'vendor_update_own missing';
  END IF;

  def := pg_get_functiondef(oid_found);
  IF position('pause_credit_days' IN def) > 0 THEN
    RETURN;
  END IF;

  updated := regexp_replace(
    def,
    $re$p_patch \? 'grace_ends_at'$re$,
    $re$p_patch ? 'grace_ends_at'
     OR p_patch ? 'pause_credit_days'$re$,
    1,
    1
  );

  IF updated IS NULL OR updated = def THEN
    RAISE EXCEPTION 'failed to inject pause_credit_days into vendor_update_own field_not_allowed';
  END IF;

  EXECUTE updated;
END;
$guard$;

-- ── 2. vendor_billing_pauses ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vendor_billing_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors (id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  days integer NOT NULL DEFAULT 0,
  credited_days integer NOT NULL DEFAULT 0,
  qualified boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.vendor_billing_pauses IS
  'Account-level fully-paused billing windows. Written only by _sync_vendor_billing_pause.';

CREATE UNIQUE INDEX IF NOT EXISTS vendor_billing_pauses_open_uidx
  ON public.vendor_billing_pauses (vendor_id)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS vendor_billing_pauses_vendor_ended_idx
  ON public.vendor_billing_pauses (vendor_id, ended_at DESC NULLS FIRST);

ALTER TABLE public.vendor_billing_pauses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_billing_pauses_owner_read ON public.vendor_billing_pauses;
CREATE POLICY vendor_billing_pauses_owner_read ON public.vendor_billing_pauses
  FOR SELECT
  TO anon, authenticated
  USING (
    vendor_id IN (
      SELECT v.id FROM public.vendors v WHERE v.phone = public.auth_user_phone()
    )
  );

REVOKE ALL ON public.vendor_billing_pauses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.vendor_billing_pauses TO anon, authenticated;
GRANT ALL ON public.vendor_billing_pauses TO service_role, postgres;

-- ── 3. Effective trial end ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendor_effective_trial_end(p_vendor_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_created timestamptz;
  v_credit integer;
  v_trial integer;
BEGIN
  SELECT v.created_at, COALESCE(v.pause_credit_days, 0)
  INTO v_created, v_credit
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  IF v_created IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(NULLIF(trim(value), '')::integer, 30)
  INTO v_trial
  FROM public.app_config
  WHERE key = 'vendor_trial_days';
  v_trial := COALESCE(v_trial, 30);

  RETURN v_created
    + (v_trial::text || ' days')::interval
    + (v_credit::text || ' days')::interval;
END;
$$;

COMMENT ON FUNCTION public.vendor_effective_trial_end(uuid) IS
  'Trial end = vendors.created_at + vendor_trial_days + pause_credit_days. Does not read trial_ends_at.';

REVOKE ALL ON FUNCTION public.vendor_effective_trial_end(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_effective_trial_end(uuid)
  TO anon, authenticated, service_role;

-- ── 4. Sync fully-paused windows ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._vendor_account_is_fully_paused(p_vendor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND vc.status = 'approved'
      AND COALESCE(vc.is_paused, false) = false
  );
$$;

CREATE OR REPLACE FUNCTION public._sync_vendor_billing_pause(p_vendor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fully boolean;
  v_open_id uuid;
  v_started timestamptz;
  v_ended timestamptz;
  v_days integer;
  v_min_credit integer;
  v_min_live integer;
  v_prev_ended timestamptz;
  v_qualified boolean;
  v_credited integer;
  v_reason text;
BEGIN
  IF p_vendor_id IS NULL THEN
    RETURN jsonb_build_object(
      'credited_days', 0,
      'window_days', 0,
      'qualified', false,
      'reason', 'no_open_window'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.vendors v WHERE v.id = p_vendor_id) THEN
    RETURN jsonb_build_object(
      'credited_days', 0,
      'window_days', 0,
      'qualified', false,
      'reason', 'no_open_window'
    );
  END IF;

  PERFORM 1 FROM public.vendors v WHERE v.id = p_vendor_id FOR UPDATE;

  SELECT COALESCE(NULLIF(trim(value), '')::integer, 7)
  INTO v_min_credit
  FROM public.app_config
  WHERE key = 'pause_min_credit_days';
  v_min_credit := COALESCE(v_min_credit, 7);

  SELECT COALESCE(NULLIF(trim(value), '')::integer, 7)
  INTO v_min_live
  FROM public.app_config
  WHERE key = 'pause_min_live_days';
  v_min_live := COALESCE(v_min_live, 7);

  v_fully := public._vendor_account_is_fully_paused(p_vendor_id);

  SELECT w.id, w.started_at
  INTO v_open_id, v_started
  FROM public.vendor_billing_pauses w
  WHERE w.vendor_id = p_vendor_id
    AND w.ended_at IS NULL
  LIMIT 1;

  IF v_fully THEN
    IF v_open_id IS NULL THEN
      INSERT INTO public.vendor_billing_pauses (
        vendor_id, started_at, ended_at, days, credited_days, qualified
      )
      VALUES (p_vendor_id, now(), NULL, 0, 0, false);
    END IF;
    RETURN jsonb_build_object(
      'credited_days', 0,
      'window_days', 0,
      'qualified', false,
      'reason', 'no_open_window'
    );
  END IF;

  IF v_open_id IS NULL THEN
    RETURN jsonb_build_object(
      'credited_days', 0,
      'window_days', 0,
      'qualified', false,
      'reason', 'no_open_window'
    );
  END IF;

  -- Already closed (idempotent re-entry).
  -- (ended_at IS NULL was required to select v_open_id)

  v_ended := now();
  v_days := FLOOR(EXTRACT(EPOCH FROM (v_ended - v_started)) / 86400.0)::integer;
  IF v_days < 0 THEN
    v_days := 0;
  END IF;

  SELECT w.ended_at
  INTO v_prev_ended
  FROM public.vendor_billing_pauses w
  WHERE w.vendor_id = p_vendor_id
    AND w.qualified = true
    AND w.ended_at IS NOT NULL
    AND w.id IS DISTINCT FROM v_open_id
  ORDER BY w.ended_at DESC
  LIMIT 1;

  v_qualified := (v_days >= v_min_credit)
    AND (
      v_prev_ended IS NULL
      OR (v_started - v_prev_ended) >= (v_min_live::text || ' days')::interval
    );

  IF v_qualified THEN
    v_credited := v_days;
    v_reason := 'credited';
  ELSE
    v_credited := 0;
    IF v_days < v_min_credit THEN
      v_reason := 'below_min_credit_days';
    ELSE
      v_reason := 'below_min_live_days';
    END IF;
  END IF;

  UPDATE public.vendor_billing_pauses w
  SET
    ended_at = v_ended,
    days = v_days,
    credited_days = v_credited,
    qualified = v_qualified
  WHERE w.id = v_open_id
    AND w.ended_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'credited_days', 0,
      'window_days', 0,
      'qualified', false,
      'reason', 'no_open_window'
    );
  END IF;

  IF v_credited > 0 THEN
    PERFORM set_config('app.via_billing_pause_sync', 'true', true);
    UPDATE public.vendors v
    SET pause_credit_days = COALESCE(v.pause_credit_days, 0) + v_credited
    WHERE v.id = p_vendor_id;
  END IF;

  RETURN jsonb_build_object(
    'credited_days', v_credited,
    'window_days', v_days,
    'qualified', v_qualified,
    'reason', v_reason
  );
END;
$$;

COMMENT ON FUNCTION public._sync_vendor_billing_pause(uuid) IS
  'Idempotent: open a billing window when the account is fully paused; close and maybe credit when it is not.';

REVOKE ALL ON FUNCTION public._sync_vendor_billing_pause(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._vendor_account_is_fully_paused(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._sync_vendor_billing_pause(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._vendor_account_is_fully_paused(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._vendor_categories_billing_pause_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  v_id := COALESCE(NEW.vendor_id, OLD.vendor_id);
  PERFORM public._sync_vendor_billing_pause(v_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendor_categories_billing_pause_trg ON public.vendor_categories;
CREATE TRIGGER vendor_categories_billing_pause_trg
  AFTER INSERT OR DELETE OR UPDATE OF is_paused, status
  ON public.vendor_categories
  FOR EACH ROW
  EXECUTE FUNCTION public._vendor_categories_billing_pause_trg();

-- ── 5. Resume outcome on vendor_update_category_profile ──────────────────────

DROP FUNCTION IF EXISTS public.vendor_update_category_profile(uuid, text, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.vendor_update_category_profile(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_category_id uuid,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fee numeric;
  v_min numeric;
  v_was_paused boolean;
  v_want_paused boolean;
  v_counts jsonb;
  v_help integer;
  v_delivery integer;
  v_appointment integer;
  v_sub text;
  v_is_resume boolean := false;
  v_open_id uuid;
  v_outcome jsonb := '{}'::jsonb;
  v_row public.vendor_billing_pauses%ROWTYPE;
  v_min_credit integer;
BEGIN
  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);

  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.vendors
    WHERE id = p_vendor_id AND phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF p_patch ? 'inspection_fee' THEN
    IF p_patch->>'inspection_fee' IS NULL OR btrim(p_patch->>'inspection_fee') = '' THEN
      v_fee := NULL;
    ELSE
      v_fee := (p_patch->>'inspection_fee')::numeric;
      IF v_fee IS NOT NULL AND v_fee <= 0 THEN
        v_fee := NULL;
      END IF;
      IF v_fee IS NOT NULL AND v_fee > 99999 THEN
        RAISE EXCEPTION 'inspection_fee_invalid';
      END IF;
    END IF;
  END IF;

  IF p_patch ? 'min_delivery_order_amount' THEN
    IF p_patch->>'min_delivery_order_amount' IS NULL
       OR btrim(p_patch->>'min_delivery_order_amount') = '' THEN
      v_min := NULL;
    ELSE
      v_min := (p_patch->>'min_delivery_order_amount')::numeric;
      IF v_min IS NOT NULL AND v_min <= 0 THEN
        v_min := NULL;
      END IF;
      IF v_min IS NOT NULL AND v_min > 99999 THEN
        RAISE EXCEPTION 'min_delivery_order_amount_invalid';
      END IF;
    END IF;
  END IF;

  SELECT COALESCE(vc.is_paused, false)
  INTO v_was_paused
  FROM public.vendor_categories vc
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = p_category_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  IF p_patch ? 'is_paused' THEN
    v_want_paused := COALESCE((p_patch->>'is_paused')::boolean, false);
    IF v_want_paused = true AND COALESCE(v_was_paused, false) = false THEN
      v_counts := public._vendor_business_open_work_counts(p_vendor_id, p_category_id);
      v_help := COALESCE((v_counts->>'help')::integer, 0);
      v_delivery := COALESCE((v_counts->>'delivery')::integer, 0);
      v_appointment := COALESCE((v_counts->>'appointment')::integer, 0);
      IF (v_help + v_delivery + v_appointment) > 0 THEN
        RAISE EXCEPTION 'pause_blocked_open_work'
          USING DETAIL = jsonb_build_object(
            'help', v_help,
            'delivery', v_delivery,
            'appointment', v_appointment
          )::text;
      END IF;

      SELECT v.subscription_status
      INTO v_sub
      FROM public.vendors v
      WHERE v.id = p_vendor_id
      LIMIT 1;

      IF v_sub IN ('grace', 'expired') THEN
        RAISE EXCEPTION 'pause_blocked_subscription'
          USING DETAIL = jsonb_build_object(
            'subscription_status', v_sub,
            'help', v_help,
            'delivery', v_delivery,
            'appointment', v_appointment
          )::text;
      END IF;
    END IF;

    IF v_want_paused = false AND COALESCE(v_was_paused, false) = true THEN
      v_is_resume := true;
      SELECT w.id
      INTO v_open_id
      FROM public.vendor_billing_pauses w
      WHERE w.vendor_id = p_vendor_id
        AND w.ended_at IS NULL
      LIMIT 1;
    END IF;
  END IF;

  UPDATE public.vendor_categories vc
  SET
    brand_name = CASE
      WHEN p_patch ? 'brand_name' THEN NULLIF(trim(p_patch->>'brand_name'), '')
      ELSE vc.brand_name
    END,
    vendor_note = CASE
      WHEN p_patch ? 'vendor_note' THEN NULLIF(trim(p_patch->>'vendor_note'), '')
      ELSE vc.vendor_note
    END,
    serves_at_vendor_place = CASE
      WHEN p_patch ? 'serves_at_vendor_place' THEN (p_patch->>'serves_at_vendor_place')::boolean
      ELSE vc.serves_at_vendor_place
    END,
    serves_at_customer_place = CASE
      WHEN p_patch ? 'serves_at_customer_place' THEN (p_patch->>'serves_at_customer_place')::boolean
      ELSE vc.serves_at_customer_place
    END,
    service_radius_km = CASE
      WHEN p_patch ? 'service_radius_km' THEN (p_patch->>'service_radius_km')::numeric
      ELSE vc.service_radius_km
    END,
    is_paused = CASE
      WHEN p_patch ? 'is_paused' THEN COALESCE((p_patch->>'is_paused')::boolean, false)
      ELSE vc.is_paused
    END,
    inspection_fee = CASE
      WHEN p_patch ? 'inspection_fee' THEN v_fee
      ELSE vc.inspection_fee
    END,
    min_delivery_order_amount = CASE
      WHEN p_patch ? 'min_delivery_order_amount' THEN v_min
      ELSE vc.min_delivery_order_amount
    END
  WHERE vc.vendor_id = p_vendor_id
    AND vc.category_id = p_category_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_not_found';
  END IF;

  IF v_is_resume THEN
    IF v_open_id IS NULL THEN
      v_outcome := jsonb_build_object(
        'credited_days', 0,
        'window_days', 0,
        'qualified', false,
        'reason', 'no_open_window'
      );
    ELSE
      SELECT * INTO v_row
      FROM public.vendor_billing_pauses w
      WHERE w.id = v_open_id;

      SELECT COALESCE(NULLIF(trim(value), '')::integer, 7)
      INTO v_min_credit
      FROM public.app_config
      WHERE key = 'pause_min_credit_days';
      v_min_credit := COALESCE(v_min_credit, 7);

      v_outcome := jsonb_build_object(
        'credited_days', COALESCE(v_row.credited_days, 0),
        'window_days', COALESCE(v_row.days, 0),
        'qualified', COALESCE(v_row.qualified, false),
        'reason', CASE
          WHEN v_row.ended_at IS NULL THEN 'no_open_window'
          WHEN v_row.qualified THEN 'credited'
          WHEN COALESCE(v_row.days, 0) < v_min_credit THEN 'below_min_credit_days'
          ELSE 'below_min_live_days'
        END
      );
    END IF;
  END IF;

  RETURN v_outcome;
END;
$$;

COMMENT ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb) IS
  'Owner patch of per-business note/reach/pause/inspection_fee/min_delivery_order_amount. Returns {} except on resume, which returns credited_days/window_days/qualified/reason. Pause false->true refused when the business has open work or subscription is grace/expired.';

REVOKE ALL ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_update_category_profile(uuid, text, uuid, jsonb)
  TO anon, authenticated, service_role;
