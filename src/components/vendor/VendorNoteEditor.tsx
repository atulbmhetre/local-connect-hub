import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import {
  NetworkExhaustedError,
  throwOnSupabaseNetworkError,
  withNetworkRetry,
} from "@/lib/withNetworkRetry";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  dismissNetworkRetryingToast,
  showNetworkFailedToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";

type Props = {
  vendorId: string;
  initialNote: string | null;
  onSaved: (newNote: string) => void;
  showLabel?: boolean;
  className?: string;
};

export function VendorNoteEditor({
  vendorId,
  initialNote,
  onSaved,
  showLabel = true,
  className,
}: Props) {
  const { s } = useLanguage();
  const [note, setNote] = useState(initialNote ?? "");
  const [saving, setSaving] = useState(false);
  const [noteChanged, setNoteChanged] = useState(false);

  useEffect(() => {
    setNote(initialNote ?? "");
    setNoteChanged(false);
  }, [initialNote]);

  const saveNote = async () => {
    setSaving(true);
    const trimmed = note.trim();
    const vendorPhone = getUserPhone()?.trim();
    if (!vendorPhone) {
      setSaving(false);
      toast.error(s.vendor_note_save_failed);
      return;
    }
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("vendor_update_own", {
              p_vendor_id: vendorId,
              p_vendor_phone: vendorPhone,
              p_patch: { vendor_note: trimmed || null },
            }),
          ),
        {
          onRetrying: () => {
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (error) {
        toast.error(s.vendor_note_save_failed, { description: error.message });
        return;
      }
      onSaved(trimmed);
      setNoteChanged(false);
      toast.success(s.vendor_note_saved);
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void saveNote(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn("space-y-1", showLabel && "mt-4", className)}>
      {showLabel && (
        <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {s.vendor_note_customers}
        </label>
      )}
      <textarea
        value={note}
        onChange={(e) => {
          setNote(e.target.value.slice(0, 100));
          setNoteChanged(true);
        }}
        rows={2}
        placeholder={s.vendor_note_edit_placeholder}
        className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
      />
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-muted-foreground">{note.length}/100</p>
        <button
          type="button"
          onClick={() => void saveNote()}
          disabled={!noteChanged || saving}
          className="text-xs font-semibold text-brand hover:underline disabled:opacity-50"
        >
          {saving ? s.vendor_saving : s.vendor_save_note}
        </button>
      </div>
    </div>
  );
}
