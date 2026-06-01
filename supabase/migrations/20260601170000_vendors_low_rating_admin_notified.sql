alter table public.vendors
  add column if not exists low_rating_admin_notified boolean not null default false;
