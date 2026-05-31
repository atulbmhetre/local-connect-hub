alter table public.user_notifications
  add column if not exists is_read boolean not null default false;

update public.user_notifications
set is_read = true
where read_at is not null and is_read = false;

create index if not exists user_notifications_unread_idx
  on public.user_notifications (user_phone, is_read, created_at desc)
  where is_read = false;
