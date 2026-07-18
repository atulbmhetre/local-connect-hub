# Manual verification scripts

Operator-run diagnostics against a live environment. These are **not** part of
the automated Playwright or Vitest suite — run them explicitly when you need a
hands-on discoverability check.

| Script | Env | Purpose |
|--------|-----|---------|
| `verify-atul-dual-mode-radar.mjs` | TEST (`.env.test`) | Seed a throwaway dual-mode vendor (Cook/Help + Dairy/Delivery), confirm anon Radar Help/Delivery/Appointment membership, then clean up. |
| `probe-prod-per-category-state.mjs` | PROD (`.env.test.prod`) | Read-only: does `get_radar_category_mode_matches` / `vendor_category_modes` exist, and does any real vendor already have differing per-category modes? |
| `verify-prod-atul-dual-mode.mjs` | PROD (`.env.test.prod`) | Same dual-mode Radar check as the TEST verifier, on production. Seeds a throwaway vendor only if no existing candidate qualifies; always cleans up. |

Usage (from repo root):

```bash
node scripts/manual/verify-atul-dual-mode-radar.mjs
node scripts/manual/probe-prod-per-category-state.mjs
node scripts/manual/verify-prod-atul-dual-mode.mjs
```
