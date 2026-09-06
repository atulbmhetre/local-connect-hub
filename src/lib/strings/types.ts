import type { en } from "./en";

export type Language = "en" | "hi" | "mr";

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  hi: "हिंदी",
  mr: "मराठी",
};

export type StringKeys = keyof typeof en;

type StringBundleValue<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => R
  : string;

/** Shape of a locale bundle: same keys as `en`, localized string/function values. */
export type StringBundle = {
  readonly [K in StringKeys]: StringBundleValue<(typeof en)[K]>;
};
