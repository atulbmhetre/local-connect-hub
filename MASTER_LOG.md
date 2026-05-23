# Aaspaas Pro — Master Log

Project documentation: known issues, tech debt, and key decisions.

## KNOWN_BUGS / TECH DEBT

| Issue | Severity | Notes |
|-------|----------|-------|
| RLS blanket policy "Anyone can update request status" still active | High | Must drop when JWT auth is wired — currently all JWT-based policies are shadowed by this. Also clean up duplicate INSERT and SELECT policies. |
| User push when vendor cancels order | Medium | Needs `user_devices` table (`device_id` + `fcm_token`) and `invokeNotifyUser` before cancel can notify offline users; Realtime + MyOrders UI handles open-app case for now. |

## KEY DECISIONS LOG

| Topic | Decision | Notes |
|-------|----------|-------|
| RLS tightening | Deferred — app uses anon key, JWT policies don't fire yet | Needs proper auth session before RLS can enforce vendor/user boundaries |

## requests table schema

| Column | Type | Notes |
|--------|------|-------|
| delivery_slot | text | Nullable — ASAP/Morning/Afternoon/Evening/Tomorrow |
