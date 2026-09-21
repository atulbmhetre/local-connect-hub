export type PauseOpenWorkCounts = {
  help: number;
  delivery: number;
  appointment: number;
};

export type VendorPausePreflight = {
  can_pause: boolean;
  block_reason: "open_work" | "subscription_state" | string | null;
  open_work: PauseOpenWorkCounts;
  khata: { pending_amount: number; customer_count: number };
  upi_claims_pending: number;
  subscription_status: string | null;
  will_freeze_billing: boolean;
  pause_min_credit_days: number;
};

export type PauseResumeOutcome = {
  credited_days?: number;
  window_days?: number;
  qualified?: boolean;
  reason?: string | null;
};

export function fillPauseTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{${key}}`,
  );
}

export function parseVendorPausePreflight(raw: unknown): VendorPausePreflight | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const open = (row.open_work ?? {}) as Record<string, unknown>;
  const khata = (row.khata ?? {}) as Record<string, unknown>;
  return {
    can_pause: row.can_pause === true,
    block_reason: (row.block_reason as VendorPausePreflight["block_reason"]) ?? null,
    open_work: {
      help: Number(open.help ?? 0) || 0,
      delivery: Number(open.delivery ?? 0) || 0,
      appointment: Number(open.appointment ?? 0) || 0,
    },
    khata: {
      pending_amount: Number(khata.pending_amount ?? 0) || 0,
      customer_count: Number(khata.customer_count ?? 0) || 0,
    },
    upi_claims_pending: Number(row.upi_claims_pending ?? 0) || 0,
    subscription_status: row.subscription_status != null ? String(row.subscription_status) : null,
    will_freeze_billing: row.will_freeze_billing === true,
    pause_min_credit_days: Number(row.pause_min_credit_days ?? 7) || 7,
  };
}

export function pauseErrorCode(err: unknown): "pause_blocked_open_work" | "pause_blocked_subscription" | null {
  const parts: string[] = [];
  if (typeof err === "string") parts.push(err);
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; details?: unknown; hint?: unknown };
    if (o.message != null) parts.push(String(o.message));
    if (o.details != null) parts.push(String(o.details));
    if (o.hint != null) parts.push(String(o.hint));
  }
  const blob = parts.join(" ");
  if (blob.includes("pause_blocked_open_work")) return "pause_blocked_open_work";
  if (blob.includes("pause_blocked_subscription")) return "pause_blocked_subscription";
  return null;
}

export function parsePauseErrorDetails(err: unknown): {
  help: number;
  delivery: number;
  appointment: number;
  subscription_status: string | null;
} {
  const empty = { help: 0, delivery: 0, appointment: 0, subscription_status: null as string | null };
  if (!err || typeof err !== "object") return empty;
  const details = (err as { details?: unknown }).details;
  if (details == null) return empty;
  let parsed: Record<string, unknown> = {};
  if (typeof details === "string") {
    try {
      parsed = JSON.parse(details) as Record<string, unknown>;
    } catch {
      return empty;
    }
  } else if (typeof details === "object") {
    parsed = details as Record<string, unknown>;
  }
  return {
    help: Number(parsed.help ?? 0) || 0,
    delivery: Number(parsed.delivery ?? 0) || 0,
    appointment: Number(parsed.appointment ?? 0) || 0,
    subscription_status:
      parsed.subscription_status != null ? String(parsed.subscription_status) : null,
  };
}

export function shouldShowPauseLedgerNote(preflight: VendorPausePreflight): boolean {
  return (
    preflight.khata.pending_amount > 0 ||
    preflight.khata.customer_count > 0 ||
    preflight.upi_claims_pending > 0
  );
}

export function formatPauseAmount(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

export function pausedSinceLabel(
  pausedAt: string | null | undefined,
  locale: string,
  template: string,
): string | null {
  if (!pausedAt) return null;
  const d = new Date(pausedAt);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return fillPauseTemplate(template, { date });
}

export function dateLocaleForLang(lang: string): string {
  if (lang === "hi") return "hi-IN";
  if (lang === "mr") return "mr-IN";
  return "en-IN";
}

type PauseCopy = {
  vendor_pause_blocked_grace: string;
  vendor_pause_blocked_expired: string;
  vendor_pause_blocked_subscription: string;
  vendor_pause_resume_credited: string;
  vendor_pause_resume_under_min: string;
  vendor_pause_resume_too_soon: string;
  vendor_unpause_saved: string;
};

export function subscriptionPauseBlockMessage(
  status: string | null | undefined,
  s: Pick<
    PauseCopy,
    | "vendor_pause_blocked_grace"
    | "vendor_pause_blocked_expired"
    | "vendor_pause_blocked_subscription"
  >,
): string {
  if (status === "grace") return s.vendor_pause_blocked_grace;
  if (status === "expired") return s.vendor_pause_blocked_expired;
  return s.vendor_pause_blocked_subscription;
}

export function resumePauseToast(
  outcome: PauseResumeOutcome | null | undefined,
  minDays: number,
  s: Pick<
    PauseCopy,
    | "vendor_pause_resume_credited"
    | "vendor_pause_resume_under_min"
    | "vendor_pause_resume_too_soon"
    | "vendor_unpause_saved"
  >,
): string {
  const credited = Number(outcome?.credited_days ?? 0);
  const days = Number(outcome?.window_days ?? 0);
  if (outcome?.qualified === true || credited > 0) {
    return fillPauseTemplate(s.vendor_pause_resume_credited, { X: credited });
  }
  if (outcome?.reason === "below_min_live_days") {
    return fillPauseTemplate(s.vendor_pause_resume_too_soon, { Y: days, N: minDays });
  }
  if (outcome?.reason === "below_min_credit_days" || days > 0) {
    return fillPauseTemplate(s.vendor_pause_resume_under_min, { Y: days, N: minDays });
  }
  return s.vendor_unpause_saved;
}

export function parseResumeOutcome(raw: unknown): PauseResumeOutcome | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (
    row.credited_days == null &&
    row.window_days == null &&
    row.qualified == null &&
    row.reason == null
  ) {
    return null;
  }
  return {
    credited_days: Number(row.credited_days ?? 0) || 0,
    window_days: Number(row.window_days ?? 0) || 0,
    qualified: row.qualified === true,
    reason: row.reason != null ? String(row.reason) : null,
  };
}
