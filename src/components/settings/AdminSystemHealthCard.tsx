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

export function AdminSystemHealthCard() {
  const [openAlerts, setOpenAlerts] = useState<Map<string, OpenAlert>>(new Map());

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
    };

    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, []);

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
    </SettingsCard>
  );
}
