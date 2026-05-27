ALTER TABLE vendor_reviews
  ADD COLUMN IF NOT EXISTS vendor_response text,
  ADD COLUMN IF NOT EXISTS vendor_responded_at timestamptz;
