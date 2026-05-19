-- Allow clients to update request status (vendor: seen/done; user: done)
drop policy if exists "Anyone can update request status" on public.requests;
create policy "Anyone can update request status"
  on public.requests for update
  using (true)
  with check (true);
