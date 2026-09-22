-- related_id on user_notifications FK → requests(id).
-- Category review / referral credit must not store categories.id / referrals.id there.
-- Appointment-cancel copy: NEW.appointment_status = cancelled means a cancelled booking
-- even if that column did not change on this UPDATE (retry completing status→done).
-- Already-done retry: status is not DISTINCT FROM 'done' → no second ping.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

CREATE OR REPLACE FUNCTION public.notify_vendor_on_referral_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_phone text;
  v_title text;
  v_body text;
BEGIN
  IF NEW.referral_id IS NULL OR NEW.vendor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT NULLIF(btrim(phone), '') INTO v_phone FROM public.vendors WHERE id = NEW.vendor_id;
  IF v_phone IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT f.title, f.body INTO v_title, v_body
  FROM public.notification_i18n_format(
    'referral_credit',
    v_phone,
    jsonb_build_object('amount', COALESCE(NEW.amount, 2.5)::text)
  ) f;

  PERFORM public._vendor_inbox_and_fcm(
    NEW.vendor_id, v_title, v_body, 'referral_credit', 'vendor',
    jsonb_build_object('vendor_id', NEW.vendor_id, 'referral_id', NEW.referral_id),
    NULL, NULL, NEW.referral_id, false
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_vendor_on_category_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_title text;
  v_body text;
  v_key text;
  v_type text;
  v_phone text;
BEGIN
  IF NEW.suggested_by_vendor_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'active' AND COALESCE(OLD.status, '') IS DISTINCT FROM 'active' THEN
    v_key := 'category_approved';
    v_type := 'category_approved';
  ELSIF NEW.status = 'rejected' AND COALESCE(OLD.status, '') IS DISTINCT FROM 'rejected' THEN
    v_key := 'category_rejected';
    v_type := 'category_rejected';
  ELSE
    RETURN NEW;
  END IF;

  SELECT NULLIF(btrim(phone), '') INTO v_phone
  FROM public.vendors WHERE id = NEW.suggested_by_vendor_id;

  SELECT f.title, f.body INTO v_title, v_body
  FROM public.notification_i18n_format(
    v_key, COALESCE(v_phone, 'en'), jsonb_build_object('label', COALESCE(NEW.label, ''))
  ) f;

  PERFORM public._vendor_inbox_and_fcm(
    NEW.suggested_by_vendor_id, v_title, v_body, v_type, 'settings',
    jsonb_build_object('vendor_id', NEW.suggested_by_vendor_id, 'category_id', NEW.id),
    NULL, NULL, NULL, true
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_on_request_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_title text;
  v_body text;
  v_phone text := NULLIF(btrim(COALESCE(NEW.user_phone, '')), '');
  v_vendor_phone text;
  v_amount text;
  v_utr text;
  v_copy text;
  v_engaged_old boolean;
  v_has_appt boolean;
  v_same_day boolean;
  v_customer text;
  v_ref_date date;
BEGIN
  v_engaged_old := (
    OLD.status IN ('accepted', 'fulfilled')
    OR COALESCE(OLD.appointment_status, '') = 'confirmed'
  );

  IF NEW.appointment_status IS DISTINCT FROM OLD.appointment_status
     AND NEW.appointment_status = 'confirmed'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format('appt_confirmed', v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );

  ELSIF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'accepted'
     AND OLD.status = 'sent'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format('order_accepted_help', v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_accepted', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );

  ELSIF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'accepted'
     AND OLD.status = 'seen'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format('order_accepted_delivery', v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'fulfilled'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format('order_fulfilled', v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
     AND NEW.payment_status = 'confirmed'
     AND v_phone IS NOT NULL THEN
    SELECT COALESCE(round(ob.total_amount::numeric, 2)::text, '')
    INTO v_amount
    FROM public.order_bills ob
    WHERE ob.request_id = NEW.id
    ORDER BY ob.created_at DESC NULLS LAST
    LIMIT 1;
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'payment_confirmed', v_phone, jsonb_build_object('amount', COALESCE(v_amount, ''))
    ) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'payment_confirmed', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
     AND NEW.payment_status = 'disputed'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format('payment_disputed', v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'payment_disputed', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
     AND NEW.payment_status = 'claimed' THEN
    SELECT NULLIF(btrim(phone), '') INTO v_vendor_phone FROM public.vendors WHERE id = NEW.vendor_id;
    SELECT COALESCE(to_char(round(ob.total_amount::numeric, 2), 'FM999999990.00'), '')
    INTO v_amount
    FROM public.order_bills ob
    WHERE ob.request_id = NEW.id
    ORDER BY ob.created_at DESC NULLS LAST
    LIMIT 1;
    v_utr := COALESCE(NULLIF(btrim(NEW.payment_utr), ''), '');
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'payment_claimed',
      COALESCE(v_vendor_phone, 'en'),
      jsonb_build_object('amount', COALESCE(v_amount, ''), 'utr', v_utr)
    ) f;
    PERFORM public._vendor_inbox_and_fcm(
      NEW.vendor_id, v_title, v_body, 'payment_claimed', 'vendor',
      jsonb_build_object('order_id', NEW.id), NEW.id, NEW.id, NULL, false
    );
  END IF;

  IF NEW.appointment_status IS DISTINCT FROM OLD.appointment_status
     AND NEW.appointment_status = 'declined'
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'appt_declined', v_phone,
      jsonb_build_object('reason', COALESCE(NULLIF(btrim(NEW.cancel_reason), ''), ''))
    ) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'cancelled'
     AND NULLIF(btrim(NEW.cancel_reason), '') IS NOT NULL
     AND v_phone IS NOT NULL THEN
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'order_cancelled_vendor', v_phone,
      jsonb_build_object('reason', btrim(NEW.cancel_reason))
    ) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  IF OLD.vendor_started_at IS NULL AND NEW.vendor_started_at IS NOT NULL AND v_phone IS NOT NULL THEN
    IF NULLIF(btrim(NEW.delivery_slot), '') IS NOT NULL
       AND (NEW.appointment_time IS NULL OR btrim(COALESCE(NEW.appointment_time::text, '')) = '') THEN
      v_copy := 'ive_started_delivery';
    ELSIF NEW.delivery_slot IS NULL
       AND (NEW.appointment_time IS NULL OR btrim(COALESCE(NEW.appointment_time::text, '')) = '') THEN
      v_copy := 'ive_started_help';
    ELSE
      v_copy := 'ive_started_appointment';
    END IF;
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(v_copy, v_phone, '{}'::jsonb) f;
    PERFORM public._user_inbox_and_fcm(
      v_phone, v_title, v_body, 'order_update', 'my-orders',
      jsonb_build_object('order_id', NEW.id), NEW.id, NULL, false
    );
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'cancelled'
     AND NULLIF(btrim(COALESCE(NEW.cancel_reason, '')), '') IS NULL
     AND v_engaged_old THEN
    SELECT NULLIF(btrim(phone), '') INTO v_vendor_phone FROM public.vendors WHERE id = NEW.vendor_id;
    SELECT f.title, f.body INTO v_title, v_body
    FROM public.notification_i18n_format(
      'customer_cancelled', COALESCE(v_vendor_phone, 'en'), '{}'::jsonb
    ) f;
    PERFORM public._vendor_inbox_and_fcm(
      NEW.vendor_id, v_title, v_body, 'order_update', 'vendor',
      jsonb_build_object('order_id', NEW.id), NEW.id, NEW.id, NULL, false
    );
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'done'
     AND v_engaged_old THEN
    SELECT NULLIF(btrim(phone), '') INTO v_vendor_phone FROM public.vendors WHERE id = NEW.vendor_id;
    IF COALESCE(NEW.appointment_status, '') = 'cancelled' THEN
      SELECT f.title, f.body INTO v_title, v_body
      FROM public.notification_i18n_format(
        'customer_cancelled', COALESCE(v_vendor_phone, 'en'), '{}'::jsonb
      ) f;
    ELSE
      SELECT f.title, f.body INTO v_title, v_body
      FROM public.notification_i18n_format(
        'customer_dismissed', COALESCE(v_vendor_phone, 'en'), '{}'::jsonb
      ) f;
    END IF;
    PERFORM public._vendor_inbox_and_fcm(
      NEW.vendor_id, v_title, v_body, 'order_update', 'vendor',
      jsonb_build_object('order_id', NEW.id), NEW.id, NEW.id, NULL, false
    );
  END IF;

  IF NEW.message IS DISTINCT FROM OLD.message
     AND COALESCE(NEW.is_edited, false) IS TRUE THEN
    SELECT NULLIF(btrim(phone), '') INTO v_vendor_phone FROM public.vendors WHERE id = NEW.vendor_id;
    IF v_vendor_phone IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.user_notifications n
      WHERE n.user_phone = v_vendor_phone
        AND n.type = 'order_update'
        AND n.created_at > now() - interval '2 minutes'
    ) THEN
      v_has_appt := NEW.appointment_time IS NOT NULL
        AND btrim(COALESCE(NEW.appointment_time::text, '')) <> '';
      v_ref_date := CASE
        WHEN v_has_appt THEN (NEW.appointment_time AT TIME ZONE 'UTC')::date
        ELSE (NEW.created_at AT TIME ZONE 'UTC')::date
      END;
      v_same_day := (v_ref_date = (now() AT TIME ZONE 'UTC')::date);
      v_customer := COALESCE(NULLIF(btrim(NEW.user_phone), ''), 'Customer');
      IF v_has_appt AND v_same_day THEN
        v_copy := 'order_edited_same_day_appt';
      ELSIF v_has_appt THEN
        v_copy := 'order_edited_appt';
      ELSIF v_same_day THEN
        v_copy := 'order_edited_same_day';
      ELSE
        v_copy := 'order_edited';
      END IF;
      SELECT f.title, f.body INTO v_title, v_body
      FROM public.notification_i18n_format(
        v_copy, COALESCE(v_vendor_phone, 'en'),
        jsonb_build_object('customer', v_customer)
      ) f;
      PERFORM public._vendor_inbox_and_fcm(
        NEW.vendor_id, v_title, v_body, 'order_update', 'vendor',
        jsonb_build_object('order_id', NEW.id), NEW.id, NEW.id, NULL, false
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_on_request_lifecycle() IS
  'AFTER UPDATE on requests. Dismiss→done uses customer_cancelled when NEW.appointment_status is cancelled (including retry where it was already cancelled); otherwise customer_dismissed. related_id is the request id.';

COMMENT ON FUNCTION public.notify_vendor_on_referral_credit() IS
  'AFTER INSERT vendor_credits. p_related_id NULL (FK is requests); referral_id in route_params and p_referral_id.';

COMMENT ON FUNCTION public.notify_vendor_on_category_review() IS
  'AFTER UPDATE on categories. p_related_id NULL; category_id in route_params.';
