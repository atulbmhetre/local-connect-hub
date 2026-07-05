-- Sync missing service-role RLS policy from PROD to TEST on user_notifications.
-- PROD already has this policy; TEST was missing it (environment drift found during
-- Session 65 audit). This is additive only — does not modify or replace the existing
-- user_notifications_owner policy, and does not change any application behavior,
-- since service-role connections already bypass RLS regardless of this policy.

create policy "Service role full access"
on public.user_notifications
for all
to public
using (auth.role() = 'service_role');
