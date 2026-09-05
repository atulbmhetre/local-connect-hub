/**
 * Persist order-placement idempotency keys across lost-response Retry.
 * Key is tied to vendor + composition fingerprint; cleared on success or cancel.
 */

import { safeRandomUUID } from "@/lib/safeRandomUUID";

const storageKeyFor = (vendorId: string) => `aaspaas:place_idem:${vendorId}`;

type StoredPlacementIdem = {
  key: string;
  fingerprint: string;
};

function readStored(vendorId: string): StoredPlacementIdem | null {
  try {
    const raw = sessionStorage.getItem(storageKeyFor(vendorId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPlacementIdem;
    if (
      typeof parsed?.key === "string" &&
      parsed.key.length > 0 &&
      typeof parsed?.fingerprint === "string"
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeStored(vendorId: string, value: StoredPlacementIdem): void {
  try {
    sessionStorage.setItem(storageKeyFor(vendorId), JSON.stringify(value));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Build a stable fingerprint for one order-composition attempt. */
export function buildOrderPlacementFingerprint(parts: {
  vendorId: string;
  phone: string;
  message: string;
  serviceMode: string;
  deliverySlot: string | null;
  appointmentTimestamp: string | null;
  appointmentInstant: boolean;
  address: string | null;
  itemsJson: string;
  recurrenceKind: string;
  recurrenceCustomDays: string;
  serviceLocation: string | null;
}): string {
  return [
    parts.vendorId,
    parts.phone,
    parts.message,
    parts.serviceMode,
    parts.deliverySlot ?? "",
    parts.appointmentTimestamp ?? "",
    parts.appointmentInstant ? "1" : "0",
    parts.address ?? "",
    parts.itemsJson,
    parts.recurrenceKind,
    parts.recurrenceCustomDays,
    parts.serviceLocation ?? "",
  ].join("\u001f");
}

/**
 * Reuse the in-flight key for the same vendor+composition (Retry after lost
 * response); mint a new key when the composition changes.
 */
export function getOrCreateOrderPlacementIdempotencyKey(
  vendorId: string,
  fingerprint: string,
): string {
  const existing = readStored(vendorId);
  if (existing && existing.fingerprint === fingerprint) {
    return existing.key;
  }
  const key = safeRandomUUID();
  writeStored(vendorId, { key, fingerprint });
  return key;
}

/** Clear after confirmed success or explicit sheet cancel — not on network Retry. */
export function clearOrderPlacementIdempotencyKey(vendorId: string): void {
  try {
    sessionStorage.removeItem(storageKeyFor(vendorId));
  } catch {
    /* ignore */
  }
}
