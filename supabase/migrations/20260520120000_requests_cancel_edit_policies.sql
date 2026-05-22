-- Allow vendor to cancel their own orders
drop policy if exists "Vendor can cancel own orders" on public.requests;
create policy "Vendor can cancel own orders"
  on public.requests for update
  using (
    vendor_id = (
      select id from public.vendors
      where id::text = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  )
  with check (status = 'cancelled');

-- Allow user to update message on their own orders
drop policy if exists "User can edit own order message" on public.requests;
create policy "User can edit own order message"
  on public.requests for update
  using (user_phone = current_setting('request.jwt.claims', true)::json->>'phone')
  with check (status in ('sent', 'seen'));
