-- related_id on user_notifications FK → requests. Do not pass vendor_id.

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
        NULL,
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
