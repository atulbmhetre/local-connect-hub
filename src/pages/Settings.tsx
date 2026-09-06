import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import {
  Trash2,
  Store,
  Loader2,
  ChevronRight,
  Moon,
  Sun,
  MapPin,
  Camera,
  Zap,
  Globe,
  Phone,
  CheckCircle2,
} from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { toast } from "sonner";
import {
  applyPermissionRequestResult,
  checkNativePermissionStatuses,
  DEFAULT_NATIVE_PERMISSION_STATUSES,
  isPermissionGranted,
  requestNativePermission,
  type NativePermissionKind,
  type NativePermissionStatuses,
} from "@/lib/nativePermissions";
import {
  supabase,
  invokeDeleteAccount,
  invokeCancelDeletion,
  type Vendor,
} from "@/lib/supabase";
import { NotificationBell } from "@/components/NotificationBell";
import { notifyVendorIdChanged } from "@/lib/vendorSessionSync";
import { stopAllVendorLocationTracking } from "@/lib/vendorBackgroundLocation";
import { getUserPhone, ensureUserDeviceLink, migrateUserPhone, restoreVendorSession } from "@/lib/userIdentity";
import { showClearMyDataSuccessThenReload } from "@/lib/clearMyDataFeedback";
import { PhoneEntrySheet } from "@/components/PhoneEntrySheet";
import { fetchVendorOwn } from "@/lib/vendorRead";
import { formatVendorDeletionDate } from "@/lib/vendorDeletion";
import { getDeviceId } from "@/lib/deviceId";
import { resolveAccountStanding } from "@/lib/accountStanding";
import { useLanguage } from "@/lib/language";
import { useTheme } from "@/lib/theme";
import { MAX_ADDRESS_TEXT_CHARS } from "@/lib/addressLimits";
import { useAppConfig } from "@/hooks/useAppConfig";
import { useFeedNotificationsEnabled } from "@/hooks/useFeedNotificationsEnabled";
import { FeedReachChips } from "@/components/FeedReachChips";
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
import {
  VendorSettings,
  VendorSettingsReferEarn,
  type VendorReferralCredits,
} from "@/components/settings/VendorSettings";
import { VendorMyBusiness } from "@/components/settings/VendorMyBusiness";
const AdminConsole = lazy(() =>
  import("@/components/settings/AdminConsole").then((m) => ({ default: m.AdminConsole })),
);
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { isWebDesktopShell } from "@/lib/desktopShell";
import { Input } from "@/components/ui/input";
import {
  SettingsPageHeader,
  SettingsCard,
  SettingsRow,
  SettingsCollapsible,
  SettingsParentCollapsible,
} from "@/components/settings/SettingsSection";
import { captureError, phoneSuffix } from "@/lib/sentry";

const LARGE_TEXT_KEY = "aaspaas:large_text";
const VOICE_LANG_KEY = "aaspaas:voice_lang";

type VoiceInputLang = "auto" | "en-IN" | "hi-IN" | "mr-IN";

const VOICE_INPUT_OPTIONS: { code: VoiceInputLang; labelKey: "settings_voiceAuto" | "settings_voiceEnglish" | "settings_voiceHindi" | "settings_voiceMarathi" }[] = [
  { code: "auto", labelKey: "settings_voiceAuto" },
  { code: "en-IN", labelKey: "settings_voiceEnglish" },
  { code: "hi-IN", labelKey: "settings_voiceHindi" },
  { code: "mr-IN", labelKey: "settings_voiceMarathi" },
];

const Settings = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { lang, setLang, s } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const { config } = useAppConfig();
  const [referEarnVisible, setReferEarnVisible] = useState(true);
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
  const [titleTaps, setTitleTaps] = useState(0);
  const [adminTabRevealed, setAdminTabRevealed] = useState(false);
  const [identityNonce, setIdentityNonce] = useState(0);
  const userPhone = getUserPhone();
  void identityNonce;
  const deviceId = getDeviceId();
  const vendorId = localStorage.getItem("aaspaas:vendor_id");
  const isVendor = Boolean(vendorId?.trim());
  const [phoneEntryOpen, setPhoneEntryOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminAuthChecked, setAdminAuthChecked] = useState(false);
  const [adminSessionEmail, setAdminSessionEmail] = useState<string | null>(null);


  const checkAdminSession = useCallback(async (): Promise<boolean> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setIsAdmin(false);
      setAdminSessionEmail(null);
      return false;
    }

    setAdminSessionEmail(session.user.email?.trim() || null);

    const { data, error } = await supabase.rpc("is_admin_session");
    if (error) {
      console.error("is_admin_session", error);
      setIsAdmin(false);
      return false;
    }

    const admin = data === true;
    setIsAdmin(admin);
    return admin;
  }, []);

  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [vendorExtras, setVendorExtras] = useState<{
    referralCredits: VendorReferralCredits;
  } | null>(null);
  const identityPhone = (vendor?.phone ?? "").trim() || (userPhone ?? "").trim() || null;

  const {
    addresses,
    loading: addressesLoading,
    failed: addressesFailed,
    refresh: refreshAddresses,
  } = useUserAddresses();
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [editAddressValue, setEditAddressValue] = useState("");
  const [deleteAddressId, setDeleteAddressId] = useState<string | null>(null);
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const [clearingData, setClearingData] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [dualRoleDelete, setDualRoleDelete] = useState(false);
  const [deleteAccountLoading, setDeleteAccountLoading] = useState(false);
  const [vendorDeletionRequestedAt, setVendorDeletionRequestedAt] = useState<string | null>(null);
  const [permissionHint, setPermissionHint] = useState<string | null>(null);
  const [permissionStatuses, setPermissionStatuses] = useState<NativePermissionStatuses>(
    DEFAULT_NATIVE_PERMISSION_STATUSES,
  );
  /** Skip resume refresh while an OS permission dialog is open (avoids false ✅). */
  const permissionRequestInFlightRef = useRef(false);
  const [deletingAddress, setDeletingAddress] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  const [voiceInputLang, setVoiceInputLang] = useState<VoiceInputLang>(() => {
    const stored = localStorage.getItem(VOICE_LANG_KEY);
    if (stored === "auto") return "auto";
    if (stored === "en-IN" || stored === "hi-IN" || stored === "mr-IN") return stored;
    return "auto";
  });
  const [largeText, setLargeText] = useState(() => {
    try {
      return localStorage.getItem(LARGE_TEXT_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [addressesOpen, setAddressesOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [accountStandingOpen, setAccountStandingOpen] = useState(false);
  const [feedDiscoveryOpen, setFeedDiscoveryOpen] = useState(false);
  const [userTrust, setUserTrust] = useState<{
    trust_score: number | null;
    warn_count: number | null;
    is_banned: boolean;
  } | null>(null);
  // True only when the trust RPC itself failed — distinct from "no row yet",
  // which is a legitimately good standing, not an unknown one.
  const [trustLoadFailed, setTrustLoadFailed] = useState(false);
  const [trustLoading, setTrustLoading] = useState(() => Boolean(getUserPhone()?.trim()));
  const [accountOpen, setAccountOpen] = useState(false);
  const [shopOpen, setShopOpen] = useState(() => Boolean(vendorId?.trim()));
  const initialVendorPanelTab =
    (location.state as { vendorSettingsTab?: string } | null)?.vendorSettingsTab === "preferences"
      ? "preferences"
      : "business";
  const [vendorPanelTab, setVendorPanelTab] = useState<"business" | "preferences">(
    initialVendorPanelTab,
  );
  const openVendorReviews = Boolean(
    (location.state as { openVendorReviews?: boolean } | null)?.openVendorReviews,
  );

  useEffect(() => {
    const tab = (location.state as { vendorSettingsTab?: string } | null)?.vendorSettingsTab;
    if (tab === "business" || tab === "preferences") {
      setVendorPanelTab(tab);
    }
  }, [location.state]);
  const [referOpen, setReferOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);

  const refreshPermissionStatuses = useCallback(() => {
    // Live OS read only — never write/read an app-level permission cache.
    void checkNativePermissionStatuses()
      .then(setPermissionStatuses)
      .catch(() => {
        /* keep last known statuses */
      });
  }, []);

  const handlePermissionRequest = async (kind: NativePermissionKind, deniedLabel: string) => {
    if (!Capacitor.isNativePlatform()) return;

    const current = permissionStatuses[kind];
    if (isPermissionGranted(current)) return;
    if (current === "denied") {
      setPermissionHint(deniedLabel);
      return;
    }

    permissionRequestInFlightRef.current = true;
    try {
      const result = await requestNativePermission(kind);
      // Trust the OS request callback for this kind; never tick ✅ on dismiss alone.
      let live = DEFAULT_NATIVE_PERMISSION_STATUSES;
      try {
        live = await checkNativePermissionStatuses();
      } catch {
        /* use defaults + request result below */
      }
      setPermissionStatuses(applyPermissionRequestResult(live, kind, result));
      if (result === "denied") {
        setPermissionHint(deniedLabel);
      }
    } catch {
      setPermissionHint(deniedLabel);
      refreshPermissionStatuses();
    } finally {
      permissionRequestInFlightRef.current = false;
    }
  };

  const permissionRevokeHint = (status: NativePermissionStatuses[NativePermissionKind]) =>
    isPermissionGranted(status) ? (
      <span
        className="block mt-1 text-xs leading-snug text-muted-foreground"
        data-testid="settings-permission-revoke-hint"
      >
        {s.settings_permission_revoke_hint}
      </span>
    ) : null;

  const permissionSublabel = (
    status: NativePermissionStatuses[NativePermissionKind],
    base: string,
  ) => (
    <>
      {base}
      {permissionRevokeHint(status)}
    </>
  );

  const renderPermissionAction = (
    status: NativePermissionStatuses[NativePermissionKind],
    onRequest: () => void,
  ) => {
    if (isPermissionGranted(status)) {
      return (
        <span
          className="shrink-0 text-lg leading-none"
          aria-label="Granted"
          data-testid="settings-permission-granted"
        >
          ✅
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={onRequest}
        data-testid="settings-permission-allow"
        className="shrink-0 min-h-[44px] rounded-lg border border-surface-border px-3 py-1 text-xs font-semibold text-foreground"
      >
        {s.settings_permission_request}
      </button>
    );
  };
  const { enabled: feedNotificationsEnabled, onCheckedChange: onFeedNotificationsChange } =
    useFeedNotificationsEnabled();
  const [feedDiscoveryRadiusKm, setFeedDiscoveryRadiusKm] = useState<number | null>(5);

  useEffect(() => {
    const phone = userPhone?.trim();
    if (!phone) return;
    void supabase.rpc("get_feed_preferences", { p_user_phone: phone }).then(({ data, error }) => {
      if (error) {
        console.error("get_feed_preferences", error);
        toast.error(s.settings_feedDiscoveryLoadError);
        return;
      }
      const raw = (data as { feed_discovery_radius_km?: number | null } | null)
        ?.feed_discovery_radius_km;
      setFeedDiscoveryRadiusKm(raw === null ? null : (raw ?? 5));
    });
  }, [userPhone, s.settings_feedDiscoveryLoadError]);

  const onFeedDiscoveryRadiusChange = async (km: number | null) => {
    const phone = userPhone?.trim();
    if (!phone) return;
    const previous = feedDiscoveryRadiusKm;
    setFeedDiscoveryRadiusKm(km);
    const { error } = await supabase.rpc("set_feed_discovery_radius", {
      p_user_phone: phone,
      p_radius_km: km,
    });
    if (error) {
      console.error("set_feed_discovery_radius", error);
      captureError(error, { scope: "settings.setFeedDiscoveryRadius" });
      setFeedDiscoveryRadiusKm(previous);
      toast.error(s.feed_notifyToggle_saveError);
      return;
    }
    toast.success(s.settings_feedDiscoveryRadiusSaved);
  };

  const [activeTab, setActiveTab] = useState<"settings" | "admin">("settings");

  useEffect(() => {
    void (async () => {
      await checkAdminSession();
      setAdminAuthChecked(true);
    })();
  }, [checkAdminSession]);

  // Defense-in-depth: /settings/admin requires session; reveal tab + stay on login if not admin.
  useEffect(() => {
    const onAdminRoute = location.pathname === "/settings/admin";
    if (!onAdminRoute) return;
    setAdminTabRevealed(true);
    setActiveTab("admin");
  }, [location.pathname]);

  useEffect(() => {
    if (!adminAuthChecked) return;
    if (location.pathname !== "/settings/admin") return;
    if (!isAdmin) {
      // Keep admin tab visible so login gate renders; do not show panel.
      setActiveTab("admin");
    }
  }, [adminAuthChecked, isAdmin, location.pathname]);

  // Session drop while viewing admin → force login gate (never leave panel open).
  useEffect(() => {
    if (!adminAuthChecked) return;
    if (activeTab === "admin" && !isAdmin) {
      setAdminTabRevealed(true);
    }
  }, [adminAuthChecked, activeTab, isAdmin]);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void checkAdminSession();
    });
    return () => subscription.unsubscribe();
  }, [checkAdminSession]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from("app_config")
        .select("value")
        .eq("key", "referral_enabled")
        .maybeSingle();
      const raw = data?.value?.trim().toLowerCase();
      if (raw === "false" || raw === "0") setReferEarnVisible(false);
      else setReferEarnVisible(true);
    })();
  }, []);

  useEffect(() => {
    if (isAdmin && adminTabRevealed) setActiveTab("admin");
  }, [isAdmin, adminTabRevealed]);

  useEffect(() => {
    const phone = userPhone?.trim();
    if (!phone) {
      setUserTrust(null);
      setTrustLoadFailed(false);
      setTrustLoading(false);
      return;
    }
    setTrustLoading(true);
    void (async () => {
      const { data, error } = await supabase.rpc("lookup_user_by_phone", { p_phone: phone });
      if (error) {
        captureError(error, { scope: "settings.loadUserTrust" });
        console.error("loadUserTrust", error);
        setUserTrust(null);
        setTrustLoadFailed(true);
        setTrustLoading(false);
        return;
      }
      setTrustLoadFailed(false);
      const row = data?.[0];
      setUserTrust(
        row
          ? {
              trust_score: row.trust_score,
              warn_count: row.warn_count,
              is_banned: row.is_banned,
            }
          : null,
      );
      setTrustLoading(false);
    })();
  }, [userPhone]);

  const accountStanding = useMemo(
    () =>
      resolveAccountStanding({
        loading: trustLoading,
        loadFailed: trustLoadFailed,
        userTrust,
        labels: {
          trust_status_loading: s.trust_status_loading,
          trust_status_unavailable: s.trust_status_unavailable,
          trust_status_good: s.trust_status_good,
          trust_status_fair: s.trust_status_fair,
          trust_status_complaints: s.trust_status_complaints,
          trust_status_banned: s.trust_status_banned,
        },
      }),
    [userTrust, trustLoadFailed, trustLoading, s],
  );
  const [vendorLoadFailed, setVendorLoadFailed] = useState(false);
  const loadVendorOwn = useCallback(async () => {
    if (!vendorId) return;
    setVendorLoadFailed(false);
    const phone = getUserPhone()?.trim();
    if (!phone) {
      console.error("Failed to load vendor: phone required");
      setVendorLoadFailed(true);
      return;
    }
    const { data, error } = await fetchVendorOwn(vendorId, phone);
    if (error) {
      captureError(error, { scope: "settings.fetchVendorOwn", vendorId });
      console.error("Failed to load vendor:", error.message);
      setVendorLoadFailed(true);
      return;
    }
    if (data) setVendor(data);
  }, [vendorId]);

  useEffect(() => {
    void loadVendorOwn();
  }, [loadVendorOwn]);

  // Batch-fetch referral credits for Preferences (menu/offers live under My Business).
  useEffect(() => {
    if (!vendorId) {
      setVendorExtras(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const vendorPhoneForCredits = getUserPhone()?.trim();
      const creditsRes = vendorPhoneForCredits
        ? await supabase.rpc("get_vendor_credits", {
            p_vendor_id: vendorId,
            p_vendor_phone: vendorPhoneForCredits,
          })
        : { data: [], error: null };

      if (cancelled) return;
      if (creditsRes.error) {
        captureError(creditsRes.error, { scope: "settings.vendorExtras.credits", vendorId });
        console.error("vendorExtras credits", creditsRes.error);
      }

      let total = 0;
      let pending = 0;
      for (const row of creditsRes.data ?? []) {
        const amt = Number(row.amount) || 0;
        total += amt;
        if (!row.disbursed) pending += amt;
      }
      setVendorExtras({
        referralCredits: creditsRes.error
          ? { total: 0, pending: 0, failed: true }
          : { total, pending },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

  useEffect(() => {
    const phone = userPhone?.trim();
    if (!phone) {
      setVendorDeletionRequestedAt(null);
      return;
    }
    void (async () => {
      let at: string | null = null;
      if (isVendor) {
        const { data, error } = await supabase.rpc("get_vendor_deletion_status", {
          p_phone: phone,
        });
        if (error) {
          console.error("loadVendorDeletionRequestedAt", error);
        } else {
          const row = Array.isArray(data) ? data[0] : null;
          at = row?.deletion_requested_at ?? null;
        }
      }
      if (!at) {
        const { data, error } = await supabase.rpc("get_user_deletion_status", {
          p_phone: phone,
        });
        if (error) {
          console.error("loadUserDeletionRequestedAt", error);
        } else {
          const row = Array.isArray(data) ? data[0] : null;
          at = row?.deletion_requested_at ?? null;
        }
      }
      setVendorDeletionRequestedAt(at);
    })();
  }, [userPhone, isVendor]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    // Permission badges only — do not navigate, reload, or remount routes on resume.
    const refreshIfIdle = () => {
      if (permissionRequestInFlightRef.current) return;
      refreshPermissionStatuses();
    };

    refreshIfIdle();

    let listener: { remove: () => Promise<void> } | undefined;
    void App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) refreshIfIdle();
    }).then((handle) => {
      listener = handle;
    });

    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshIfIdle();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      void listener?.remove();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshPermissionStatuses]);

  // Re-read OS permissions whenever the Device section is opened (post Clear Data / new user).
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !deviceOpen) return;
    if (permissionRequestInFlightRef.current) return;
    refreshPermissionStatuses();
  }, [deviceOpen, refreshPermissionStatuses]);


  // Hidden gesture: tap the page title 7× to reveal the Admin tab (login still required).
  const tapTitle = () => {
    const next = titleTaps + 1;
    setTitleTaps(next);
    if (next >= 7) {
      setTitleTaps(0);
      setAdminTabRevealed(true);
    }
  };

  const reset = async () => {
    if (clearingData) return;
    setClearingData(true);
    try {
      await stopAllVendorLocationTracking();
      const phone = localStorage.getItem("aaspaas:user_phone");
      const deviceId = getDeviceId();
      if (phone) {
        const { error } = await supabase.rpc("clear_my_data", {
          p_user_phone: phone,
          p_device_id: deviceId,
        });
        if (error) {
          captureError(error, { scope: "settings.clearMyData", phoneSuffix: phoneSuffix(phone) });
          toast.error(s.settings_clearDataFailed);
          return;
        }
      }

      Object.keys(localStorage)
        .filter((key) => key.startsWith("aaspaas:"))
        .forEach((key) => localStorage.removeItem(key));

      for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
        const key = sessionStorage.key(i);
        if (key?.startsWith("aaspaas:")) sessionStorage.removeItem(key);
      }

      let notificationNudge: string | undefined;
      try {
        const live = await checkNativePermissionStatuses();
        if (isPermissionGranted(live.notifications)) {
          notificationNudge = s.settings_clearDataDescription_permissions;
        }
      } catch {
        /* OS check failed — skip the post-clear nudge */
      }

      setClearDataOpen(false);
      showClearMyDataSuccessThenReload({
        message: phone ? s.settings_accountDataCleared : s.settings_localDataCleared,
        description: notificationNudge,
        toastSuccess: (message, description) =>
          description
            ? toast.success(message, { description })
            : toast.success(message),
      });
    } finally {
      setClearingData(false);
    }
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
    const trimmed = editAddressValue.trim().slice(0, MAX_ADDRESS_TEXT_CHARS);
    if (!trimmed || !editingAddressId) {
      toast.error(s.settings_addressEmptyError);
      return;
    }
    setSavingAddress(true);
    const phone = userPhone?.trim();
    if (!phone) {
      setSavingAddress(false);
      toast.error(s.settings_addressPhoneRequiredSave);
      return;
    }
    const { error } = await supabase.rpc("update_user_address", {
      p_user_phone: phone,
      p_address_id: editingAddressId,
      p_address_text: trimmed,
    });
    setSavingAddress(false);
    if (error) {
      captureError(error, { scope: "settings.saveEditAddress" });
      toast.error(error.message);
      return;
    }
    cancelEditAddress();
    await refreshAddresses();
  };

  const confirmDeleteAddress = async () => {
    if (!deleteAddressId) return;
    setDeletingAddress(true);
    const phone = userPhone?.trim();
    if (!phone) {
      setDeletingAddress(false);
      toast.error(s.settings_addressPhoneRequiredDelete);
      return;
    }
    const { error } = await supabase.rpc("delete_user_address", {
      p_user_phone: phone,
      p_address_id: deleteAddressId,
    });
    setDeletingAddress(false);
    if (error) {
      captureError(error, { scope: "settings.confirmDeleteAddress" });
      toast.error(error.message);
      return;
    }
    setDeleteAddressId(null);
    if (editingAddressId === deleteAddressId) {
      cancelEditAddress();
    }
    await refreshAddresses();
  };

  const openDeleteAccountConfirm = async () => {
    const phone = userPhone?.trim();
    if (!phone) {
      setDualRoleDelete(false);
      setDeleteConfirmOpen(true);
      return;
    }

    // OTP-off: both vendors (hidden/draft rows) and users are unreadable
    // directly under RLS; use the phone-identity RPCs instead.
    const [{ data: vendorRows }, { data: userRows }] = await Promise.all([
      supabase.rpc("get_vendor_deletion_status", { p_phone: phone }),
      supabase.rpc("lookup_user_by_phone", { p_phone: phone }),
    ]);

    const vendorExists = Array.isArray(vendorRows) && vendorRows.length > 0;
    const userExists = Array.isArray(userRows) && userRows.length > 0;
    setDualRoleDelete(vendorExists && userExists);
    setDeleteConfirmOpen(true);
  };

  const confirmDeleteAccount = async () => {
    const phone = userPhone?.trim();
    if (!phone) return;

    setDeleteAccountLoading(true);
    // Catch phones saved before ensure_user_device_link existed (web / no-push).
    await ensureUserDeviceLink(phone);
    const result = await invokeDeleteAccount(
      phone,
      isVendor ? "vendor" : "customer",
      deviceId,
    );
    setDeleteAccountLoading(false);
    setDeleteConfirmOpen(false);

    if (result.ok === false) {
      captureError(new Error(result.error), { scope: "settings.invokeDeleteAccount" });
      toast.error(result.error);
      return;
    }

    if (isVendor) {
      const { data } = await supabase.rpc("get_vendor_deletion_status", {
        p_phone: phone,
      });
      const row = Array.isArray(data) ? data[0] : null;
      setVendorDeletionRequestedAt(
        row?.deletion_requested_at ?? new Date().toISOString(),
      );
      toast.success(s.delete_account_success_vendor);
      return;
    }

    setVendorDeletionRequestedAt(new Date().toISOString());
    toast.success(s.delete_account_success_vendor);
  };

  const cancelAccountDeletion = async () => {
    const phone = userPhone?.trim();
    if (!phone) return;

    setDeleteAccountLoading(true);
    const result = await invokeCancelDeletion(phone, deviceId);
    setDeleteAccountLoading(false);

    if (result.ok === false) {
      captureError(new Error(result.error), { scope: "settings.invokeCancelDeletion" });
      toast.error(result.error);
      return;
    }

    setVendorDeletionRequestedAt(null);

    let restoredId = vendorId?.trim() || "";
    let restoredActive = vendor?.is_active === true;
    if (!restoredId) {
      const { data } = await supabase.rpc("get_vendor_restore_status", {
        p_phone: phone,
      });
      const status = data as {
        vendor_id?: string | null;
        restore_allowed?: boolean;
        is_active?: boolean;
      } | null;
      if (status?.restore_allowed && status.vendor_id) {
        restoredId = status.vendor_id;
        restoredActive = status.is_active === true;
      }
    }
    if (restoredId) {
      restoreVendorSession(restoredId, restoredActive);
      notifyVendorIdChanged();
    }

    toast.success(s.delete_account_cancelled);
  };


  return (
    <AppShell theme="dark">
      <div
        className="pb-8"
        data-testid="settings-screen"
        data-admin-auth-checked={adminAuthChecked ? "true" : "false"}
      >
      {adminTabRevealed && (
      <div className="flex gap-2 px-4 pt-2 pb-4" data-testid="settings-admin-tabs">
          <button
            type="button"
            data-testid="settings-tab-settings"
            onClick={() => setActiveTab("settings")}
            className={cn(
              "flex-1 rounded-xl border h-10 text-sm font-bold transition-colors active:scale-[0.98]",
              activeTab === "settings"
                ? "border-brand bg-brand/15 text-brand"
                : "border-surface-border bg-surface text-muted-foreground",
            )}
          >
            Settings
          </button>
          <button
            type="button"
            data-testid="settings-tab-admin"
            onClick={() => setActiveTab("admin")}
            className={cn(
              "flex-1 rounded-xl border h-10 text-sm font-bold transition-colors active:scale-[0.98]",
              activeTab === "admin"
                ? "border-brand bg-brand/15 text-brand"
                : "border-surface-border bg-surface text-muted-foreground",
            )}
          >
            Admin
          </button>
        </div>
      )}

      {(!adminTabRevealed || activeTab === "settings") && (
      <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <SettingsPageHeader
            title={s.settings_tagline}
            subtitle={s.settings_heading}
            onTitleClick={tapTitle}
          />
        </div>
        <NotificationBell className={cn("mt-6 mr-4 shrink-0", isWebDesktopShell() && "lg:mt-0")} />
      </div>

      {!vendorId && (
        <SettingsCard>
          <button
            type="button"
            onClick={() => navigate("/vendor")}
            className="w-full flex items-center gap-3 px-4 py-3 text-left active:opacity-90"
          >
            <span className="h-10 w-10 shrink-0 rounded-xl bg-brand/10 border border-brand/30 grid place-items-center">
              <Store className="h-5 w-5 text-brand" />
            </span>
            <span className="text-sm font-medium text-foreground">{s.settings_register_business}</span>
          </button>
          <p className="text-xs text-muted-foreground px-4 pb-3">{s.settings_register_business_sub}</p>
        </SettingsCard>
      )}

      <SettingsParentCollapsible
        label={s.settings_myAccount}
        open={accountOpen}
        onToggle={() => setAccountOpen((o) => !o)}
        testId="settings-my-account-toggle"
      >
        <SettingsCollapsible
          label={s.settings_myIdentity}
          open={identityOpen}
          onToggle={() => setIdentityOpen((o) => !o)}
          nested
          testId="settings-identity-toggle"
        >
          <div className="px-4 py-3">
            {!vendorId ? (
              (userPhone ?? "").trim() ? (
                <div>
                  <p className="text-sm font-medium text-foreground" data-testid="settings-identity-phone">
                    {s.settings_phonePrefix}
                    {(userPhone ?? "").trim()}
                  </p>
                  <p className="text-xs text-brand mt-1">{s.settings_registered}</p>
                  <button
                    type="button"
                    data-testid="settings-change-phone"
                    onClick={() => setPhoneEntryOpen(true)}
                    className="mt-3 text-sm font-semibold text-brand active:opacity-80"
                  >
                    {s.settings_changePhone}
                  </button>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-medium text-foreground">{s.settings_noPhone}</p>
                  <p className="text-xs text-muted-foreground mt-1">{s.settings_noPhoneHint}</p>
                  <button
                    type="button"
                    data-testid="settings-add-phone"
                    onClick={() => setPhoneEntryOpen(true)}
                    className="mt-3 w-full rounded-xl border border-brand/40 bg-brand/10 h-10 text-sm font-semibold text-brand active:opacity-90"
                  >
                    {s.settings_addPhone}
                  </button>
                </div>
              )
            ) : identityPhone != null ? (
              <div>
                <p className="text-sm font-medium text-foreground">
                  {s.settings_phonePrefix}
                  {identityPhone}
                </p>
                <p className="text-xs text-brand mt-1">{s.settings_registered}</p>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium text-foreground">{s.settings_noPhone}</p>
                <p className="text-xs text-muted-foreground mt-1">{s.settings_noPhoneHint}</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground/70 mt-3 tabular-nums">
              {s.settings_devicePrefix}
              {deviceId.slice(0, 8)}
              {s.settings_deviceEllipsis}
            </p>
          </div>
        </SettingsCollapsible>

        <SettingsCollapsible
          label={s.settings_accountStanding}
          open={accountStandingOpen}
          onToggle={() => setAccountStandingOpen((o) => !o)}
          nested
          testId="settings-account-standing-toggle"
        >
          <div className="px-4 py-3" data-testid="account-standing-row">
            <span
              className={cn(
                "inline-block rounded-full border px-3 py-1 text-xs font-semibold leading-snug",
                accountStanding.tone === "banned" &&
                  "bg-destructive/10 text-destructive border-destructive/30",
                accountStanding.tone === "complaints" &&
                  "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
                accountStanding.tone === "fair" &&
                  "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
                accountStanding.tone === "good" &&
                  "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30",
                (accountStanding.tone === "unavailable" ||
                  accountStanding.tone === "loading") &&
                  "bg-muted text-muted-foreground border-surface-border",
              )}
            >
              {accountStanding.label}
            </span>
          </div>
        </SettingsCollapsible>

        <SettingsCollapsible
          label={
            addressesFailed
              ? s.settings_myDeliveryAddresses
              : `${s.settings_myDeliveryAddresses} (${addresses.length})`
          }
          open={addressesOpen}
          onToggle={() => setAddressesOpen((o) => !o)}
          nested
        >
        {addressesLoading ? (
          <p className="text-sm text-muted-foreground px-4 py-3">{s.settings_loading}</p>
        ) : addressesFailed ? (
          <div className="px-4 py-3 space-y-2">
            <p className="text-sm text-destructive">{s.settings_addressesUnavailable}</p>
            <button
              type="button"
              onClick={() => void refreshAddresses()}
              className="rounded-xl border border-surface-border px-3 py-1 text-xs font-semibold text-foreground"
            >
              {s.network_retry_btn}
            </button>
          </div>
        ) : addresses.length === 0 ? (
          <p className="text-sm text-muted-foreground px-4 py-3">{s.settings_noAddresses}</p>
        ) : (
          <ul>
            {addresses.map((addr, idx) => (
              <li
                key={addr.id}
                className={cn(
                  "px-4 py-3",
                  idx < addresses.length - 1 && "border-b border-surface-border",
                )}
              >
                {editingAddressId === addr.id ? (
                  <div className="space-y-2">
                    <Input
                      type="text"
                      value={editAddressValue}
                      onChange={(e) =>
                        setEditAddressValue(e.target.value.slice(0, MAX_ADDRESS_TEXT_CHARS))
                      }
                      maxLength={MAX_ADDRESS_TEXT_CHARS}
                      className="bg-surface border-surface-border"
                      autoFocus
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => void saveEditAddress()}
                        disabled={savingAddress}
                        className="text-xs font-semibold text-brand disabled:opacity-50"
                        aria-label={s.settings_save}
                      >
                        {s.settings_save}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEditAddress}
                        disabled={savingAddress}
                        className="text-xs font-semibold text-muted-foreground disabled:opacity-50"
                        aria-label={s.settings_cancel}
                      >
                        ❌ {s.settings_cancel}
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
                      className="shrink-0 min-h-[44px] min-w-[44px] rounded-lg border border-surface-border text-sm active:opacity-80 inline-flex items-center justify-center"
                      aria-label="Edit address"
                    >
                      ✏️
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteAddressId(addr.id)}
                      className="shrink-0 min-h-[44px] min-w-[44px] rounded-lg border border-surface-border text-sm active:opacity-80 inline-flex items-center justify-center"
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
        </SettingsCollapsible>


        <SettingsCollapsible
          label={s.settings_preferences}
          open={preferencesOpen}
          onToggle={() => setPreferencesOpen((o) => !o)}
          nested
        >
        <SettingsRow
          label={s.theme}
          sublabel={theme === "dark" ? s.dark : s.light}
        >
          <button
            type="button"
            data-testid="theme-toggle"
            onClick={toggleTheme}
            className="h-10 w-10 shrink-0 grid place-items-center rounded-full border border-surface-border bg-surface text-brand active:opacity-90"
            aria-label={s.theme}
          >
            {theme === "dark" ? (
              <Moon className="h-5 w-5" aria-hidden />
            ) : (
              <Sun className="h-5 w-5" aria-hidden />
            )}
          </button>
        </SettingsRow>
        <div className="px-4 pb-3 border-t border-surface-border pt-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            {s.settings_language}
          </p>
          <Select value={lang} onValueChange={(value) => setLang(value as Language)}>
            <SelectTrigger
              data-testid="language-select"
              className="w-full rounded-xl border-surface-border bg-surface h-10 px-3 font-medium text-sm"
            >
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
        </div>
        <div className="px-4 py-3 border-t border-surface-border">
          <p className="text-sm font-medium text-foreground">{s.settings_voiceInputLang}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Language used when speaking to the app
          </p>
        </div>
        <div className="px-4 pb-2 flex gap-2">
          {VOICE_INPUT_OPTIONS.map(({ code, labelKey }) => (
            <button
              key={code}
              type="button"
              onClick={() => {
                localStorage.setItem(VOICE_LANG_KEY, code);
                setVoiceInputLang(code);
              }}
              className={cn(
                "flex-1 rounded-xl border h-10 text-sm font-bold transition-colors active:scale-[0.98]",
                voiceInputLang === code
                  ? "border-brand bg-brand/15 text-brand"
                  : "border-surface-border bg-surface text-muted-foreground",
              )}
            >
              {s[labelKey]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground px-4 pb-3 border-b border-surface-border">
          {s.settings_voiceAutoDetect}
        </p>
        <SettingsRow label={s.settings_largeText} sublabel={s.settings_largeTextHint}>
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
        </SettingsRow>
        </SettingsCollapsible>

        <SettingsCollapsible
          label={s.nav_feed}
          open={feedDiscoveryOpen}
          onToggle={() => setFeedDiscoveryOpen((o) => !o)}
          nested
          testId="settings-feed-discovery-toggle"
        >
          <div data-testid="settings-feed-discovery">
            {/* Account-level only (app_users.feed_discovery_radius_km) — never per-category. */}
            <SettingsRow
              label={s.settings_feedDiscoveryRadius}
              sublabel={s.settings_feedDiscoveryRadiusHint}
            />
            <div className="px-4 pb-3">
              <FeedReachChips
                mode="reader"
                value={feedDiscoveryRadiusKm}
                onChange={(km) => void onFeedDiscoveryRadiusChange(km)}
                disabled={!userPhone}
              />
            </div>
            {/*
              Native: FCM via Capacitor. Web: same Settings toggle is the user
              gesture for Notification.requestPermission + web FCM token.
            */}
            <SettingsRow
              label={s.settings_feedNotifications}
              sublabel={
                Capacitor.isNativePlatform()
                  ? s.settings_feedNotificationsHint
                  : s.settings_browserNotificationsHint
              }
            >
              <Switch
                data-testid="settings-feed-notifications-switch"
                className="data-[state=checked]:bg-brand"
                checked={feedNotificationsEnabled}
                onCheckedChange={onFeedNotificationsChange}
              />
            </SettingsRow>
          </div>
        </SettingsCollapsible>
      </SettingsParentCollapsible>

      {vendorId && (
        <>
          {vendorLoadFailed && (
            <div className="px-4 mb-5 space-y-2" data-testid="settings-vendor-load-failed">
              <p className="text-sm text-destructive">{s.settings_vendorLoadFailed}</p>
              <button
                type="button"
                onClick={() => void loadVendorOwn()}
                className="rounded-xl border border-surface-border px-3 py-1 text-xs font-semibold text-foreground"
              >
                {s.network_retry_btn}
              </button>
            </div>
          )}
          {!vendorLoadFailed && (!vendor || !vendorExtras) && (
            <p className="text-sm text-muted-foreground px-4 mb-5">{s.settings_loading}</p>
          )}
          {vendor && vendorExtras && vendor.is_banned && (
            <div
              data-testid="settings-vendor-banned"
              className="min-h-[40vh] flex flex-col items-center justify-center px-6 mb-6 animate-fade-up"
            >
              <div className="w-full max-w-md rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-8 text-center space-y-3">
                <p className="text-lg font-bold text-foreground">{s.admin_vendor_banned_title}</p>
                <p className="text-sm text-foreground leading-relaxed">{s.admin_vendor_banned_body}</p>
              </div>
            </div>
          )}
          {vendor && vendorExtras && !vendor.is_banned && (
            <Tabs
              value={vendorPanelTab}
              onValueChange={(v) => setVendorPanelTab(v as "business" | "preferences")}
              className="px-4 mb-4"
            >
              <TabsList className="w-full grid grid-cols-2 h-11 bg-muted/80">
                <TabsTrigger
                  value="business"
                  data-testid="settings-vendor-tab-business"
                  className="text-sm font-semibold"
                >
                  {s.settings_myBusiness}
                </TabsTrigger>
                <TabsTrigger
                  value="preferences"
                  data-testid="settings-vendor-tab-preferences"
                  className="text-sm font-semibold"
                >
                  {s.settings_preferences}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="business" className="mt-4">
                <VendorMyBusiness
                  vendor={vendor}
                  onVendorUpdated={setVendor}
                  userPhone={userPhone}
                />
              </TabsContent>
              <TabsContent value="preferences" className="mt-4">
                <VendorSettings
                  vendor={vendor}
                  onVendorUpdated={setVendor}
                  shopOpen={shopOpen}
                  onShopOpenChange={setShopOpen}
                  referEarnVisible={referEarnVisible}
                  userPhone={userPhone}
                  referralCredits={vendorExtras.referralCredits}
                  openReviewsInitially={openVendorReviews}
                />
              </TabsContent>
            </Tabs>
          )}
        </>
      )}

      {Capacitor.isNativePlatform() && (
        <>
          <SettingsParentCollapsible
            label={s.settings_device_section}
            open={deviceOpen}
            onToggle={() => setDeviceOpen((o) => !o)}
          >
            <p className="px-3 pt-1 pb-2 text-xs font-bold uppercase tracking-widest text-brand">
              {s.settings_permission_heading}
            </p>
            <SettingsCard className="mx-0 mb-3 border-surface-border">
              <SettingsRow
                label={s.settings_permission_notifications}
                sublabel={permissionSublabel(
                  permissionStatuses.notifications,
                  s.settings_permission_notifications_sub,
                )}
              >
                {renderPermissionAction(permissionStatuses.notifications, () =>
                  void handlePermissionRequest(
                    "notifications",
                    s.settings_permission_notifications,
                  ),
                )}
              </SettingsRow>
              <SettingsRow
                label={s.settings_permission_location}
                sublabel={permissionSublabel(
                  permissionStatuses.location,
                  s.settings_permission_location_sub,
                )}
              >
                {renderPermissionAction(permissionStatuses.location, () =>
                  void handlePermissionRequest("location", s.settings_permission_location),
                )}
              </SettingsRow>
              <SettingsRow
                label={s.settings_permission_background_location}
                sublabel={permissionSublabel(
                  permissionStatuses.backgroundLocation,
                  s.settings_permission_background_location_sub,
                )}
              >
                {renderPermissionAction(permissionStatuses.backgroundLocation, () =>
                  void handlePermissionRequest(
                    "backgroundLocation",
                    s.settings_permission_background_location,
                  ),
                )}
              </SettingsRow>
              <SettingsRow
                label={s.settings_permission_camera}
                sublabel={permissionSublabel(
                  permissionStatuses.camera,
                  s.settings_permission_camera_sub,
                )}
              >
                {renderPermissionAction(permissionStatuses.camera, () =>
                  void handlePermissionRequest("camera", s.settings_permission_camera),
                )}
              </SettingsRow>
              <SettingsRow
                label={s.settings_permission_mic}
                sublabel={permissionSublabel(
                  permissionStatuses.microphone,
                  s.settings_permission_mic_sub,
                )}
              >
                {renderPermissionAction(permissionStatuses.microphone, () =>
                  void handlePermissionRequest("microphone", s.settings_permission_mic),
                )}
              </SettingsRow>
              <SettingsRow
                label={s.settings_permission_battery}
                sublabel={s.settings_permission_battery_sub}
              >
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground">{s.settings_permission_manual}</span>
                  <button
                    type="button"
                    onClick={() => setPermissionHint(s.settings_permission_battery)}
                    className="shrink-0 rounded-lg border border-surface-border px-3 py-1 text-xs font-semibold text-foreground"
                  >
                    {s.onboard_open_settings}
                  </button>
                </div>
              </SettingsRow>
            </SettingsCard>
          </SettingsParentCollapsible>

          <AlertDialog
            open={permissionHint != null}
            onOpenChange={(open) => {
              if (!open) setPermissionHint(null);
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>{s.onboard_open_settings}</AlertDialogTitle>
                <AlertDialogDescription>
                  {permissionHint ? s.settings_permission_open_settings_body(permissionHint) : ""}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogAction
                  className="mt-0"
                  onClick={(e) => {
                    e.preventDefault();
                    setPermissionHint(null);
                    void App.openUrl({ url: "app-settings:" });
                  }}
                >
                  {s.settings_ok}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}

      <SettingsParentCollapsible
        label={s.settings_connection_privacy}
        open={connectionOpen}
        onToggle={() => setConnectionOpen((o) => !o)}
      >
        <SettingsRow label={s.settings_trustSecurity} sublabel={s.settings_tlsNote}>
          <CheckCircle2 className="h-5 w-5 text-brand shrink-0" aria-hidden />
        </SettingsRow>
        <button
          type="button"
          data-testid="settings-privacy-policy-link"
          onClick={() => navigate("/privacy", { state: { returnTo: "/settings" } })}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 border-b border-surface-border text-left active:opacity-90"
        >
          <span className="text-sm font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2">
            {s.privacy_policy_title}
          </span>
          <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden />
        </button>
        <button
          type="button"
          data-testid="settings-terms-of-service-link"
          onClick={() => navigate("/terms", { state: { returnTo: "/settings" } })}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 border-b border-surface-border text-left active:opacity-90"
        >
          <span className="text-sm font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2">
            {s.terms_of_service_title}
          </span>
          <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden />
        </button>
        <div className="px-4 pb-3">
          <p className="text-xs text-brand font-medium">{s.settings_dbConnected}</p>
        </div>
      </SettingsParentCollapsible>

      <button
        type="button"
        data-testid="settings-help-support-link"
        onClick={() => navigate("/settings/help")}
        className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-surface-border bg-card px-4 py-3 text-left active:opacity-90"
      >
        <span className="text-sm font-medium text-foreground">{s.help_support_title}</span>
        <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden />
      </button>

      <div className="mt-8 pt-4 border-t border-surface-border/50">
      <button
        type="button"
        onClick={() => setClearDataOpen(true)}
        disabled={clearingData}
        className="w-full rounded-xl border border-destructive/40 text-destructive bg-transparent min-h-[44px] text-sm font-medium flex items-center justify-center gap-2 active:opacity-90 disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" /> {s.settings_clearMyData}
      </button>

      {userPhone && (
        <section className="mt-4 space-y-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold px-1">
            {s.delete_account_title}
          </p>
          {deleteAccountLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : vendorDeletionRequestedAt ? (
            <>
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100 leading-relaxed">
                {s.delete_account_scheduled.replace(
                  "{date}",
                  formatVendorDeletionDate(vendorDeletionRequestedAt),
                )}
              </div>
              <button
                type="button"
                onClick={() => void cancelAccountDeletion()}
                className="w-full rounded-xl border border-border min-h-[44px] text-sm font-semibold text-foreground active:opacity-90"
              >
                {s.delete_account_cancel}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void openDeleteAccountConfirm()}
              className="w-full rounded-xl bg-destructive text-destructive-foreground min-h-[44px] text-sm font-semibold active:opacity-90"
            >
              {s.delete_account_title}
            </button>
          )}
        </section>
      )}

      <p className="text-xs text-muted-foreground text-center py-4 mt-2">
        {s.settings_appName} · {s.settings_version}
        <br />
        {s.settings_copyright}
      </p>
      </div>

      </>
      )}

      {adminTabRevealed && activeTab === "admin" && (
        <Suspense
          fallback={
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-brand" />
            </div>
          }
        >
          <AdminConsole
            isAdmin={isAdmin}
            adminAuthChecked={adminAuthChecked}
            adminSessionEmail={adminSessionEmail}
            checkAdminSession={checkAdminSession}
            onAdminAuthChange={(next) => {
              setIsAdmin(next);
              if (!next) setAdminSessionEmail(null);
            }}
            onRequestSettingsTab={() => setActiveTab("settings")}
            onHideAdminTab={() => setAdminTabRevealed(false)}
            onReferEarnVisibleChange={setReferEarnVisible}
            highlightVendorId={
              (location.state as { highlightVendorId?: string } | null)?.highlightVendorId
            }
          />
        </Suspense>
      )}

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.delete_account_confirm_title}</AlertDialogTitle>
            <AlertDialogDescription>
              {dualRoleDelete
                ? s.deletion_dualRoleNotice
                : isVendor
                  ? s.delete_account_confirm_body
                  : s.delete_account_confirm_body_customer}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0">{s.settings_cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteAccountLoading}
              onClick={(e) => {
                e.preventDefault();
                void confirmDeleteAccount();
              }}
            >
              {s.delete_account_confirm_action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={clearDataOpen}
        onOpenChange={(open) => {
          if (clearingData) return;
          setClearDataOpen(open);
        }}
      >
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.settings_clearDataTitle}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <ul className="list-disc space-y-2 pl-5 text-left">
                  <li>{s.settings_clearDataDescription_wiped}</li>
                  <li>{s.settings_clearDataDescription_permissions}</li>
                  <li>{s.settings_clearDataDescription_kept}</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0" disabled={clearingData}>
              {s.settings_cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="settings-clear-data-confirm"
              disabled={clearingData}
              onClick={(e) => {
                e.preventDefault();
                void reset();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {clearingData ? s.settings_loading : s.settings_clearDataConfirm}
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
            <AlertDialogTitle>{s.settings_deleteAddressTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {s.settings_deleteAddressBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0" disabled={deletingAddress}>
              {s.settings_cancel}
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

      </div>

      <PhoneEntrySheet
        isOpen={phoneEntryOpen}
        onClose={() => setPhoneEntryOpen(false)}
        context="settings"
        skipRecovery
        onConfirmed={(phone) => {
          void (async () => {
            await migrateUserPhone(phone, getDeviceId());
            void ensureUserDeviceLink(phone);
            setPhoneEntryOpen(false);
            setIdentityNonce((n) => n + 1);
            toast.success(s.settings_phoneSaved);
          })();
        }}
      />
    </AppShell>
  );
};

export default Settings;

