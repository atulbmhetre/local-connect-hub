-- AI-powered category suggestion (R2)

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS ai_reasoning text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS suggestion_count integer NOT NULL DEFAULT 0;

-- Numeric confidence (legacy ai_confidence column remains text high/medium/low)
ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS ai_confidence_score numeric(4, 2);

UPDATE public.categories
SET status = 'pending_review'
WHERE status IS NULL AND COALESCE(pending_review, false) = true;

UPDATE public.categories
SET status = 'active'
WHERE status IS NULL AND is_active = true AND COALESCE(pending_review, false) = false;

UPDATE public.categories
SET status = 'rejected'
WHERE status IS NULL AND is_active = false AND COALESCE(pending_review, false) = false;

UPDATE public.categories
SET status = 'active'
WHERE status IS NULL;

ALTER TABLE public.categories
  DROP CONSTRAINT IF EXISTS categories_status_check;

ALTER TABLE public.categories
  ADD CONSTRAINT categories_status_check
  CHECK (status IN ('active', 'pending_review', 'rejected'));

ALTER TABLE public.categories
  ALTER COLUMN status SET DEFAULT 'active';

INSERT INTO public.app_config (key, value, description)
VALUES
  ('ai_category_confidence_threshold', '0.85', 'Auto-assign when AI confidence >= this (0-1)'),
  ('ai_category_model', 'claude-sonnet-4-20250514', 'Anthropic model for category suggestion')
ON CONFLICT (key) DO NOTHING;
