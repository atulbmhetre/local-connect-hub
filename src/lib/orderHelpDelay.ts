export function isHelpAcceptDelayed(
  updatedAt: string | null | undefined,
  createdAt: string | null | undefined,
  timeoutHours: number,
): boolean {
  const iso = updatedAt ?? createdAt;
  const t = new Date(iso ?? "").getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t >= timeoutHours * 60 * 60 * 1000;
}

export function formatHelpDelayedWarning(
  template: string,
  timeoutHours: number,
): string {
  return template.replace("{hours}", String(timeoutHours));
}
