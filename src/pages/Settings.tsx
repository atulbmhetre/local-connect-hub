import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import {
  ShieldCheck,
  Trash2,
  Wrench,
  CheckCircle2,
  Phone,
  MapPin,
  Heart,
  Globe,
  Store,
  TrendingUp,
  BarChart2,
  Users,
  ShieldAlert,
  Search,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { notifyVendorIdChanged } from "@/lib/vendorSessionSync";
import { getUserPhone, clearUserPhone } from "@/lib/userIdentity";
import { getDeviceId } from "@/lib/deviceId";

const Settings = () => {
  const [titleTaps, setTitleTaps] = useState(0);
  const [devOpen, setDevOpen] = useState(false);
  const userPhone = getUserPhone();
  const deviceId = getDeviceId();
  const vendorId = localStorage.getItem("aaspaas:vendor_id");
  const isAdmin = userPhone === "8888169446";

  const [vendorStats, setVendorStats] = useState({
    total: 0,
    fulfilled: 0,
    declined: 0,
    thisMonth: 0,
  });
  const [vendorInfo, setVendorInfo] = useState<{
    shop_name: string;
    category: string;
    service_mode: string;
    vendor_note: string;
  } | null>(null);

  const [adminStats, setAdminStats] = useState({
    totalOrders: 0,
    ordersToday: 0,
    ordersThisWeek: 0,
    totalVendors: 0,
    activeVendorsToday: 0,
    newVendorsThisWeek: 0,
    unverifiedVendors: 0,
  });

  const [vendorList, setVendorList] = useState<
    {
      id: string;
      name: string;
      shop_name: string;
      category: string;
      phone: string;
      is_manual_verified: boolean;
      is_active: boolean;
    }[]
  >([]);
  const [vendorSearch, setVendorSearch] = useState("");
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifySheet, setVerifySheet] = useState<{
    open: boolean;
    vendor: (typeof vendorList)[number] | null;
  }>({ open: false, vendor: null });
  const [verifyChecks, setVerifyChecks] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!vendorId) return;
    const load = async () => {
      const { data: vendor } = await supabase
        .from("vendors")
        .select("shop_name, category, service_mode, vendor_note")
        .eq("id", vendorId)
        .single();
      if (vendor)
        setVendorInfo(
          vendor as {
            shop_name: string;
            category: string;
            service_mode: string;
            vendor_note: string;
          },
        );

      const { data: orders } = await supabase
        .from("requests")
        .select("status, created_at")
        .eq("vendor_id", vendorId);
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
  }, [vendorId]);

  useEffect(() => {
    if (!isAdmin) return;
    const load = async () => {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).toISOString();

      const { data: orders } = await supabase.from("requests").select("created_at");
      const { data: vendors } = await supabase
        .from("vendors")
        .select("created_at, last_updated, is_manual_verified");

      if (orders && vendors) {
        setAdminStats({
          totalOrders: orders.length,
          ordersToday: orders.filter((o) => o.created_at >= startOfToday).length,
          ordersThisWeek: orders.filter((o) => o.created_at >= startOfWeek).length,
          totalVendors: vendors.length,
          activeVendorsToday: vendors.filter((v) => v.last_updated >= startOfToday).length,
          newVendorsThisWeek: vendors.filter((v) => v.created_at >= startOfWeek).length,
          unverifiedVendors: vendors.filter((v) => !v.is_manual_verified).length,
        });
      }
    };
    void load();
  }, [isAdmin]);

  const loadVendorList = async () => {
    const { data } = await supabase
      .from("vendors")
      .select("id, name, shop_name, category, phone, is_manual_verified, is_active")
      .order("is_manual_verified", { ascending: true })
      .order("shop_name");
    if (data) setVendorList(data);
  };

  useEffect(() => {
    if (!isAdmin) return;
    void loadVendorList();
  }, [isAdmin]);

  const openVerifySheet = (vendor: (typeof vendorList)[number]) => {
    setVerifySheet({ open: true, vendor });
    setVerifyChecks({});
  };

  const closeVerifySheet = () => {
    setVerifySheet({ open: false, vendor: null });
    setVerifyChecks({});
  };

  const allChecked = Object.keys(verifyChecks).length === 12 && Object.values(verifyChecks).every(Boolean);

  const confirmVerify = async () => {
    if (!verifySheet.vendor || !allChecked) return;
    setVerifying(verifySheet.vendor.id);
    await supabase.from("vendors").update({ is_manual_verified: true }).eq("id", verifySheet.vendor.id);
    await loadVendorList();
    setVerifying(null);
    closeVerifySheet();
    toast("Vendor verified ✅");
  };

  const confirmUnverify = async (vendorId: string) => {
    if (!window.confirm("Remove verification from this vendor?")) return;
    setVerifying(vendorId);
    await supabase.from("vendors").update({ is_manual_verified: false }).eq("id", vendorId);
    await loadVendorList();
    setVerifying(null);
    toast("Verification removed");
  };

  const filteredVendors = vendorList.filter(
    (v) =>
      v.shop_name.toLowerCase().includes(vendorSearch.toLowerCase()) ||
      v.name.toLowerCase().includes(vendorSearch.toLowerCase()) ||
      v.phone.includes(vendorSearch),
  );

  // Hidden gesture: tap the page title 7× to unlock the developer menu.
  const tapTitle = () => {
    const next = titleTaps + 1;
    setTitleTaps(next);
    if (next >= 7) {
      setDevOpen(true);
      setTitleTaps(0);
      toast("Developer menu unlocked");
    }
  };

  const reset = () => {
    if (!window.confirm("Clear all locally stored Aaspaas data on this device?")) return;
    localStorage.removeItem("aaspaas:role");
    localStorage.removeItem("aaspaas:vendor_id");
    clearUserPhone();
    notifyVendorIdChanged();
    toast("Local data cleared");
  };

  return (
    <AppShell theme="light">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Settings</p>
        <h1
          onClick={tapTitle}
          className="font-display text-3xl font-bold mt-1 select-none cursor-default"
        >
          Make it yours.
        </h1>
      </header>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          Switch role
        </p>
        <p className="text-sm text-muted-foreground">
          Use the bottom navigation — <span className="font-semibold text-foreground">Home</span> for help,{" "}
          <span className="font-semibold text-foreground">Vendor</span> to earn.
        </p>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="flex items-center gap-3 mb-3">
          <Phone className="h-5 w-5 text-secondary" />
          <p className="font-display font-bold">My Identity</p>
        </div>
        {userPhone != null ? (
          <div>
            <p className="text-sm font-semibold text-foreground">📞 {userPhone}</p>
            <p className="text-xs text-[#22C55E] mt-1">Registered — orders sync across devices</p>
          </div>
        ) : (
          <div>
            <p className="text-sm font-semibold text-foreground">No phone registered yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Save a vendor or send an order to register
            </p>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground/70 mt-3 tabular-nums">
          Device: {deviceId.slice(0, 8)}…
        </p>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="flex items-center gap-3 mb-3">
          <MapPin className="h-5 w-5 text-secondary" />
          <p className="font-display font-bold">My Addresses</p>
        </div>
        <p className="text-sm text-muted-foreground">Address management coming soon.</p>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="flex items-center gap-3 mb-3">
          <Heart className="h-5 w-5 text-secondary" />
          <p className="font-display font-bold">Saved Vendors</p>
        </div>
        <p className="text-sm text-muted-foreground">Your saved vendors appear here.</p>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="flex items-center gap-3 mb-3">
          <Globe className="h-5 w-5 text-secondary" />
          <p className="font-display font-bold">Language</p>
        </div>
        <p className="text-sm font-semibold text-foreground">English</p>
        <p className="text-xs text-muted-foreground mt-1">Hindi support coming soon.</p>
      </section>

      {vendorId && (
        <>
          <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
            <div className="flex items-center gap-3 mb-3">
              <Store className="h-5 w-5 text-secondary" />
              <p className="font-display font-bold">My Shop</p>
            </div>
            {vendorInfo ? (
              <div className="space-y-1">
                <p className="text-sm font-semibold">{vendorInfo.shop_name}</p>
                <p className="text-xs text-muted-foreground">
                  {vendorInfo.category} · {vendorInfo.service_mode}
                </p>
                {vendorInfo.vendor_note && (
                  <p className="text-xs text-[#22C55E] mt-1">📌 {vendorInfo.vendor_note}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Loading...</p>
            )}
          </section>

          <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
            <div className="flex items-center gap-3 mb-3">
              <BarChart2 className="h-5 w-5 text-secondary" />
              <p className="font-display font-bold">My Analytics</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-2xl font-bold text-secondary">{vendorStats.total}</p>
                <p className="text-xs text-muted-foreground mt-1">Total Orders</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-2xl font-bold text-secondary">{vendorStats.thisMonth}</p>
                <p className="text-xs text-muted-foreground mt-1">This Month</p>
              </div>
              <div className="rounded-2xl bg-green-500/10 p-3 text-center">
                <p className="text-2xl font-bold text-green-500">{vendorStats.fulfilled}</p>
                <p className="text-xs text-muted-foreground mt-1">Fulfilled</p>
              </div>
              <div className="rounded-2xl bg-destructive/10 p-3 text-center">
                <p className="text-2xl font-bold text-destructive">{vendorStats.declined}</p>
                <p className="text-xs text-muted-foreground mt-1">Declined</p>
              </div>
            </div>
          </section>
        </>
      )}

      {isAdmin && (
        <>
          <section className="rounded-3xl bg-card border-2 border-secondary/40 shadow-card p-5 mb-5">
            <div className="flex items-center gap-3 mb-1">
              <ShieldAlert className="h-5 w-5 text-secondary" />
              <p className="font-display font-bold">Admin — App Health</p>
            </div>
            <p className="text-xs text-muted-foreground mb-4">Only visible to you.</p>

            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">Orders</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.totalOrders}</p>
                <p className="text-[10px] text-muted-foreground mt-1">All Time</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.ordersThisWeek}</p>
                <p className="text-[10px] text-muted-foreground mt-1">This Week</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.ordersToday}</p>
                <p className="text-[10px] text-muted-foreground mt-1">Today</p>
              </div>
            </div>

            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">Vendors</p>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.totalVendors}</p>
                <p className="text-[10px] text-muted-foreground mt-1">Total</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.activeVendorsToday}</p>
                <p className="text-[10px] text-muted-foreground mt-1">Active Today</p>
              </div>
              <div className="rounded-2xl bg-green-500/10 p-3 text-center">
                <p className="text-xl font-bold text-green-500">{adminStats.newVendorsThisWeek}</p>
                <p className="text-[10px] text-muted-foreground mt-1">New This Week</p>
              </div>
              <div className="rounded-2xl bg-destructive/10 p-3 text-center">
                <p className="text-xl font-bold text-destructive">{adminStats.unverifiedVendors}</p>
                <p className="text-[10px] text-muted-foreground mt-1">Unverified</p>
              </div>
            </div>
          </section>

          <section className="rounded-3xl bg-card border-2 border-secondary/40 shadow-card p-5 mb-5">
            <div className="flex items-center gap-3 mb-1">
              <Users className="h-5 w-5 text-secondary" />
              <p className="font-display font-bold">Vendor Verification</p>
            </div>
            <p className="text-xs text-muted-foreground mb-4">Unverified vendors shown first.</p>

            <div className="flex items-center gap-2 rounded-2xl border border-border bg-background px-3 py-2 mb-4">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Search by name, shop, phone..."
                value={vendorSearch}
                onChange={(e) => setVendorSearch(e.target.value)}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-3 max-h-96 overflow-y-auto">
              {filteredVendors.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No vendors found.</p>
              )}
              {filteredVendors.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-3 rounded-2xl border border-border p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold truncate">{v.shop_name}</p>
                      {v.is_active && <span className="text-[10px] text-green-500 font-semibold">LIVE</span>}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {v.name} · {v.category}
                    </p>
                    <p className="text-xs text-muted-foreground">{v.phone}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      v.is_manual_verified ? void confirmUnverify(v.id) : openVerifySheet(v)
                    }
                    disabled={verifying === v.id}
                    className={`shrink-0 flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
                      v.is_manual_verified
                        ? "bg-green-500/10 text-green-500 border border-green-500/30"
                        : "bg-destructive/10 text-destructive border border-destructive/30"
                    }`}
                  >
                    {verifying === v.id ? (
                      "..."
                    ) : v.is_manual_verified ? (
                      <>
                        <CheckCircle className="h-3 w-3" /> Verified
                      </>
                    ) : (
                      <>
                        <XCircle className="h-3 w-3" /> Unverified
                      </>
                    )}
                  </button>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="flex items-center gap-3 mb-3">
          <ShieldCheck className="h-5 w-5 text-secondary" />
          <p className="font-display font-bold">Trust & Security</p>
        </div>
        <div className="flex items-center gap-2 rounded-2xl bg-secondary/10 border border-secondary/30 px-4 py-3">
          <CheckCircle2 className="h-5 w-5 text-secondary shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-secondary">Database: Connected & Secure</p>
            <p className="text-xs text-muted-foreground">
              All data is transmitted over TLS and protected with row-level security.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5 text-center">
        <p className="font-display font-bold text-lg">Aaspaas Pro</p>
        <p className="text-sm text-muted-foreground mt-1">Help, around you. Now.</p>
        <p className="text-xs text-muted-foreground mt-3">Version 1.0.0 · Built for Bharat</p>
        <p className="text-xs text-muted-foreground mt-1">© 2026 Aaspaas Pro</p>
      </section>

      {devOpen && (
        <section className="rounded-3xl bg-card border-2 border-dashed border-destructive/40 p-5 mb-5 animate-fade-up">
          <div className="flex items-center gap-2 mb-3">
            <Wrench className="h-4 w-4 text-destructive" />
            <p className="text-xs uppercase tracking-wider text-destructive font-semibold">Developer menu</p>
          </div>
          <button
            onClick={() => setDevOpen(false)}
            className="w-full text-xs text-muted-foreground underline"
          >
            Hide developer menu
          </button>
        </section>
      )}

      <button
        type="button"
        onClick={reset}
        className="w-full rounded-2xl border border-destructive/50 text-destructive bg-transparent py-4 font-semibold flex items-center justify-center gap-2"
      >
        <Trash2 className="h-4 w-4" /> Clear My Data
      </button>

      {verifySheet.open && verifySheet.vendor && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closeVerifySheet} />
          <div className="relative w-full bg-card rounded-t-3xl p-5 max-h-[90vh] overflow-y-auto shadow-xl">
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-5" />

            <div className="flex items-center gap-3 mb-1">
              <ShieldAlert className="h-5 w-5 text-secondary" />
              <p className="font-display font-bold text-lg">Verify Vendor</p>
            </div>
            <p className="text-sm text-muted-foreground mb-1">{verifySheet.vendor.shop_name}</p>
            <p className="text-xs text-muted-foreground mb-5">
              {verifySheet.vendor.name} · {verifySheet.vendor.category} · {verifySheet.vendor.phone}
            </p>

            {[
              { id: "phone_called", label: "Called vendor on registered phone — person picked up" },
              { id: "name_match", label: "Name matches what they said on call" },
              { id: "aware", label: "Vendor is aware they registered on Aaspaas" },
              { id: "shop_exists", label: "Shop physically exists at registered location" },
              { id: "shop_name_match", label: "Shop name matches signboard / what they said" },
              { id: "category_match", label: "Category matches actual service they provide" },
              { id: "service_mode_correct", label: "Service mode is correct (help / delivery / appointment)" },
              { id: "no_duplicate", label: "No duplicate account found (same phone or same shop)" },
              { id: "photo_genuine", label: "Shop photo uploaded and looks genuine" },
              { id: "upi_verified", label: "UPI ID verified (if provided)" },
              { id: "no_suspicious", label: "No suspicious activity (multiple rapid orders, fake numbers)" },
              { id: "rules_understood", label: "Vendor understands Aaspaas usage rules" },
            ].map((item) => (
              <label key={item.id} className="flex items-start gap-3 mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!verifyChecks[item.id]}
                  onChange={(e) =>
                    setVerifyChecks((prev) => ({ ...prev, [item.id]: e.target.checked }))
                  }
                  className="mt-0.5 h-4 w-4 accent-green-500 shrink-0"
                />
                <span className="text-sm text-foreground leading-snug">{item.label}</span>
              </label>
            ))}

            <button
              type="button"
              onClick={() => void confirmVerify()}
              disabled={!allChecked || verifying === verifySheet.vendor?.id}
              className={`w-full rounded-2xl py-4 font-bold text-sm transition-colors mt-2 ${
                allChecked ? "bg-green-500 text-white" : "bg-muted text-muted-foreground cursor-not-allowed"
              }`}
            >
              {verifying === verifySheet.vendor?.id ? "Verifying..." : "✅ Mark as Verified"}
            </button>

            <button
              type="button"
              onClick={closeVerifySheet}
              className="w-full text-xs text-muted-foreground underline mt-3 py-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </AppShell>
  );
};

export default Settings;
