import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { distanceKm, fetchActiveVendorCategoryLabels, isValidPhone, supabase } from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";
import { getDeviceId } from "@/lib/deviceId";
import { cn } from "@/lib/utils";
import { feedAuthorLabel } from "@/lib/khataDisplay";
import { uploadFeedImage } from "@/lib/imageUpload";
import { FeedImagePicker } from "@/components/settings/FeedImagePicker";
import { SettingsSectionLabel, SettingsCard } from "@/components/settings/SettingsSection";
import { NotificationBell } from "@/components/NotificationBell";
import { useLanguage } from "@/lib/language";
import { strings } from "@/lib/strings";
import { buildRecommendedVendorRadarUrl, resolveRecommendedVendorRadarLink } from "@/lib/feedVendorLink";
import { maskPhoneNumbers } from "@/lib/textUtils";
type FeedStrings = typeof strings.en;
const MAX_CONTENT = 200;
const FLAG_HIDE_THRESHOLD = 5;
const FEED_CACHE_KEY = "aaspaas:feed_cache";
const FEED_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const FEED_CACHE_MAX_POSTS = 20;
const GPS_TIMEOUT_MS = 10_000;
/** Default reach when post row has NULL/0 reach_radius_km (matches DB backfill). */
const DEFAULT_FEED_REACH_KM = 2;

type FeedCachePayload = {
  timestamp: number;
  posts: FeedPost[];
};

type GeoCoords = { lat: number; lng: number };

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
  reach_radius_km: number | null;
  flagged_count: number;
  is_hidden: boolean;
  created_at: string;
  recommended_vendor_id: string | null;
  recommended_vendor_name: string | null;
  recommended_vendor_phone: string | null;
  vendors: { shop_name: string; category: string | null } | null;
  recommended_vendor: { shop_name: string; service_mode: string | null } | null;
};

type FeedReply = {
  id: string;
  post_id: string;
  user_phone: string;
  content: string;
  created_at: string;
};

type VendorSearchHit = {
  id: string;
  shop_name: string;
};

type FeedCategory = {
  id: string;
  label: string;
  emoji: string;
};

const getPosition = () =>
  new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: GPS_TIMEOUT_MS,
      maximumAge: 60_000,
    }),
  );

async function getGeoCoords(): Promise<GeoCoords | null> {
  try {
    const pos = await getPosition();
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch {
    return null;
  }
}

function readFeedCache(): FeedPost[] | null {
  try {
    const raw = localStorage.getItem(FEED_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FeedCachePayload;
    if (!Array.isArray(parsed.posts) || typeof parsed.timestamp !== "number") return null;
    if (Date.now() - parsed.timestamp > FEED_CACHE_MAX_AGE_MS) return null;
    return parsed.posts;
  } catch {
    return null;
  }
}

function writeFeedCache(posts: FeedPost[]) {
  try {
    const payload: FeedCachePayload = {
      timestamp: Date.now(),
      posts: posts.slice(0, FEED_CACHE_MAX_POSTS),
    };
    localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota errors */
  }
}

async function resolveReaderCoords(): Promise<GeoCoords | null> {
  const gps = await getGeoCoords();
  if (gps) return gps;

  const phone = getUserPhone()?.trim();
  const deviceId = getDeviceId();
  if (!phone || !deviceId) return null;

  const { data, error } = await supabase.rpc("get_user_device", {
    p_user_phone: phone,
    p_device_id: deviceId,
  });
  if (error) {
    console.error("resolveReaderCoords/get_user_device", error);
    return null;
  }

  const row = data as { last_lat: number | null; last_lng: number | null } | null;
  if (row?.last_lat == null || row?.last_lng == null) return null;
  return { lat: row.last_lat, lng: row.last_lng };
}

function parseFeedPostsFromRpc(data: unknown): FeedPost[] {
  if (!Array.isArray(data)) return [];
  return data as FeedPost[];
}

function filterPostsByLocation(posts: FeedPost[], coords: GeoCoords): FeedPost[] {
  return posts.filter((post) => {
    if (post.lat == null || post.lng == null) return false;
    const reachKm = post.reach_radius_km && post.reach_radius_km > 0
      ? post.reach_radius_km
      : DEFAULT_FEED_REACH_KM;
    return distanceKm(coords, { lat: post.lat, lng: post.lng }) <= reachKm;
  });
}

function expiryBadgeLabel(
  expiresAt: string | null,
  s: {
    feed_expiresTonight: string;
    feed_expiresTomorrow: string;
    feed_expiresInDays: (days: number) => string;
  },
): string | null {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfExp = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate());
  const dayDiff = Math.round(
    (startOfExp.getTime() - startOfToday.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (dayDiff <= 0) return s.feed_expiresTonight;
  if (dayDiff === 1) return s.feed_expiresTomorrow;
  return s.feed_expiresInDays(dayDiff);
}

function feedPostedTimeLabel(
  createdAt: string,
  s: {
    feed_postedMinutesAgo: (minutes: number) => string;
    feed_postedHoursAgo: (hours: number) => string;
    feed_postedYesterday: string;
  },
): string {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return "";
  const diffMs = Math.max(0, Date.now() - t);
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) {
    return s.feed_postedMinutesAgo(Math.max(1, diffMin));
  }
  const diffHr = Math.floor(diffMs / 3_600_000);
  if (diffHr < 24) {
    return s.feed_postedHoursAgo(Math.max(1, diffHr));
  }
  const postDate = new Date(createdAt);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (postDate.toDateString() === yesterday.toDateString()) {
    return s.feed_postedYesterday;
  }
  return postDate.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

type LocationHighlightState = { highlightPostId?: string };

export default function LocalFeed() {
  const location = useLocation();
  const highlightPostId = (location.state as LocationHighlightState | null)?.highlightPostId;
  const { s } = useLanguage();
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [flashPostId, setFlashPostId] = useState<string | null>(null);
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
  const [flaggedByMe, setFlaggedByMe] = useState<Set<string>>(() => new Set());
  const [vendorSearchQuery, setVendorSearchQuery] = useState("");
  const [vendorSearchResults, setVendorSearchResults] = useState<VendorSearchHit[]>([]);
  const [vendorSearchLoading, setVendorSearchLoading] = useState(false);
  const [recommendedVendorId, setRecommendedVendorId] = useState<string | null>(null);
  const [recommendedVendorShopName, setRecommendedVendorShopName] = useState<string | null>(
    null,
  );
  const [showManualVendor, setShowManualVendor] = useState(false);
  const [recommendedVendorName, setRecommendedVendorName] = useState("");
  const [recommendedVendorPhone, setRecommendedVendorPhone] = useState("");

  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [vendor, setVendor] = useState<{
    phone: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null>(null);
  const viewerPhone = getUserPhone();

  useEffect(() => {
    const vendorId = localStorage.getItem("aaspaas:vendor_id");
    if (!vendorId?.trim()) return;
    void supabase
      .from("vendors")
      .select("phone, latitude, longitude")
      .eq("id", vendorId)
      .maybeSingle()
      .then(({ data }) => {
        setVendor(data ?? null);
      });
  }, []);

  useEffect(() => {
    if (!showCompose || composeType !== "recommendation") return;
    const q = vendorSearchQuery.trim();
    if (q.length < 2 || recommendedVendorId) {
      setVendorSearchResults([]);
      setVendorSearchLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setVendorSearchLoading(true);
      void supabase
        .from("vendors")
        .select("id, shop_name")
        .eq("is_active", true)
        .ilike("shop_name", `%${q}%`)
        .order("shop_name", { ascending: true })
        .limit(5)
        .then(({ data, error }) => {
          if (cancelled) return;
          setVendorSearchLoading(false);
          if (error) {
            console.error("vendorSearch", error);
            setVendorSearchResults([]);
            return;
          }
          setVendorSearchResults((data ?? []) as VendorSearchHit[]);
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [vendorSearchQuery, showCompose, composeType, recommendedVendorId]);

  const fetchPosts = useCallback(async () => {
    const cached = readFeedCache();
    const showingCached = cached != null;
    if (showingCached) {
      setPosts(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }

    try {
      const readerCoords = await resolveReaderCoords();
      if (!readerCoords) {
        if (!showingCached) {
          setPosts([]);
        }
        return;
      }

      const { data, error } = await supabase.rpc("get_local_feed_posts", {
        p_reader_lat: readerCoords.lat,
        p_reader_lng: readerCoords.lng,
        p_limit: 50,
      });

      if (error) {
        console.warn("get_local_feed_posts unavailable, using client filter", error);
        const { data: fallbackData, error: fallbackError } = await supabase
          .from("feed_posts")
          .select(
            "*, vendors!vendor_id(shop_name, category), recommended_vendor:vendors!recommended_vendor_id(shop_name, service_mode)",
          )
          .eq("is_hidden", false)
          .or("expires_at.is.null,expires_at.gt.now()")
          .or("starts_at.is.null,starts_at.lte.now()")
          .order("created_at", { ascending: false })
          .limit(50);
        if (fallbackError) throw fallbackError;
        const nextPosts = filterPostsByLocation((fallbackData ?? []) as FeedPost[], readerCoords);
        setPosts(nextPosts);
        writeFeedCache(nextPosts);
        return;
      }

      const nextPosts = parseFeedPostsFromRpc(data);
      setPosts(nextPosts);
      writeFeedCache(nextPosts);
    } catch (error) {
      console.error("fetchPosts", error);
      toast.error(s.feed_errLoad);
      if (!showingCached) {
        setPosts([]);
      }
    } finally {
      setLoading(false);
    }
  }, [s.feed_errLoad]);

  useEffect(() => {
    void fetchPosts();
  }, [fetchPosts]);

  useEffect(() => {
    if (!viewerPhone || posts.length === 0) {
      setFlaggedByMe(new Set());
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("feed_flags")
        .select("post_id")
        .eq("flagged_by_phone", viewerPhone)
        .in(
          "post_id",
          posts.map((p) => p.id),
        );
      if (cancelled) return;
      if (error) {
        console.error("loadUserFeedFlags", error);
        return;
      }
      setFlaggedByMe(new Set((data ?? []).map((row) => row.post_id)));
    })();
    return () => {
      cancelled = true;
    };
  }, [posts, viewerPhone]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const [catsRes, activeLabels] = await Promise.all([
        supabase.from("categories").select("id, label, emoji").eq("is_active", true).order("sort_order", { ascending: true }),
        fetchActiveVendorCategoryLabels(),
      ]);
      if (cancelled) return;
      if (catsRes.error) {
        console.error("fetch categories", catsRes.error);
        setCategories([]);
        return;
      }
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

  useEffect(() => {
    if (!highlightPostId || loading) return;
    const el = document.getElementById(`feed-post-${highlightPostId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashPostId(highlightPostId);
    const t = window.setTimeout(() => setFlashPostId(null), 2000);
    return () => window.clearTimeout(t);
  }, [highlightPostId, loading, posts.length]);

  const selectedCategoryMeta = selectedCategory
    ? categories.find((c) => c.id === selectedCategory) ?? null
    : null;

  const visiblePosts = useMemo(() => {
    if (!selectedCategoryMeta) return posts;
    const chipLabel = selectedCategoryMeta.label;
    return posts.filter((post) => {
      return offerMatchesCategory(post.vendors?.category, chipLabel);
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
      toast.error(s.feed_errLoadReplies);
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
      toast.error(s.feed_phoneRequired);
      return;
    }
    const content = (replyDrafts[postId] ?? "").trim();
    if (!content) return;

    const { error } = await supabase.rpc("submit_feed_reply", {
      p_post_id: postId,
      p_user_phone: phone,
      p_content: content,
    });

    if (error) {
      console.error("submitReply", error);
      toast.error(s.feed_errSendReply);
      return;
    }

    setReplyDrafts((prev) => ({ ...prev, [postId]: "" }));
    await loadReplies(postId);
  };

  const flagPost = async (postId: string) => {
    const phone = getUserPhone();
    if (!phone) {
      toast.error(s.feed_phoneRequired);
      return;
    }

    setFlaggingId(postId);
    const { error } = await supabase.rpc("increment_flag_count", {
      p_post_id: postId,
      p_user_phone: phone,
    });

    setFlaggingId(null);

    if (error) {
      console.error("flagPost", error);
      if (error.code === "23505") {
        setFlaggedByMe((prev) => new Set(prev).add(postId));
        toast.error(s.feed_alreadyFlagged);
        return;
      }
      toast.error(s.feed_errReportPost);
      return;
    }

    setFlaggedByMe((prev) => new Set(prev).add(postId));

    const post = posts.find((p) => p.id === postId);
    const newCount = (post?.flagged_count ?? 0) + 1;

    toast.success(s.feed_reportedSuccess);
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
    setVendorSearchQuery("");
    setVendorSearchResults([]);
    setVendorSearchLoading(false);
    setRecommendedVendorId(null);
    setRecommendedVendorShopName(null);
    setShowManualVendor(false);
    setRecommendedVendorName("");
    setRecommendedVendorPhone("");
  };

  const selectRecommendedVendor = (vendor: VendorSearchHit) => {
    setRecommendedVendorId(vendor.id);
    setRecommendedVendorShopName(vendor.shop_name);
    setVendorSearchQuery(vendor.shop_name);
    setVendorSearchResults([]);
    setShowManualVendor(false);
    setRecommendedVendorName("");
    setRecommendedVendorPhone("");
  };

  const clearRecommendedVendor = () => {
    setRecommendedVendorId(null);
    setRecommendedVendorShopName(null);
    setVendorSearchQuery("");
    setVendorSearchResults([]);
  };

  const toggleManualVendor = () => {
    setShowManualVendor((prev) => {
      const next = !prev;
      if (next) clearRecommendedVendor();
      return next;
    });
  };

  const openCompose = async () => {
    try {
      await getPosition();
    } catch {
      toast.error(s.feed_gps_required);
      return;
    }
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
      toast.error(s.feed_phoneRequired);
      return;
    }

    const content = composeContent.trim();
    if (!content) {
      toast.error(s.feed_errEmptyPost);
      return;
    }
    if (content.length > MAX_CONTENT) {
      toast.error(s.feed_errMaxChars(MAX_CONTENT));
      return;
    }

    if (composeType === "recommendation" && showManualVendor) {
      const manualName = recommendedVendorName.trim();
      const manualPhone = recommendedVendorPhone.trim();
      if (!manualName) {
        toast.error(s.feed_recommendVendor_name);
        return;
      }
      if (!isValidPhone(manualPhone)) {
        toast.error(s.vendor_phone_invalid);
        return;
      }
    }

    let lat: number | null = null;
    let lng: number | null = null;
    try {
      const pos = await getPosition();
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
    } catch {
      toast.error(s.feed_locationRequired);
      return;
    }

    setSubmitting(true);

    let imageUrl: string | null = null;
    if (composeType === "announcement" && imageFile) {
      try {
        imageUrl = await uploadFeedImage(imageFile, "announcements");
      } catch (err) {
        console.error("uploadFeedImage", err);
        toast.error(s.feed_errImageUpload);
        setSubmitting(false);
        return;
      }
    }

    const expiresAt =
      composeType === "announcement" || composeType === "recommendation"
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        : null;

    const recommendationFields =
      composeType === "recommendation"
        ? recommendedVendorId
          ? {
              recommended_vendor_id: recommendedVendorId,
              recommended_vendor_name: null,
              recommended_vendor_phone: null,
            }
          : showManualVendor
            ? {
                recommended_vendor_id: null,
                recommended_vendor_name: recommendedVendorName.trim(),
                recommended_vendor_phone: recommendedVendorPhone.trim(),
              }
            : {
                recommended_vendor_id: null,
                recommended_vendor_name: null,
                recommended_vendor_phone: null,
              }
        : {};

    const { error } = await supabase.rpc("submit_customer_feed_post", {
      p_user_phone: phone,
      p_type: composeType,
      p_content: content,
      p_expires_at: expiresAt,
      p_image_url: imageUrl,
      p_lat: lat,
      p_lng: lng,
      p_recommended_vendor_id: recommendationFields.recommended_vendor_id ?? null,
      p_recommended_vendor_name: recommendationFields.recommended_vendor_name ?? null,
      p_recommended_vendor_phone: recommendationFields.recommended_vendor_phone ?? null,
    });

    setSubmitting(false);

    if (error) {
      console.error("submitPost", error);
      toast.error(s.feed_errPost);
      return;
    }

    closeCompose();
    await fetchPosts();
    toast.success(s.feed_postedSuccess);
  };

  const onImagePick = (file: File | undefined) => {
    if (!file) return;
    setImageFile(file);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(URL.createObjectURL(file));
  };

  return (
    <AppShell>
      <div className="space-y-3 pb-24" data-testid="feed-screen">
      <header className="flex items-start justify-between gap-3 px-4 pt-2">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{s.nav_feed}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{s.feed_nearYou}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <NotificationBell />
          <button
            type="button"
            data-testid="feed-post-btn"
            onClick={openCompose}
            className="h-12 w-12 shrink-0 grid place-items-center rounded-full bg-brand text-page-bg shadow-lg active:scale-[0.98] transition-transform"
            aria-label={s.feed_newPostAria}
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
              {s.feed_categoryFilterHint(selectedCategoryMeta.label)}
            </p>
          )}
        </div>
      )}

      {loading ? (
        <ul className="flex flex-col gap-3 pb-4 px-4" aria-busy="true" aria-label={s.feed_loadingAria}>
          {Array.from({ length: 4 }, (_, i) => (
            <FeedPostSkeleton key={i} />
          ))}
        </ul>
      ) : visiblePosts.length === 0 ? (
        <p className="text-center text-muted-foreground py-12 px-4">
          {s.feed_empty}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground text-center py-2 px-4">
            {s.feed_auto_remove_note}
          </p>
          <ul className="flex flex-col gap-3 pb-4">
          {visiblePosts.map((post) => (
            <li
              key={post.id}
              id={`feed-post-${post.id}`}
              className={cn(
                "rounded-2xl transition-shadow",
                flashPostId === post.id && "ring-2 ring-brand shadow-md",
              )}
            >
              {post.type === "offer" && (
                <OfferCard post={post} viewerPhone={viewerPhone} s={s} />
              )}
              {post.type === "announcement" && (
                <AnnouncementCard
                  post={post}
                  viewerPhone={viewerPhone}
                  s={s}
                  onFlag={() => void flagPost(post.id)}
                  flagging={flaggingId === post.id}
                  reported={flaggedByMe.has(post.id)}
                />
              )}
              {post.type === "recommendation" && (
                <RecommendationCard
                  post={post}
                  viewerPhone={viewerPhone}
                  s={s}
                  expanded={expandedReplies.has(post.id)}
                  replies={replies[post.id] ?? []}
                  loadingReplies={loadingReplies.has(post.id)}
                  replyDraft={replyDrafts[post.id] ?? ""}
                  onReplyDraftChange={(v) =>
                    setReplyDrafts((prev) => ({ ...prev, [post.id]: v }))
                  }
                  onToggleReplies={() => void toggleReplies(post.id)}
                  onSendReply={() => void submitReply(post.id)}
                  onFlag={() => void flagPost(post.id)}
                  flagging={flaggingId === post.id}
                  reported={flaggedByMe.has(post.id)}
                />
              )}
            </li>
          ))}
        </ul>
        </>
      )}

      {showCompose && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label={s.feed_closeAria}
            onClick={closeCompose}
          />
          <div className="relative z-10 mx-auto w-full max-w-md rounded-t-2xl border border-border bg-card p-5 pb-8 shadow-lg max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-semibold text-lg">{s.feed_composeTitle}</h2>
              <button
                type="button"
                onClick={closeCompose}
                className="h-9 w-9 grid place-items-center rounded-lg border border-border"
                aria-label={s.feed_closeAria}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <SettingsSectionLabel>{s.feed_postTypeLabel}</SettingsSectionLabel>
            <div className="flex flex-wrap gap-2 mb-4 px-4">
              <TypeChip
                active={composeType === "announcement"}
                onClick={() => setComposeType("announcement")}
                label={s.feed_typeAnnouncement}
                icon={Megaphone}
              />
              <TypeChip
                active={composeType === "recommendation"}
                onClick={() => setComposeType("recommendation")}
                label={s.feed_typeRecommendation}
                icon={HelpCircle}
              />
            </div>

            <SettingsCard className="mx-4">
              <Textarea
                value={composeContent}
                onChange={(e) => setComposeContent(e.target.value.slice(0, MAX_CONTENT))}
                placeholder={
                  composeType === "announcement"
                    ? s.feed_composePlaceholderAnnouncement
                    : s.feed_composePlaceholderRecommendation
                }
                className="min-h-[100px] mb-1 border-0 bg-transparent focus-visible:ring-0"
                maxLength={MAX_CONTENT}
              />
            </SettingsCard>
            <p className="text-[11px] text-muted-foreground text-right mb-4">
              {composeContent.length}/{MAX_CONTENT}
            </p>

            {composeType === "recommendation" && (
              <div className="mb-4 px-4 space-y-3">
                <SettingsSectionLabel>{s.feed_recommendVendor_label}</SettingsSectionLabel>

                {!showManualVendor && (
                  <div className="space-y-2">
                    <Input
                      value={vendorSearchQuery}
                      onChange={(e) => {
                        const value = e.target.value;
                        setVendorSearchQuery(value);
                        if (recommendedVendorId) {
                          setRecommendedVendorId(null);
                          setRecommendedVendorShopName(null);
                        }
                      }}
                      placeholder={s.feed_recommendVendor_search}
                      className="rounded-xl"
                      disabled={!!recommendedVendorId}
                    />
                    {recommendedVendorId && recommendedVendorShopName && (
                      <div className="flex items-center justify-between gap-2 rounded-xl border border-brand/30 bg-brand/10 px-3 py-2">
                        <span className="text-sm font-medium text-foreground truncate">
                          {recommendedVendorShopName}
                        </span>
                        <button
                          type="button"
                          onClick={clearRecommendedVendor}
                          className="shrink-0 text-xs font-semibold text-muted-foreground hover:text-foreground"
                          aria-label={s.feed_closeAria}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                    {vendorSearchLoading && (
                      <div className="flex justify-center py-1">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    )}
                    {!recommendedVendorId && vendorSearchResults.length > 0 && (
                      <ul className="rounded-xl border border-surface-border overflow-hidden">
                        {vendorSearchResults.map((vendor) => (
                          <li key={vendor.id}>
                            <button
                              type="button"
                              onClick={() => selectRecommendedVendor(vendor)}
                              className="w-full text-left px-3 py-2.5 text-sm hover:bg-muted/60 border-b border-surface-border last:border-b-0"
                            >
                              {vendor.shop_name}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={toggleManualVendor}
                  className={cn(
                    "w-full rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors",
                    showManualVendor
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-surface-border text-muted-foreground",
                  )}
                >
                  {s.feed_recommendVendor_notOnApp}
                </button>

                {showManualVendor && (
                  <div className="space-y-2">
                    <Input
                      value={recommendedVendorName}
                      onChange={(e) => setRecommendedVendorName(e.target.value)}
                      placeholder={s.feed_recommendVendor_name}
                      className="rounded-xl"
                    />
                    <Input
                      value={recommendedVendorPhone}
                      onChange={(e) =>
                        setRecommendedVendorPhone(e.target.value.replace(/\D/g, "").slice(0, 10))
                      }
                      placeholder={s.feed_recommendVendor_phone}
                      className="rounded-xl"
                      inputMode="numeric"
                    />
                  </div>
                )}
              </div>
            )}

            {composeType === "announcement" && (
              <div className="mb-4">
                <FeedImagePicker
                  label={s.feed_noImageHint}
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
                  {s.feed_posting}
                </>
              ) : (
                s.feed_postButton
              )}
            </Button>
          </div>
        </div>
      )}
      </div>
    </AppShell>
  );
}

function FeedPostSkeleton() {
  return (
    <li className="rounded-2xl border border-surface-border bg-surface p-4 animate-pulse space-y-3">
      <div className="h-3 w-24 rounded-md bg-muted" />
      <div className="space-y-2">
        <div className="h-3 w-full rounded-md bg-muted" />
        <div className="h-3 w-5/6 rounded-md bg-muted" />
      </div>
      <div className="h-2.5 w-16 rounded-md bg-muted" />
    </li>
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
  s,
}: {
  post: FeedPost;
  viewerPhone: string | null;
  s: FeedStrings;
}) {
  const expiry = expiryBadgeLabel(post.expires_at, s);
  const postedAt = feedPostedTimeLabel(post.created_at, s);
  return (
    <article
      data-testid="feed-post-card"
      className="mx-4 mb-3 rounded-2xl border border-surface-border bg-surface p-4"
    >
      <span className="inline-block text-xs font-semibold rounded-full bg-amber-500/20 text-amber-400 px-2 py-0.5 mb-2">
        {s.feed_typeOffer}
      </span>
      <p className="text-[10px] text-muted-foreground font-medium mb-2">
        {postedAt}
        {postedAt ? " · " : ""}
        {feedAuthorLabel(post.user_phone, viewerPhone)}
      </p>
      <div className="flex items-start gap-2 mb-2">
        <Tag className="h-4 w-4 text-brand shrink-0 mt-0.5" />
        <p className="font-semibold text-foreground">
          {post.vendors?.shop_name ?? s.feed_localVendor}
        </p>
      </div>
      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap mb-3">
        {maskPhoneNumbers(post.content)}
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

function FeedFlagButton({
  reported,
  flagging,
  onFlag,
  s,
}: {
  reported: boolean;
  flagging: boolean;
  onFlag: () => void;
  s: FeedStrings;
}) {
  return (
    <button
      type="button"
      data-testid="feed-flag-btn"
      data-reported={reported ? "true" : "false"}
      onClick={onFlag}
      disabled={flagging || reported}
      className={cn(
        "absolute bottom-3 right-3 h-8 w-8 grid place-items-center rounded-lg transition-colors",
        reported
          ? "text-destructive bg-destructive/10 cursor-default"
          : "text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50",
      )}
      aria-label={reported ? s.feed_reportedPostAria : s.feed_reportPostAria}
      aria-pressed={reported}
    >
      {flagging ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Flag className={cn("h-4 w-4", reported && "fill-current")} />
      )}
    </button>
  );
}

function AnnouncementCard({
  post,
  viewerPhone,
  s,
  onFlag,
  flagging,
  reported,
}: {
  post: FeedPost;
  viewerPhone: string | null;
  s: FeedStrings;
  onFlag: () => void;
  flagging: boolean;
  reported: boolean;
}) {
  const expiry = expiryBadgeLabel(post.expires_at, s);
  const postedAt = feedPostedTimeLabel(post.created_at, s);
  return (
    <article
      data-testid="feed-post-card"
      className="mx-4 mb-3 rounded-2xl border border-surface-border bg-surface p-4 relative"
    >
      <span className="inline-block text-xs font-semibold rounded-full bg-blue-500/20 text-blue-400 px-2 py-0.5 mb-2">
        {s.feed_typeAnnouncement}
      </span>
      <p className="text-[10px] text-muted-foreground font-medium mb-2">
        {postedAt}
        {postedAt ? " · " : ""}
        {feedAuthorLabel(post.user_phone, viewerPhone)}
      </p>
      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap mb-3">
        {maskPhoneNumbers(post.content)}
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
      <FeedFlagButton reported={reported} flagging={flagging} onFlag={onFlag} s={s} />
    </article>
  );
}

function RecommendationCard({
  post,
  viewerPhone,
  s,
  expanded,
  replies,
  loadingReplies,
  replyDraft,
  onReplyDraftChange,
  onToggleReplies,
  onSendReply,
  onFlag,
  flagging,
  reported,
}: {
  post: FeedPost;
  viewerPhone: string | null;
  s: FeedStrings;
  expanded: boolean;
  replies: FeedReply[];
  loadingReplies: boolean;
  replyDraft: string;
  onReplyDraftChange: (v: string) => void;
  onToggleReplies: () => void;
  onSendReply: () => void;
  onFlag: () => void;
  flagging: boolean;
  reported: boolean;
}) {
  const navigate = useNavigate();
  const [linkingVendor, setLinkingVendor] = useState(false);
  const postedAt = feedPostedTimeLabel(post.created_at, s);
  const linkedShopName = post.recommended_vendor?.shop_name ?? null;

  const handleRecommendedVendorTap = async () => {
    const vendorId = post.recommended_vendor_id;
    if (!vendorId || linkingVendor) return;
    setLinkingVendor(true);
    try {
      const result = await resolveRecommendedVendorRadarLink(
        vendorId,
        post.recommended_vendor?.service_mode,
      );
      if (!result.ok) {
        if (result.offline) {
          toast.error(s.radar_vendorWentOffline);
        } else {
          navigate("/radar", { state: { highlightVendorId: vendorId } });
        }
        return;
      }
      const mode = post.recommended_vendor?.service_mode ?? "help";
      navigate(buildRecommendedVendorRadarUrl(result.categoryLabel, mode), {
        state: { highlightVendorId: vendorId },
      });
    } finally {
      setLinkingVendor(false);
    }
  };

  return (
    <article
      data-testid="feed-post-card"
      className="mx-4 mb-3 rounded-2xl border border-surface-border bg-surface p-4 relative"
    >
      <span className="inline-block text-xs font-semibold rounded-full bg-purple-500/20 text-purple-400 px-2 py-0.5 mb-2">
        {s.feed_typeRecommendation}
      </span>
      <p className="text-[10px] text-muted-foreground font-medium mb-2">
        {postedAt}
        {postedAt ? " · " : ""}
        {feedAuthorLabel(post.user_phone, viewerPhone)}
      </p>
      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap mb-3">
        {maskPhoneNumbers(post.content)}
      </p>
      {post.recommended_vendor_id && linkedShopName && (
        <button
          type="button"
          onClick={() => void handleRecommendedVendorTap()}
          disabled={linkingVendor}
          className="inline-flex items-center gap-1.5 mb-3 rounded-full border border-brand/30 bg-brand/10 px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand/15 disabled:opacity-60"
        >
          <Tag className="h-3.5 w-3.5" />
          {linkedShopName}
        </button>
      )}
      {!post.recommended_vendor_id && post.recommended_vendor_name && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="text-sm font-medium text-foreground">
            {post.recommended_vendor_name}
          </span>
          <span className="inline-block text-[10px] font-semibold rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
            {s.feed_notOnAaspaas}
          </span>
        </div>
      )}
      <div className="flex justify-end pr-10">
        <button
          type="button"
          onClick={onToggleReplies}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700"
        >
          <MessageCircle className="h-4 w-4" />
          {s.feed_reply}
        </button>
      </div>
      <FeedFlagButton reported={reported} flagging={flagging} onFlag={onFlag} s={s} />

      {expanded && (
        <div className="mt-4 ml-4 border-l-2 border-surface-border pl-3 space-y-3">
          {loadingReplies ? (
            <div className="flex justify-center py-2">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : replies.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center">{s.feed_noRepliesYet}</p>
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
                  <p className="text-foreground">{maskPhoneNumbers(r.content)}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={replyDraft}
              onChange={(e) => onReplyDraftChange(e.target.value)}
              placeholder={s.feed_replyPlaceholder}
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
              {s.feed_sendReply}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
