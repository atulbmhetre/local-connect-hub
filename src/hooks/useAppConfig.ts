import { useEffect, useState } from "react";
import { supabase, type VendorSubscriptionAppConfig } from "@/lib/supabase";

export interface AppConfig extends VendorSubscriptionAppConfig {
  vendorTrialDays: number;
  subscriptionPriceInr: number;
  helpCallLimitSeconds: number;
  deliveryCallLimitSeconds: number;
  appointmentCallLimitSeconds: number;
  vendorStoppedDistanceMeters: number;
  vendorStoppedMinutes: number;
  maxOrderMessageChars: number;
  referralEnabled: boolean;
  localizationEnabled: boolean;
  langHindiEnabled: boolean;
  langMarathiEnabled: boolean;
  appBaseUrl: string;
  referralVendorCreditTotal: number;
  referralVendorCreditM1: number;
  referralVendorCreditM2: number;
  referralVendorCreditM3: number;
  referralUserCredit: number;
  referralVeteranThresholdMonths: number;
  helpAcceptTimeoutHours: number;
  aiCategoryConfidenceThreshold: number;
}

const DEFAULT_CONFIG: AppConfig = {
  payments_enabled: "false",
  vendor_subscription_price: "99",
  razorpay_key_id: "",
  vendorTrialDays: 30,
  subscriptionPriceInr: 99,
  helpCallLimitSeconds: 300,
  deliveryCallLimitSeconds: 120,
  appointmentCallLimitSeconds: 180,
  vendorStoppedDistanceMeters: 200,
  vendorStoppedMinutes: 10,
  maxOrderMessageChars: 200,
  referralEnabled: false,
  localizationEnabled: true,
  langHindiEnabled: true,
  langMarathiEnabled: true,
  appBaseUrl: "https://aaspaas.app",
  referralVendorCreditTotal: 25,
  referralVendorCreditM1: 8.34,
  referralVendorCreditM2: 8.34,
  referralVendorCreditM3: 8.32,
  referralUserCredit: 2.5,
  referralVeteranThresholdMonths: 12,
  helpAcceptTimeoutHours: 2,
  aiCategoryConfidenceThreshold: 0.85,
};

const BOOLEAN_KEYS = new Set<keyof AppConfig>([
  "referralEnabled",
  "localizationEnabled",
  "langHindiEnabled",
  "langMarathiEnabled",
]);

const STRING_KEYS = new Set<keyof AppConfig>([
  "appBaseUrl",
  "payments_enabled",
  "vendor_subscription_price",
  "razorpay_key_id",
]);

const DB_KEY_TO_CONFIG: Record<string, keyof AppConfig> = {
  vendor_trial_days: "vendorTrialDays",
  vendor_subscription_price: "subscriptionPriceInr",
  help_call_limit_seconds: "helpCallLimitSeconds",
  delivery_call_limit_seconds: "deliveryCallLimitSeconds",
  appointment_call_limit_seconds: "appointmentCallLimitSeconds",
  vendor_stopped_distance_meters: "vendorStoppedDistanceMeters",
  vendor_stopped_minutes: "vendorStoppedMinutes",
  max_order_message_chars: "maxOrderMessageChars",
  referral_enabled: "referralEnabled",
  localization_enabled: "localizationEnabled",
  lang_hindi_enabled: "langHindiEnabled",
  lang_marathi_enabled: "langMarathiEnabled",
  app_base_url: "appBaseUrl",
  referral_vendor_credit_total: "referralVendorCreditTotal",
  referral_vendor_credit_m1: "referralVendorCreditM1",
  referral_vendor_credit_m2: "referralVendorCreditM2",
  referral_vendor_credit_m3: "referralVendorCreditM3",
  referral_user_credit: "referralUserCredit",
  referral_veteran_threshold_months: "referralVeteranThresholdMonths",
  help_accept_timeout_hours: "helpAcceptTimeoutHours",
  ai_category_confidence_threshold: "aiCategoryConfidenceThreshold",
  payments_enabled: "payments_enabled",
  razorpay_key_id: "razorpay_key_id",
};

for (const key of Object.keys(DEFAULT_CONFIG) as (keyof AppConfig)[]) {
  DB_KEY_TO_CONFIG[key] = key;
}

type AppConfigRow = {
  key: string;
  value: string;
};

function parseConfigValue(field: keyof AppConfig, raw: string): boolean | number | string {
  const trimmed = raw.trim();
  if (BOOLEAN_KEYS.has(field)) {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return DEFAULT_CONFIG[field] as boolean;
  }
  if (STRING_KEYS.has(field)) {
    return trimmed || (DEFAULT_CONFIG[field] as string);
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : (DEFAULT_CONFIG[field] as number);
}

function rowsToConfig(rows: AppConfigRow[]): AppConfig {
  const config = { ...DEFAULT_CONFIG };
  for (const row of rows) {
    const field = DB_KEY_TO_CONFIG[row.key];
    if (!field) continue;
    const parsed = parseConfigValue(field, row.value);
    (config as Record<string, string | number | boolean>)[field] = parsed;
  }
  return config;
}

let cachedConfig: AppConfig | null = null;
let fetchPromise: Promise<AppConfig> | null = null;

async function loadAppConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig;
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    const { data, error } = await supabase.from("app_config").select("key, value");
    if (error || !data) {
      cachedConfig = DEFAULT_CONFIG;
      return DEFAULT_CONFIG;
    }
    cachedConfig = rowsToConfig(data as AppConfigRow[]);
    return cachedConfig;
  })();

  try {
    return await fetchPromise;
  } catch {
    cachedConfig = DEFAULT_CONFIG;
    return DEFAULT_CONFIG;
  } finally {
    fetchPromise = null;
  }
}

export function useAppConfig(): { config: AppConfig; loading: boolean } {
  const [config, setConfig] = useState<AppConfig>(cachedConfig ?? DEFAULT_CONFIG);
  const [loading, setLoading] = useState(cachedConfig === null);

  useEffect(() => {
    let cancelled = false;

    if (cachedConfig) {
      setConfig(cachedConfig);
      setLoading(false);
      return;
    }

    void loadAppConfig().then((loaded) => {
      if (!cancelled) {
        setConfig(loaded);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return { config, loading };
}
