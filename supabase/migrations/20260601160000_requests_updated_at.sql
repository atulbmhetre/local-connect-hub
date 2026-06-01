alter table public.requests
  add column if not exists updated_at timestamptz;

update public.requests
set updated_at = created_at
where updated_at is null;

alter table public.requests
  alter column updated_at set default now(),
  alter column updated_at set not null;

create or replace function public.set_requests_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists requests_set_updated_at on public.requests;
create trigger requests_set_updated_at
  before update on public.requests
  for each row
  execute function public.set_requests_updated_at();
