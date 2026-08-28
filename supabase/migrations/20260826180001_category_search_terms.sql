-- DB-driven category search aliases (replaces hardcoded KNOWN_CATEGORIES for resolution).
-- Many-to-many: same term may map to multiple category_id rows.
-- Seeded from the former 85 static aliases (source=manual, status=active).
-- Apply to TEST first; do not push to PROD until verified.

CREATE TABLE IF NOT EXISTS public.category_search_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  term text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'proactive_ai', 'corrective_ai')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending_review')),
  confidence numeric(4, 2) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_search_terms_category_term_unique UNIQUE (category_id, term)
);

CREATE INDEX IF NOT EXISTS category_search_terms_term_lower_idx
  ON public.category_search_terms (lower(term));

CREATE INDEX IF NOT EXISTS category_search_terms_status_idx
  ON public.category_search_terms (status);

CREATE INDEX IF NOT EXISTS category_search_terms_category_id_idx
  ON public.category_search_terms (category_id);

COMMENT ON TABLE public.category_search_terms IS
  'Search aliases mapping to categories (many-to-many). Replaces static KNOWN_CATEGORIES for resolveCanonicalTerm.';

ALTER TABLE public.category_search_terms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS category_search_terms_public_read ON public.category_search_terms;
CREATE POLICY category_search_terms_public_read
  ON public.category_search_terms
  FOR SELECT
  TO anon, authenticated
  USING (status = 'active');

INSERT INTO public.category_search_terms (category_id, term, language, source, status)
SELECT c.id, v.term, 'en', 'manual', 'active'
FROM (VALUES
  ('Beautician', 'butisian'),
  ('Beautician', 'beautician'),
  ('Beautician', 'parlour'),
  ('Beautician', 'parlor'),
  ('Beautician', 'beauty'),
  ('Beautician', 'salon'),
  ('Beautician', 'therapist'),
  ('Beautician', 'therapy'),
  ('Beautician', 'massage'),
  ('Beautician', 'spa'),
  ('Beautician', 'beauty parlour'),
  ('Beautician', 'mehendi'),
  ('Beautician', 'makeup artist'),
  ('Beautician', 'nail art'),
  ('Beautician', 'facial'),
  ('Beautician', 'waxing'),
  ('Grocery Store', 'kirana'),
  ('Grocery Store', 'grocery'),
  ('Grocery Store', 'groceries'),
  ('Grocery Store', 'general store'),
  ('Grocery Store', 'dukan'),
  ('Grocery Store', 'dukkan'),
  ('Mechanic', 'mikanik'),
  ('Mechanic', 'mechanic'),
  ('Mechanic', 'garage'),
  ('Mechanic', 'engine'),
  ('Mechanic', 'car repair'),
  ('Mechanic', 'bike repair'),
  ('Towing', 'towing'),
  ('Towing', 'tow'),
  ('Towing', 'tow truck'),
  ('Towing', 'breakdown'),
  ('Towing', 'crane'),
  ('Tyre Service', 'tyre'),
  ('Tyre Service', 'tire'),
  ('Tyre Service', 'puncture'),
  ('Tyre Service', 'flat tyre'),
  ('Tyre Service', 'wheel'),
  ('Key Maker', 'key'),
  ('Key Maker', 'keymaker'),
  ('Key Maker', 'locksmith'),
  ('Key Maker', 'duplicate key'),
  ('Key Maker', 'lock'),
  ('Ambulance', 'ambulance'),
  ('Ambulance', 'emergency'),
  ('Ambulance', 'accident'),
  ('Ambulance', '108'),
  ('Pharmacy', 'dawai'),
  ('Pharmacy', 'dawa'),
  ('Pharmacy', 'medicine'),
  ('Pharmacy', 'pharmacy'),
  ('Pharmacy', 'chemist'),
  ('Pharmacy', 'medical'),
  ('Pharmacy', 'drug store'),
  ('Pharmacy', 'tablet'),
  ('Nursing', 'nurse'),
  ('Nursing', 'nursing'),
  ('Nursing', 'caretaker'),
  ('Nursing', 'home care'),
  ('Nursing', 'patient care'),
  ('Plumber', 'plumber'),
  ('Plumber', 'pipe'),
  ('Plumber', 'nal wala'),
  ('Plumber', 'water'),
  ('Plumber', 'plumbing'),
  ('Plumber', 'leak'),
  ('Plumber', 'tap'),
  ('Electrician', 'bijli'),
  ('Electrician', 'electrician'),
  ('Electrician', 'light wala'),
  ('Electrician', 'current wala'),
  ('Electrician', 'electric'),
  ('Electrician', 'wiring'),
  ('Electrician', 'fuse'),
  ('Electrician', 'power'),
  ('Electrician', 'current'),
  ('Security', 'security'),
  ('Security', 'guard'),
  ('Security', 'watchman'),
  ('Security', 'bouncer'),
  ('Fire Brigade', 'fire station'),
  ('Fire Brigade', 'fire brigade'),
  ('Fire Brigade', 'agni shaman'),
  ('Fire Brigade', 'agnishaman'),
  ('Fire Brigade', 'fire emergency')
) AS v(label, term)
JOIN public.categories c
  ON c.label = v.label
 AND COALESCE(c.is_active, false) = true
ON CONFLICT (category_id, term) DO NOTHING;
