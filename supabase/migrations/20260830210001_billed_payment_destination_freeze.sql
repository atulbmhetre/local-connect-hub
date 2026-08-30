-- Freeze UPI / QR / mobile-pay destinations at first intended stamp (UPI bill
-- create). intended_* still refreshes on payment-sheet open (hijack cluster).
-- Mobile pay is vendors.phone as {phone}@upi — not a per-business column.
-- TEST project-ref at write time: hhdylnhqdzfabsolwxdz

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS billed_upi_id text,
  ADD COLUMN IF NOT EXISTS billed_upi_qr_url text,
  ADD COLUMN IF NOT EXISTS billed_upi_payee_id text,
  ADD COLUMN IF NOT EXISTS billed_payment_phone text,
  ADD COLUMN IF NOT EXISTS billed_payment_snapshot_at timestamptz;

COMMENT ON COLUMN public.requests.billed_upi_id IS
  'UPI VPA frozen at first intended stamp (UPI bill create). Never overwritten by sheet-open.';
COMMENT ON COLUMN public.requests.billed_upi_qr_url IS
  'UPI QR URL frozen with billed_upi_id.';
COMMENT ON COLUMN public.requests.billed_upi_payee_id IS
  'Decoded QR payee frozen with billed_upi_id.';
COMMENT ON COLUMN public.requests.billed_payment_phone IS
  'vendors.phone frozen at first intended stamp; Pay mobile tab uses {phone}@upi.';
COMMENT ON COLUMN public.requests.billed_payment_snapshot_at IS
  'Set once when billed_* are frozen. Null = legacy row, skip the Pay-screen notice.';

CREATE OR REPLACE FUNCTION public._stamp_request_upi_payee(
  p_request_id uuid,
  p_kind text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vendor_id uuid;
  v_category_id uuid;
  v_mode text;
  v_upi_id text;
  v_upi_qr_url text;
  v_upi_payee_id text;
  v_payment_phone text;
BEGIN
  IF p_kind NOT IN ('intended', 'claimed') THEN
    RAISE EXCEPTION 'invalid_upi_snapshot_kind';
  END IF;

  SELECT r.vendor_id, r.category_id
  INTO v_vendor_id, v_category_id
  FROM public.requests r
  WHERE r.id = p_request_id;

  IF v_vendor_id IS NULL THEN
    RETURN;
  END IF;

  SELECT ob.payment_mode
  INTO v_mode
  FROM public.order_bills ob
  WHERE ob.request_id = p_request_id
    AND ob.payment_status IS DISTINCT FROM 'void'
  LIMIT 1;

  IF v_mode IS DISTINCT FROM 'upi' THEN
    IF p_kind = 'intended' THEN
      UPDATE public.requests
      SET
        intended_upi_id = NULL,
        intended_upi_qr_url = NULL,
        intended_upi_payee_id = NULL,
        billed_upi_id = NULL,
        billed_upi_qr_url = NULL,
        billed_upi_payee_id = NULL,
        billed_payment_phone = NULL,
        billed_payment_snapshot_at = NULL
      WHERE id = p_request_id;
    END IF;
    RETURN;
  END IF;

  IF v_category_id IS NOT NULL THEN
    SELECT
      NULLIF(btrim(vc.upi_id), ''),
      NULLIF(btrim(vc.upi_qr_url), ''),
      NULLIF(btrim(vc.upi_qr_payee_id), '')
    INTO v_upi_id, v_upi_qr_url, v_upi_payee_id
    FROM public.vendor_categories vc
    WHERE vc.vendor_id = v_vendor_id
      AND vc.category_id = v_category_id;
  END IF;

  SELECT NULLIF(btrim(v.phone), '')
  INTO v_payment_phone
  FROM public.vendors v
  WHERE v.id = v_vendor_id;

  IF p_kind = 'intended' THEN
    UPDATE public.requests
    SET
      intended_upi_id = v_upi_id,
      intended_upi_qr_url = v_upi_qr_url,
      intended_upi_payee_id = v_upi_payee_id,
      billed_upi_id = CASE
        WHEN billed_payment_snapshot_at IS NULL THEN v_upi_id
        ELSE billed_upi_id
      END,
      billed_upi_qr_url = CASE
        WHEN billed_payment_snapshot_at IS NULL THEN v_upi_qr_url
        ELSE billed_upi_qr_url
      END,
      billed_upi_payee_id = CASE
        WHEN billed_payment_snapshot_at IS NULL THEN v_upi_payee_id
        ELSE billed_upi_payee_id
      END,
      billed_payment_phone = CASE
        WHEN billed_payment_snapshot_at IS NULL THEN v_payment_phone
        ELSE billed_payment_phone
      END,
      billed_payment_snapshot_at = COALESCE(billed_payment_snapshot_at, now())
    WHERE id = p_request_id;
  ELSE
    UPDATE public.requests
    SET
      claimed_upi_id = v_upi_id,
      claimed_upi_qr_url = v_upi_qr_url,
      claimed_upi_payee_id = v_upi_payee_id
    WHERE id = p_request_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public._stamp_request_upi_payee(uuid, text) IS
  'Internal: snapshot vendor_categories UPI onto requests as intended or claimed. First intended stamp also freezes billed_* (UPI/QR/phone). Cash/khata skip claimed and clear intended + billed.';

REVOKE ALL ON FUNCTION public._stamp_request_upi_payee(uuid, text) FROM PUBLIC;
