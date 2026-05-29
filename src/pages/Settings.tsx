import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import {
  ShieldCheck,
  Trash2,
  Wrench,
  CheckCircle2,
  Bell,
  Phone,
  MapPin,
  Camera,
  Zap,
  Globe,
  Moon,
  Sun,
  Users,
  ShieldAlert,
  Search,
  CheckCircle,
  XCircle,
  Store,
  Tag,
} from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";
import {
  supabase,
  invokeNotifyUser,
  useCategoryLabel,
  useServiceModeLabel,
  type Vendor,
} from "@/lib/supabase";
import { notifyVendorIdChanged } from "@/lib/vendorSessionSync";
import { getUserPhone, clearUserPhone } from "@/lib/userIdentity";
import { getDeviceId } from "@/lib/deviceId";
import { useLanguage } from "@/lib/language";
import { useTheme } from "@/lib/theme";
import { useAppConfig } from "@/hooks/useAppConfig";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Switch } from "@/components/ui/switch";

const LARGE_TEXT_KEY = "aaspaas:large_text";

const Settings = () => {
  const navigate = useNavigate();
  const { lang, setLang, s } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const { config } = useAppConfig();
  const languageOptions = useMemo(
    () =>
      (Object.entries(LANGUAGE_LABELS) as [Language, string][]).filter(([code]) => {
        if (code === "en") return true;
        if (code === "hi") return config.langHindiEnabled;
        if (code === "mr") return config.langMarathiEnabled;
        return false;
      }),
    [config.langHindiEnabled, config.langMarathiEnabled],
  );
  const getLabel = useCategoryLabel();
  const getServiceModeLabel = useServiceModeLabel();
  const [titleTaps, setTitleTaps] = useState(0);
  const [devOpen, setDevOpen] = useState(false);
  const userPhone = getUserPhone();
  const deviceId = getDeviceId();
  const vendorId = localStorage.getItem("aaspaas:vendor_id");
  const isAdmin = userPhone === "8888169446";
  const [devPhone, setDevPhone] = useState(userPhone ?? "");

  const [vendor, setVendor] = useState<Vendor | null>(null);
  const identityPhone = (vendor?.phone ?? "").trim() || (userPhone ?? "").trim() || null;

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
  const [pendingCategories, setPendingCategories] = useState<
    {
      id: string;
      label: string;
      emoji: string;
      service_mode: string;
      ai_confidence: string | null;
      suggested_by_vendor_id: string | null;
    }[]
  >([]);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [flaggedUsers, setFlaggedUsers] = useState<
    {
      phone: string;
      trust_score: number;
      noshow_count: number;
      fake_count: number;
      is_banned: boolean;
      ban_reason: string | null;
    }[]
  >([]);
  const [flaggedAction, setFlaggedAction] = useState<string | null>(null);
  const [banDialog, setBanDialog] = useState<{ open: boolean; phone: string | null }>({
    open: false,
    phone: null,
  });
  const [banReason, setBanReason] = useState("");
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
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const [permissionHint, setPermissionHint] = useState<string | null>(null);
  const [deletingAddress, setDeletingAddress] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  const [largeText, setLargeText] = useState(() => {
    try {
      return localStorage.getItem(LARGE_TEXT_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [activeOffer, setActiveOffer] = useState<{
    id: string;
    content: string;
    expires_at: string | null;
  } | null>(null);
  const [offerText, setOfferText] = useState("");
  const [offerExpiry, setOfferExpiry] = useState<"today" | "tomorrow" | "3days" | "7days">("today");
  const [offerLoading, setOfferLoading] = useState(false);

  const loadActiveOffer = async () => {
    if (!vendorId) {
      setActiveOffer(null);
      return;
    }
    const { data, error } = await supabase
      .from("feed_posts")
      .select("*")
      .eq("vendor_id", vendorId)
      .eq("type", "offer")
      .eq("is_hidden", false)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error) {
      console.error("loadActiveOffer", error);
      setActiveOffer(null);
      return;
    }
    setActiveOffer(
      data
        ? {
            id: data.id as string,
            content: (data.content as string) ?? "",
            expires_at: (data.expires_at as string | null) ?? null,
          }
        : null,
    );
  };

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
    if (!vendorId) {
      setActiveOffer(null);
      return;
    }
    void loadActiveOffer();
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

  const loadPendingCategories = async () => {
    const { data } = await supabase
      .from("categories")
      .select("id, label, emoji, service_mode, ai_confidence, suggested_by_vendor_id")
      .eq("pending_review", true)
      .eq("is_active", false)
      .order("created_at", { ascending: false });
    setPendingCategories(data ?? []);
  };

  useEffect(() => {
    if (!isAdmin) return;
    void loadPendingCategories();
  }, [isAdmin]);

  const loadFlaggedUsers = async () => {
    const { data, error } = await supabase
      .from("users")
      .select("phone, trust_score, noshow_count, fake_count, is_banned, ban_reason")
      .or("noshow_count.gt.0,fake_count.gt.0,is_banned.eq.true")
      .order("trust_score", { ascending: true });
    if (error) {
      console.error("loadFlaggedUsers", error);
      setFlaggedUsers([]);
      return;
    }
    setFlaggedUsers(data ?? []);
  };

  useEffect(() => {
    if (!isAdmin) return;
    void loadFlaggedUsers();
  }, [isAdmin]);

  const trustScoreClass = (score: number) => {
    if (score >= 75) return "text-green-500";
    if (score >= 50) return "text-amber-500";
    return "text-red-500";
  };

  const warnFlaggedUser = async (phone: string) => {
    setFlaggedAction(phone);
    await invokeNotifyUser({
      user_phone: phone,
      title: "⚠️ Account Warning",
      body: "Your account has received complaints from vendors. Further issues may result in suspension.",
    });
    setFlaggedAction(null);
    toast.success("Warning sent");
  };

  const confirmBanUser = async () => {
    if (!banDialog.phone || !banReason.trim()) return;
    setFlaggedAction(banDialog.phone);
    const { error } = await supabase
      .from("users")
      .update({
        is_banned: true,
        ban_reason: banReason.trim(),
        trust_score: 0,
      })
      .eq("phone", banDialog.phone);
    setFlaggedAction(null);
    if (error) {
      console.error("confirmBanUser", error);
      return;
    }
    toast.success("User banned");
    setBanDialog({ open: false, phone: null });
    setBanReason("");
    await loadFlaggedUsers();
  };

  const unbanFlaggedUser = async (phone: string) => {
    setFlaggedAction(phone);
    const { error } = await supabase
      .from("users")
      .update({
        is_banned: false,
        ban_reason: null,
        trust_score: 50,
      })
      .eq("phone", phone);
    setFlaggedAction(null);
    if (error) {
      console.error("unbanFlaggedUser", error);
      return;
    }
    toast.success("User unbanned");
    await loadFlaggedUsers();
  };

  const approvePendingCategory = async (categoryId: string) => {
    setPendingAction(categoryId);
    const { error } = await supabase
      .from("categories")
      .update({ is_active: true, pending_review: false })
      .eq("id", categoryId);
    setPendingAction(null);
    if (error) {
      toast.error("Update failed: " + error.message);
      return;
    }
    await loadPendingCategories();
  };

  const rejectPendingCategory = async (categoryId: string) => {
    setPendingAction(categoryId);
    const { error: updateError } = await supabase
      .from("categories")
      .update({ pending_review: false, is_active: false })
      .eq("id", categoryId);
    if (updateError) {
      setPendingAction(null);
      toast.error("Update failed: " + updateError.message);
      return;
    }
    const { error: deleteError } = await supabase
      .from("categories")
      .delete()
      .eq("id", categoryId);
    setPendingAction(null);
    if (deleteError) {
      toast.error("Delete failed: " + deleteError.message);
      return;
    }
    await loadPendingCategories();
  };

  const confidenceBadgeClass = (confidence: string | null) => {
    if (confidence === "high") {
      return "bg-green-500/10 text-green-700 border border-green-500/30";
    }
    if (confidence === "medium") {
      return "bg-amber-500/10 text-amber-700 border border-amber-500/30";
    }
    if (confidence === "low") {
      return "bg-destructive/10 text-destructive border border-destructive/30";
    }
    return "bg-muted text-muted-foreground border border-border";
  };

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
    localStorage.removeItem("aaspaas:role");
    localStorage.removeItem("aaspaas:vendor_id");
    clearUserPhone();
    notifyVendorIdChanged();
    setClearDataOpen(false);
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

  const inviteFriend = async () => {
    const shareMessage = `Get help around you, now! Download Aaspaas: ${config.appBaseUrl}`;
    if (navigator.share) {
      try {
        await navigator.share({ text: shareMessage });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    await navigator.clipboard.writeText(shareMessage);
  };

  const computeOfferExpiry = () => {
    if (offerExpiry === "today") {
      return new Date(new Date().setHours(23, 59, 59, 999)).toISOString();
    }
    if (offerExpiry === "tomorrow") {
      return new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    }
    if (offerExpiry === "3days") {
      return new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    }
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  };

  const postOffer = async () => {
    if (!vendorId) return;
    const content = offerText.trim();
    if (!content) return;
    setOfferLoading(true);
    const { error } = await supabase.from("feed_posts").insert({
      type: "offer",
      vendor_id: vendorId,
      user_phone: getUserPhone(),
      content,
      is_hidden: false,
      expires_at: computeOfferExpiry(),
    });
    setOfferLoading(false);
    if (error) {
      console.error("postOffer", error);
      toast.error(error.message);
      return;
    }
    setOfferText("");
    setOfferExpiry("today");
    await loadActiveOffer();
    toast("Offer posted!");
  };

  const removeOffer = async () => {
    if (!activeOffer) return;
    setOfferLoading(true);
    const { error } = await supabase
      .from("feed_posts")
      .update({ is_hidden: true })
      .eq("id", activeOffer.id);
    setOfferLoading(false);
    if (error) {
      console.error("removeOffer", error);
      toast.error(error.message);
      return;
    }
    setActiveOffer(null);
    toast("Offer removed");
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

      {!vendorId && (
        <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
          <button
            type="button"
            onClick={() => navigate("/vendor")}
            className="w-full flex items-center gap-3 rounded-2xl border border-border bg-muted/30 px-4 py-3 text-left active:scale-[0.99] transition-transform hover:bg-muted/50"
          >
            <span className="h-10 w-10 shrink-0 rounded-xl bg-secondary/10 border border-secondary/30 grid place-items-center">
              <Store className="h-5 w-5 text-secondary" />
            </span>
            <span className="text-sm font-semibold text-foreground">{s.settings_register_business}</span>
          </button>
          <p className="text-xs text-muted-foreground mt-3">{s.settings_register_business_sub}</p>
        </section>
      )}

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="flex items-center gap-3 mb-3">
          <Phone className="h-5 w-5 text-secondary" />
          <p className="font-display font-bold">{s.settings_myIdentity}</p>
        </div>
        {identityPhone != null ? (
          <div>
            <p className="text-sm font-semibold text-foreground">{s.settings_phonePrefix}{identityPhone}</p>
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
          <p className="text-sm text-muted-foreground">{s.settings_noAddresses}</p>
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

      {vendor == null && (
        <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
          <button
            type="button"
            onClick={() => void inviteFriend()}
            className="w-full rounded-2xl bg-secondary text-secondary-foreground px-4 py-3 text-sm font-semibold transition-colors active:scale-[0.99]"
          >
            {s.settings_shareApp}
          </button>
        </section>
      )}

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
        <Select value={lang} onValueChange={(value) => setLang(value as Language)}>
          <SelectTrigger className="w-full rounded-2xl border-border bg-background h-auto px-4 py-3 font-semibold text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languageOptions.map(([code, label]) => (
              <SelectItem key={code} value={code}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <p className="font-display font-bold mb-3">{s.settings_accessibility}</p>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{s.settings_largeText}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{s.settings_largeTextHint}</p>
          </div>
          <Switch
            className="data-[state=checked]:bg-brand"
            checked={largeText}
            onCheckedChange={(checked) => {
              setLargeText(checked);
              try {
                localStorage.setItem(LARGE_TEXT_KEY, checked ? "true" : "false");
              } catch {
                /* ignore */
              }
              document.documentElement.classList.toggle("large-text", checked);
            }}
          />
        </div>
      </section>

      {vendorId && !vendor && (
        <p className="text-sm text-muted-foreground mb-5">{s.settings_loading}</p>
      )}
      {vendor && <VendorSettings vendor={vendor} onVendorUpdated={setVendor} />}
      {vendorId && (
        <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
          <div className="flex items-center gap-3 mb-3">
            <Tag className="h-5 w-5 text-secondary" />
            <p className="font-display font-bold">Post an Offer</p>
          </div>

          {activeOffer ? (
            <div className="space-y-3">
              <p className="text-sm text-foreground">{activeOffer.content}</p>
              <p className="text-xs text-muted-foreground">
                Expires:{" "}
                {activeOffer.expires_at ? new Date(activeOffer.expires_at).toLocaleString() : "—"}
              </p>
              <button
                type="button"
                onClick={() => void removeOffer()}
                disabled={offerLoading}
                className="rounded-xl border border-destructive/40 text-destructive px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <input
                type="text"
                maxLength={100}
                value={offerText}
                onChange={(e) => setOfferText(e.target.value)}
                placeholder="e.g. 20% off groceries today"
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["today", "Today"],
                    ["tomorrow", "Tomorrow"],
                    ["3days", "3 days"],
                    ["7days", "7 days"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setOfferExpiry(value)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${
                      offerExpiry === value
                        ? "bg-secondary text-secondary-foreground border-secondary"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void postOffer()}
                disabled={offerLoading || offerText.trim().length === 0}
                className="rounded-xl bg-green-500 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                Post Offer
              </button>
            </div>
          )}
        </section>
      )}

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
            <p className="font-display font-bold mb-4">
              {s.admin_pendingCategories} ({pendingCategories.length})
            </p>
            {pendingCategories.length === 0 ? (
              <p className="text-sm text-muted-foreground">{s.admin_noPendingCategories}</p>
            ) : (
              <div className="space-y-3">
                {pendingCategories.map((cat) => (
                  <div
                    key={cat.id}
                    className="rounded-2xl border border-border p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg" aria-hidden>
                        {cat.emoji}
                      </span>
                      <p className="text-sm font-semibold">{cat.label}</p>
                      <span className="rounded-full bg-secondary/10 text-secondary text-[10px] font-semibold px-2 py-0.5 border border-secondary/30">
                        {getServiceModeLabel(cat.service_mode)}
                      </span>
                      {cat.ai_confidence && (
                        <span
                          className={`rounded-full text-[10px] font-semibold px-2 py-0.5 ${confidenceBadgeClass(cat.ai_confidence)}`}
                        >
                          {cat.ai_confidence}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void approvePendingCategory(cat.id)}
                        disabled={pendingAction === cat.id}
                        className="flex-1 rounded-xl bg-green-500/10 text-green-700 border border-green-500/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        ✅ {s.admin_approve}
                      </button>
                      <button
                        type="button"
                        onClick={() => void rejectPendingCategory(cat.id)}
                        disabled={pendingAction === cat.id}
                        className="flex-1 rounded-xl bg-destructive/10 text-destructive border border-destructive/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        ❌ {s.admin_reject}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
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

          <section className="rounded-3xl bg-card border-2 border-secondary/40 shadow-card p-5 mb-5">
            <div className="flex items-center gap-3 mb-1">
              <ShieldAlert className="h-5 w-5 text-secondary" />
              <p className="font-display font-bold">Flagged Users</p>
            </div>
            <p className="text-xs text-muted-foreground mb-4">{s.settings_adminOnly}</p>

            {flaggedUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground">✅ No flagged users at this time</p>
            ) : (
              <div className="space-y-3">
                {flaggedUsers.map((user) => (
                  <div
                    key={user.phone}
                    className="rounded-2xl border border-border p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold">{user.phone}</p>
                      {user.is_banned && (
                        <span className="rounded-full bg-destructive/10 text-destructive text-[10px] font-bold px-2 py-0.5 border border-destructive/30">
                          BANNED
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Trust score:{" "}
                      <span className={`font-semibold ${trustScoreClass(user.trust_score)}`}>
                        {user.trust_score}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {user.noshow_count} no-shows, {user.fake_count} fakes
                    </p>
                    {user.is_banned && user.ban_reason && (
                      <p className="text-[11px] text-destructive/80">{user.ban_reason}</p>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void warnFlaggedUser(user.phone)}
                        disabled={flaggedAction === user.phone}
                        className="flex-1 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        Warn
                      </button>
                      {!user.is_banned && (
                        <button
                          type="button"
                          onClick={() => {
                            setBanReason("");
                            setBanDialog({ open: true, phone: user.phone });
                          }}
                          disabled={flaggedAction === user.phone}
                          className="flex-1 rounded-xl bg-destructive/10 text-destructive border border-destructive/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                        >
                          Ban
                        </button>
                      )}
                      {user.is_banned && (
                        <button
                          type="button"
                          onClick={() => void unbanFlaggedUser(user.phone)}
                          disabled={flaggedAction === user.phone}
                          className="flex-1 rounded-xl bg-green-500/10 text-green-700 border border-green-500/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                        >
                          Unban
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <AlertDialog
            open={banDialog.open}
            onOpenChange={(open) => {
              if (!open) {
                setBanDialog({ open: false, phone: null });
                setBanReason("");
              }
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>Ban this user?</AlertDialogTitle>
                <AlertDialogDescription>
                  Enter a reason for the ban. The user will be notified on their next order attempt.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <input
                type="text"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value.slice(0, 200))}
                placeholder="Ban reason"
                className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
                <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={!banReason.trim() || flaggedAction != null}
                  onClick={(e) => {
                    e.preventDefault();
                    void confirmBanUser();
                  }}
                >
                  Confirm ban
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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

      {Capacitor.isNativePlatform() && (
        <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
          <p className="font-display font-bold mb-3">Permissions</p>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-background px-3 py-3">
              <div className="min-w-0 flex items-start gap-3">
                <Bell className="h-4 w-4 text-secondary mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">Notifications</p>
                  <p className="text-xs text-muted-foreground">Required for order alerts</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPermissionHint("Notifications")}
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold"
              >
                Open Settings
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-background px-3 py-3">
              <div className="min-w-0 flex items-start gap-3">
                <MapPin className="h-4 w-4 text-secondary mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">Location</p>
                  <p className="text-xs text-muted-foreground">Required for help mode tracking</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPermissionHint("Location")}
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold"
              >
                Open Settings
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-background px-3 py-3">
              <div className="min-w-0 flex items-start gap-3">
                <Camera className="h-4 w-4 text-secondary mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">Camera</p>
                  <p className="text-xs text-muted-foreground">Required for shop verification</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPermissionHint("Camera")}
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold"
              >
                Open Settings
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-background px-3 py-3">
              <div className="min-w-0 flex items-start gap-3">
                <Zap className="h-4 w-4 text-secondary mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">Battery optimization</p>
                  <p className="text-xs text-muted-foreground">Keep app awake for orders</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPermissionHint("Battery optimization")}
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold"
              >
                Open Settings
              </button>
            </div>
          </div>

          <AlertDialog
            open={permissionHint != null}
            onOpenChange={(open) => {
              if (!open) setPermissionHint(null);
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>Open Settings</AlertDialogTitle>
                <AlertDialogDescription>
                  Go to Android Settings → Apps → AasPaas Pro → Permissions and enable{" "}
                  {permissionHint}.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogAction className="mt-0">OK</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </section>
      )}

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
        onClick={() => setClearDataOpen(true)}
        className="w-full rounded-2xl border border-destructive/50 text-destructive bg-transparent py-4 font-semibold flex items-center justify-center gap-2"
      >
        <Trash2 className="h-4 w-4" /> {s.settings_clearMyData}
      </button>

      <AlertDialog open={clearDataOpen} onOpenChange={setClearDataOpen}>
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.settings_clearDataTitle}</AlertDialogTitle>
            <AlertDialogDescription>{s.settings_clearDataDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0">{s.settings_cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                reset();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {s.settings_clearDataConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
