import { useCallback, useEffect, useState } from "react";
import { Pencil, Trash2, Mic, Camera, Loader2 } from "lucide-react";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { toast } from "sonner";
import { Capacitor } from "@capacitor/core";
import {
  supabase,
  useCategoryLabel,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  type Vendor,
} from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { getVoiceLang } from "@/lib/voiceUtils";
import { normalizeServiceRadiusKm } from "@/lib/serviceRadius";
import { captureError } from "@/lib/sentry";
import { LiveCamera, type CapturedShot } from "@/components/LiveCamera";
import {
  bestEffortDeleteMenuPhotoByUrl,
  MenuPhotoValidationError,
  uploadMenuPhoto,
} from "@/lib/menuPhotoUpload";
import {
  SettingsCard,
  SettingsRow,
  SettingsCollapsible,
} from "@/components/settings/SettingsSection";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { VendorCategoryNoteEditor } from "@/components/vendor/VendorCategoryNoteEditor";
import { VendorCategoryOffers } from "@/components/settings/VendorCategoryOffers";
import { filterMenuItemsByCategoryContext } from "@/lib/categoryScopedVendor";
import type { MenuItem } from "@/components/settings/VendorSettingsShared";

type ApprovedCategoryChip = {
  id: string;
  label: string;
  emoji: string;
  service_mode: string;
};

type CategorySettingsSlice = {
  vendor_note: string;
  service_radius_km: number | null;
  latitude: number | null;
  longitude: number | null;
};

export type VendorMyBusinessOperationsProps = {
  vendor: Vendor;
  userPhone?: string | null;
  approvedCategories: ApprovedCategoryChip[];
  activeCategoryId: string | null;
  onActiveCategoryIdChange: (id: string) => void;
  categorySettingsById: Record<string, CategorySettingsSlice>;
  onCategoryNoteSaved: (categoryId: string, note: string) => void;
};

export function VendorMyBusinessOperations({
  vendor,
  userPhone,
  approvedCategories,
  activeCategoryId,
  onActiveCategoryIdChange,
  categorySettingsById,
  onCategoryNoteSaved,
}: VendorMyBusinessOperationsProps) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const vendorPhone = (vendor.phone ?? userPhone ?? "").trim();

  const isMultiCategory = approvedCategories.length > 1;
  const activeSettings = activeCategoryId ? categorySettingsById[activeCategoryId] : null;

  const [cancelReasons, setCancelReasons] = useState(["", "", "", ""]);
  const [cancelReasonsChanged, setCancelReasonsChanged] = useState(false);
  const [savingReasons, setSavingReasons] = useState(false);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuLoadFailed, setMenuLoadFailed] = useState(false);
  const [editingMenuItem, setEditingMenuItem] = useState<MenuItem | null>(null);
  const [editDraft, setEditDraft] = useState({
    name: "",
    price: "",
    unit: "",
    description: "",
    image_url: null as string | null,
  });
  const [newItem, setNewItem] = useState({
    name: "",
    price: "",
    unit: "",
    description: "",
    image_url: null as string | null,
  });
  const [addingItem, setAddingItem] = useState(false);
  const [menuPhotoCameraTarget, setMenuPhotoCameraTarget] = useState<"new" | "edit" | null>(null);
  const [menuPhotoUploading, setMenuPhotoUploading] = useState(false);
  const [isListeningMenu, setIsListeningMenu] = useState(false);
  const [isProcessingImageMenu, setIsProcessingImageMenu] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const scopedMenuItems = filterMenuItemsByCategoryContext(menuItems, activeCategoryId);

  const loadMenu = useCallback(async () => {
    setMenuLoading(true);
    const { data, error } = await supabase
      .from("vendor_menu_items")
      .select("*")
      .eq("vendor_id", vendor.id)
      .order("sort_order", { ascending: true });
    if (error) {
      captureError(error, { scope: "vendorMyBusinessOps.loadMenu", vendorId: vendor.id });
      setMenuLoadFailed(true);
      setMenuLoading(false);
      return;
    }
    setMenuLoadFailed(false);
    setMenuItems((data ?? []) as MenuItem[]);
    setMenuLoading(false);
  }, [vendor.id]);

  useEffect(() => {
    void loadMenu();
  }, [loadMenu]);

  const loadCategoryCancelReasons = useCallback(
    async (categoryId: string | null) => {
      if (!categoryId) {
        setCancelReasons([
          vendor.cancel_reason_1 ?? "",
          vendor.cancel_reason_2 ?? "",
          vendor.cancel_reason_3 ?? "",
          vendor.cancel_reason_4 ?? "",
        ]);
        setCancelReasonsChanged(false);
        return;
      }
      const { data, error } = await supabase
        .from("vendor_category_cancel_reasons")
        .select("reason_text, position")
        .eq("vendor_id", vendor.id)
        .eq("category_id", categoryId)
        .order("position", { ascending: true });
      if (error) {
        captureError(error, {
          scope: "vendorMyBusinessOps.loadCategoryCancelReasons",
          vendorId: vendor.id,
        });
        return;
      }
      const next = ["", "", "", ""];
      for (const row of data ?? []) {
        const pos = Number(row.position);
        if (pos >= 1 && pos <= 4) next[pos - 1] = row.reason_text ?? "";
      }
      if (next.every((r) => !r.trim())) {
        next[0] = vendor.cancel_reason_1 ?? "";
        next[1] = vendor.cancel_reason_2 ?? "";
        next[2] = vendor.cancel_reason_3 ?? "";
        next[3] = vendor.cancel_reason_4 ?? "";
      }
      setCancelReasons(next);
      setCancelReasonsChanged(false);
    },
    [
      vendor.id,
      vendor.cancel_reason_1,
      vendor.cancel_reason_2,
      vendor.cancel_reason_3,
      vendor.cancel_reason_4,
    ],
  );

  useEffect(() => {
    void loadCategoryCancelReasons(activeCategoryId);
  }, [activeCategoryId, loadCategoryCancelReasons]);

  useEffect(() => {
    if (approvedCategories.length === 0) {
      setCancelReasons([
        vendor.cancel_reason_1 ?? "",
        vendor.cancel_reason_2 ?? "",
        vendor.cancel_reason_3 ?? "",
        vendor.cancel_reason_4 ?? "",
      ]);
      setCancelReasonsChanged(false);
    }
  }, [
    approvedCategories.length,
    vendor.cancel_reason_1,
    vendor.cancel_reason_2,
    vendor.cancel_reason_3,
    vendor.cancel_reason_4,
  ]);

  const patchVendor = async (patch: Record<string, unknown>) => {
    if (!vendorPhone) return { error: { message: "identity_required" } };
    return supabase.rpc("vendor_update_own", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_patch: patch,
    });
  };

  const saveCancelReasons = async () => {
    setSavingReasons(true);
    if (activeCategoryId) {
      const { error } = await supabase.rpc("vendor_upsert_category_cancel_reasons", {
        p_vendor_id: vendor.id,
        p_vendor_phone: vendorPhone,
        p_category_id: activeCategoryId,
        p_reasons: cancelReasons.map((r) => r.trim()),
      });
      setSavingReasons(false);
      if (error) {
        toast.error(error.message);
        return;
      }
      setCancelReasonsChanged(false);
      toast.success(s.vendor_settings_saved);
      return;
    }
    const updates = {
      cancel_reason_1: cancelReasons[0].trim() || null,
      cancel_reason_2: cancelReasons[1].trim() || null,
      cancel_reason_3: cancelReasons[2].trim() || null,
      cancel_reason_4: cancelReasons[3].trim() || null,
    };
    const { error } = await patchVendor(updates);
    setSavingReasons(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setCancelReasonsChanged(false);
    toast.success(s.vendor_settings_saved);
  };

  const saveNewItem = async () => {
    if (!newItem.name.trim() || !newItem.price || !vendorPhone || !activeCategoryId) return;
    const { error } = await supabase.rpc("vendor_insert_menu_items", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_items: [
        {
          name: newItem.name.trim(),
          price: parseFloat(newItem.price),
          unit: newItem.unit.trim() || null,
          description: newItem.description.trim() || null,
          sort_order: menuItems.length,
          category_id: activeCategoryId,
          image_url: newItem.image_url || null,
        },
      ],
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    setNewItem({ name: "", price: "", unit: "", description: "", image_url: null });
    setAddingItem(false);
    void loadMenu();
  };

  const saveEditedMenuItem = async () => {
    if (!editingMenuItem || !editDraft.name.trim() || !editDraft.price || !vendorPhone || !activeCategoryId)
      return;
    const previousImageUrl = editingMenuItem.image_url;
    const { error } = await supabase.rpc("vendor_update_menu_item", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_item_id: editingMenuItem.id,
      p_name: editDraft.name.trim(),
      p_price: parseFloat(editDraft.price),
      p_unit: editDraft.unit.trim() || null,
      p_description: editDraft.description.trim() || null,
      p_category_id: activeCategoryId,
      p_image_url: editDraft.image_url ?? "",
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    if (previousImageUrl && previousImageUrl !== editDraft.image_url) {
      void bestEffortDeleteMenuPhotoByUrl(previousImageUrl);
    }
    setEditingMenuItem(null);
    void loadMenu();
  };

  const toggleAvailability = async (item: MenuItem) => {
    if (!vendorPhone) return;
    const { error } = await supabase.rpc("vendor_toggle_menu_item_availability", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_item_id: item.id,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    void loadMenu();
  };

  const deleteMenuItem = async (id: string) => {
    if (!vendorPhone) return;
    const item = menuItems.find((m) => m.id === id);
    const { error } = await supabase.rpc("vendor_delete_menu_item", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_item_id: id,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    if (item?.image_url) void bestEffortDeleteMenuPhotoByUrl(item.image_url);
    void loadMenu();
  };

  const menuPhotoErrorToast = (err: unknown) => {
    if (err instanceof MenuPhotoValidationError) {
      if (err.message === "menu_photo_too_large") toast.error(s.menu_photoTooLarge);
      else if (err.message === "unsupported_menu_photo_type") toast.error(s.menu_photoUnsupportedType);
      else toast.error(s.menu_photoUploadFailed);
      return;
    }
    captureError(err, { scope: "vendorMyBusinessOps.menuPhotoUpload", vendorId: vendor.id });
    toast.error(s.menu_photoUploadFailed);
  };

  const onMenuPhotoCaptured = async (shot: CapturedShot, target: "new" | "edit") => {
    setMenuPhotoUploading(true);
    try {
      const uploaded = await uploadMenuPhoto(vendor.id, shot.blob);
      if (target === "new") {
        setNewItem((p) => {
          if (p.image_url) void bestEffortDeleteMenuPhotoByUrl(p.image_url);
          return { ...p, image_url: uploaded.publicUrl };
        });
      } else {
        setEditDraft((p) => {
          if (p.image_url && p.image_url !== editingMenuItem?.image_url) {
            void bestEffortDeleteMenuPhotoByUrl(p.image_url);
          }
          return { ...p, image_url: uploaded.publicUrl };
        });
      }
    } catch (err) {
      menuPhotoErrorToast(err);
    } finally {
      setMenuPhotoUploading(false);
    }
  };

  const startVoiceMenu = async () => {
    if (!activeCategoryId) return;
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error(s.vendor_voice_not_available);
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
        body: JSON.stringify({ text, phone: vendorPhone, vendor_id: vendor.id }),
      });
      const result = await resp.json();
      if (result.success && result.items?.length && vendorPhone) {
        const { error: insertError } = await supabase.rpc("vendor_insert_menu_items", {
          p_vendor_id: vendor.id,
          p_vendor_phone: vendorPhone,
          p_items: result.items.map(
            (item: { description?: string; unit_price?: number; unit?: string }, idx: number) => ({
              name: item.description ?? "",
              price: item.unit_price ?? 0,
              unit: item.unit || null,
              sort_order: menuItems.length + idx,
              category_id: activeCategoryId,
            }),
          ),
        });
        if (insertError) {
          toast.error(insertError.message);
          return;
        }
        void loadMenu();
        toast.success(s.menu_voiceAdded);
      } else {
        toast.error(s.voice_failed);
      }
    } catch {
      // user cancelled
    } finally {
      setIsListeningMenu(false);
    }
  };

  const startImageMenu = async () => {
    if (!activeCategoryId) return;
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
          body: JSON.stringify({
            image_base64: base64,
            media_type: file.type,
            phone: vendorPhone,
            vendor_id: vendor.id,
          }),
        });
        const result = await resp.json();
        if (result.success && result.items?.length && vendorPhone) {
          const { error: insertError } = await supabase.rpc("vendor_insert_menu_items", {
            p_vendor_id: vendor.id,
            p_vendor_phone: vendorPhone,
            p_items: result.items.map(
              (item: { description?: string; unit_price?: number; unit?: string }, idx: number) => ({
                name: item.description ?? "",
                price: item.unit_price ?? 0,
                unit: item.unit || null,
                sort_order: menuItems.length + idx,
                category_id: activeCategoryId,
              }),
            ),
          });
          if (insertError) {
            toast.error(insertError.message);
            setIsProcessingImageMenu(false);
            return;
          }
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

  const businessHasLocation =
    activeSettings?.latitude != null &&
    activeSettings?.longitude != null &&
    Number.isFinite(activeSettings.latitude) &&
    Number.isFinite(activeSettings.longitude);

  return (
    <SettingsCard className="mx-0 mt-3 border-surface-border" data-testid="my-business-operations">
      {isMultiCategory && (
        <div className="px-4 pt-3 pb-2 space-y-1.5" data-testid="my-business-ops-category-picker">
          <p className="text-xs text-muted-foreground">{s.cancel_reasons_pick_category}</p>
          <div className="flex flex-wrap gap-1.5">
            {approvedCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                data-testid={`my-business-ops-cat-${cat.id}`}
                onClick={() => onActiveCategoryIdChange(cat.id)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs font-semibold",
                  activeCategoryId === cat.id
                    ? "border-brand bg-brand/15 text-brand"
                    : "border-surface-border text-muted-foreground",
                )}
              >
                {cat.emoji ? `${cat.emoji} ` : ""}
                {getLabel(cat.label)}
              </button>
            ))}
          </div>
        </div>
      )}

      <SettingsCollapsible
        label={s.vendor_note_customers}
        open={noteOpen}
        onToggle={() => setNoteOpen((o) => !o)}
        nested
      >
        <div className="p-4">
          {activeCategoryId ? (
            <VendorCategoryNoteEditor
              vendorId={vendor.id}
              categoryId={activeCategoryId}
              initialNote={activeSettings?.vendor_note ?? null}
              onSaved={(newNote) => onCategoryNoteSaved(activeCategoryId, newNote)}
              showLabel={false}
              className="mt-0"
            />
          ) : (
            <p className="text-xs text-muted-foreground">{s.vendor_categories_required}</p>
          )}
        </div>
      </SettingsCollapsible>

      <SettingsCollapsible
        label={s.menu_title}
        badge={
          menuLoadFailed ? null : (
            <span className="text-[10px] font-semibold text-muted-foreground normal-case tracking-normal">
              {scopedMenuItems.length} items
            </span>
          )
        }
        open={menuOpen}
        onToggle={() => setMenuOpen((o) => !o)}
        nested
      >
        <div className="flex items-center justify-end gap-2 px-4 py-2 border-b border-surface-border">
          <button
            type="button"
            onClick={() => void startImageMenu()}
            disabled={isProcessingImageMenu || !activeCategoryId}
            className="p-1.5 rounded-lg border border-surface-border bg-surface text-muted-foreground active:text-brand disabled:opacity-50"
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
                  {s.settings_listeningSpeak}
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void startVoiceMenu()}
                disabled={!activeCategoryId}
                className="p-1.5 rounded-lg border border-surface-border bg-surface text-muted-foreground active:text-brand shrink-0 disabled:opacity-50"
                aria-label={s.menu_voicePrompt}
              >
                <Mic className="h-3.5 w-3.5" />
              </button>
            ))}
        </div>

        {menuLoading && (
          <p className="text-xs text-muted-foreground px-4 py-3.5">{s.settings_loading}</p>
        )}

        {!menuLoading && menuLoadFailed && (
          <div className="px-4 py-3.5 space-y-2">
            <p className="text-xs text-destructive">{s.menu_items_unavailable}</p>
            <button
              type="button"
              onClick={() => void loadMenu()}
              className="rounded-lg border border-surface-border px-2.5 py-1 text-xs font-semibold text-foreground"
            >
              {s.network_retry_btn}
            </button>
          </div>
        )}

        {!menuLoading && !menuLoadFailed && scopedMenuItems.length === 0 && (
          <p className="text-xs text-muted-foreground px-4 py-3.5">{s.menu_empty}</p>
        )}

        {scopedMenuItems.map((item) => (
          <SettingsRow
            key={item.id}
            label={
              <span className="flex items-center gap-2 min-w-0">
                {item.image_url ? (
                  <img
                    src={item.image_url}
                    alt=""
                    className="h-10 w-10 rounded-lg object-cover shrink-0 border border-surface-border"
                  />
                ) : null}
                <span className="truncate">{item.name}</span>
              </span>
            }
            sublabel={
              <>
                {item.description && <span className="block truncate">{item.description}</span>}
                <span className="text-brand font-semibold">
                  ₹{item.price}
                  {item.unit ? `/${item.unit}` : ""}
                </span>
              </>
            }
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void toggleAvailability(item)}
                className={cn(
                  "text-xs px-2 py-1 rounded-lg border whitespace-nowrap",
                  item.is_available
                    ? "border-brand/40 text-brand"
                    : "border-surface-border text-muted-foreground",
                )}
              >
                {item.is_available ? s.menu_available : s.menu_unavailable}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingMenuItem(item);
                  setEditDraft({
                    name: item.name,
                    price: String(item.price),
                    unit: item.unit ?? "",
                    description: item.description ?? "",
                    image_url: item.image_url ?? null,
                  });
                }}
                className="p-1.5 text-muted-foreground active:text-brand"
                aria-label={s.vendor_menu_edit_aria}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void deleteMenuItem(item.id)}
                className="p-1.5 text-muted-foreground active:text-danger"
                aria-label={s.vendor_menu_delete_aria}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </SettingsRow>
        ))}

        {addingItem && (
          <div className="px-4 py-3 border-t border-surface-border space-y-2">
            <input
              type="text"
              value={newItem.name}
              onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
              placeholder={s.menu_itemName}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                value={newItem.price}
                onChange={(e) => setNewItem((p) => ({ ...p, price: e.target.value }))}
                placeholder={s.menu_price}
                className="bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
              />
              <input
                type="text"
                value={newItem.unit}
                onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))}
                placeholder={s.menu_unit}
                className="bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
              />
            </div>
            <input
              type="text"
              value={newItem.description}
              onChange={(e) => setNewItem((p) => ({ ...p, description: e.target.value }))}
              placeholder={s.menu_description}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
            />
            <button
              type="button"
              onClick={() => void saveNewItem()}
              disabled={!newItem.name.trim() || !newItem.price}
              className="w-full rounded-lg bg-brand text-page-bg text-sm font-semibold py-2 disabled:opacity-50"
            >
              {s.menu_save}
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => setAddingItem(true)}
          disabled={!activeCategoryId}
          className="w-full mx-4 mb-3 mt-1 rounded-xl border border-brand/30 bg-brand/5 py-3 text-sm font-semibold text-brand active:scale-[0.99] disabled:opacity-50"
        >
          + {s.menu_addItem}
        </button>
      </SettingsCollapsible>

      <Sheet
        open={editingMenuItem !== null}
        onOpenChange={(open) => {
          if (!open) setEditingMenuItem(null);
        }}
      >
        <SheetContent className="bg-page-bg border-surface-border">
          <SheetHeader>
            <SheetTitle className="text-foreground">{s.menu_itemName}</SheetTitle>
          </SheetHeader>
          {editingMenuItem && (
            <div className="mt-4 space-y-2">
              <input
                type="text"
                value={editDraft.name}
                onChange={(e) => setEditDraft((p) => ({ ...p, name: e.target.value }))}
                placeholder={s.menu_itemName}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  value={editDraft.price}
                  onChange={(e) => setEditDraft((p) => ({ ...p, price: e.target.value }))}
                  placeholder={s.menu_price}
                  className="bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
                />
                <input
                  type="text"
                  value={editDraft.unit}
                  onChange={(e) => setEditDraft((p) => ({ ...p, unit: e.target.value }))}
                  placeholder={s.menu_unit}
                  className="bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
                />
              </div>
              <input
                type="text"
                value={editDraft.description}
                onChange={(e) => setEditDraft((p) => ({ ...p, description: e.target.value }))}
                placeholder={s.menu_description}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
              />
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void saveEditedMenuItem()}
                  className="flex-1 rounded-lg bg-brand text-page-bg text-sm font-semibold py-2"
                >
                  {s.menu_save}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingMenuItem(null)}
                  className="flex-1 rounded-lg border border-surface-border text-sm py-2 text-foreground"
                >
                  {s.settings_cancel}
                </button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <VendorCategoryOffers
        vendorId={vendor.id}
        businessCategoryId={activeCategoryId}
        businessReachKm={activeSettings?.service_radius_km ?? null}
        businessHasLocation={businessHasLocation}
      />

      <SettingsCollapsible
        label={s.cancelReasons}
        open={cancelOpen}
        onToggle={() => setCancelOpen((o) => !o)}
        nested
      >
        <p className="text-xs text-muted-foreground px-4 pt-3 pb-2">{s.cancelReasonsSubtitle}</p>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="px-4 py-2 space-y-1 border-b border-surface-border last:border-0">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {`${s.rejectionReasonField} ${i + 1}`}
            </label>
            <input
              type="text"
              value={cancelReasons[i]}
              disabled={isMultiCategory && !activeCategoryId}
              onChange={(e) => {
                const next = [...cancelReasons];
                next[i] = e.target.value.slice(0, 60);
                setCancelReasons(next);
                setCancelReasonsChanged(true);
              }}
              maxLength={60}
              className="w-full bg-surface border border-surface-border rounded-xl px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-brand disabled:opacity-50"
            />
          </div>
        ))}
        <div className="flex justify-end px-4 py-3">
          <button
            type="button"
            onClick={() => void saveCancelReasons()}
            disabled={
              savingReasons ||
              !cancelReasonsChanged ||
              (isMultiCategory && !activeCategoryId)
            }
            className="text-xs font-semibold text-brand active:opacity-80 disabled:opacity-50"
          >
            {savingReasons ? s.incoming_saving : s.saveReasons}
          </button>
        </div>
      </SettingsCollapsible>

      <LiveCamera
        open={menuPhotoCameraTarget !== null}
        onClose={() => setMenuPhotoCameraTarget(null)}
        onCapture={(shot) => {
          const target = menuPhotoCameraTarget;
          setMenuPhotoCameraTarget(null);
          if (target) void onMenuPhotoCaptured(shot, target);
        }}
      />
    </SettingsCard>
  );
}
