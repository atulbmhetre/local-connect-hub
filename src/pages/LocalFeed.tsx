import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
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
import { supabase } from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";
import { cn } from "@/lib/utils";
import { feedAuthorLabel } from "@/lib/khataDisplay";
import { uploadFeedImage } from "@/lib/imageUpload";
import { FeedImagePicker } from "@/components/settings/FeedImagePicker";
import { SettingsSectionLabel, SettingsCard } from "@/components/settings/SettingsSection";
import { NotificationBell } from "@/components/NotificationBell";
const MAX_CONTENT = 200;
const FLAG_HIDE_THRESHOLD = 5;

const CATEGORY_ALIASES: Record<string, string> = {
  "Grocery Store": "Kirana Store",
  "Kirana Store": "Grocery Store",
};

function categoryHasActiveVendor(label: string, activeLabels: Set<string>): boolean {
  if (activeLabels.has(label)) return true;
  const alias = CATEGORY_ALIASES[label];
  return alias != null && activeLabels.has(alias);
}

function offerMatchesCategory(vendorCategory: string | null | undefined, chipLabel: string): boolean {
  if (!vendorCategory) return false;
  if (vendorCategory === chipLabel) return true;
  const alias = CATEGORY_ALIASES[chipLabel];
  return alias != null && vendorCategory === alias;
}

type PostType = "announcement" | "recommendation";

type FeedPost = {
  id: string;
  user_phone: string;
  vendor_id: string | null;
  type: PostType | "offer";
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

type FeedCategory = {
  id: string;
  label: string;
  emoji: string;
};

const getPosition = () =>
  new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 }),
  );

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
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCompose, setShowCompose] = useState(false);
  const [composeType, setComposeType] = useState<PostType>("announcement");
  const [composeContent, setComposeContent] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [replies, setReplies] = useState<Record<string, FeedReply[]>>({});
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set());
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [loadingReplies, setLoadingReplies] = useState<Set<string>>(new Set());
  const [flaggingId, setFlaggingId] = useState<string | null>(null);

  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [vendor, setVendor] = useState<{ phone: string | null } | null>(null);
  const viewerPhone = getUserPhone();

  useEffect(() => {
    const vendorId = localStorage.getItem("aaspaas:vendor_id");
    if (!vendorId?.trim()) return;
    void supabase
      .from("vendors")
      .select("phone")
      .eq("id", vendorId)
      .maybeSingle()
      .then(({ data }) => {
        setVendor(data ?? null);
      });
  }, []);

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

    let query = supabase
      .from("feed_posts")
      .select("*, vendors(shop_name, category)")
      .eq("is_hidden", false)
      .or("expires_at.is.null,expires_at.gt.now()")
      .or("starts_at.is.null,starts_at.lte.now()")
      .order("created_at", { ascending: false })
      .limit(50);

    if (userLat != null && userLng != null) {
      query = query
        .gte("lat", userLat - 0.45)
        .lte("lat", userLat + 0.45)
        .gte("lng", userLng - 0.45)
        .lte("lng", userLng + 0.45);
    }

    const { data, error } = await query;

    if (error) {
      console.error("fetchPosts", error);
      toast.error("Could not load feed");
      setPosts([]);
    } else {
      setPosts((data ?? []) as FeedPost[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchPosts();
  }, [fetchPosts]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const [catsRes, vendorsRes] = await Promise.all([
        supabase.from("categories").select("id, label, emoji").order("sort_order", { ascending: true }),
        supabase.from("vendors").select("category").eq("is_active", true),
      ]);
      if (cancelled) return;
      if (catsRes.error) {
        console.error("fetch categories", catsRes.error);
        setCategories([]);
        return;
      }
      const activeLabels = new Set(
        (vendorsRes.data ?? [])
          .map((v) => v.category)
          .filter((c): c is string => typeof c === "string" && c.length > 0),
      );
      const filtered = ((catsRes.data ?? []) as FeedCategory[]).filter((c) =>
        categoryHasActiveVendor(c.label, activeLabels),
      );
      setCategories(filtered);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedCategory != null && !categories.some((c) => c.id === selectedCategory)) {
      setSelectedCategory(null);
    }
  }, [categories, selectedCategory]);

  const selectedCategoryMeta = selectedCategory
    ? categories.find((c) => c.id === selectedCategory) ?? null
    : null;

  const visiblePosts = useMemo(() => {
    if (!selectedCategoryMeta) return posts;
    const chipLabel = selectedCategoryMeta.label;
    return posts.filter((post) => {
      if (post.type === "announcement" || post.type === "recommendation") return true;
      if (post.type === "offer") {
        return offerMatchesCategory(post.vendors?.category, chipLabel);
      }
      return true;
    });
  }, [posts, selectedCategoryMeta]);

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
    setImageFile(null);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(null);
    setComposeType("announcement");
  };

  const openCompose = () => {
    resetCompose();
    setShowCompose(true);
  };

  const closeCompose = () => {
    setShowCompose(false);
    resetCompose();
  };

  const submitPost = async () => {
    const phone = getUserPhone() || vendor?.phone || null;
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

    setSubmitting(true);

    let imageUrl: string | null = null;
    if (composeType === "announcement" && imageFile) {
      try {
        imageUrl = await uploadFeedImage(imageFile, "announcements");
      } catch (err) {
        console.error("uploadFeedImage", err);
        toast.error("Image upload failed");
        setSubmitting(false);
        return;
      }
    }

    const expiresAt =
      composeType === "announcement"
        ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
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

    const { data: newPost, error } = await supabase
      .from("feed_posts")
      .insert({
        user_phone: phone,
        vendor_id: null,
        type: composeType,
        content,
        expires_at: expiresAt,
        image_url: imageUrl,
        lat,
        lng,
      })
      .select("id")
      .single();

    setSubmitting(false);

    if (error) {
      console.error("submitPost", error);
      toast.error("Could not post");
      return;
    }

    if (lat != null && lng != null) {
      const authorPhone = getUserPhone();
      if (authorPhone && newPost?.id) {
        const notifyTitle =
          composeType === "announcement"
            ? "📢 Announcement near you"
            : "💬 Recommendation near you";
        void supabase.functions
          .invoke("notify-feed-post", {
            body: {
              post_id: newPost.id,
              post_type: composeType,
              title: notifyTitle,
              body: content.substring(0, 100),
              lat,
              lng,
              author_phone: authorPhone,
            },
          })
          .catch(() => {});
      }
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
      <div className="space-y-3 pb-24">
      <header className="flex items-start justify-between gap-3 px-4 pt-2">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Local Feed</h1>
          <p className="text-xs text-muted-foreground mt-0.5">📍 Near You</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <NotificationBell />
          <button
            type="button"
            onClick={openCompose}
            className="h-12 w-12 shrink-0 grid place-items-center rounded-full bg-brand text-page-bg shadow-lg active:scale-[0.98] transition-transform"
            aria-label="New post"
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>
      </header>

      {categories.length > 0 && (
        <div className="px-4 space-y-2">
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {categories.map((c) => {
              const isSelected = selectedCategory === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCategory(isSelected ? null : c.id)}
                  className={cn(
                    "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold border transition-colors",
                    isSelected
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-surface-border text-muted-foreground bg-muted",
                  )}
                >
                  {c.emoji} {c.label}
                </button>
              );
            })}
          </div>
          {selectedCategoryMeta && (
            <p className="text-xs text-muted-foreground">
              Showing {selectedCategoryMeta.label} offers · All announcements & recommendations
            </p>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : visiblePosts.length === 0 ? (
        <p className="text-center text-muted-foreground py-12 px-4">
          No posts near you yet. Be the first to post!
        </p>
      ) : (
        <ul className="flex flex-col gap-3 pb-4">
          {visiblePosts.map((post) => (
            <li key={post.id}>
              {post.type === "offer" && (
                <OfferCard post={post} viewerPhone={viewerPhone} />
              )}
              {post.type === "announcement" && (
                <AnnouncementCard
                  post={post}
                  viewerPhone={viewerPhone}
                  onFlag={() => void flagPost(post.id)}
                  flagging={flaggingId === post.id}
                />
              )}
              {post.type === "recommendation" && (
                <RecommendationCard
                  post={post}
                  viewerPhone={viewerPhone}
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

            <SettingsSectionLabel>Post type</SettingsSectionLabel>
            <div className="flex flex-wrap gap-2 mb-4 px-4">
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

            <SettingsCard className="mx-4">
              <Textarea
                value={composeContent}
                onChange={(e) => setComposeContent(e.target.value.slice(0, MAX_CONTENT))}
                placeholder={
                  composeType === "announcement"
                    ? "Share something with your neighbourhood..."
                    : composeType === "recommendation"
                      ? "What are you recommending? e.g. 'Great chai at Sharma Tea Stall'"
                      : "What's happening nearby?"
                }
                className="min-h-[100px] mb-1 border-0 bg-transparent focus-visible:ring-0"
                maxLength={MAX_CONTENT}
              />
            </SettingsCard>
            <p className="text-[11px] text-muted-foreground text-right mb-4">
              {composeContent.length}/{MAX_CONTENT}
            </p>

            {composeType === "announcement" && (
              <div className="mb-4">
                <FeedImagePicker
                  label="Photo (required)"
                  previewUrl={imagePreview}
                  onPick={(file) => onImagePick(file)}
                />
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
      </div>
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
          ? "bg-brand text-white border-brand"
          : "border-surface-border text-muted-foreground bg-surface",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function OfferCard({
  post,
  viewerPhone,
}: {
  post: FeedPost;
  viewerPhone: string | null;
}) {
  const expiry = expiryBadgeLabel(post.expires_at);
  return (
    <article className="mx-4 mb-3 rounded-2xl border border-surface-border bg-surface p-4">
      <span className="inline-block text-xs font-semibold rounded-full bg-amber-500/20 text-amber-400 px-2 py-0.5 mb-2">
        Offer
      </span>
      <p className="text-[10px] text-muted-foreground font-medium mb-2">
        {feedAuthorLabel(post.user_phone, viewerPhone)}
      </p>
      <div className="flex items-start gap-2 mb-2">
        <Tag className="h-4 w-4 text-brand shrink-0 mt-0.5" />
        <p className="font-semibold text-foreground">
          {post.vendors?.shop_name ?? "Local vendor"}
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
  viewerPhone,
  onFlag,
  flagging,
}: {
  post: FeedPost;
  viewerPhone: string | null;
  onFlag: () => void;
  flagging: boolean;
}) {
  return (
    <article className="mx-4 mb-3 rounded-2xl border border-surface-border bg-surface p-4 relative">
      <span className="inline-block text-xs font-semibold rounded-full bg-blue-500/20 text-blue-400 px-2 py-0.5 mb-2">
        Announcement
      </span>
      <p className="text-[10px] text-muted-foreground font-medium mb-2">
        {feedAuthorLabel(post.user_phone, viewerPhone)}
      </p>
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
  viewerPhone,
  expanded,
  replies,
  loadingReplies,
  replyDraft,
  onReplyDraftChange,
  onToggleReplies,
  onSendReply,
}: {
  post: FeedPost;
  viewerPhone: string | null;
  expanded: boolean;
  replies: FeedReply[];
  loadingReplies: boolean;
  replyDraft: string;
  onReplyDraftChange: (v: string) => void;
  onToggleReplies: () => void;
  onSendReply: () => void;
}) {
  return (
    <article className="mx-4 mb-3 rounded-2xl border border-surface-border bg-surface p-4">
      <span className="inline-block text-xs font-semibold rounded-full bg-purple-500/20 text-purple-400 px-2 py-0.5 mb-2">
        Recommendation
      </span>
      <p className="text-[10px] text-muted-foreground font-medium mb-2">
        {feedAuthorLabel(post.user_phone, viewerPhone)}
      </p>
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
        <div className="mt-4 ml-4 border-l-2 border-surface-border pl-3 space-y-3">
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
                    {feedAuthorLabel(r.user_phone, viewerPhone)}
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
