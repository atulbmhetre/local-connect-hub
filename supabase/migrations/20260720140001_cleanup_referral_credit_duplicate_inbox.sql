-- One-time cleanup: referral_credit dual-write duplicates created BEFORE 2026-07-17.
-- Root cause fixed in process-vendor-referral (skip_inbox) on 2026-07-17 (commit 69b2978).
-- For each confirmed pair (same phone, title, body, vendor_id, created within 1 second),
-- keep the earlier row and delete the later one. Do not touch rows on/after 2026-07-17.

WITH ranked AS (
  SELECT
    n.id,
    n.created_at,
    LAG(n.id) OVER (
      PARTITION BY
        n.user_phone,
        n.title,
        n.body,
        COALESCE(n.route_params->>'vendor_id', '')
      ORDER BY n.created_at ASC, n.id ASC
    ) AS prev_id,
    LAG(n.created_at) OVER (
      PARTITION BY
        n.user_phone,
        n.title,
        n.body,
        COALESCE(n.route_params->>'vendor_id', '')
      ORDER BY n.created_at ASC, n.id ASC
    ) AS prev_created_at
  FROM public.user_notifications n
  WHERE n.type = 'referral_credit'
    AND n.created_at < TIMESTAMPTZ '2026-07-17 00:00:00+00'
),
dupes AS (
  SELECT id
  FROM ranked
  WHERE prev_id IS NOT NULL
    AND created_at - prev_created_at <= INTERVAL '1 second'
)
DELETE FROM public.user_notifications un
USING dupes
WHERE un.id = dupes.id;
