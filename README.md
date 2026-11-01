# Rossco Prep

Prep-only system for Rossco Ltd: equipment database, job equipment lists, sub-hires, clash view and warehouse prep, replacing CurrentRMS for prep.

Built and maintained with Claude. The spec and the setup guide live in the Prep System project on claude.ai.

## Layout
- `app/`, `components/`, `lib/`, `proxy.ts`: the Next.js app
- `supabase/migrations/`: numbered SQL files, run once each, in order
- `supabase/manual/`: one-off SQL (first admin, table check)
- `supabase/tests/`: local database tests (`run_local.sh`)

## Environment variables
See `.env.example`. The secret key is set on Vercel only.

## Phases
1. Foundation (this commit): sign-in, five roles, security rules, audit trail, Admin screen
2. Equipment database and import
3. Jobs and lists
4. Warehouse
5. Clash view
6. Go-live
