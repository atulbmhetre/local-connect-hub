-- Saved vendors (anonymous device_id) + Digital Parchi requests
-- Tables are idempotent if already created in the hosted project.

create table if not exists public.saved_vendors (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  vendor_id uuid not null references public.vendors (id) on delete cascade,
  category text not null,
  nickname text not null,
  created_at timestamptz not null default now(),
  unique (device_id, vendor_id)
);

create index if not exists saved_vendors_device_id_idx on public.saved_vendors (device_id);

create table if not exists public.requests (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  vendor_id uuid not null references public.vendors (id) on delete cascade,
  message text not null,
  status text not null default 'sent',
  created_at timestamptz not null default now()
);

create index if not exists requests_device_id_idx on public.requests (device_id);
create index if not exists requests_vendor_id_idx on public.requests (vendor_id);

alter table public.saved_vendors enable row level security;
alter table public.requests enable row level security;

-- Anonymous clients identify via device_id in the row; policies are permissive
-- (app always filters by device_id). Tighten later with RPC + service role if needed.

drop policy if exists "saved_vendors_select" on public.saved_vendors;
create policy "saved_vendors_select" on public.saved_vendors for select using (true);

drop policy if exists "saved_vendors_insert" on public.saved_vendors;
create policy "saved_vendors_insert" on public.saved_vendors for insert with check (true);

drop policy if exists "requests_insert" on public.requests;
create policy "requests_insert" on public.requests for insert with check (true);

drop policy if exists "requests_select" on public.requests;
create policy "requests_select" on public.requests for select using (true);
