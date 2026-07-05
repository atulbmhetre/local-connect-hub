-- Generic rate-limiting infrastructure for edge functions.
-- Starting use case: suggest-category (calls paid Anthropic API, reachable anonymously).
-- Designed to be reused for other edge functions later by calling the same RPC
-- with a different function_name/limits — no new table needed per function.

create table if not exists public.edge_function_rate_limits (
  id bigint generated always as identity primary key,
  function_name text not null,
  identifier_type text not null check (identifier_type in ('device_id', 'ip')),
  identifier text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_rate_limits_lookup
  on public.edge_function_rate_limits (function_name, identifier_type, identifier, created_at);

alter table public.edge_function_rate_limits enable row level security;

create policy "Service role full access"
on public.edge_function_rate_limits
for all
to public
using (auth.role() = 'service_role');

-- No anon/authenticated policy — this table is written and read exclusively
-- by edge functions using the service role. Nothing in the client ever
-- queries this table directly.

create or replace function public.check_and_log_rate_limit(
  p_function_name text,
  p_identifier_type text,
  p_identifier text,
  p_max_requests int,
  p_window_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.edge_function_rate_limits
  where function_name = p_function_name
    and identifier_type = p_identifier_type
    and identifier = p_identifier
    and created_at > now() - make_interval(secs => p_window_seconds);

  if v_count >= p_max_requests then
    return false; -- blocked
  end if;

  insert into public.edge_function_rate_limits (function_name, identifier_type, identifier)
  values (p_function_name, p_identifier_type, p_identifier);

  return true; -- allowed
end;
$$;

grant execute on function public.check_and_log_rate_limit(text, text, text, int, int) to service_role;
