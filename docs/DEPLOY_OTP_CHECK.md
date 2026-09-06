# Production OTP flag — single control point

**To change whether OTP is on, change it in Vercel’s dashboard only — everything else follows automatically.**

`npm run build:prod` uses Production `VITE_OTP_ENABLED` from Vercel only, and **refuses** to build unless the effective production env targets PROD Supabase and `VITE_ENVIRONMENT=production`:

- **On Vercel cloud builds:** the dashboard Production env is already injected (`VERCEL=1`).
- **On local/APK prod builds:** the script fetches OTP from the Vercel API (credentials in gitignored `.env.vercel.local`) and validates `VITE_SUPABASE_URL` / `VITE_ENVIRONMENT` from Vercel + gitignored `.env.production`.

There is no local OTP copy in `.env.production` to drift. Copy `.env.production.example` → `.env.production` for local release builds.

## One-time local setup (developers building prod locally)

1. Copy `.env.vercel.local.example` → `.env.vercel.local` (gitignored).
2. Set `VERCEL_TOKEN` (https://vercel.com/account/tokens) and `VERCEL_PROJECT_ID`.
3. Optional: `VERCEL_TEAM_ID` if the project is under a team.

```bash
npm run check:otp-prod   # prints the live Vercel Production value
npm run build:prod       # fails loudly if Vercel cannot be reached / var missing
```

| Failure | Result |
|---------|--------|
| Local build, no token / API error | Build **refuses** (no default) |
| Production `VITE_OTP_ENABLED` missing or not `true`/`false` | Build **refuses** |
| Local `.env.production` still has `VITE_OTP_ENABLED=` | Build **refuses** (remove the line) |
| `VITE_SUPABASE_URL` missing or not PROD (`rpxsyeqskvhjmbkxnpmd`) | Build **refuses** |
| `VITE_ENVIRONMENT` not `production` | Build **refuses** |
| Vercel cloud build without the Production env var | Build **refuses** |
