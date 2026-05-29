import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import {
  Tag,
  Megaphone,
  HelpCircle,
  Flag,
  MessageCircle,
  Plus,
  X,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";
import { cn } from "@/lib/utils";

const FEED_IMAGES_BUCKET = "feed-images";
const MAX_CONTENT = 200;
const FLAG_HIDE_THRESHOLD = 5;

type PostType = "offer" | "announcement" | "recommendation";

type FeedPost = {
  id: string;
  user_phone: string;
  vendor_id: string | null;
  type: PostType;
  content: string;
  expires_at: string | null;
  image_url: string | null;
  lat: number | null;
  lng: number | null;
  flagged_count: number;
  is_hidden: boolean;
  created_at: string;
  vendors: { shop_name: string; category: string | null } | null;
};

type FeedReply = {
  id: string;
  post_id: string;
  user_phone: string;
  content: string;
  created_at: string;
};

type ExpiryOption = "today" | "tomorrow" | "3days" | "7days" | "custom";

type FeedCategory = {
  id: string;
  label: string;
  emoji: string;
};

type VendorCard = {
  id: string;
  shop_name: string;
  category: string;
  avg_rating: number | null;
  review_count: number | null;
};

const getPosition = () =>
  new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 }),
  );

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return `••••${last4}`;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function computeExpiresAt(option: ExpiryOption, customDate?: string): string {
  const now = new Date();
  switch (option) {
    case "today":
      return endOfDay(now).toISOString();
    case "tomorrow": {
      const t = new Date(now);
      t.setDate(t.getDate() + 1);
      return endOfDay(t).toISOString();
    }
    case "3days": {
      const t = new Date(now);
      t.setDate(t.getDate() + 3);
      return endOfDay(t).toISOString();
    }
    case "7days": {
      const t = new Date(now);
      t.setDate(t.getDate() + 7);
      return endOfDay(t).toISOString();
    }
    case "custom": {
      if (customDate) {
        const [y, m, d] = customDate.split("-").map(Number);
        return endOfDay(new Date(y, m - 1, d)).toISOString();
      }
      return endOfDay(now).toISOString();
    }
  }
}

function todayDateInputMin(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function expiryBadgeLabel(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfExp = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate());
  const dayDiff = Math.round(
    (startOfExp.getTime() - startOfToday.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (dayDiff <= 0) return "Expires tonight";
  if (dayDiff === 1) return "Expires tomorrow";
  return `Expires in ${dayDiff} days`;
}

export default function LocalFeed() {
  const navigate = useNavigate();

  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCompose, setShowCompose] = useState(false);
  const [composeType, setComposeType] = useState<PostType>("announcement");
  const [composeContent, setComposeContent] = useState("");
  const [expiryOption, setExpiryOption] = useState<ExpiryOption>("today");
  const [customExpiryDate, setCustomExpiryDate] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [replies, setReplies] = useState<Record<string, FeedReply[]>>({});
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set());
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [loadingReplies, setLoadingReplies] = useState<Set<string>>(new Set());
  const [flaggingId, setFlaggingId] = useState<string | null>(null);

  const vendorId = localStorage.getItem("aaspaas:vendor_id");
  const hasVendorId = !!vendorId;

  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [categoryVendors, setCategoryVendors] = useState<VendorCard[]>([]);
  const [loadingVendors, setLoadingVendors] = useState(false);

  const fetchPosts = useCallback(async () => {
    setLoading(true);
    let userLat: number | null = null;
    let userLng: number | null = null;
    try {
      const pos = await getPosition();
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
    } catch {
      userLat = null;
      userLng = null;
    }

    const { data, error } = await supabase
      .from("feed_posts")
      .select("*, vendors(shop_name, category)")
      .eq("is_hidden", false)
      .or("expires_at.is.null,expires_at.gt.now()")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("fetchPosts", error);
      toast.error("Could not load feed");
      setPosts([]);
    } else {
      const rows = (data ?? []) as FeedPost[];
      if (userLat == null || userLng == null) {
        setPosts(rows.slice(0, 50));
      } else {
        const filtered = rows.filter((post) => {
          if (post.lat == null || post.lng == null) return true;
          return haversineKm(userLat, userLng, post.lat, post.lng) <= 50;
        });
        setPosts(filtered.slice(0, 50));
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchPosts();
  }, [fetchPosts]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const { data, error } = await supabase
        .from("categories")
        .select("id, label, emoji")
        .order("sort_order", { ascending: true });
      if (cancelled) return;
      if (error) {
        console.error("fetch categories", error);
        setCategories([]);
        return;
      }
      setCategories((data ?? []) as FeedCategory[]);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchVendorsForCategory = useCallback(
    async (categoryLabel: string) => {
      setLoadingVendors(true);
      const { data, error } = await supabase
        .from("vendors")
        .select("id, shop_name, category, avg_rating, review_count")
        .eq("category", categoryLabel)
        .eq("is_active", true)
        .eq("is_live", true)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("fetchVendorsForCategory", error);
        setCategoryVendors([]);
        setLoadingVendors(false);
        return;
      }

      setCategoryVendors((data ?? []) as VendorCard[]);
      setLoadingVendors(false);
    },
    [],
  );

  useEffect(() => {
    if (selectedCategory === null) {
      setCategoryVendors([]);
      return;
    }
    const meta = categories.find((c) => c.id === selectedCategory);
    if (!meta) return;
    void fetchVendorsForCategory(meta.label);
  }, [categories, fetchVendorsForCategory, selectedCategory]);

  const selectedCategoryMeta = selectedCategory
    ? categories.find((c) => c.id === selectedCategory) ?? null
    : null;

  const loadReplies = async (postId: string) => {
    setLoadingReplies((prev) => new Set(prev).add(postId));
    const { data, error } = await supabase
      .from("feed_replies")
      .select("*")
      .eq("post_id", postId)
      .order("created_at", { ascending: true });

    setLoadingReplies((prev) => {
      const next = new Set(prev);
      next.delete(postId);
      return next;
    });

    if (error) {
      console.error("loadReplies", error);
      toast.error("Could not load replies");
      return;
    }
    setReplies((prev) => ({ ...prev, [postId]: (data ?? []) as FeedReply[] }));
  };

  const toggleReplies = async (postId: string) => {
    const next = new Set(expandedReplies);
    if (next.has(postId)) {
      next.delete(postId);
      setExpandedReplies(next);
      return;
    }
    next.add(postId);
    setExpandedReplies(next);
    if (!replies[postId]) {
      await loadReplies(postId);
    }
  };

  const submitReply = async (postId: string) => {
    const phone = getUserPhone();
    if (!phone) {
      toast.error("Add your phone in Settings first");
      return;
    }
    const content = (replyDrafts[postId] ?? "").trim();
    if (!content) return;

    const { error } = await supabase.from("feed_replies").insert({
      post_id: postId,
      user_phone: phone,
      content,
    });

    if (error) {
      console.error("submitReply", error);
      toast.error("Could not send reply");
      return;
    }

    setReplyDrafts((prev) => ({ ...prev, [postId]: "" }));
    await loadReplies(postId);
  };

  const flagPost = async (postId: string) => {
    const phone = getUserPhone();
    if (!phone) {
      toast.error("Add your phone in Settings first");
      return;
    }

    setFlaggingId(postId);
    const { error: flagErr } = await supabase.from("feed_flags").insert({
      post_id: postId,
      flagged_by_phone: phone,
    });

    if (flagErr) {
      console.error("flagPost", flagErr);
      setFlaggingId(null);
      toast.error("Could not report post");
      return;
    }

    const post = posts.find((p) => p.id === postId);
    const newCount = (post?.flagged_count ?? 0) + 1;
    const { error: updErr } = await supabase
      .from("feed_posts")
      .update({
        flagged_count: newCount,
        ...(newCount >= FLAG_HIDE_THRESHOLD ? { is_hidden: true } : {}),
      })
      .eq("id", postId);

    setFlaggingId(null);

    if (updErr) {
      console.error("flagPost update", updErr);
    }

    toast.success("Post reported");
    if (newCount >= FLAG_HIDE_THRESHOLD) {
      setPosts((prev) => prev.filter((p) => p.id !== postId));
    } else {
      setPosts((prev) =>
        prev.map((p) => (p.id === postId ? { ...p, flagged_count: newCount } : p)),
      );
    }
  };

  const resetCompose = () => {
    setComposeContent("");
    setExpiryOption("today");
    setCustomExpiryDate("");
    setImageFile(null);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(null);
    setComposeType(hasVendorId ? "offer" : "announcement");
  };

  const openCompose = () => {
    resetCompose();
    setShowCompose(true);
  };

  const closeCompose = () => {
    setShowCompose(false);
    resetCompose();
  };

  const uploadFeedImage = async (file: File): Promise<string | null> => {
    const path = `announcements/${Date.now()}-${file.name.replace(/\s+/g, "_")}`;
    const { error } = await supabase.storage
      .from(FEED_IMAGES_BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
    if (error) {
      console.error("uploadFeedImage", error);
      toast.error("Image upload failed");
      return null;
    }
    const { data } = supabase.storage.from(FEED_IMAGES_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  };

  const submitPost = async () => {
    const phone = getUserPhone();
    if (!phone) {
      toast.error("Add your phone in Settings first");
      return;
    }

    const content = composeContent.trim();
    if (!content) {
      toast.error("Write something to post");
      return;
    }
    if (content.length > MAX_CONTENT) {
      toast.error(`Max ${MAX_CONTENT} characters`);
      return;
    }

    if (composeType === "announcement" && !imageFile) {
      toast.error("Image is required for announcements");
      return;
    }

    if (composeType === "offer" && !vendorId) {
      toast.error("Vendor account required for offers");
      return;
    }

    if (composeType === "offer" && expiryOption === "custom" && !customExpiryDate) {
      toast.error("Select a date");
      return;
    }

    setSubmitting(true);

    let imageUrl: string | null = null;
    if (composeType === "announcement" && imageFile) {
      imageUrl = await uploadFeedImage(imageFile);
      if (!imageUrl) {
        setSubmitting(false);
        return;
      }
    }

    const expiresAt =
      composeType === "offer"
        ? computeExpiresAt(expiryOption, customExpiryDate)
        : composeType === "announcement"
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : null;

    let lat: number | null = null;
    let lng: number | null = null;
    try {
      const pos = await getPosition();
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
    } catch {
      lat = null;
      lng = null;
    }

    const { error } = await supabase.from("feed_posts").insert({
      user_phone: phone,
      vendor_id: composeType === "offer" ? vendorId : null,
      type: composeType,
      content,
      expires_at: expiresAt,
      image_url: imageUrl,
      lat,
      lng,
    });

    setSubmitting(false);

    if (error) {
      console.error("submitPost", error);
      toast.error("Could not post");
      return;
    }

    closeCompose();
    await fetchPosts();
    toast.success("Posted!");
  };

  const onImagePick = (file: File | undefined) => {
    if (!file) return;
    setImageFile(file);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(URL.createObjectURL(file));
  };

  return (
    <AppShell>
      <header className="flex items-start justify-between gap-3 mb-6">
        <div>
          <p className="text-[10px] uppercase tracking-[0.35em] text-brand font-bold">
            LOCAL FEED
          </p>
          <p className="text-sm text-muted-foreground mt-1">📍 Near You</p>
        </div>
        <button
          type="button"
          onClick={openCompose}
          className="h-10 w-10 shrink-0 grid place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm active:scale-[0.98] transition-transform"
          aria-label="New post"
        >
          <Plus className="h-5 w-5" />
        </button>
      </header>

      <div className="flex overflow-x-auto gap-2 pb-2 no-scrollbar mb-4">
        <button
          type="button"
          onClick={() => setSelectedCategory(null)}
          className={cn(
            "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
            selectedCategory === null
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          All
        </button>
        {categories.map((c) => {
          const isSelected = selectedCategory === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedCategory(c.id)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                isSelected
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {c.emoji} {c.label}
            </button>
          );
        })}
      </div>

      {selectedCategory === null ? (
        loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : posts.length === 0 ? (
          <p className="text-center text-muted-foreground py-12 px-4">
            No posts near you yet. Be the first to post!
          </p>
        ) : (
          <ul className="flex flex-col gap-4 pb-4">
            {posts.map((post) => (
              <li key={post.id}>
                {post.type === "offer" && <OfferCard post={post} />}
                {post.type === "announcement" && (
                  <AnnouncementCard
                    post={post}
                    onFlag={() => void flagPost(post.id)}
                    flagging={flaggingId === post.id}
                  />
                )}
                {post.type === "recommendation" && (
                  <RecommendationCard
                    post={post}
                    expanded={expandedReplies.has(post.id)}
                    replies={replies[post.id] ?? []}
                    loadingReplies={loadingReplies.has(post.id)}
                    replyDraft={replyDrafts[post.id] ?? ""}
                    onReplyDraftChange={(v) =>
                      setReplyDrafts((prev) => ({ ...prev, [post.id]: v }))
                    }
                    onToggleReplies={() => void toggleReplies(post.id)}
                    onSendReply={() => void submitReply(post.id)}
                  />
                )}
              </li>
            ))}
          </ul>
        )
      ) : loadingVendors ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : categoryVendors.length === 0 ? (
        <p className="text-center text-muted-foreground py-12 px-4">
          No active vendors in this category right now
        </p>
      ) : (
        <div className="flex flex-col gap-4 pb-4">
          {categoryVendors.map((v) => (
            <article
              key={v.id}
              className="rounded-2xl border border-border bg-card p-4 shadow-sm flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <h3 className="font-display font-bold truncate">
                  {v.shop_name}
                </h3>
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                  <span aria-hidden>{selectedCategoryMeta?.emoji ?? "✨"}</span>
                  <span>Nearby</span>
                </p>
                {v.avg_rating && v.review_count ? (
                  <p className="text-xs text-muted-foreground mt-2">
                    ⭐ {v.avg_rating.toFixed(1)} ({v.review_count})
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-2">⭐ —</p>
                )}
              </div>

              <Button
                className="shrink-0"
                onClick={() =>
                  navigate(
                    `/radar?category=${encodeURIComponent(selectedCategory ?? "")}`,
                  )
                }
              >
                Connect
              </Button>
            </article>
          ))}
        </div>
      )}

      {showCompose && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label="Close"
            onClick={closeCompose}
          />
          <div className="relative z-10 mx-auto w-full max-w-md rounded-t-2xl border border-border bg-card p-5 pb-8 shadow-lg max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-semibold text-lg">New post</h2>
              <button
                type="button"
                onClick={closeCompose}
                className="h-9 w-9 grid place-items-center rounded-lg border border-border"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-wrap gap-2 mb-4">
              {hasVendorId && (
                <TypeChip
                  active={composeType === "offer"}
                  onClick={() => setComposeType("offer")}
                  label="Offer"
                  icon={Tag}
                />
              )}
              <TypeChip
                active={composeType === "announcement"}
                onClick={() => setComposeType("announcement")}
                label="Announcement"
                icon={Megaphone}
              />
              <TypeChip
                active={composeType === "recommendation"}
                onClick={() => setComposeType("recommendation")}
                label="Recommendation"
                icon={HelpCircle}
              />
            </div>

            <Textarea
              value={composeContent}
              onChange={(e) => setComposeContent(e.target.value.slice(0, MAX_CONTENT))}
              placeholder="What's happening nearby?"
              className="min-h-[100px] mb-1"
              maxLength={MAX_CONTENT}
            />
            <p className="text-[11px] text-muted-foreground text-right mb-4">
              {composeContent.length}/{MAX_CONTENT}
            </p>

            {composeType === "offer" && (
              <div className="mb-4">
                <label className="block text-xs font-semibold text-muted-foreground mb-2">
                  Offer valid until
                </label>
                <Select
                  value={expiryOption}
                  onValueChange={(v) => setExpiryOption(v as ExpiryOption)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select expiry" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="tomorrow">Tomorrow</SelectItem>
                    <SelectItem value="3days">3 days</SelectItem>
                    <SelectItem value="7days">7 days</SelectItem>
                    <SelectItem value="custom">Custom date</SelectItem>
                  </SelectContent>
                </Select>
                {expiryOption === "custom" && (
                  <input
                    type="date"
                    min={todayDateInputMin()}
                    value={customExpiryDate}
                    onChange={(e) => setCustomExpiryDate(e.target.value)}
                    className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                )}
              </div>
            )}

            {composeType === "announcement" && (
              <div className="mb-4">
                <label className="block text-xs font-semibold text-muted-foreground mb-2">
                  Photo (required)
                </label>
                <input
                  type="file"
                  accept="image/*"
                  className="text-sm w-full"
                  onChange={(e) => onImagePick(e.target.files?.[0])}
                />
                {imagePreview && (
                  <img
                    src={imagePreview}
                    alt=""
                    className="mt-3 w-full rounded-xl border border-border object-cover max-h-48"
                  />
                )}
              </div>
            )}

            <Button
              className="w-full"
              disabled={submitting}
              onClick={() => void submitPost()}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Posting…
                </>
              ) : (
                "Post"
              )}
            </Button>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function TypeChip({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold border transition-colors",
        active
          ? "bg-brand/15 border-brand text-brand"
          : "border-border text-muted-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function OfferCard({ post }: { post: FeedPost }) {
  const expiry = expiryBadgeLabel(post.expires_at);
  return (
    <article className="rounded-2xl border border-border bg-card p-4 border-l-4 border-l-brand shadow-sm">
      <div className="flex items-start gap-2 mb-2">
        <Tag className="h-4 w-4 text-brand shrink-0 mt-0.5" />
        <p className="font-semibold text-foreground">
          {post.vendors?.shop_name ?? "Local vendor"}
        </p>
      </div>
      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
        {post.content}
      </p>
      {expiry && (
        <span className="inline-block mt-3 text-[11px] font-medium rounded-full bg-brand/10 text-brand px-2.5 py-0.5">
          {expiry}
        </span>
      )}
    </article>
  );
}

function AnnouncementCard({
  post,
  onFlag,
  flagging,
}: {
  post: FeedPost;
  onFlag: () => void;
  flagging: boolean;
}) {
  return (
    <article className="rounded-2xl border border-border bg-card p-4 border-l-4 border-l-amber-500 shadow-sm relative">
      <div className="flex items-start gap-2 mb-2 pr-10">
        <Megaphone className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
        <p className="text-xs font-bold uppercase tracking-wide text-amber-700">
          Announcement
        </p>
      </div>
      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap mb-3">
        {post.content}
      </p>
      {post.image_url && (
        <img
          src={post.image_url}
          alt=""
          className="w-full rounded-xl border border-border object-cover max-h-56 mb-3"
        />
      )}
      <button
        type="button"
        onClick={onFlag}
        disabled={flagging}
        className="absolute bottom-3 right-3 h-8 w-8 grid place-items-center rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
        aria-label="Report post"
      >
        {flagging ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Flag className="h-4 w-4" />
        )}
      </button>
    </article>
  );
}

function RecommendationCard({
  post,
  expanded,
  replies,
  loadingReplies,
  replyDraft,
  onReplyDraftChange,
  onToggleReplies,
  onSendReply,
}: {
  post: FeedPost;
  expanded: boolean;
  replies: FeedReply[];
  loadingReplies: boolean;
  replyDraft: string;
  onReplyDraftChange: (v: string) => void;
  onToggleReplies: () => void;
  onSendReply: () => void;
}) {
  return (
    <article className="rounded-2xl border border-border bg-card p-4 border-l-4 border-l-blue-500 shadow-sm">
      <div className="flex items-start gap-2 mb-2">
        <HelpCircle className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
        <p className="text-xs font-bold uppercase tracking-wide text-blue-700">
          Looking for help
        </p>
      </div>
      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap mb-3">
        {post.content}
      </p>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onToggleReplies}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700"
        >
          <MessageCircle className="h-4 w-4" />
          Reply
        </button>
      </div>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-border space-y-3">
          {loadingReplies ? (
            <div className="flex justify-center py-2">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : replies.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center">No replies yet</p>
          ) : (
            <ul className="space-y-2">
              {replies.map((r) => (
                <li
                  key={r.id}
                  className="rounded-xl bg-muted/60 px-3 py-2 text-sm"
                >
                  <p className="text-[10px] text-muted-foreground font-medium mb-0.5">
                    {maskPhone(r.user_phone)}
                  </p>
                  <p className="text-foreground">{r.content}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={replyDraft}
              onChange={(e) => onReplyDraftChange(e.target.value)}
              placeholder="Write a reply…"
              className="flex-1 rounded-xl border border-input bg-background px-3 py-2 text-sm"
              maxLength={200}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSendReply();
                }
              }}
            />
            <Button size="sm" onClick={onSendReply}>
              Send
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
