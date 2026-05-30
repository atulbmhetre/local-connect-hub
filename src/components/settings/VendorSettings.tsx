import { useEffect, useState, type ReactNode } from "react";
import { VendorNoteEditor } from "@/components/vendor/VendorNoteEditor";
import { Store, Bell, ChevronDown, Pencil, Trash2, Mic, Camera, Loader2 } from "lucide-react";
import { AiBridgeSheet, type AiBridgeVendor } from "@/components/AiBridgeSheet";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { toast } from "sonner";
import { Capacitor } from "@capacitor/core";
import {
  supabase,
  useCategoryLabel,
  useServiceModeLabel,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  type Vendor,
} from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { getVoiceLang } from "@/lib/voiceUtils";
import { useAppConfig } from "@/hooks/useAppConfig";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  isVendorSoundEnabled,
  isVendorVibrateEnabled,
  setVendorSoundEnabled,
  setVendorVibrateEnabled,
} from "@/lib/pushNotifications";
import { formatTimeAgo } from "@/lib/orders";

type MenuItem = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  unit: string | null;
  is_available: boolean;
  sort_order: number;
};

type VendorReview = {
  id: string;
  rating: number;
  review_text: string | null;
  service_mode: string | null;
  created_at: string;
  user_phone: string | null;
};

type Props = {
  vendor: Vendor;
  onVendorUpdated: (updated: Vendor) => void;
  activeOfferSection?: ReactNode;
};

export function VendorSettingsNotifications({ vendor: _vendor }: { vendor: Vendor }) {
  const { s } = useLanguage();
  const [vendorVibrate, setVendorVibrate] = useState(() => isVendorVibrateEnabled());
  const [vendorSound, setVendorSound] = useState(() => isVendorSoundEnabled());

  if (!Capacitor.isNativePlatform()) return null;

  return (
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
  );
}

export function VendorSettingsReferEarn({ vendor }: { vendor: Vendor }) {
  const { s } = useLanguage();
  const { config } = useAppConfig();
  const [referralCode, setReferralCode] = useState<string | null>(null);

  useEffect(() => {
    const loadReferral = async () => {
      const { data } = await supabase
        .from("vendors")
        .select("referral_code")
        .eq("id", vendor.id)
        .maybeSingle();
      setReferralCode(data?.referral_code ?? null);
    };
    void loadReferral();
  }, [vendor.id]);

  const referLink =
    referralCode != null ? `${config.appBaseUrl}/r/${referralCode}` : null;

  const shareReferLink = async () => {
    if (!referLink) return;
    const message = `Order from ${vendor.shop_name} on Aaspaas! ${referLink}`;
    if (navigator.share) {
      try {
        await navigator.share({ text: message });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    await navigator.clipboard.writeText(message);
    toast.success(s.vendor_referLinkCopied);
  };

  return (
    <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
      <p className="font-display font-bold mb-3">{s.vendor_referEarn}</p>
      {referralCode != null ? (
        <>
          <div className="rounded-2xl bg-secondary/10 border border-secondary/30 px-4 py-3 mb-3">
            <p className="text-lg font-bold font-mono tracking-wider text-secondary text-center">{referralCode}</p>
          </div>
          <button
            type="button"
            onClick={() => void shareReferLink()}
            disabled={!referLink}
            className="w-full rounded-2xl bg-secondary text-secondary-foreground px-4 py-3 text-sm font-semibold transition-colors active:scale-[0.99] disabled:opacity-50 mb-3"
          >
            {s.vendor_referShare}
          </button>
        </>
      ) : (
        <p className="text-sm text-muted-foreground mb-3">{s.settings_loading}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {s.vendor_referVendorCredit(config.referralVendorCreditTotal)}
      </p>
      <p className="text-xs text-muted-foreground mt-1">
        {s.vendor_referUserCredit(config.referralUserCredit)}
      </p>
    </section>
  );
}

export function VendorSettings({ vendor, onVendorUpdated, activeOfferSection }: Props) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const getMode = useServiceModeLabel();

  const [cancelReasons, setCancelReasons] = useState(["", "", "", ""]);
  const [savingReasons, setSavingReasons] = useState(false);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [menuLoading, setMenuLoading] = useState(false);
  const [editingMenuItem, setEditingMenuItem] = useState<MenuItem | null>(null);
  const [newItem, setNewItem] = useState({ name: "", price: "", unit: "", description: "" });
  const [addingItem, setAddingItem] = useState(false);
  const [isListeningMenu, setIsListeningMenu] = useState(false);
  const [isProcessingImageMenu, setIsProcessingImageMenu] = useState(false);
  const [reviews, setReviews] = useState<VendorReview[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [showReviews, setShowReviews] = useState(false);
  const [callReview, setCallReview] = useState<{
    callerPhone: string;
    serviceMode: string;
  } | null>(null);

  const aiBridgeVendor: AiBridgeVendor = {
    id: vendor.id,
    name: vendor.name,
    shop_name: vendor.shop_name,
    category: vendor.category,
    vendor_note: vendor.vendor_note ?? null,
    phone: vendor.phone,
    service_mode: vendor.service_mode ?? "help",
    verification_status: vendor.verification_status,
    is_manual_verified: vendor.is_manual_verified,
    total_helped: vendor.total_helped,
    on_time_rate: vendor.on_time_rate,
    shop_photo_url: vendor.shop_photo_url,
    upi_verified: vendor.upi_verified,
  };

  const loadReviews = async () => {
    setReviewsLoading(true);
    const { data } = await supabase
      .from("vendor_reviews")
      .select("id, rating, review_text, service_mode, created_at, user_phone")
      .eq("vendor_id", vendor.id)
      .order("created_at", { ascending: false });
    setReviews(data ?? []);
    setReviewsLoading(false);
  };

  const loadMenu = async () => {
    setMenuLoading(true);
    const { data } = await supabase
      .from("vendor_menu_items")
      .select("*")
      .eq("vendor_id", vendor.id)
      .order("sort_order", { ascending: true });
    setMenuItems(data ?? []);
    setMenuLoading(false);
  };

  useEffect(() => {
    void loadMenu();
  }, [vendor.id]);

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

  const saveNewItem = async () => {
    if (!newItem.name.trim() || !newItem.price) return;
    await supabase.from("vendor_menu_items").insert({
      vendor_id: vendor.id,
      name: newItem.name.trim(),
      price: parseFloat(newItem.price),
      unit: newItem.unit.trim() || null,
      description: newItem.description.trim() || null,
      sort_order: menuItems.length,
    });
    setNewItem({ name: "", price: "", unit: "", description: "" });
    setAddingItem(false);
    void loadMenu();
  };

  const toggleAvailability = async (item: MenuItem) => {
    await supabase
      .from("vendor_menu_items")
      .update({ is_available: !item.is_available })
      .eq("id", item.id);
    void loadMenu();
  };

  const deleteMenuItem = async (id: string) => {
    await supabase.from("vendor_menu_items").delete().eq("id", id);
    void loadMenu();
  };

  const startVoiceMenu = async () => {
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error("Voice not available");
        return;
      }
      await SpeechRecognition.requestPermissions();
      setIsListeningMenu(true);
      const speechResult = await SpeechRecognition.start({
        language: getVoiceLang(),
        maxResults: 1,
        popup: false,
        partialResults: false,
      });
      const text = speechResult?.matches?.[0]?.trim();
      if (!text) return;

      const resp = await fetch(`${SUPABASE_URL}/functions/v1/parse-voice-bill`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ text }),
      });
      const result = await resp.json();
      if (result.success && result.items?.length) {
        await supabase.from("vendor_menu_items").insert(
          result.items.map(
            (
              item: { description?: string; unit_price?: number; unit?: string },
              idx: number,
            ) => ({
              vendor_id: vendor.id,
              name: item.description ?? "",
              price: item.unit_price ?? 0,
              unit: item.unit || null,
              sort_order: menuItems.length + idx,
            }),
          ),
        );
        void loadMenu();
        toast.success(s.menu_voiceAdded);
      } else {
        toast.error(s.voice_failed);
      }
    } catch {
      // user cancelled or denied — silent
    } finally {
      setIsListeningMenu(false);
    }
  };

  const startImageMenu = async () => {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.capture = "environment";
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        setIsProcessingImageMenu(true);
        const base64 = await new Promise<string>((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res((reader.result as string).split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(file);
        });
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/parse-image-bill`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({ image_base64: base64, media_type: file.type }),
        });
        const result = await resp.json();
        if (result.success && result.items?.length) {
          await supabase.from("vendor_menu_items").insert(
            result.items.map(
              (
                item: { description?: string; unit_price?: number; unit?: string },
                idx: number,
              ) => ({
                vendor_id: vendor.id,
                name: item.description ?? "",
                price: item.unit_price ?? 0,
                unit: item.unit || null,
                sort_order: menuItems.length + idx,
              }),
            ),
          );
          void loadMenu();
          toast.success(s.menu_imageAdded);
        } else {
          toast.error(s.image_failed);
        }
        setIsProcessingImageMenu(false);
      };
      input.click();
    } catch {
      toast.error(s.image_failed);
      setIsProcessingImageMenu(false);
    }
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
        </div>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <VendorNoteEditor
          vendorId={vendor.id}
          initialNote={vendor.vendor_note ?? null}
          onSaved={(newNote) => onVendorUpdated({ ...vendor, vendor_note: newNote || null })}
        />
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-foreground">📋 {s.menu_title}</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void startImageMenu()}
                  disabled={isProcessingImageMenu}
                  className="p-1.5 rounded-lg border border-surface-border bg-surface text-gray-400 hover:text-brand disabled:opacity-50"
                >
                  {isProcessingImageMenu ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Camera className="h-3.5 w-3.5" />
                  )}
                </button>
                {Capacitor.isNativePlatform() &&
                  (isListeningMenu ? (
                    <div className="flex items-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 px-2.5 py-1.5 shrink-0">
                      <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse shrink-0" />
                      <span className="text-[10px] font-semibold text-red-500 whitespace-nowrap">
                        Listening... speak now
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void startVoiceMenu()}
                      className="p-1.5 rounded-lg border border-surface-border bg-surface text-gray-400 hover:text-brand transition-colors shrink-0"
                      aria-label={s.menu_voicePrompt}
                    >
                      <Mic className="h-3.5 w-3.5" />
                    </button>
                  ))}
                <button
                  type="button"
                  onClick={() => setAddingItem(true)}
                  className="text-xs text-brand font-semibold"
                >
                  + {s.menu_addItem}
                </button>
              </div>
            </div>

            {menuLoading && (
              <p className="text-xs text-muted-foreground">{s.settings_loading}</p>
            )}

            {!menuLoading && menuItems.length === 0 && (
              <p className="text-xs text-muted-foreground">{s.menu_empty}</p>
            )}

            {menuItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-xl border border-surface-border bg-surface px-3 py-2.5"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{item.name}</p>
                  {item.description && (
                    <p className="text-xs text-muted-foreground truncate">{item.description}</p>
                  )}
                  <p className="text-xs text-brand font-semibold">
                    ₹{item.price}
                    {item.unit ? `/${item.unit}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-2">
                  <button
                    type="button"
                    onClick={() => void toggleAvailability(item)}
                    className={`text-xs px-2 py-1 rounded-lg border ${
                      item.is_available
                        ? "border-brand/40 text-brand"
                        : "border-surface-border text-muted-foreground"
                    }`}
                  >
                    {item.is_available ? s.menu_available : s.menu_unavailable}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingMenuItem(item)}
                    className="text-muted-foreground hover:text-brand"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteMenuItem(item.id)}
                    className="text-muted-foreground hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}

            {addingItem && (
              <div className="rounded-xl border border-brand-border bg-brand/5 p-3 space-y-2">
                <input
                  type="text"
                  value={newItem.name}
                  onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
                  placeholder={s.menu_itemName}
                  className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    value={newItem.price}
                    onChange={(e) => setNewItem((p) => ({ ...p, price: e.target.value }))}
                    placeholder={s.menu_price}
                    className="bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                  <input
                    type="text"
                    value={newItem.unit}
                    onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))}
                    placeholder={s.menu_unit}
                    className="bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
                <input
                  type="text"
                  value={newItem.description}
                  onChange={(e) => setNewItem((p) => ({ ...p, description: e.target.value }))}
                  placeholder={s.menu_description}
                  className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void saveNewItem()}
                    className="flex-1 rounded-lg bg-brand text-page-bg text-sm font-semibold py-2"
                  >
                    {s.menu_save}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingItem(false);
                      setNewItem({ name: "", price: "", unit: "", description: "" });
                    }}
                    className="flex-1 rounded-lg border border-surface-border text-sm py-2"
                  >
                    {s.settings_cancel}
                  </button>
                </div>
              </div>
            )}
        </div>
      </section>

      {activeOfferSection}

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <Collapsible>
          <CollapsibleTrigger className="w-full flex items-center justify-between gap-3 group">
            <div className="text-left min-w-0">
              <p className="text-sm font-semibold">{s.cancelReasons}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{s.cancelReasonsSubtitle}</p>
            </div>
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-1">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {`${s.rejectionReasonField} ${i + 1}`}
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
          </CollapsibleContent>
        </Collapsible>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <button
          type="button"
          onClick={() => {
            setShowReviews((p) => !p);
            if (!showReviews) void loadReviews();
          }}
          className="w-full flex items-center justify-between text-sm font-semibold text-foreground"
        >
          <span>⭐ {s.review_myReviews}</span>
          <span className="text-brand text-xs">{showReviews ? s.review_hide : s.review_show}</span>
        </button>

        {showReviews && (
          <div className="space-y-2 mt-3">
            {reviewsLoading && (
              <p className="text-xs text-muted-foreground">{s.settings_loading}</p>
            )}
            {!reviewsLoading && reviews.length === 0 && (
              <p className="text-xs text-muted-foreground">{s.review_noReviews}</p>
            )}
            {reviews.map((r) => (
              <div
                key={r.id}
                className="rounded-xl border border-surface-border bg-surface px-3 py-2.5 space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {"⭐".repeat(r.rating)}
                    {"☆".repeat(5 - r.rating)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatTimeAgo(r.created_at)}
                  </span>
                </div>
                {r.review_text && (
                  <p className="text-xs text-foreground leading-relaxed">
                    &quot;{r.review_text}&quot;
                  </p>
                )}
                {r.rating <= 2 && r.user_phone && (
                  <button
                    type="button"
                    onClick={() =>
                      setCallReview({
                        callerPhone: r.user_phone!,
                        serviceMode: r.service_mode ?? vendor.service_mode ?? "help",
                      })
                    }
                    className="text-[10px] text-muted-foreground mt-1 hover:text-foreground"
                  >
                    📞 Call customer
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {callReview && (
        <AiBridgeSheet
          open={callReview !== null}
          onClose={() => setCallReview(null)}
          vendor={aiBridgeVendor}
          callerPhone={callReview.callerPhone}
          userNeed=""
          distanceKm={null}
        />
      )}
    </>
  );
}
