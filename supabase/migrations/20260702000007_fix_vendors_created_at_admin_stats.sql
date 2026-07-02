-- vendors.created_at for new-vendor stats (column missing on some envs).

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

UPDATE public.vendors
SET created_at = COALESCE(last_updated, now())
WHERE created_at IS NULL;

-- Re-apply stats RPC (uses vendors.created_at for new_vendors_this_week).
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats(p_admin_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_now timestamptz := now();
  v_start_of_today timestamptz;
  v_start_of_week timestamptz;
  v_stuck_cutoff timestamptz;
  v_total_orders integer;
  v_orders_today integer;
  v_orders_this_week integer;
  v_total_vendors integer;
  v_total_customers integer;
  v_stuck_orders integer;
  v_active_vendors_today integer;
  v_new_vendors_this_week integer;
  v_unverified_vendors integer;
  v_risky_users integer;
  v_total_referrals integer;
  v_avg_vendor_rating numeric;
BEGIN
  v_phone := NULLIF(trim(p_admin_phone), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'identity_required';
  END IF;

  IF NOT public.is_admin_phone(v_phone) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  v_start_of_today := date_trunc('day', v_now AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  v_start_of_week := v_start_of_today - interval '7 days';
  v_stuck_cutoff := v_now - interval '48 hours';

  SELECT count(*)::integer INTO v_total_orders FROM public.requests;
  SELECT count(*)::integer INTO v_orders_today
  FROM public.requests WHERE created_at >= v_start_of_today;
  SELECT count(*)::integer INTO v_orders_this_week
  FROM public.requests WHERE created_at >= v_start_of_week;

  SELECT count(*)::integer INTO v_total_vendors FROM public.vendors;
  SELECT count(*)::integer INTO v_total_customers FROM public.app_users;
  SELECT count(*)::integer INTO v_stuck_orders
  FROM public.requests
  WHERE status IN ('sent', 'accepted') AND created_at < v_stuck_cutoff;
  SELECT count(*)::integer INTO v_active_vendors_today
  FROM public.vendors
  WHERE is_active = true AND last_updated >= v_start_of_today;
  SELECT count(*)::integer INTO v_new_vendors_this_week
  FROM public.vendors WHERE created_at >= v_start_of_week;
  SELECT count(*)::integer INTO v_unverified_vendors
  FROM public.vendors WHERE is_manual_verified = false;
  SELECT count(*)::integer INTO v_risky_users
  FROM public.users WHERE trust_score < 25 AND is_banned = false;
  SELECT count(*)::integer INTO v_total_referrals FROM public.referrals;

  SELECT round(avg(avg_rating)::numeric, 1) INTO v_avg_vendor_rating
  FROM public.vendors
  WHERE avg_rating > 0 AND is_active = true;

  RETURN jsonb_build_object(
    'total_orders', COALESCE(v_total_orders, 0),
    'orders_today', COALESCE(v_orders_today, 0),
    'orders_this_week', COALESCE(v_orders_this_week, 0),
    'total_vendors', COALESCE(v_total_vendors, 0),
    'total_customers', COALESCE(v_total_customers, 0),
    'stuck_orders', COALESCE(v_stuck_orders, 0),
    'active_vendors_today', COALESCE(v_active_vendors_today, 0),
    'new_vendors_this_week', COALESCE(v_new_vendors_this_week, 0),
    'unverified_vendors', COALESCE(v_unverified_vendors, 0),
    'risky_users', COALESCE(v_risky_users, 0),
    'total_referrals', COALESCE(v_total_referrals, 0),
    'avg_vendor_rating', COALESCE(v_avg_vendor_rating, 0)
  );
END;
$$;
