-- KB-06: Per-vendor khata credit warning thresholds (amber / red).

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS khata_amber_limit numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS khata_red_limit numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.vendors.khata_amber_limit IS
  'Outstanding balance (₹) at which customer/vendor UI shows amber khata warning; 0 = khata credit disabled.';
COMMENT ON COLUMN public.vendors.khata_red_limit IS
  'Outstanding balance (₹) at which customer/vendor UI shows red khata warning; must be > khata_amber_limit when enabled.';
