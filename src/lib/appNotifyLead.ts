import { isValidIndianMobile, normalizePhoneDigits } from "@/lib/phoneOtpEnabled";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParsedAppNotifyContact =
  | { ok: true; contact: string; kind: "phone" | "email" }
  | { ok: false };

export function parseAppNotifyContact(raw: string): ParsedAppNotifyContact {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false };

  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false };
    return { ok: true, contact: email, kind: "email" };
  }

  const digits = normalizePhoneDigits(trimmed);
  if (!isValidIndianMobile(digits)) return { ok: false };
  return { ok: true, contact: digits, kind: "phone" };
}

export type SubmitAppNotifyLeadResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "error" };

export async function submitAppNotifyLead(
  raw: string,
): Promise<SubmitAppNotifyLeadResult> {
  const parsed = parseAppNotifyContact(raw);
  if (!parsed.ok) return { ok: false, reason: "invalid" };

  try {
    const { supabase } = await import("@/lib/supabase");
    const { data, error } = await supabase.rpc("submit_app_notify_lead", {
      p_contact: parsed.contact,
    });
    if (error) {
      console.warn("submit_app_notify_lead", error);
      return { ok: false, reason: "error" };
    }
    // Missing RPC / unexpected payload must not look like a saved lead.
    if (data === false) return { ok: false, reason: "invalid" };
    if (data !== true) {
      console.warn("submit_app_notify_lead unexpected result", data);
      return { ok: false, reason: "error" };
    }
    return { ok: true };
  } catch (err) {
    console.warn("submit_app_notify_lead failed", err);
    return { ok: false, reason: "error" };
  }
}
