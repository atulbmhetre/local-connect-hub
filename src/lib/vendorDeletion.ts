/** deletion_requested_at + 30 days, formatted for user-facing copy. */
export function formatVendorDeletionDate(deletionRequestedAt: string): string {
  const d = new Date(deletionRequestedAt);
  d.setDate(d.getDate() + 30);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
