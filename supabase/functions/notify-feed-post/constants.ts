/** Feed push titles by lang. Prefer DB notification_i18n when available. */
export const FEED_PUSH_TITLES = {
  en: {
    announcement: "📢 Announcement near you",
    recommendation: "💬 Recommendation near you",
    offer: "New offer nearby",
  },
  hi: {
    announcement: "📢 आपके पास घोषणा",
    recommendation: "💬 आपके पास सुझाव",
    offer: "पास में नया ऑफर",
  },
  mr: {
    announcement: "📢 तुमच्या जवळ घोषणा",
    recommendation: "💬 तुमच्या जवळ शिफारस",
    offer: "जवळ नवीन ऑफर",
  },
} as const;

export type FeedPushLang = keyof typeof FEED_PUSH_TITLES;
export type FeedPostKind = keyof typeof FEED_PUSH_TITLES.en;

export function feedPushTitle(postType: string, lang: string): string {
  const key: FeedPostKind =
    postType === "announcement"
      ? "announcement"
      : postType === "offer"
        ? "offer"
        : "recommendation";
  const normalized = (lang === "hi" || lang === "mr" ? lang : "en") as FeedPushLang;
  return FEED_PUSH_TITLES[normalized][key];
}
