import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { supabase, type Vendor, CATEGORIES } from "@/lib/supabase";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Power, AlertCircle, MapPin } from "lucide-react";

const STORAGE_KEY = "aaspaas:vendor_id";

const VendorMode = () => {
  const [vendorId, setVendorId] = useState<string | null>(localStorage.getItem(STORAGE_KEY));
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // form
  const [name, setName] = useState("");
  const [shopName, setShopName] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0].label);
  const [upi, setUpi] = useState("");
  const [phone, setPhone] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    localStorage.setItem("aaspaas:role", "vendor");
  }, []);

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

  const detectLocation = () => {
    if (!("geolocation" in navigator)) {
      toast.error("Geolocation not supported on this device.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setCoords({ lat: p.coords.latitude, lng: p.coords.longitude });
        setLocating(false);
        toast.success("Shop location captured");
      },
      (err) => {
        setLocating(false);
        toast.error("Couldn't get location", { description: err.message });
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from("vendors")
      .insert({
        name: name.trim(),
        shop_name: shopName.trim(),
        category: category.trim(),
        upi_id: upi.trim(),
        phone: phone.trim(),
        is_active: false,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
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
    toast.success("Welcome aboard!", { description: "Flip the toggle to start receiving requests." });
  };

  const toggleActive = async () => {
    if (!vendor) return;
    const next = !vendor.is_active;
    setVendor({ ...vendor, is_active: next }); // optimistic
    const { error } = await supabase.from("vendors").update({ is_active: next }).eq("id", vendor.id);
    if (error) {
      setVendor({ ...vendor, is_active: !next });
      toast.error("Couldn't update status", { description: error.message });
    } else {
      toast(next ? "You're live ✨" : "You're offline", {
        description: next ? "Customers nearby can now find you." : "You won't receive new requests.",
      });
    }
  };

  const signOut = () => {
    localStorage.removeItem(STORAGE_KEY);
    setVendorId(null);
    setVendor(null);
  };

  return (
    <AppShell>
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
              className="mt-1 w-full bg-card border border-border rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.label}>{c.emoji}  {c.label}</option>
              ))}
              <option value="Food & Sweets">🍮  Food & Sweets</option>
              <option value="Other">✨  Other</option>
            </select>
          </div>
          <Field label="Phone" value={phone} onChange={setPhone} placeholder="+91 98xxxxxxxx" required />
          <Field label="UPI ID" value={upi} onChange={setUpi} placeholder="name@okbank" required />

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
            disabled={loading}
            className="w-full mt-2 rounded-2xl bg-gradient-vendor text-secondary-foreground py-4 font-semibold shadow-card active:scale-[0.98] disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
            Register me
          </button>
        </form>
      )}

      {vendorId && loading && !vendor && (
        <div className="grid place-items-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {vendor && (
        <div className="space-y-5 animate-fade-up">
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
          </div>

          <div className="rounded-2xl bg-muted/60 p-4 text-sm space-y-1">
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

          <button onClick={signOut} className="w-full text-sm text-muted-foreground underline">
            Switch vendor account
          </button>
        </div>
      )}
    </AppShell>
  );
};

const Field = ({
  label, value, onChange, placeholder, required,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) => (
  <div>
    <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      className="mt-1 w-full bg-card border border-border rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2 focus:ring-primary"
    />
  </div>
);

export default VendorMode;
