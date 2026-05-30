const CATEGORY_MODE_MAP: Record<string, "help" | "delivery" | "appointment"> = {
  Beautician: "appointment",
  Tailor: "appointment",
  Gym: "appointment",
  Yoga: "appointment",
  Tutor: "appointment",
  "Grocery Store": "delivery",
  "Kirana Store": "delivery",
  Pharmacy: "delivery",
  Bakery: "delivery",
  Dairy: "delivery",
  Plumber: "help",
  Electrician: "help",
  Carpenter: "help",
  Mechanic: "help",
};

export function suggestServiceMode(
  category: string,
): "help" | "delivery" | "appointment" | null {
  return CATEGORY_MODE_MAP[category] ?? null;
}
