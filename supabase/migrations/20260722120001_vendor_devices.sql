-- vendor_devices: multi-device FCM push for vendors, mirroring user_devices.
-- vendors.fcm_token remains as a read fallback / mirror of the latest token
-- (kept in sync by upsert_vendor_device) so any code still reading the single
-- column keeps working during rollout.

CREATE TABLE IF NOT EXISTS public.vendor_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  fcm_token text,
  last_lat double precision,
  last_lng double precision,
  last_location_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, device_id)
);

CREATE INDEX IF NOT EXISTS vendor_devices_vendor_id_idx ON public.vendor_devices (vendor_id);
CREATE INDEX IF NOT EXISTS vendor_devices_fcm_token_idx ON public.vendor_devices (fcm_token);

-- ── backfill: migrate existing vendors.fcm_token into a 'legacy' device row ──
-- Without losing tokens: only inserts where a token exists, and is a no-op if
-- a legacy row already exists for that vendor (re-runnable migration).
INSERT INTO public.vendor_devices (vendor_id, device_id, fcm_token, updated_at)
SELECT v.id, 'legacy', v.fcm_token, now()
FROM public.vendors v
WHERE v.fcm_token IS NOT NULL
  AND trim(v.fcm_token) <> ''
ON CONFLICT (vendor_id, device_id) DO UPDATE
SET fcm_token = EXCLUDED.fcm_token,
    updated_at = now()
WHERE public.vendor_devices.fcm_token IS DISTINCT FROM EXCLUDED.fcm_token;

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Private — only the owning vendor sees its own device rows. Edge functions
-- (notify-vendor, FCM token save) use the service role and bypass RLS.
ALTER TABLE public.vendor_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_devices_vendor ON public.vendor_devices;
CREATE POLICY vendor_devices_vendor ON public.vendor_devices
  FOR ALL
  TO anon, authenticated
  USING (
    vendor_id IN (
      SELECT id FROM public.vendors WHERE phone = public.auth_user_phone()
    )
  )
  WITH CHECK (
    vendor_id IN (
      SELECT id FROM public.vendors WHERE phone = public.auth_user_phone()
    )
  );

-- ── upsert_vendor_device RPC (SECURITY DEFINER) ──────────────────────────
-- Mirrors upsert_user_device: clears the token from any other vendor/device
-- row (collision/reassignment), upserts on (vendor_id, device_id), and keeps
-- vendors.fcm_token mirrored to the latest token as a fallback single column.
CREATE OR REPLACE FUNCTION public.upsert_vendor_device(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_device_id text,
  p_fcm_token text,
  p_last_lat double precision DEFAULT NULL,
  p_last_lng double precision DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_device text;
  v_token text;
BEGIN
  IF p_vendor_id IS NULL THEN
    RAISE EXCEPTION 'vendor_id_required';
  END IF;
  IF p_vendor_phone IS NULL OR trim(p_vendor_phone) = '' THEN
    RAISE EXCEPTION 'identity_required';
  END IF;
  IF p_device_id IS NULL OR trim(p_device_id) = '' THEN
    RAISE EXCEPTION 'device_id_required';
  END IF;
  IF p_fcm_token IS NULL OR trim(p_fcm_token) = '' THEN
    RAISE EXCEPTION 'fcm_token_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors v
    WHERE v.id = p_vendor_id
      AND v.phone = trim(p_vendor_phone)
  ) THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  v_device := trim(p_device_id);
  v_token := trim(p_fcm_token);

  -- Same token must not remain on any other vendor/device row (collision / reassignment).
  UPDATE public.vendor_devices vd
  SET fcm_token = NULL, updated_at = now()
  WHERE vd.fcm_token = v_token
    AND NOT (vd.vendor_id = p_vendor_id AND vd.device_id = v_device);

  INSERT INTO public.vendor_devices (
    vendor_id,
    device_id,
    fcm_token,
    last_lat,
    last_lng,
    last_location_at,
    updated_at
  )
  VALUES (
    p_vendor_id,
    v_device,
    v_token,
    p_last_lat,
    p_last_lng,
    CASE
      WHEN p_last_lat IS NOT NULL AND p_last_lng IS NOT NULL THEN now()
      ELSE NULL
    END,
    now()
  )
  ON CONFLICT (vendor_id, device_id) DO UPDATE
  SET
    fcm_token = EXCLUDED.fcm_token,
    last_lat = COALESCE(EXCLUDED.last_lat, public.vendor_devices.last_lat),
    last_lng = COALESCE(EXCLUDED.last_lng, public.vendor_devices.last_lng),
    last_location_at = CASE
      WHEN EXCLUDED.last_lat IS NOT NULL AND EXCLUDED.last_lng IS NOT NULL THEN now()
      ELSE public.vendor_devices.last_location_at
    END,
    updated_at = now();

  -- Mirror the latest token onto vendors.fcm_token so any remaining single-column
  -- reads (fallback path) keep working during rollout.
  UPDATE public.vendors
  SET fcm_token = v_token
  WHERE id = p_vendor_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_vendor_device(uuid, text, text, text, double precision, double precision) IS
  'Upserts a vendor push-token device row (multi-device, keyed on vendor_id+device_id). Mirrors latest token onto vendors.fcm_token as a fallback.';

REVOKE ALL ON FUNCTION public.upsert_vendor_device(uuid, text, text, text, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_vendor_device(uuid, text, text, text, double precision, double precision)
  TO anon, authenticated, service_role;
