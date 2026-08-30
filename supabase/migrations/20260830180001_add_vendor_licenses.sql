-- Optional per-business license capture at registration (number + photo).
-- Filename requested as 20260830_add_vendor_licenses.sql; 14-digit prefix is
-- required so TEST applies this after today's already-pushed migrations.
-- RLS mirrors vendor_menu_items owner (vendor_id → vendors.phone = auth_user_phone()).
-- Storage path license-docs/% reuses anon+authenticated from upi-qr/%.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE TABLE IF NOT EXISTS public.vendor_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories (id) ON DELETE CASCADE,
  license_type text NOT NULL,
  license_number text NULL,
  photo_url text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_licenses_type_nonempty
    CHECK (char_length(btrim(license_type)) > 0),
  CONSTRAINT vendor_licenses_vendor_category_type_key
    UNIQUE (vendor_id, category_id, license_type)
);

COMMENT ON TABLE public.vendor_licenses IS
  'Optional license number + photo per vendor business (category). Not shown to customers.';

CREATE INDEX IF NOT EXISTS vendor_licenses_vendor_id_idx
  ON public.vendor_licenses (vendor_id);

ALTER TABLE public.vendor_licenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_licenses_owner ON public.vendor_licenses;
CREATE POLICY vendor_licenses_owner ON public.vendor_licenses
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

-- OTP-off / phone-match write path (same identity model as vendor_menu_items RPCs).

CREATE OR REPLACE FUNCTION public.vendor_upsert_licenses(
  p_vendor_id uuid,
  p_vendor_phone text,
  p_licenses jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_cat uuid;
  v_type text;
  v_number text;
  v_photo text;
BEGIN
  PERFORM public._assert_vendor_identity(p_vendor_id, p_vendor_phone);
  PERFORM public._assert_vendor_session_matches(p_vendor_id, p_vendor_phone);

  IF NOT public.check_and_log_rate_limit(
    'vendor_upsert_licenses', 'phone', btrim(p_vendor_phone), 30, 60
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_licenses, '[]'::jsonb))
  LOOP
    v_cat := NULLIF(v_item->>'category_id', '')::uuid;
    v_type := NULLIF(btrim(COALESCE(v_item->>'license_type', '')), '');
    v_number := NULLIF(btrim(COALESCE(v_item->>'license_number', '')), '');
    v_photo := NULLIF(btrim(COALESCE(v_item->>'photo_url', '')), '');

    IF v_cat IS NULL OR v_type IS NULL THEN
      CONTINUE;
    END IF;
    IF v_number IS NULL AND v_photo IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.vendor_licenses (
      vendor_id,
      category_id,
      license_type,
      license_number,
      photo_url
    )
    VALUES (
      p_vendor_id,
      v_cat,
      v_type,
      v_number,
      v_photo
    )
    ON CONFLICT (vendor_id, category_id, license_type)
    DO UPDATE SET
      license_number = COALESCE(EXCLUDED.license_number, public.vendor_licenses.license_number),
      photo_url = COALESCE(EXCLUDED.photo_url, public.vendor_licenses.photo_url),
      updated_at = now();
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.vendor_upsert_licenses(uuid, text, jsonb) IS
  'Vendor phone-match upsert of optional per-business licenses. Empty items are skipped.';

REVOKE ALL ON FUNCTION public.vendor_upsert_licenses(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_upsert_licenses(uuid, text, jsonb)
  TO anon, authenticated, service_role;

-- ── vendor-docs: license-docs/% (same roles as upi-qr/%) ─────────────────────

DROP POLICY IF EXISTS "Anon upload vendor docs license" ON storage.objects;
DROP POLICY IF EXISTS "Anon update vendor docs license" ON storage.objects;

CREATE POLICY "Anon upload vendor docs license"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (
  bucket_id = 'vendor-docs'
  AND name LIKE 'license-docs/%'
);

CREATE POLICY "Anon update vendor docs license"
ON storage.objects FOR UPDATE
TO anon, authenticated
USING (
  bucket_id = 'vendor-docs'
  AND name LIKE 'license-docs/%'
)
WITH CHECK (
  bucket_id = 'vendor-docs'
  AND name LIKE 'license-docs/%'
);

SET app.via_admin_rpc = 'true';
INSERT INTO public.app_config (key, value, description)
VALUES (
  'license_field_categories',
  '{"Pharmacy":["drug_license"],"Chemist":["drug_license"],"Grocery":["fssai"],"Kirana":["fssai"],"Restaurant":["fssai"],"Dhaba":["fssai"],"Clinic":["medical_registration"],"Doctor":["medical_registration"],"Hospital":["medical_registration"],"Salon":["shop_establishment"],"Beauty Parlour":["shop_establishment"]}',
  'Catalog label → license types shown as optional fields at vendor registration'
)
ON CONFLICT (key) DO UPDATE
SET
  description = EXCLUDED.description,
  value = CASE
    WHEN public.app_config.value IS NULL OR btrim(public.app_config.value) = ''
      THEN EXCLUDED.value
    ELSE public.app_config.value
  END;
RESET app.via_admin_rpc;
