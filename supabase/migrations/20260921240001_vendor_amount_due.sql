-- Phase 6: vendor_amount_due — single source of truth for waive-off maths.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz
-- Does not change razorpay-webhook or checkout charge behaviour.

CREATE OR REPLACE FUNCTION public.vendor_amount_due(p_vendor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_price_raw text;
  v_price_inr numeric;
  v_base numeric;
  v_months integer;
  v_pct numeric;
  v_amount numeric;
BEGIN
  IF p_vendor_id IS NULL THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.vendors v WHERE v.id = p_vendor_id) THEN
    RAISE EXCEPTION 'vendor_not_found';
  END IF;

  SELECT COALESCE(NULLIF(btrim(ac.value), ''), NULLIF(btrim(ac.default_value), ''), '99')
  INTO v_price_raw
  FROM public.app_config ac
  WHERE ac.key = 'vendor_subscription_price'
  LIMIT 1;

  BEGIN
    v_price_inr := NULLIF(v_price_raw, '')::numeric;
  EXCEPTION WHEN others THEN
    v_price_inr := NULL;
  END;

  IF v_price_inr IS NULL OR v_price_inr < 0 THEN
    v_price_inr := 99;
  END IF;

  v_base := ROUND(v_price_inr * 100, 0);
  IF v_base < 0 THEN
    v_base := 0;
  END IF;

  SELECT
    GREATEST(COALESCE(v.waiveoff_months_remaining, 0), 0),
    COALESCE(v.waiveoff_percent, 0)
  INTO v_months, v_pct
  FROM public.vendors v
  WHERE v.id = p_vendor_id;

  IF v_months <= 0 THEN
    v_pct := 0;
  ELSE
    v_pct := LEAST(GREATEST(v_pct, 0), 100);
  END IF;

  v_amount := ROUND(v_base * (100 - v_pct) / 100.0, 0);
  IF v_amount < 0 THEN
    v_amount := 0;
  END IF;
  IF v_amount > v_base THEN
    v_amount := v_base;
  END IF;

  RETURN jsonb_build_object(
    'amount_paise', v_amount::integer,
    'base_paise', v_base::integer,
    'waiveoff_percent', v_pct::integer,
    'months_remaining', v_months,
    'is_free', (v_amount = 0)
  );
END;
$$;

COMMENT ON FUNCTION public.vendor_amount_due(uuid) IS
  'Due subscription amount in paise from app_config.vendor_subscription_price and vendor waive-off columns. No client-supplied price or percent.';

REVOKE ALL ON FUNCTION public.vendor_amount_due(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_amount_due(uuid)
  TO anon, authenticated, service_role;
