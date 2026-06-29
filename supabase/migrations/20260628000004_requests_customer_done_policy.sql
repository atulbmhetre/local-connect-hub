-- Allow customer to mark their own request as done (dismiss).
-- Phase C dropped the open update policy — customers lost ability to dismiss orders.
-- This restores it narrowly: only status = 'done', only own requests.
CREATE POLICY requests_customer_mark_done ON public.requests
  FOR UPDATE
  TO anon, authenticated
  USING (
    user_phone = public.auth_user_phone()
    OR device_id = current_setting('request.headers', true)::json->>'x-device-id'
  )
  WITH CHECK (
    status = 'done'
  );
