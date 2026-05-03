import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import {
  supabase,
  type Vendor,
  type VerificationStatus,
  type CategoryClassification,
  CATEGORIES,
  SHOP_PHOTOS_BUCKET,
  GPS_MATCH_TOLERANCE_M,
  isValidPhone,
  isValidUpi,
  isMobileCategory,
  distanceMeters,
  classifyCategory,
} from "@/lib/supabase";
import { toast } from "sonner";
import {
  CheckCircle2,
  Loader2,
  Power,
  AlertCircle,
  MapPin,
  Camera,
  ShieldCheck,
  AlertTriangle,
  Truck,
} from "lucide-react";
import { LiveCamera, type CapturedShot } from "@/components/LiveCamera";
import { VerificationBadge } from "@/components/VerificationBadge";

const STORAGE_KEY = "aaspaas:vendor_id";

// Heuristic gibberish detector: rejects keyboard mashing like "asdfasdf"
// or strings without any vowels. Tuned to be permissive for real names.
function looksLikeGibberish(s: string) {
  const t = s.trim().toLowerCase();
  if (t.length < 2) return true;
  if (!/[aeiouy]/.test(t)) return true;                  // no vowels
  if (/(.)\1{3,}/.test(t)) return true;                  // 4+ repeats: "aaaa"
  if (/^[asdfghjkl;]+$/.test(t) && t.length > 4) return true; // home-row mash
  if (/^[qwertyuiop]+$/.test(t) && t.length > 4) return true;
  return false;
}

const VendorMode = () => {
  const [vendorId, setVendorId] = useState<string | null>(
    localStorage.getItem(STORAGE_KEY),
  );
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- registration form ----
  const [name, setName] = useState("");
  const [shopName, setShopName] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0].label);
  const [customCategory, setCustomCategory] = useState("");
  const [categorySuggestion, setCategorySuggestion] =
    useState<CategoryClassification | null>(null);
  const [classifyingCategory, setClassifyingCategory] = useState(false);
  const [confirmedCategory, setConfirmedCategory] = useState<string | null>(null);
  const [upi, setUpi] = useState("");
  const [phone, setPhone] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);

  // ---- profile actions ----
  const [cameraOpen, setCameraOpen] = useState(false);
  const [verifyingUpi, setVerifyingUpi] = useState(false);
  const [updatingLocation, setUpdatingLocation] = useState(false);

  useEffect(() => {
    localStorage.setItem("aaspaas:role", "vendor");
  }, []);

  // Broadcast vendor "live" state so the BottomNav can pulse the Vendor tab.
  useEffect(() => {
    const live = !!vendor?.is_active;
    if (live) localStorage.setItem("aaspaas:vendor_live", "1");
    else localStorage.removeItem("aaspaas:vendor_live");
    window.dispatchEvent(new CustomEvent("aaspaas:vendor_live", { detail: live }));
    return () => {
      // On unmount we don't clear — the flag should reflect DB state, not route.
    };
  }, [vendor?.is_active]);

  useEffect(() => {
    if (!vendorId) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from("vendors")
      .select("*")
      .eq("id", vendorId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setError(error.message);
        else if (!data) {
          localStorage.removeItem(STORAGE_KEY);
          setVendorId(null);
        } else setVendor(data as Vendor);
        setLoading(false);
      });

    const channel = supabase
      .channel(`vendor-${vendorId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "vendors", filter: `id=eq.${vendorId}` },
        (payload) => setVendor(payload.new as Vendor),
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [vendorId]);

  const detectLocation = (): Promise<{ lat: number; lng: number } | null> => {
    return new Promise((resolve) => {
      if (!("geolocation" in navigator)) {
        toast.error("Geolocation not supported on this device.");
        resolve(null);
        return;
      }
      setLocating(true);
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const c = { lat: p.coords.latitude, lng: p.coords.longitude };
          setCoords(c);
          setLocating(false);
          toast.success("Shop location captured");
          resolve(c);
        },
        (err) => {
          setLocating(false);
          toast.error("Couldn't get location", { description: err.message });
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
      );
    });
  };

  // ---- registration ----
  const phoneOk = isValidPhone(phone);
  const upiFmtOk = isValidUpi(upi);
  const isOther = category === "Other";
  const effectiveCategory =
    isOther && confirmedCategory ? confirmedCategory : isOther ? customCategory.trim() : category.trim();
  const categoryOk =
    effectiveCategory.length > 1 && !looksLikeGibberish(effectiveCategory);
  const nameOk = name.trim().length > 1 && !looksLikeGibberish(name);
  const shopOk = shopName.trim().length > 1 && !looksLikeGibberish(shopName);
  const canRegister =
    nameOk &&
    shopOk &&
    categoryOk &&
    phoneOk &&
    upiFmtOk &&
    !loading;

  useEffect(() => {
    if (!isOther) {
      setCategorySuggestion(null);
      setClassifyingCategory(false);
      setConfirmedCategory(null);
      return;
    }

    const raw = customCategory.trim();
    setConfirmedCategory(null);
    if (raw.length < 2 || looksLikeGibberish(raw)) {
      setCategorySuggestion(null);
      setClassifyingCategory(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setClassifyingCategory(true);
      try {
        const result = await classifyCategory(raw);
        if (cancelled) return;
        setCategorySuggestion(result);
      } catch {
        if (cancelled) return;
        setCategorySuggestion(null);
      } finally {
        if (!cancelled) setClassifyingCategory(false);
      }
    }, 1000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOther, customCategory]);

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    // Surface the most useful error first.
    if (!nameOk) {
      toast.error("That name doesn't look right", {
        description: "Please enter your real name (letters only, no random keys).",
      });
      return;
    }
    if (!shopOk) {
      toast.error("Shop name looks invalid", {
        description: "Please enter a real shop name we can show to customers.",
      });
      return;
    }
    if (!categoryOk) {
      toast.error("Specify your service", {
        description: "When choosing 'Other', describe your service in plain words.",
      });
      return;
    }
    if (!phoneOk) {
      toast.error("Invalid phone number", {
        description: "Enter a valid 10-digit Indian mobile number.",
      });
      return;
    }
    if (!upiFmtOk) {
      toast.error("Invalid UPI ID", {
        description: "UPI must look like handle@bank (e.g. ramesh@okicici).",
      });
      return;
    }
    setLoading(true);
    setError(null);

    // Phone + UPI on file ⇒ identity_linked
    const initialStatus: VerificationStatus = "identity_linked";

    const { data, error } = await supabase
      .from("vendors")
      .insert({
        name: name.trim(),
        shop_name: shopName.trim(),
        category: effectiveCategory,
        upi_id: upi.trim(),
        phone: phone.trim(),
        is_active: false,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
        verification_status: initialStatus,
        upi_verified: false,
        is_manual_verified: false,
        shop_photo_url: null,
      })
      .select()
      .single();
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    localStorage.setItem(STORAGE_KEY, data.id);
    setVendorId(data.id);
    setVendor(data as Vendor);
    toast.success("Welcome aboard!", {
      description: "Identity linked. Capture a live shop photo to upgrade to Verified.",
    });
  };

  // ---- runtime actions ----
  const toggleActive = async () => {
    if (!vendor) return;
    const next = !vendor.is_active;
    setVendor({ ...vendor, is_active: next });

    // Mobile services (mechanic, key maker) refresh GPS each time they go live,
    // so customers always see their current position on the radar.
    let liveCoords: { lat: number; lng: number } | null = null;
    if (next && isMobileCategory(vendor.category)) {
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          if (!("geolocation" in navigator)) {
            reject(new Error("Geolocation not supported"));
            return;
          }
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 8000,
            maximumAge: 0,
          });
        });
        liveCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch (e: any) {
        setVendor({ ...vendor, is_active: !next });
        toast.error("Location required to go live", {
          description: "Mobile services need a fresh GPS fix when going online.",
        });
        return;
      }
    }

    const patch: Record<string, unknown> = { is_active: next };
    if (liveCoords) {
      patch.latitude = liveCoords.lat;
      patch.longitude = liveCoords.lng;
    }

    const { error } = await supabase
      .from("vendors")
      .update(patch)
      .eq("id", vendor.id);
    if (error) {
      setVendor({ ...vendor, is_active: !next });
      toast.error("Couldn't update status", { description: error.message });
    } else {
      toast(next ? "You're live ✨" : "You're offline", {
        description: next
          ? liveCoords
            ? "Live position updated. Customers nearby can now find you."
            : "Customers nearby can now find you."
          : "You won't receive new requests.",
      });
    }
  };

  const verifyUpi = async () => {
    if (!vendor) return;
    if (!isValidUpi(vendor.upi_id)) {
      toast.error("Invalid UPI format", { description: "Expected handle@bank" });
      return;
    }
    setVerifyingUpi(true);
    // Simulated bank-name lookup. Replace with a real PSP call later.
    await new Promise((r) => setTimeout(r, 900));
    const bank = vendor.upi_id.split("@")[1] ?? "bank";
    const { error } = await supabase
      .from("vendors")
      .update({ upi_verified: true })
      .eq("id", vendor.id);
    setVerifyingUpi(false);
    if (error) {
      toast.error("Couldn't verify UPI", { description: error.message });
      return;
    }
    toast.success(`UPI verified · ${bank.toUpperCase()}`, {
      description: "Bank handle looks valid.",
    });
  };

  const handleShopPhoto = async (shot: CapturedShot) => {
    if (!vendor) return;
    setCameraOpen(false);

    // 1. GPS match check vs the recorded shop coords.
    if (vendor.latitude == null || vendor.longitude == null) {
      toast.error("Set your shop location first", {
        description: "Tap 'Update Shop Location' before capturing the photo.",
      });
      return;
    }
    const meters = distanceMeters(
      { lat: vendor.latitude, lng: vendor.longitude },
      shot.coords,
    );
    if (meters > GPS_MATCH_TOLERANCE_M) {
      toast.error("Location mismatch", {
        description: `Photo was taken ${Math.round(meters)} m from your shop. Must be within ${GPS_MATCH_TOLERANCE_M} m.`,
      });
      return;
    }

    // 2. Upload to Storage.
    const path = `${vendor.id}/${Date.now()}.jpg`;
    const { error: upErr } = await supabase.storage
      .from(SHOP_PHOTOS_BUCKET)
      .upload(path, shot.blob, {
        contentType: "image/jpeg",
        upsert: true,
      });
    if (upErr) {
      toast.error("Upload failed", { description: upErr.message });
      return;
    }
    const { data: pub } = supabase.storage.from(SHOP_PHOTOS_BUCKET).getPublicUrl(path);

    // 3. Promote to business_verified (admin still gates the green glow).
    const { error: updErr } = await supabase
      .from("vendors")
      .update({
        shop_photo_url: pub.publicUrl,
        verification_status: "business_verified" as VerificationStatus,
      })
      .eq("id", vendor.id);
    if (updErr) {
      toast.error("Couldn't save verification", { description: updErr.message });
      return;
    }
    toast.success("Shop photo verified", {
      description: vendor.is_manual_verified
        ? "Green badge live."
        : "Awaiting final admin approval for the Green badge.",
    });
  };

  const updateShopLocation = async () => {
    if (!vendor) return;
    if (vendor.verification_status === "business_verified") {
      const ok = window.confirm(
        "Changing your location will require re-verification of your shop. Continue?",
      );
      if (!ok) return;
    }
    const c = await detectLocation();
    if (!c) return;
    setUpdatingLocation(true);

    // If they were business_verified, drop them back to identity_linked and
    // clear the manual flag — admin must re-approve after a fresh photo.
    const downgraded = vendor.verification_status === "business_verified";
    const patch: Partial<Vendor> = {
      latitude: c.lat,
      longitude: c.lng,
      ...(downgraded
        ? {
            verification_status: "identity_linked" as VerificationStatus,
            shop_photo_url: null,
            is_manual_verified: false,
          }
        : {}),
    };
    const { error } = await supabase
      .from("vendors")
      .update(patch)
      .eq("id", vendor.id);
    setUpdatingLocation(false);
    if (error) {
      toast.error("Couldn't update location", { description: error.message });
      return;
    }
    toast(downgraded ? "Re-verification required" : "Location updated", {
      description: downgraded
        ? "Capture a new live shop photo to regain Verified status."
        : "Your shop coordinates have been saved.",
    });
  };

  const signOut = () => {
    localStorage.removeItem(STORAGE_KEY);
    setVendorId(null);
    setVendor(null);
  };

  return (
    <AppShell theme="dark">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Vendor Mode</p>
        <h1 className="font-display text-3xl font-bold mt-1">Earn from your skills.</h1>
      </header>

      {error && (
        <div className="mb-4 rounded-2xl bg-destructive/10 border border-destructive/30 p-4 flex gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive break-words">{error}</p>
        </div>
      )}

      {!vendorId && (
        <form onSubmit={register} className="space-y-3 animate-fade-up">
          <Field label="Your Name" value={name} onChange={setName} placeholder="Ramesh Kumar" required />
          <Field label="Shop Name" value={shopName} onChange={setShopName} placeholder="Ramesh Tyre Works" required />
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="mt-1 w-full bg-card border border-border rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2 focus:ring-primary vendor-select"
            >
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.label}>{c.emoji}  {c.label}</option>
              ))}
            </select>
            {isOther && (
              <div className="mt-3 animate-fade-up">
                <Field
                  label="Specify Your Service"
                  value={customCategory}
                  onChange={setCustomCategory}
                  placeholder="e.g. Carpenter, Tailor, Tiffin Service"
                  required
                  error={
                    customCategory.length > 0 && !categoryOk
                      ? "Please describe your service in plain words."
                      : undefined
                  }
                />
                {classifyingCategory && (
                  <p className="mt-2 text-xs text-muted-foreground inline-flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Understanding your service...
                  </p>
                )}
                {categorySuggestion && !confirmedCategory && (
                  <div className="mt-2 rounded-xl border border-[#22C55E]/40 bg-[#22C55E]/10 p-3">
                    <p className="text-sm text-[#22C55E] font-medium">
                      We think you mean: {categorySuggestion.canonical} {categorySuggestion.emoji} (
                      {categorySuggestion.mode === "help" ? "Help service" : "Delivery service"})
                    </p>
                    <button
                      type="button"
                      onClick={() => setConfirmedCategory(categorySuggestion.canonical)}
                      className="mt-2 rounded-lg bg-[#22C55E] text-[#0b1f14] px-3 py-1.5 text-xs font-semibold"
                    >
                      Confirm
                    </button>
                  </div>
                )}
                {confirmedCategory && (
                  <p className="mt-2 text-xs text-[#22C55E] font-semibold">
                    Confirmed category: {confirmedCategory}
                  </p>
                )}
              </div>
            )}
          </div>
          <Field
            label="Phone (required)"
            value={phone}
            onChange={setPhone}
            placeholder="+91 98xxxxxxxx"
            required
            error={phone.length > 0 && !phoneOk ? "Enter a valid 10-digit Indian mobile number." : undefined}
          />
          <Field
            label="UPI ID"
            value={upi}
            onChange={setUpi}
            placeholder="name@okbank"
            required
            error={upi.length > 0 && !upiFmtOk ? "UPI must look like handle@bank." : undefined}
          />

          <button
            type="button"
            onClick={detectLocation}
            className={`w-full rounded-xl border-2 py-3.5 flex items-center justify-center gap-2 font-semibold transition-colors ${
              coords ? "border-secondary text-secondary bg-secondary/5" : "border-border text-foreground"
            }`}
          >
            {locating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
            {coords
              ? `Location set (${coords.lat.toFixed(3)}, ${coords.lng.toFixed(3)})`
              : "Use my current location"}
          </button>

          <button
            disabled={!canRegister}
            className="w-full mt-2 rounded-2xl bg-gradient-vendor text-secondary-foreground py-4 font-semibold shadow-card active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
            Register me
          </button>
          {!phoneOk && (
            <p className="text-xs text-muted-foreground text-center">
              Registration unlocks once a valid phone number is entered.
            </p>
          )}
        </form>
      )}

      {vendorId && loading && !vendor && (
        <div className="grid place-items-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {vendor && (
        <div className="space-y-5 animate-fade-up">
          {/* Status card */}
          <div className="rounded-3xl bg-card border border-border shadow-card p-6 text-center">
            <p className="text-xs uppercase tracking-[0.25em] text-muted-foreground">Status</p>
            <p className={`mt-1 font-display text-2xl font-bold ${vendor.is_active ? "text-secondary" : "text-muted-foreground"}`}>
              {vendor.is_active ? "Ready to Help" : "Offline"}
            </p>

            <button
              onClick={toggleActive}
              aria-pressed={vendor.is_active}
              className={`mt-6 mx-auto h-32 w-32 rounded-full grid place-items-center transition-all active:scale-95 ${
                vendor.is_active
                  ? "bg-gradient-vendor shadow-glow text-secondary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <Power className="h-12 w-12" strokeWidth={2.5} />
            </button>

            <p className="mt-5 text-sm text-muted-foreground">
              Tap to {vendor.is_active ? "go offline" : "go live"} instantly.
            </p>
            {isMobileCategory(vendor.category) && (
              <p className="mt-2 text-[11px] text-muted-foreground inline-flex items-center justify-center gap-1">
                <Truck className="h-3 w-3 text-secondary" />
                Mobile service · GPS refreshes each time you go live.
              </p>
            )}

            <div className="mt-4 flex justify-center">
              <VerificationBadge vendor={vendor} showLabel />
            </div>
          </div>

          {/* Verification card */}
          <div className="rounded-2xl bg-card border border-border shadow-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-secondary" />
              <h2 className="font-display font-bold">Verification</h2>
            </div>

            <Step
              done={isValidPhone(vendor.phone ?? "")}
              title="Phone on file"
              sub={vendor.phone || "Not provided"}
            />

            <div className="flex items-start justify-between gap-3">
              <Step
                done={vendor.upi_verified}
                title="UPI bank-match"
                sub={vendor.upi_id}
              />
              {!vendor.upi_verified && (
                <button
                  onClick={verifyUpi}
                  disabled={verifyingUpi}
                  className="text-xs font-semibold rounded-lg bg-primary text-primary-foreground px-3 py-2 disabled:opacity-60 shrink-0"
                >
                  {verifyingUpi ? "Checking…" : "Verify UPI"}
                </button>
              )}
            </div>

            <div className="flex items-start justify-between gap-3">
              <Step
                done={!!vendor.shop_photo_url}
                title="Live shop photo + GPS match"
                sub={
                  vendor.shop_photo_url
                    ? "Captured & GPS verified"
                    : "Live camera only · within 75 m of shop"
                }
              />
              <button
                onClick={() => setCameraOpen(true)}
                className="text-xs font-semibold rounded-lg bg-foreground text-background px-3 py-2 shrink-0 inline-flex items-center gap-1"
              >
                <Camera className="h-3.5 w-3.5" />
                {vendor.shop_photo_url ? "Re-shoot" : "Capture"}
              </button>
            </div>

            {vendor.shop_photo_url && (
              <img
                src={vendor.shop_photo_url}
                alt="Captured shop"
                className="w-full rounded-xl border border-border"
              />
            )}

            <div className="rounded-xl bg-muted/60 p-3 text-xs text-muted-foreground">
              The Green “Business Verified” badge glows only after admin
              approval ({vendor.is_manual_verified ? "✅ approved" : "pending"}).
            </div>
          </div>

          {/* Shop info */}
          <div className="rounded-2xl bg-muted/60 p-4 text-sm space-y-2">
            <div>
              <p className="font-semibold">{vendor.shop_name}</p>
              <p className="text-muted-foreground">{vendor.name} · {vendor.category}</p>
              <p className="text-muted-foreground text-xs">📞 {vendor.phone}</p>
              <p className="text-muted-foreground text-xs">UPI: {vendor.upi_id}</p>
              {vendor.latitude != null && vendor.longitude != null && (
                <p className="text-muted-foreground text-xs">
                  📍 {vendor.latitude.toFixed(4)}, {vendor.longitude.toFixed(4)}
                </p>
              )}
            </div>
            <button
              onClick={updateShopLocation}
              disabled={updatingLocation}
              className="w-full rounded-xl border-2 border-border py-2.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {updatingLocation ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MapPin className="h-4 w-4" />
              )}
              Update Shop Location
            </button>
            {vendor.verification_status === "business_verified" && (
              <p className="text-[11px] text-muted-foreground inline-flex items-start gap-1">
                <AlertTriangle className="h-3 w-3 text-accent mt-0.5 shrink-0" />
                Moving location will reset your Verified status.
              </p>
            )}
          </div>

          <button onClick={signOut} className="w-full text-sm text-muted-foreground underline">
            Switch vendor account
          </button>
        </div>
      )}

      <LiveCamera
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={handleShopPhoto}
      />
    </AppShell>
  );
};

const Field = ({
  label, value, onChange, placeholder, required, error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  error?: string;
}) => (
  <div>
    <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      className={`mt-1 w-full bg-card border rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2 ${
        error ? "border-destructive focus:ring-destructive" : "border-border focus:ring-primary"
      }`}
    />
    {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
  </div>
);

const Step = ({ done, title, sub }: { done: boolean; title: string; sub: string }) => (
  <div className="flex-1 flex items-start gap-3">
    <span
      className={`mt-0.5 h-5 w-5 rounded-full grid place-items-center shrink-0 ${
        done ? "bg-secondary text-secondary-foreground" : "bg-muted text-muted-foreground"
      }`}
    >
      {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
    </span>
    <div className="min-w-0">
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-xs text-muted-foreground truncate">{sub}</p>
    </div>
  </div>
);

export default VendorMode;
