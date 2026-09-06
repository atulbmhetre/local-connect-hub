/** Stable identity for a set of ids — same members → same string, regardless of order. */
export function stableSortedKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join(",");
}

/** Skip the backup poll when Realtime delivered an update inside this window (Incoming: 25s). */
export function shouldSkipBackupPoll(
  lastRealtimeAtMs: number,
  nowMs: number,
  windowMs = 25_000,
): boolean {
  return lastRealtimeAtMs > 0 && nowMs - lastRealtimeAtMs < windowMs;
}
