/**
 * Delivery slot deadlines + cancel window opens.
 * Matches Postgres: `(day + time 'HH:00') AT TIME ZONE 'Asia/Kolkata'`
 * (`_delivery_slot_deadline_on`) and `delivery_slot_window_start`.
 *
 * Never use Date#setHours / getHours for slot math — those are device-local
 * and diverge from IST on non-India timezones.
 */

/** Business timezone for order slots (India; no DST). */
export const APP_TIME_ZONE = "Asia/Kolkata";

/** Fixed IST offset — Kolkata does not observe DST. */
export const IST_OFFSET = "+05:30";

export const DELIVERY_ASAP_OFFSET_MS = 2 * 60 * 60 * 1000;

/** Morning / afternoon / evening: window opens at deadline − 4h (SQL). */
export const DELIVERY_SLOT_WINDOW_BEFORE_DEADLINE_MS = 4 * 60 * 60 * 1000;

/** Tomorrow: window opens at deadline − 20h = midnight IST that calendar day (SQL). */
export const DELIVERY_SLOT_TOMORROW_WINDOW_BEFORE_DEADLINE_MS = 20 * 60 * 60 * 1000;

export type IstYmd = { year: number; month: number; day: number };

function partNumber(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  const raw = parts.find((p) => p.type === type)?.value;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`IST format missing part: ${type}`);
  }
  return n;
}

/** Calendar Y-M-D in Asia/Kolkata for an instant. */
export function getIstYmd(now: Date = new Date()): IstYmd {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return {
    year: partNumber(parts, "year"),
    month: partNumber(parts, "month"),
    day: partNumber(parts, "day"),
  };
}

/** Hour 0–23 in Asia/Kolkata for an instant (slot cutoffs). */
export function getIstHour(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return partNumber(parts, "hour");
}

/**
 * Wall-clock time in Asia/Kolkata → UTC ISO string.
 * Mirrors `(date + time) AT TIME ZONE 'Asia/Kolkata'`.
 */
export function zonedIstDateTimeToUtcIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): string {
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}${IST_OFFSET}`).toISOString();
}

function addIstCalendarDays(ymd: IstYmd, days: number): IstYmd {
  // Noon IST + N×24h stays on the intended calendar day (IST has no DST).
  const noon = new Date(zonedIstDateTimeToUtcIso(ymd.year, ymd.month, ymd.day, 12));
  return getIstYmd(new Date(noon.getTime() + days * 24 * 60 * 60 * 1000));
}

/**
 * Client stamp for `requests.delivery_slot_deadline` (and instant appointment_time via "asap").
 * Scheduled slots use Asia/Kolkata wall clock — not the device timezone.
 */
export function getDeliverySlotDeadline(
  slot: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const s = String(slot ?? "")
    .trim()
    .toLowerCase();
  if (!s) return null;

  if (s === "asap") {
    return new Date(now.getTime() + DELIVERY_ASAP_OFFSET_MS).toISOString();
  }

  const ymd = getIstYmd(now);
  if (s === "morning") {
    return zonedIstDateTimeToUtcIso(ymd.year, ymd.month, ymd.day, 12);
  }
  if (s === "afternoon") {
    return zonedIstDateTimeToUtcIso(ymd.year, ymd.month, ymd.day, 16);
  }
  if (s === "evening") {
    return zonedIstDateTimeToUtcIso(ymd.year, ymd.month, ymd.day, 20);
  }
  if (s === "tomorrow") {
    const next = addIstCalendarDays(ymd, 1);
    return zonedIstDateTimeToUtcIso(next.year, next.month, next.day, 20);
  }
  return null;
}

/**
 * Cancel window open time — mirrors SQL `delivery_slot_window_start`.
 * Operates on the stored timestamptz; offsets match server intervals.
 * Deadlines must themselves be IST-stamped (see getDeliverySlotDeadline).
 */
export function getDeliverySlotWindowStart(
  slot: string | null | undefined,
  deadlineIso: string | null | undefined,
): Date | null {
  const s = String(slot ?? "")
    .trim()
    .toLowerCase();
  if (!s || s === "asap") return null;
  if (deadlineIso == null || String(deadlineIso).trim() === "") return null;
  const deadline = new Date(deadlineIso).getTime();
  if (!Number.isFinite(deadline)) return null;
  if (s === "tomorrow") {
    return new Date(deadline - DELIVERY_SLOT_TOMORROW_WINDOW_BEFORE_DEADLINE_MS);
  }
  // morning / afternoon / evening (and unknown scheduled): end − 4h
  return new Date(deadline - DELIVERY_SLOT_WINDOW_BEFORE_DEADLINE_MS);
}
