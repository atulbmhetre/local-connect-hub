-- Add pending_review status to categories
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS pending_review boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS suggested_by_vendor_id uuid REFERENCES vendors(id),
  ADD COLUMN IF NOT EXISTS ai_confidence text;

-- Add admin FCM token to app_config for notifications
INSERT INTO app_config (key, value, description)
VALUES ('admin_fcm_token', '', 'Admin device FCM token for new category/vendor notifications')
ON CONFLICT (key) DO NOTHING;
