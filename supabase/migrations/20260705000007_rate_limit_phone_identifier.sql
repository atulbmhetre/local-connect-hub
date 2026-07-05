-- Extend rate-limiting to support phone-based identifiers (for register_vendor RPC).
-- Additive only — existing device_id/ip rows and behavior unchanged.
--
-- Original table used an inline column check (not a separately named constraint).
-- PostgreSQL auto-names that: edge_function_rate_limits_identifier_type_check

alter table public.edge_function_rate_limits
  drop constraint if exists edge_function_rate_limits_identifier_type_check;

alter table public.edge_function_rate_limits
  add constraint edge_function_rate_limits_identifier_type_check
  check (identifier_type in ('device_id', 'ip', 'phone'));
