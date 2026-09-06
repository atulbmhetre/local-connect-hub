/** Pure Account Standing badge resolution (Settings). */

export type AccountStandingTone =
  | "loading"
  | "unavailable"
  | "good"
  | "fair"
  | "complaints"
  | "banned";

export type AccountStandingLabels = {
  trust_status_loading: string;
  trust_status_unavailable: string;
  trust_status_good: string;
  trust_status_fair: string;
  trust_status_complaints: string;
  trust_status_banned: string;
};

export function resolveAccountStanding(opts: {
  loading: boolean;
  loadFailed: boolean;
  userTrust: {
    trust_score: number | null;
    warn_count: number | null;
    is_banned: boolean;
  } | null;
  labels: AccountStandingLabels;
}): { tone: AccountStandingTone; label: string } {
  const { loading, loadFailed, userTrust, labels } = opts;
  if (loading) {
    return { tone: "loading", label: labels.trust_status_loading };
  }
  if (loadFailed) {
    return { tone: "unavailable", label: labels.trust_status_unavailable };
  }
  // Successful load with no row → new/clean account (good).
  if (!userTrust) {
    return { tone: "good", label: labels.trust_status_good };
  }
  if (userTrust.is_banned) {
    return { tone: "banned", label: labels.trust_status_banned };
  }
  const score = userTrust.trust_score ?? 75;
  const warns = userTrust.warn_count ?? 0;
  if (score < 25 || warns >= 3) {
    return { tone: "complaints", label: labels.trust_status_complaints };
  }
  if (score >= 25 && score <= 74) {
    return { tone: "fair", label: labels.trust_status_fair };
  }
  return { tone: "good", label: labels.trust_status_good };
}
