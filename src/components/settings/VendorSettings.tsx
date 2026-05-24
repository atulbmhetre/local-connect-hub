import { useEffect, useState } from "react";
import { Store, BarChart2, Bell } from "lucide-react";
import { toast } from "sonner";
import { Capacitor } from "@capacitor/core";
import { supabase, useCategoryLabel, useServiceModeLabel, type Vendor } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { Switch } from "@/components/ui/switch";
import {
  isVendorSoundEnabled,
  isVendorVibrateEnabled,
  setVendorSoundEnabled,
  setVendorVibrateEnabled,
} from "@/lib/pushNotifications";

type Props = {
  vendor: Vendor;
  onVendorUpdated: (updated: Vendor) => void;
};

export function VendorSettings({ vendor, onVendorUpdated }: Props) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const getMode = useServiceModeLabel();

  const [vendorStats, setVendorStats] = useState({
    total: 0,
    fulfilled: 0,
    declined: 0,
    thisMonth: 0,
  });
  const [vendorVibrate, setVendorVibrate] = useState(() => isVendorVibrateEnabled());
  const [vendorSound, setVendorSound] = useState(() => isVendorSoundEnabled());
  const [cancelReasons, setCancelReasons] = useState(["", "", "", ""]);
  const [savingReasons, setSavingReasons] = useState(false);

  useEffect(() => {
    setCancelReasons([
      vendor.cancel_reason_1 ?? "",
      vendor.cancel_reason_2 ?? "",
      vendor.cancel_reason_3 ?? "",
      vendor.cancel_reason_4 ?? "",
    ]);
  }, [
    vendor.cancel_reason_1,
    vendor.cancel_reason_2,
    vendor.cancel_reason_3,
    vendor.cancel_reason_4,
  ]);

  useEffect(() => {
    const load = async () => {
      const { data: orders } = await supabase
        .from("requests")
        .select("status, created_at")
        .eq("vendor_id", vendor.id);
      if (orders) {
        const now = new Date();
        const thisMonth = orders.filter(
          (o) =>
            new Date(o.created_at).getMonth() === now.getMonth() &&
            new Date(o.created_at).getFullYear() === now.getFullYear(),
        );
        setVendorStats({
          total: orders.length,
          fulfilled: orders.filter((o) => o.status === "fulfilled" || o.status === "done").length,
          declined: orders.filter((o) => o.status === "declined").length,
          thisMonth: thisMonth.length,
        });
      }
    };
    void load();
  }, [vendor.id]);

  const saveCancelReasons = async () => {
    setSavingReasons(true);
    const updates = {
      cancel_reason_1: cancelReasons[0].trim() || null,
      cancel_reason_2: cancelReasons[1].trim() || null,
      cancel_reason_3: cancelReasons[2].trim() || null,
      cancel_reason_4: cancelReasons[3].trim() || null,
    };
    const { error } = await supabase.from("vendors").update(updates).eq("id", vendor.id);
    setSavingReasons(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    onVendorUpdated({ ...vendor, ...updates });
    toast.success("Saved");
  };

  return (
    <>
      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="flex items-center gap-3 mb-3">
          <Store className="h-5 w-5 text-secondary" />
          <p className="font-display font-bold">{s.settings_myShop}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold">{vendor.shop_name}</p>
          <p className="text-xs text-muted-foreground">
            {getLabel(vendor.category)}
            {s.settings_dotSeparator}
            {getMode(vendor.service_mode ?? "help")}
          </p>
          {vendor.vendor_note && (
            <p className="text-xs text-brand mt-1">
              {s.settings_vendorNotePrefix}
              {vendor.vendor_note}
            </p>
          )}

          <div className="space-y-3 mt-4 pt-4 border-t border-border">
            <div>
              <p className="text-sm font-semibold">{s.cancelReasons}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{s.cancelReasonsSubtitle}</p>
            </div>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-1">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Reason {i + 1}
                </label>
                <input
                  type="text"
                  value={cancelReasons[i]}
                  onChange={(e) => {
                    const next = [...cancelReasons];
                    next[i] = e.target.value.slice(0, 60);
                    setCancelReasons(next);
                  }}
                  maxLength={60}
                  className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            ))}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void saveCancelReasons()}
                disabled={savingReasons}
                className="text-xs font-semibold text-brand hover:underline disabled:opacity-50"
              >
                {savingReasons ? s.incoming_saving : s.saveReasons}
              </button>
            </div>
          </div>
        </div>
      </section>

      {Capacitor.isNativePlatform() && (
        <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
          <div className="flex items-center gap-3 mb-3">
            <Bell className="h-5 w-5 text-secondary" />
            <p className="font-display font-bold">{s.settings_notifications}</p>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{s.settings_vibrate}</p>
              </div>
              <Switch
                checked={vendorVibrate}
                onCheckedChange={(checked) => {
                  setVendorVibrate(checked);
                  setVendorVibrateEnabled(checked);
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{s.settings_sound}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{s.settings_sound_body}</p>
              </div>
              <Switch
                checked={vendorSound}
                onCheckedChange={(checked) => {
                  setVendorSound(checked);
                  setVendorSoundEnabled(checked);
                }}
              />
            </div>
          </div>
        </section>
      )}

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="flex items-center gap-3 mb-3">
          <BarChart2 className="h-5 w-5 text-secondary" />
          <p className="font-display font-bold">{s.settings_myAnalytics}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-secondary/10 p-3 text-center">
            <p className="text-2xl font-bold text-secondary">{vendorStats.total}</p>
            <p className="text-xs text-muted-foreground mt-1">{s.settings_totalOrders}</p>
          </div>
          <div className="rounded-2xl bg-secondary/10 p-3 text-center">
            <p className="text-2xl font-bold text-secondary">{vendorStats.thisMonth}</p>
            <p className="text-xs text-muted-foreground mt-1">{s.settings_thisMonth}</p>
          </div>
          <div className="rounded-2xl bg-green-500/10 p-3 text-center">
            <p className="text-2xl font-bold text-green-500">{vendorStats.fulfilled}</p>
            <p className="text-xs text-muted-foreground mt-1">{s.settings_fulfilled}</p>
          </div>
          <div className="rounded-2xl bg-destructive/10 p-3 text-center">
            <p className="text-2xl font-bold text-destructive">{vendorStats.declined}</p>
            <p className="text-xs text-muted-foreground mt-1">{s.settings_declined}</p>
          </div>
        </div>
      </section>
    </>
  );
}
