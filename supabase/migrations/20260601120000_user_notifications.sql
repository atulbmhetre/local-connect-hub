-- In-app notification inbox (complements FCM push; best-effort inserts from client)
create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_phone text not null,
  type text not null,
  title text not null,
  body text not null,
  route text,
  route_params jsonb,
  is_informational boolean not null default false,
  is_read boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_notifications_user_phone_created_idx
  on public.user_notifications (user_phone, created_at desc);

alter table public.user_notifications enable row level security;

drop policy if exists "user_notifications_select" on public.user_notifications;
create policy "user_notifications_select" on public.user_notifications for select using (true);

drop policy if exists "user_notifications_insert" on public.user_notifications;
create policy "user_notifications_insert" on public.user_notifications for insert with check (true);

drop policy if exists "user_notifications_update" on public.user_notifications;
create policy "user_notifications_update" on public.user_notifications for update using (true);
