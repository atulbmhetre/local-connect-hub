-- R7: fulfilled_at timestamp + delivery on_time_rate recalculation.

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS on_time_rate numeric;

CREATE OR REPLACE FUNCTION public.set_request_fulfilled_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'fulfilled' AND (OLD.status IS DISTINCT FROM 'fulfilled') THEN
    NEW.fulfilled_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_fulfilled_at ON public.requests;
CREATE TRIGGER trg_set_fulfilled_at
  BEFORE UPDATE ON public.requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_request_fulfilled_at();

CREATE OR REPLACE FUNCTION public.recalculate_vendor_on_time_rate(p_vendor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer;
  v_on_time integer;
  v_rate numeric;
BEGIN
  SELECT count(*) INTO v_total
  FROM public.requests
  WHERE vendor_id = p_vendor_id
    AND status = 'fulfilled'
    AND delivery_slot_deadline IS NOT NULL
    AND fulfilled_at IS NOT NULL;

  IF v_total = 0 THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_on_time
  FROM public.requests
  WHERE vendor_id = p_vendor_id
    AND status = 'fulfilled'
    AND delivery_slot_deadline IS NOT NULL
    AND fulfilled_at IS NOT NULL
    AND fulfilled_at <= delivery_slot_deadline;

  v_rate := round((v_on_time::numeric / v_total::numeric) * 100, 1);

  UPDATE public.vendors
  SET on_time_rate = v_rate
  WHERE id = p_vendor_id;
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_vendor_on_time_rate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recalculate_vendor_on_time_rate(uuid) TO anon, authenticated;
