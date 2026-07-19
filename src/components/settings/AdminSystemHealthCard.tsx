import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { SettingsCard } from "@/components/settings/SettingsSection";

const MONITORED_FUNCTIONS = [
  { key: "suggest-category", label: "AI Category" },
  { key: "parse-image-bill", label: "Bill Scanner" },
  { key: "parse-image-order", label: "Order Scanner" },
  { key: "process-new-category", label: "Category Processor" },
] as const;

type OpenAlert = {
  function_name: string;
  error_type: string;
  first_failed_at: string;
};

type FcmFailureRow = {
  notification_type: string;
  failure_events: number | string;
  success_events: number | string;
};

type RadarHealthStats = {
  total_searches: number;
  zero_result_searches: number;
  zero_result_rate_pct: number;
  active_categories_count: number;
  categories_ok: boolean;
};

type RestoreHealthStats = {
  attempts: number;
  successes: number;
  denied_banned: number;
  denied_deleted: number;
  not_found: number;
  offline_now_restorable: number;
  hidden_now_restorable: number;
  success_rate_pct: number;
};

type GreenPendingStats = {
  account_pending: number;
  category_pending: number;
  vendors_ready: number;
};

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function toCount(v: number | string | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function AdminSystemHealthCard() {
  const [openAlerts, setOpenAlerts] = useState<Map<string, OpenAlert>>(new Map());
  const [fcmRows, setFcmRows] = useState<FcmFailureRow[]>([]);
  const [fcmLoadError, setFcmLoadError] = useState(false);
  const [radarHealth, setRadarHealth] = useState<RadarHealthStats | null>(null);
  const [radarLoadError, setRadarLoadError] = useState(false);
  const [restoreHealth, setRestoreHealth] = useState<RestoreHealthStats | null>(null);
  const [restoreLoadError, setRestoreLoadError] = useState(false);
  const [greenPending, setGreenPending] = useState<GreenPendingStats | null>(null);
  const [greenPendingLoadError, setGreenPendingLoadError] = useState(false);

  useEffect(() => {
    const load = async () => {
      const { data, error } = await supabase
        .from("admin_alerts")
        .select("function_name, error_type, first_failed_at")
        .is("resolved_at", null);

      if (error) {
        console.error("admin_alerts load failed", error);
        return;
      }

      const next = new Map<string, OpenAlert>();
      for (const row of data ?? []) {
        next.set(row.function_name, row as OpenAlert);
      }
      setOpenAlerts(next);

      const { data: fcmData, error: fcmError } = await supabase.rpc(
        "get_admin_fcm_failure_stats",
        { p_hours: 24 },
      );
      if (fcmError) {
        console.error("get_admin_fcm_failure_stats failed", fcmError);
        setFcmLoadError(true);
        setFcmRows([]);
        return;
      }
      setFcmLoadError(false);
      setFcmRows((Array.isArray(fcmData) ? fcmData : []) as FcmFailureRow[]);

      const { data: radarData, error: radarError } = await supabase.rpc(
        "get_admin_radar_health_stats",
        { p_hours: 24 },
      );
      if (radarError) {
        console.error("get_admin_radar_health_stats failed", radarError);
        setRadarLoadError(true);
        setRadarHealth(null);
        return;
      }
      setRadarLoadError(false);
      setRadarHealth((radarData ?? null) as RadarHealthStats | null);

      const { data: restoreData, error: restoreError } = await supabase.rpc(
        "get_admin_restore_health_stats",
        { p_hours: 24 },
      );
      if (restoreError) {
        console.error("get_admin_restore_health_stats failed", restoreError);
        setRestoreLoadError(true);
        setRestoreHealth(null);
        return;
      }
      setRestoreLoadError(false);
      setRestoreHealth((restoreData ?? null) as RestoreHealthStats | null);

      const { data: greenData, error: greenError } = await supabase.rpc(
        "get_admin_green_pending_stats",
      );
      if (greenError) {
        console.error("get_admin_green_pending_stats failed", greenError);
        setGreenPendingLoadError(true);
        setGreenPending(null);
        return;
      }
      setGreenPendingLoadError(false);
      setGreenPending((greenData ?? null) as GreenPendingStats | null);
    };

    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, []);

  const totalFcmFailures = fcmRows.reduce((sum, r) => sum + toCount(r.failure_events), 0);
  const failingTypes = fcmRows.filter((r) => toCount(r.failure_events) > 0);
  const radarZeroRate = radarHealth?.zero_result_rate_pct ?? 0;
  const radarCategoriesOk = radarHealth?.categories_ok ?? false;
  const radarUnhealthy = radarLoadError || !radarCategoriesOk || radarZeroRate >= 80;
  const restoreAttempts = restoreHealth?.attempts ?? 0;
  const restoreSuccesses = restoreHealth?.successes ?? 0;
  const restoreDenied =
    (restoreHealth?.denied_banned ?? 0) + (restoreHealth?.denied_deleted ?? 0);
  const restoreUnhealthy =
    restoreLoadError ||
    (restoreAttempts >= 5 && restoreSuccesses === 0) ||
    (restoreAttempts >= 10 && (restoreHealth?.success_rate_pct ?? 0) < 20);
  const greenVendorsReady = greenPending?.vendors_ready ?? 0;
  const greenQueueUnhealthy = greenPendingLoadError || greenVendorsReady > 0;

  return (
    <SettingsCard className="border-brand/20" data-testid="admin-system-health">
      <div className="px-4 py-3 border-b border-surface-border">
        <p className="text-sm font-medium text-foreground">System Health</p>
        <p className="text-xs text-muted-foreground mt-0.5">Edge function status</p>
      </div>
      <div className="px-4 py-2">
        {MONITORED_FUNCTIONS.map(({ key, label }) => {
          const alert = openAlerts.get(key);
          return (
            <div
              key={key}
              className="flex items-start gap-2.5 py-2.5 border-b border-surface-border last:border-0"
            >
              <span
                className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
                  alert ? "bg-destructive" : "bg-green-500"
                }`}
                aria-hidden
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {alert
                    ? `${alert.error_type} · failed ${formatRelativeTime(alert.first_failed_at)}`
                    : "Healthy"}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-4 py-3 border-t border-surface-border" data-testid="admin-fcm-health">
        <p className="text-sm font-medium text-foreground">FCM delivery (24h)</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Push failures from fcm_delivery_log
        </p>
        <div className="flex items-start gap-2.5 py-2.5">
          <span
            className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
              fcmLoadError || totalFcmFailures > 0 ? "bg-destructive" : "bg-green-500"
            }`}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground" data-testid="admin-fcm-failure-total">
              {fcmLoadError
                ? "Unable to load FCM stats"
                : totalFcmFailures === 0
                  ? "No delivery failures"
                  : `${totalFcmFailures} failed send${totalFcmFailures === 1 ? "" : "s"}`}
            </p>
            {!fcmLoadError && failingTypes.length > 0 && (
              <ul className="mt-1 space-y-0.5" data-testid="admin-fcm-failure-breakdown">
                {failingTypes.map((row) => (
                  <li key={row.notification_type} className="text-xs text-muted-foreground">
                    {row.notification_type}: {toCount(row.failure_events)} failed
                    {toCount(row.success_events) > 0
                      ? ` · ${toCount(row.success_events)} ok`
                      : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="px-4 py-3 border-t border-surface-border" data-testid="admin-radar-health">
        <p className="text-sm font-medium text-foreground">Radar search (24h)</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Zero-result rate from logged searches + active categories
        </p>
        <div className="flex items-start gap-2.5 py-2.5">
          <span
            className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
              radarUnhealthy ? "bg-destructive" : "bg-green-500"
            }`}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground" data-testid="admin-radar-health-summary">
              {radarLoadError
                ? "Unable to load Radar stats"
                : !radarCategoriesOk
                  ? "No active categories loaded"
                  : radarZeroRate >= 80
                    ? `High zero-result rate (${radarZeroRate}%)`
                    : "Radar categories OK"}
            </p>
            {!radarLoadError && radarHealth && (
              <p className="text-xs text-muted-foreground mt-0.5" data-testid="admin-radar-health-detail">
                {radarHealth.total_searches} searches · {radarHealth.zero_result_searches} zero results ·{" "}
                {radarHealth.active_categories_count} active categories
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="px-4 py-3 border-t border-surface-border" data-testid="admin-restore-health">
        <p className="text-sm font-medium text-foreground">Account restore (24h)</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          FirstOpen restore attempts, successes, and denial reasons
        </p>
        <div className="flex items-start gap-2.5 py-2.5">
          <span
            className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
              restoreUnhealthy ? "bg-destructive" : "bg-green-500"
            }`}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p
              className="text-sm font-medium text-foreground"
              data-testid="admin-restore-health-summary"
            >
              {restoreLoadError
                ? "Unable to load restore stats"
                : restoreAttempts === 0
                  ? "No restore attempts yet"
                  : `${restoreSuccesses}/${restoreAttempts} restored (${restoreHealth?.success_rate_pct ?? 0}%)`}
            </p>
            {!restoreLoadError && restoreHealth && restoreAttempts > 0 && (
              <p
                className="text-xs text-muted-foreground mt-0.5"
                data-testid="admin-restore-health-detail"
              >
                {restoreDenied} denied (banned {restoreHealth.denied_banned} · deleted{" "}
                {restoreHealth.denied_deleted}) · not found {restoreHealth.not_found} · offline
                restored {restoreHealth.offline_now_restorable} · hidden restored{" "}
                {restoreHealth.hidden_now_restorable}
              </p>
            )}
          </div>
        </div>
      </div>

      <div
        className="px-4 py-3 border-t border-surface-border"
        data-testid="admin-green-pending-health"
      >
        <p className="text-sm font-medium text-foreground">Verification queue</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Vendors at green_pending awaiting admin review
        </p>
        <div className="flex items-start gap-2.5 py-2.5">
          <span
            className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
              greenQueueUnhealthy ? "bg-amber-500" : "bg-green-500"
            }`}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p
              className="text-sm font-medium text-foreground"
              data-testid="admin-green-pending-summary"
            >
              {greenPendingLoadError
                ? "Unable to load verification queue"
                : greenVendorsReady === 0
                  ? "No vendors waiting for review"
                  : `${greenVendorsReady} vendor${greenVendorsReady === 1 ? "" : "s"} ready for review`}
            </p>
            {!greenPendingLoadError && greenPending && greenVendorsReady > 0 && (
              <p
                className="text-xs text-muted-foreground mt-0.5"
                data-testid="admin-green-pending-detail"
              >
                account-level {greenPending.account_pending} · business-level{" "}
                {greenPending.category_pending}
              </p>
            )}
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}
