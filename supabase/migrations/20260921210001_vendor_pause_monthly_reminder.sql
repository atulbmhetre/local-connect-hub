-- Monthly (interval) reminder while any business stays paused.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz
-- Requires Phase 1 (pause_reminder_interval_days, paused_at).

-- ── 1. vendors.pause_reminder_sent_at ────────────────────────────────────────

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS pause_reminder_sent_at timestamptz NULL;

COMMENT ON COLUMN public.vendors.pause_reminder_sent_at IS
  'Last pause-still-on reminder. Cleared when the account has no paused business. Not vendor-writable.';

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
  IF position('pause_reminder_sent_at' IN def) > 0 THEN
    RETURN;
  END IF;

  IF position('pause_credit_days' IN def) > 0 THEN
    updated := regexp_replace(
      def,
      $re$p_patch \? 'pause_credit_days'$re$,
      $re$p_patch ? 'pause_credit_days'
     OR p_patch ? 'pause_reminder_sent_at'$re$,
      1,
      1
    );
  ELSE
    updated := regexp_replace(
      def,
      $re$p_patch \? 'grace_ends_at'$re$,
      $re$p_patch ? 'grace_ends_at'
     OR p_patch ? 'pause_reminder_sent_at'$re$,
      1,
      1
    );
  END IF;

  IF updated IS NULL OR updated = def THEN
    RAISE EXCEPTION 'failed to inject pause_reminder_sent_at into vendor_update_own field_not_allowed';
  END IF;

  EXECUTE updated;
END;
$guard$;

-- ── 2. Reset sent_at when nothing is paused ──────────────────────────────────

CREATE OR REPLACE FUNCTION public._clear_pause_reminder_if_unpaused(p_vendor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_vendor_id IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = p_vendor_id
      AND COALESCE(vc.is_paused, false) = true
  ) THEN
    RETURN;
  END IF;

  UPDATE public.vendors v
  SET pause_reminder_sent_at = NULL
  WHERE v.id = p_vendor_id
    AND v.pause_reminder_sent_at IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public._vendor_categories_pause_reminder_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._clear_pause_reminder_if_unpaused(COALESCE(NEW.vendor_id, OLD.vendor_id));
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendor_categories_pause_reminder_trg ON public.vendor_categories;
CREATE TRIGGER vendor_categories_pause_reminder_trg
  AFTER INSERT OR DELETE OR UPDATE OF is_paused
  ON public.vendor_categories
  FOR EACH ROW
  EXECUTE FUNCTION public._vendor_categories_pause_reminder_trg();

REVOKE ALL ON FUNCTION public._clear_pause_reminder_if_unpaused(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._vendor_categories_pause_reminder_trg() FROM PUBLIC;

-- ── 3. i18n copy ─────────────────────────────────────────────────────────────

INSERT INTO public.notification_i18n (copy_key, lang, title, body)
VALUES
  (
    'vendor_paused_reminder',
    'en',
    'Your business is paused',
    'Your business is paused — customers can''t see you. Resume anytime.'
  ),
  (
    'vendor_paused_reminder',
    'hi',
    'आपका व्यवसाय पॉज़ है',
    'आपका व्यवसाय पॉज़ है — ग्राहक आपको नहीं देख सकते। कभी भी फिर शुरू करें।'
  ),
  (
    'vendor_paused_reminder',
    'mr',
    'तुमचा व्यवसाय पॉज आहे',
    'तुमचा व्यवसाय पॉज आहे — ग्राहक तुम्हाला पाहू शकत नाहीत. केव्हाही पुन्हा सुरू करा.'
  )
ON CONFLICT (copy_key, lang) DO UPDATE
SET title = EXCLUDED.title,
    body = EXCLUDED.body;

-- ── 4. Daily cron batch ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.remind_paused_vendors()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_interval interval;
  v_days integer;
  rec record;
  v_title text;
  v_body text;
  v_sent integer := 0;
  v_updated integer;
BEGIN
  SELECT COALESCE(NULLIF(trim(value), '')::integer, 30)
  INTO v_days
  FROM public.app_config
  WHERE key = 'pause_reminder_interval_days';
  v_days := COALESCE(v_days, 30);
  IF v_days < 1 THEN
    v_days := 30;
  END IF;
  v_interval := (v_days::text || ' days')::interval;

  FOR rec IN
    SELECT v.id, v.phone
    FROM public.vendors v
    WHERE NULLIF(btrim(COALESCE(v.phone, '')), '') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.vendor_categories vc
        WHERE vc.vendor_id = v.id
          AND COALESCE(vc.is_paused, false) = true
          AND vc.paused_at IS NOT NULL
      )
      AND (
        SELECT MIN(vc.paused_at)
        FROM public.vendor_categories vc
        WHERE vc.vendor_id = v.id
          AND COALESCE(vc.is_paused, false) = true
          AND vc.paused_at IS NOT NULL
      ) <= now() - v_interval
      AND (
        v.pause_reminder_sent_at IS NULL
        OR v.pause_reminder_sent_at <= now() - v_interval
      )
    FOR UPDATE OF v SKIP LOCKED
  LOOP
    BEGIN
      SELECT f.title, f.body
      INTO v_title, v_body
      FROM public.notification_i18n_format(
        'vendor_paused_reminder',
        rec.phone,
        '{}'::jsonb
      ) f;

      PERFORM public._vendor_inbox_and_fcm(
        rec.id,
        v_title,
        v_body,
        'vendor_paused_reminder',
        'settings',
        jsonb_build_object('vendor_id', rec.id),
        rec.id,
        NULL,
        NULL,
        false
      );

      UPDATE public.vendors v
      SET pause_reminder_sent_at = now()
      WHERE v.id = rec.id
        AND (
          v.pause_reminder_sent_at IS NULL
          OR v.pause_reminder_sent_at <= now() - v_interval
        );
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated > 0 THEN
        v_sent := v_sent + 1;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object('sent', v_sent);
END;
$$;

COMMENT ON FUNCTION public.remind_paused_vendors() IS
  'Daily cron: one inbox+push per vendor when any business has been paused at least pause_reminder_interval_days and no reminder was sent in that interval.';

REVOKE ALL ON FUNCTION public.remind_paused_vendors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remind_paused_vendors() TO service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'remind-paused-vendors';

SELECT cron.schedule(
  'remind-paused-vendors',
  '20 3 * * *',
  $$SELECT public.remind_paused_vendors();$$
);
