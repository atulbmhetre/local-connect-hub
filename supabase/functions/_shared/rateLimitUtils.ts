export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return "unknown";
  const first = xff.split(",")[0]?.trim();
  return first || "unknown";
}
