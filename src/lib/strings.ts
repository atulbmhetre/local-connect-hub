export type { Language, StringBundle, StringKeys } from "./strings/types";
export { LANGUAGE_LABELS } from "./strings/types";
export {
  getCachedStringBundle,
  loadStringBundle,
  preloadStringBundle,
  setCachedStringBundle,
  t,
} from "./strings/bundles";
export { en } from "./strings/en";

import { en } from "./strings/en";
import { getCachedStringBundle } from "./strings/bundles";
import type { Language, StringBundle } from "./strings/types";

/** Sync access: `en` is always available; hi/mr require prior load via LanguageProvider. */
export const strings: Record<Language, StringBundle> = {
  get en() {
    return en;
  },
  get hi() {
    return getCachedStringBundle("hi");
  },
  get mr() {
    return getCachedStringBundle("mr");
  },
};
