-- Customers can read bill edit audit for bills on their own orders.

CREATE POLICY bill_edit_audit_customer_select ON public.bill_edit_audit
  FOR SELECT
  TO anon, authenticated
  USING (
    bill_id IN (
      SELECT ob.id
      FROM public.order_bills ob
      INNER JOIN public.requests r ON r.id = ob.request_id
      WHERE r.user_phone = public.auth_user_phone()
    )
  );
