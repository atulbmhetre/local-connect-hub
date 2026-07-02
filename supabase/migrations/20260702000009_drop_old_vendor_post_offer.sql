-- Drop stale 8-arg overload left behind after adding p_reach_radius_km.

DROP FUNCTION IF EXISTS public.vendor_post_offer(
  uuid,
  text,
  text,
  timestamptz,
  timestamptz,
  text,
  double precision,
  double precision
);
