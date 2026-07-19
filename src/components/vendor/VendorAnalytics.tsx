import { BarChart2 } from "lucide-react";
import { useLanguage } from "@/lib/language";

export type VendorOrderStats = {
  total: number;
  thisMonth: number;
  fulfilled: number;
  declined: number;
  cancelled: number;
};

export type VendorCategoryStat = {
  categoryId: string | null;
  label: string;
  total: number;
  fulfilled: number;
  onTimeRate: number | null;
};

type Props = {
  loading: boolean;
  stats: VendorOrderStats | null;
  onTimeRate: number | null;
  categoryStats?: VendorCategoryStat[];
  /** When true, render only the stat grid (parent supplies section chrome/header). */
  hideHeader?: boolean;
  /** RPC failure — show explicit error instead of silent zeros. */
  loadError?: boolean;
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
    <div className="rounded-2xl bg-surface border border-surface-border p-3 text-center">
      <p className="text-xl font-bold text-foreground tabular-nums">
        {loading ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            {value}
            {suffix != null && <span className="text-base">{suffix}</span>}
          </>
        )}
      </p>
      <p className="text-xs uppercase tracking-wide text-muted-foreground mt-1">{label}</p>
    </div>
  );
}

export function VendorAnalytics({
  loading,
  stats,
  onTimeRate,
  categoryStats = [],
  hideHeader,
  loadError,
}: Props) {
  const { s } = useLanguage();

  if (loadError && !loading) {
    const err = (
      <div
        data-testid="vendor-analytics-load-error"
        className="rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-6 text-center text-sm text-foreground"
      >
        {s.vendor_analytics_load_failed}
      </div>
    );
    if (hideHeader) return err;
    return (
      <section className="mx-4 rounded-2xl border border-surface-border bg-surface p-4">
        <div className="flex items-center gap-3 mb-3">
          <BarChart2 className="h-5 w-5 text-secondary" />
          <p className="font-display font-bold">{s.settings_myAnalytics}</p>
        </div>
        {err}
      </section>
    );
  }

  const onTimeDisplay =
    !loading && onTimeRate !== null && Number.isFinite(onTimeRate)
      ? Math.round(onTimeRate)
      : "—";

  const grid = (
    <>
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
      {!loading && categoryStats.length > 0 ? (
        <div className="mt-4 space-y-2" data-testid="vendor-analytics-by-category">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {s.settings_byCategory}
          </p>
          <ul className="space-y-2">
            {categoryStats.map((row) => (
              <li
                key={row.categoryId ?? "uncategorized"}
                data-testid="vendor-analytics-category-row"
                className="rounded-xl border border-surface-border bg-background/40 px-3 py-2 flex items-center justify-between gap-2"
              >
                <span className="text-sm font-medium text-foreground truncate">
                  {row.label}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                  {row.total} {s.settings_categoryOrders}
                  {" · "}
                  {row.onTimeRate != null && Number.isFinite(row.onTimeRate)
                    ? `${Math.round(row.onTimeRate)}${s.radar_on_time}`
                    : "—"}{" "}
                  {s.settings_categoryOnTime}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );

  if (hideHeader) return grid;

  return (
    <section className="mx-4 rounded-2xl border border-surface-border bg-surface p-4">
      <div className="flex items-center gap-3 mb-3">
        <BarChart2 className="h-5 w-5 text-secondary" />
        <p className="font-display font-bold">{s.settings_myAnalytics}</p>
      </div>
      {grid}
    </section>
  );
}
