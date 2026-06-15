ALTER TABLE feed_posts
ADD COLUMN recommended_vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
ADD COLUMN recommended_vendor_name text,
ADD COLUMN recommended_vendor_phone text;

INSERT INTO app_config (key, value)
VALUES ('vendor_lead_notify_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
