-- Allow anon/authenticated clients to dismiss notifications from the inbox UI.
drop policy if exists "user_notifications_delete" on public.user_notifications;
create policy "user_notifications_delete" on public.user_notifications for delete using (true);
