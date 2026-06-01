alter table public.requests
  add column if not exists previous_message text;

alter table public.requests
  add column if not exists is_edited boolean not null default false;
