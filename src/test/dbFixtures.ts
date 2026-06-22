/** Keys seeded by supabase/migrations/20260616000001_seed_app_config.sql */
export const SEEDED_APP_CONFIG_KEYS = [
  "help_accept_timeout_hours",
  "help_accept_timeout_minutes",
  "near_deadline_warning_minutes",
  "referral_enabled",
  "vendor_lead_notify_enabled",
  "localization_enabled",
  "lang_hindi_enabled",
  "lang_marathi_enabled",
  "ai_category_confidence_threshold",
  "app_base_url",
  "admin_phone",
  "khata_amber_limit",
  "vendor_stopped_distance_meters",
  "max_order_message_chars",
] as const;

export const SEEDED_BOOLEAN_KEYS = [
  "referral_enabled",
  "vendor_lead_notify_enabled",
  "localization_enabled",
  "lang_hindi_enabled",
  "lang_marathi_enabled",
] as const;

export const SEEDED_NUMBER_KEYS = [
  "help_accept_timeout_hours",
  "help_accept_timeout_minutes",
  "near_deadline_warning_minutes",
  "ai_category_confidence_threshold",
  "khata_amber_limit",
  "vendor_stopped_distance_meters",
  "max_order_message_chars",
] as const;

export const SEEDED_TEXT_KEYS = ["app_base_url", "admin_phone"] as const;

export const VALID_FEED_POST_TYPES = ["announcement", "recommendation", "offer"] as const;

export const VALID_APP_USER_LANGS = ["en", "hi", "mr", null] as const;
