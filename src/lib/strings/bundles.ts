import { en } from "./en";
import type { Language, StringBundle, StringKeys } from "./types";

const bundleCache: Partial<Record<Language, StringBundle>> = {
  en,
};

export function getCachedStringBundle(lang: Language): StringBundle {
  return bundleCache[lang] ?? en;
}

export function setCachedStringBundle(lang: Language, bundle: StringBundle): void {
  bundleCache[lang] = bundle;
}

export async function loadStringBundle(lang: Language): Promise<StringBundle> {
  const cached = bundleCache[lang];
  if (cached) return cached;

  if (lang === "en") {
    bundleCache.en = en;
    return en;
  }
  if (lang === "hi") {
    const { hi } = await import("./hi");
    bundleCache.hi = hi;
    return hi;
  }
  const { mr } = await import("./mr");
  bundleCache.mr = mr;
  return mr;
}

/** Preload a locale (e.g. before language switch UI). */
export async function preloadStringBundle(lang: Language): Promise<StringBundle> {
  return loadStringBundle(lang);
}

/** Localized string for a given user language (string keys only). Uses cached bundles. */
export function t(lang: Language, key: StringKeys): string {
  const value = getCachedStringBundle(lang)[key];
  return typeof value === "string" ? value : (en[key] as string);
}
