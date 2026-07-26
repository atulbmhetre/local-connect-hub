/** How far ahead an appointment still triggers the go-offline warning (even past midnight). */
export const APPOINTMENT_OFFLINE_WARN_WITHIN_MS = 6 * 60 * 60 * 1000;

/** True when the appointment is on today's local calendar date. */
export function isAppointmentToday(iso: string, now: Date = new Date()): boolean {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return false;
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/**
 * Whether going offline should show the active-orders warning for this appointment.
 * Warns if the slot is today OR starts within the next few hours (may be tomorrow's date).
 * Does not block going offline — only the warning dialog.
 */
export function appointmentWarnsGoingOffline(
  appointmentTimeIso: string,
  now: Date = new Date(),
): boolean {
  const d = new Date(appointmentTimeIso);
  if (!Number.isFinite(d.getTime())) return false;
  if (isAppointmentToday(appointmentTimeIso, now)) return true;
  const deltaMs = d.getTime() - now.getTime();
  return deltaMs >= 0 && deltaMs <= APPOINTMENT_OFFLINE_WARN_WITHIN_MS;
}
