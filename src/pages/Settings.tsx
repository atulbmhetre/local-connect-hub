import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import {
  ShieldCheck,
  Trash2,
  Wrench,
  CheckCircle2,
  Phone,
  Globe,
  Moon,
  Sun,
  Users,
  ShieldAlert,
  Search,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { supabase, useCategoryLabel, type Vendor } from "@/lib/supabase";
import { notifyVendorIdChanged } from "@/lib/vendorSessionSync";
import { getUserPhone, clearUserPhone } from "@/lib/userIdentity";
import { getDeviceId } from "@/lib/deviceId";
import { useLanguage } from "@/lib/language";
import { useTheme } from "@/lib/theme";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LANGUAGE_LABELS, type Language } from "@/lib/strings";
import { useUserAddresses } from "@/hooks/useUserAddresses";
import { VendorSettings } from "@/components/settings/VendorSettings";

const Settings = () => {
  const { lang, setLang, s } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const getLabel = useCategoryLabel();
  const [titleTaps, setTitleTaps] = useState(0);
  const [devOpen, setDevOpen] = useState(false);
  const userPhone = getUserPhone();
  const deviceId = getDeviceId();
  const vendorId = localStorage.getItem("aaspaas:vendor_id");
  const isAdmin = userPhone === "8888169446";
  const [devPhone, setDevPhone] = useState(userPhone ?? "");

  const [vendor, setVendor] = useState<Vendor | null>(null);

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
  const { addresses, loading: addressesLoading, refresh: refreshAddresses } = useUserAddresses();
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [editAddressValue, setEditAddressValue] = useState("");
  const [deleteAddressId, setDeleteAddressId] = useState<string | null>(null);
  const [deletingAddress, setDeletingAddress] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);

  useEffect(() => {
    if (!vendorId) return;
    const load = async () => {
      const { data, error } = await supabase
        .from("vendors")
        .select("*")
        .eq("id", vendorId)
        .single();
      if (error) {
        console.error("Failed to load vendor:", error.message);
        return;
      }
      if (data) setVendor(data as Vendor);
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
    const { error } = await supabase
      .from("vendors")
      .update({ is_manual_verified: true })
      .eq("id", verifySheet.vendor.id);
    if (error) {
      setVerifying(null);
      toast.error("Update failed: " + error.message);
      return;
    }
    await loadVendorList();
    setVerifying(null);
    closeVerifySheet();
    toast(s.settings_vendorVerified);
  };

  const confirmUnverify = async (vendorId: string) => {
    if (!window.confirm(s.settings_removeVerifyConfirm)) return;
    setVerifying(vendorId);
    const { error } = await supabase
      .from("vendors")
      .update({ is_manual_verified: false })
      .eq("id", vendorId);
    if (error) {
      setVerifying(null);
      toast.error("Update failed: " + error.message);
      return;
    }
    await loadVendorList();
    setVerifying(null);
    toast(s.settings_verificationRemoved);
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
      toast(s.settings_devMenuUnlocked);
    }
  };

  const reset = () => {
    if (!window.confirm(s.settings_clearDataConfirm)) return;
    localStorage.removeItem("aaspaas:role");
    localStorage.removeItem("aaspaas:vendor_id");
    clearUserPhone();
    notifyVendorIdChanged();
    toast(s.settings_localDataCleared);
  };

  const startEditAddress = (addr: (typeof addresses)[number]) => {
    setEditingAddressId(addr.id);
    setEditAddressValue(addr.address_text);
  };

  const cancelEditAddress = () => {
    setEditingAddressId(null);
    setEditAddressValue("");
  };

  const saveEditAddress = async () => {
    const trimmed = editAddressValue.trim();
    if (!trimmed || !editingAddressId) {
      toast.error("Address cannot be empty");
      return;
    }
    setSavingAddress(true);
    const { error } = await supabase
      .from("user_addresses")
      .update({ address_text: trimmed })
      .eq("id", editingAddressId);
    setSavingAddress(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    cancelEditAddress();
    await refreshAddresses();
  };

  const confirmDeleteAddress = async () => {
    if (!deleteAddressId) return;
    setDeletingAddress(true);
    const { error } = await supabase.from("user_addresses").delete().eq("id", deleteAddressId);
    setDeletingAddress(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setDeleteAddressId(null);
    if (editingAddressId === deleteAddressId) {
      cancelEditAddress();
    }
    await refreshAddresses();
  };

  return (
    <AppShell theme="light">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">{s.settings_heading}</p>
        <h1
          onClick={tapTitle}
          className="font-display text-3xl font-bold mt-1 select-none cursor-default"
        >
          {s.settings_tagline}
        </h1>
      </header>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          {s.settings_switchRole}
        </p>
        <p className="text-sm text-muted-foreground">
          {s.settings_switchRoleHintPrefix}<span className="font-semibold text-foreground">{s.settings_switchRoleHome}</span>{s.settings_switchRoleForHelp}{" "}
          <span className="font-semibold text-foreground">{s.settings_switchRoleVendor}</span>{s.settings_switchRoleToEarn}
        </p>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="flex items-center gap-3 mb-3">
          <Phone className="h-5 w-5 text-secondary" />
          <p className="font-display font-bold">{s.settings_myIdentity}</p>
        </div>
        {userPhone != null ? (
          <div>
            <p className="text-sm font-semibold text-foreground">{s.settings_phonePrefix}{userPhone}</p>
            <p className="text-xs text-brand mt-1">{s.settings_registered}</p>
          </div>
        ) : (
          <div>
            <p className="text-sm font-semibold text-foreground">{s.settings_noPhone}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {s.settings_noPhoneHint}
            </p>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground/70 mt-3 tabular-nums">
          {s.settings_devicePrefix}{deviceId.slice(0, 8)}{s.settings_deviceEllipsis}
        </p>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <p className="font-display font-bold mb-3">{s.settings_myDeliveryAddresses}</p>
        {addressesLoading ? (
          <p className="text-sm text-muted-foreground">{s.settings_loading}</p>
        ) : addresses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No saved addresses yet.</p>
        ) : (
          <ul className="space-y-2">
            {addresses.map((addr) => (
              <li
                key={addr.id}
                className="rounded-2xl border border-border bg-background px-3 py-2.5"
              >
                {editingAddressId === addr.id ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={editAddressValue}
                      onChange={(e) => setEditAddressValue(e.target.value)}
                      className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                      autoFocus
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => void saveEditAddress()}
                        disabled={savingAddress}
                        className="text-xs font-semibold text-brand disabled:opacity-50"
                        aria-label="Save address"
                      >
                        ✅ Save
                      </button>
                      <button
                        type="button"
                        onClick={cancelEditAddress}
                        disabled={savingAddress}
                        className="text-xs font-semibold text-muted-foreground disabled:opacity-50"
                        aria-label="Cancel edit"
                      >
                        ❌ Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <p className="flex-1 min-w-0 text-sm text-foreground truncate">
                      {addr.address_text}
                    </p>
                    <button
                      type="button"
                      onClick={() => startEditAddress(addr)}
                      className="shrink-0 h-8 w-8 rounded-lg border border-border text-sm hover:bg-card transition-colors"
                      aria-label="Edit address"
                    >
                      ✏️
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteAddressId(addr.id)}
                      className="shrink-0 h-8 w-8 rounded-lg border border-border text-sm hover:bg-card transition-colors"
                      aria-label="Delete address"
                    >
                      🗑️
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="flex items-center gap-3 mb-3">
          <Globe className="h-5 w-5 text-secondary" />
          <p className="font-display font-bold">{s.settings_language}</p>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border border-border bg-background text-left mb-2 transition-colors active:scale-[0.99]"
        >
          <div>
            <p className="font-semibold text-sm text-foreground">{s.theme}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {theme === "dark" ? s.dark : s.light}
            </p>
          </div>
          <span className="h-10 w-10 shrink-0 grid place-items-center rounded-xl border border-border bg-card text-secondary">
            {theme === "dark" ? (
              <Moon className="h-5 w-5" aria-hidden />
            ) : (
              <Sun className="h-5 w-5" aria-hidden />
            )}
          </span>
        </button>
        <div className="flex flex-col gap-2">
          {(Object.entries(LANGUAGE_LABELS) as [Language, string][]).map(([code, label]) => (
            <button
              key={code}
              type="button"
              onClick={() => setLang(code)}
              className={`w-full text-left px-4 py-3 rounded-2xl border font-semibold text-sm transition-colors ${
                lang === code
                  ? "bg-secondary/10 border-secondary text-secondary"
                  : "bg-background border-border text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {vendorId && !vendor && (
        <p className="text-sm text-muted-foreground mb-5">{s.settings_loading}</p>
      )}
      {vendor && <VendorSettings vendor={vendor} onVendorUpdated={setVendor} />}

      {isAdmin && (
        <>
          <section className="rounded-3xl bg-card border-2 border-secondary/40 shadow-card p-5 mb-5">
            <div className="flex items-center gap-3 mb-1">
              <ShieldAlert className="h-5 w-5 text-secondary" />
              <p className="font-display font-bold">{s.settings_adminHealth}</p>
            </div>
            <p className="text-xs text-muted-foreground mb-4">{s.settings_adminOnly}</p>

            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">{s.settings_orders}</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.totalOrders}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_allTime}</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.ordersThisWeek}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_thisWeek}</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.ordersToday}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_today}</p>
              </div>
            </div>

            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">{s.settings_vendors}</p>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.totalVendors}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_total}</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.activeVendorsToday}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_activeToday}</p>
              </div>
              <div className="rounded-2xl bg-green-500/10 p-3 text-center">
                <p className="text-xl font-bold text-green-500">{adminStats.newVendorsThisWeek}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_newThisWeek}</p>
              </div>
              <div className="rounded-2xl bg-destructive/10 p-3 text-center">
                <p className="text-xl font-bold text-destructive">{adminStats.unverifiedVendors}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_unverified}</p>
              </div>
            </div>
          </section>

          <section className="rounded-3xl bg-card border-2 border-secondary/40 shadow-card p-5 mb-5">
            <div className="flex items-center gap-3 mb-1">
              <Users className="h-5 w-5 text-secondary" />
              <p className="font-display font-bold">{s.settings_vendorVerification}</p>
            </div>
            <p className="text-xs text-muted-foreground mb-4">{s.settings_unverifiedFirst}</p>

            <div className="flex items-center gap-2 rounded-2xl border border-border bg-background px-3 py-2 mb-4">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder={s.settings_searchPlaceholder}
                value={vendorSearch}
                onChange={(e) => setVendorSearch(e.target.value)}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-3 max-h-96 overflow-y-auto">
              {filteredVendors.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">{s.settings_noVendorsFound}</p>
              )}
              {filteredVendors.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-3 rounded-2xl border border-border p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold truncate">{v.shop_name}</p>
                      {v.is_active && <span className="text-[10px] text-green-500 font-semibold">{s.settings_live}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {v.name}{s.settings_dotSeparator}{getLabel(v.category)}
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
                      s.settings_btnLoading
                    ) : v.is_manual_verified ? (
                      <>
                        <CheckCircle className="h-3 w-3" /> {s.settings_verified}
                      </>
                    ) : (
                      <>
                        <XCircle className="h-3 w-3" /> {s.settings_unverified}
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
          <p className="font-display font-bold">{s.settings_trustSecurity}</p>
        </div>
        <div className="flex items-center gap-2 rounded-2xl bg-secondary/10 border border-secondary/30 px-4 py-3">
          <CheckCircle2 className="h-5 w-5 text-secondary shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-secondary">{s.settings_dbConnected}</p>
            <p className="text-xs text-muted-foreground">
              {s.settings_tlsNote}
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5 text-center">
        <p className="font-display font-bold text-lg">{s.settings_appName}</p>
        <p className="text-sm text-muted-foreground mt-1">{s.settings_appTagline}</p>
        <p className="text-xs text-muted-foreground mt-3">{s.settings_version}</p>
        <p className="text-xs text-muted-foreground mt-1">{s.settings_copyright}</p>
      </section>

      {devOpen && (
        <section className="rounded-3xl bg-card border-2 border-dashed border-destructive/40 p-5 mb-5 animate-fade-up">
          <div className="flex items-center gap-2 mb-3">
            <Wrench className="h-4 w-4 text-destructive" />
            <p className="text-xs uppercase tracking-wider text-destructive font-semibold">{s.settings_devMenu}</p>
          </div>
          <div className="mb-4 space-y-2">
            <label className="text-xs font-semibold text-muted-foreground" htmlFor="dev-phone-number">
              Set phone number (dev)
            </label>
            <div className="flex gap-2">
              <input
                id="dev-phone-number"
                value={devPhone}
                onChange={(e) => setDevPhone(e.target.value)}
                className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
              />
              <button
                type="button"
                onClick={() => {
                  localStorage.setItem('aaspaas:user_phone', devPhone);
                  location.reload();
                }}
                className="rounded-xl bg-destructive px-4 py-2 text-xs font-semibold text-destructive-foreground"
              >
                Save
              </button>
            </div>
          </div>
          <button
            onClick={() => setDevOpen(false)}
            className="w-full text-xs text-muted-foreground underline"
          >
            {s.settings_hideDevMenu}
          </button>
        </section>
      )}

      <button
        type="button"
        onClick={reset}
        className="w-full rounded-2xl border border-destructive/50 text-destructive bg-transparent py-4 font-semibold flex items-center justify-center gap-2"
      >
        <Trash2 className="h-4 w-4" /> {s.settings_clearMyData}
      </button>

      <AlertDialog
        open={deleteAddressId != null}
        onOpenChange={(open) => {
          if (!open) setDeleteAddressId(null);
        }}
      >
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete address?</AlertDialogTitle>
            <AlertDialogDescription>
              This address will be removed from your saved list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0" disabled={deletingAddress}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingAddress}
              onClick={(e) => {
                e.preventDefault();
                void confirmDeleteAddress();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingAddress ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {verifySheet.open && verifySheet.vendor && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closeVerifySheet} />
          <div className="relative w-full bg-card rounded-t-3xl p-5 max-h-[90vh] overflow-y-auto shadow-xl">
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-5" />

            <div className="flex items-center gap-3 mb-1">
              <ShieldAlert className="h-5 w-5 text-secondary" />
              <p className="font-display font-bold text-lg">{s.settings_verifyVendor}</p>
            </div>
            <p className="text-sm text-muted-foreground mb-1">{verifySheet.vendor.shop_name}</p>
            <p className="text-xs text-muted-foreground mb-5">
              {verifySheet.vendor.name}{s.settings_dotSeparator}{getLabel(verifySheet.vendor.category)}{s.settings_dotSeparator}{verifySheet.vendor.phone}
            </p>

            {[
              { id: "phone_called", label: s.settings_check1 },
              { id: "name_match", label: s.settings_check2 },
              { id: "aware", label: s.settings_check3 },
              { id: "shop_exists", label: s.settings_check4 },
              { id: "shop_name_match", label: s.settings_check5 },
              { id: "category_match", label: s.settings_check6 },
              { id: "service_mode_correct", label: s.settings_check7 },
              { id: "no_duplicate", label: s.settings_check8 },
              { id: "photo_genuine", label: s.settings_check9 },
              { id: "upi_verified", label: s.settings_check10 },
              { id: "no_suspicious", label: s.settings_check11 },
              { id: "rules_understood", label: s.settings_check12 },
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
              {verifying === verifySheet.vendor?.id ? s.settings_verifying : s.settings_markVerified}
            </button>

            <button
              type="button"
              onClick={closeVerifySheet}
              className="w-full text-xs text-muted-foreground underline mt-3 py-2"
            >
              {s.settings_cancel}
            </button>
          </div>
        </div>
      )}
    </AppShell>
  );
};

export default Settings;
