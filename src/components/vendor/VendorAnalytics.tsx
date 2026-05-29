import { BarChart2 } from "lucide-react";
import { useLanguage } from "@/lib/language";

export type VendorOrderStats = {
  total: number;
  thisMonth: number;
  fulfilled: number;
  declined: number;
  cancelled: number;
};

type Props = {
  loading: boolean;
  stats: VendorOrderStats | null;
  onTimeRate: number | null;
};

function StatCell({
  value,
  label,
  loading,
  suffix,
}: {
  value: number | string;
  label: string;
  loading: boolean;
  suffix?: string;
}) {
  return (
    <div className="rounded-2xl bg-secondary/10 p-3 text-center">
      <p className="text-2xl font-bold text-secondary tabular-nums">
        {loading ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            {value}
            {suffix != null && <span className="text-base">{suffix}</span>}
          </>
        )}
      </p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  );
}

export function VendorAnalytics({ loading, stats, onTimeRate }: Props) {
  const { s } = useLanguage();

  const onTimeDisplay =
    !loading && onTimeRate !== null && Number.isFinite(onTimeRate)
      ? Math.round(onTimeRate)
      : "—";

  return (
    <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
      <div className="flex items-center gap-3 mb-3">
        <BarChart2 className="h-5 w-5 text-secondary" />
        <p className="font-display font-bold">{s.settings_myAnalytics}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <StatCell
          value={stats?.total ?? 0}
          label={s.settings_totalOrders}
          loading={loading}
        />
        <StatCell
          value={stats?.thisMonth ?? 0}
          label={s.settings_thisMonth}
          loading={loading}
        />
        <StatCell
          value={stats?.fulfilled ?? 0}
          label={s.settings_fulfilled}
          loading={loading}
        />
        <StatCell
          value={stats?.declined ?? 0}
          label={s.settings_declined}
          loading={loading}
        />
        <StatCell
          value={stats?.cancelled ?? 0}
          label={s.settings_cancelled}
          loading={loading}
        />
        <StatCell
          value={onTimeDisplay}
          label={s.settings_onTimeRate}
          loading={loading}
          suffix={!loading && onTimeRate !== null ? s.radar_on_time : undefined}
        />
      </div>
    </section>
  );
}
