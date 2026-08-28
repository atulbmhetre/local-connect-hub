import { getDeviceId } from "@/lib/deviceId";

export type ProactiveAliasTrigger = {
  vendorId: string;
  categoryId: string;
};

/** Fire-and-forget: propose search aliases from vendor profile; never blocks caller. */
export function triggerProactiveCategoryAliases(trigger: ProactiveAliasTrigger): void {
  const vendorId = trigger.vendorId?.trim();
  const categoryId = trigger.categoryId?.trim();
  if (!vendorId || !categoryId) return;

  void (async () => {
    try {
      const { supabase } = await import("@/lib/supabase");
      const { error } = await supabase.functions.invoke("suggest-category-aliases", {
        body: {
          vendor_id: vendorId,
          category_id: categoryId,
          device_id: getDeviceId(),
        },
      });
      if (error) console.warn("suggest-category-aliases", error.message);
    } catch (err) {
      console.warn("suggest-category-aliases failed", err);
    }
  })();
}

/** Trigger for each category id after multi-category registration / add-business. */
export function triggerProactiveCategoryAliasesForCategories(
  vendorId: string,
  categoryIds: string[],
): void {
  const seen = new Set<string>();
  for (const raw of categoryIds) {
    const id = raw?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    triggerProactiveCategoryAliases({ vendorId, categoryId: id });
  }
}
