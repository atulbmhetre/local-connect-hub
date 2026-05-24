import { useEffect, useState } from "react";
import { BarChart2, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";

type Props = {
  vendorId: string;
};

export function VendorAnalytics({ vendorId }: Props) {
  const { s } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [ordersServed, setOrdersServed] = useState(0);
  const [onTimeRate, setOnTimeRate] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async () => {
      const [{ data: orders }, { data: vendor }] = await Promise.all([
        supabase.from("requests").select("status, created_at").eq("vendor_id", vendorId),
        supabase.from("vendors").select("on_time_rate").eq("id", vendorId).single(),
      ]);
      if (cancelled) return;
      if (orders) {
        setOrdersServed(
          orders.filter((o) => o.status === "fulfilled" || o.status === "done").length,
        );
      } else {
        setOrdersServed(0);
      }
      const raw = vendor?.on_time_rate;
      setOnTimeRate(typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : null);
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

  if (loading) {
    return (
      <div className="rounded-3xl bg-card border border-border shadow-card p-6 mb-5 grid place-items-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }

  return (
    <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
      <div className="flex items-center gap-3 mb-3">
        <BarChart2 className="h-5 w-5 text-secondary" />
        <p className="font-display font-bold">{s.settings_myAnalytics}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-secondary/10 p-3 text-center">
          <p className="text-2xl font-bold text-secondary tabular-nums">{ordersServed}</p>
          <p className="text-xs text-muted-foreground mt-1">{s.settings_fulfilled}</p>
        </div>
        <div className="rounded-2xl bg-brand/10 p-3 text-center">
          <p className="text-2xl font-bold text-brand tabular-nums">
            {onTimeRate !== null ? (
              <>
                {onTimeRate}
                <span className="text-base">{s.radar_on_time}</span>
              </>
            ) : (
              "—"
            )}
          </p>
          <p className="text-xs text-muted-foreground mt-1">{s.radar_delivered_on_time}</p>
        </div>
      </div>
    </section>
  );
}
