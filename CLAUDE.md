# Rossco Prep: instructions for Claude

Prep-only web app for Rossco Ltd (AV hire). Replaces CurrentRMS for prep. The owner, Mark, is not a developer: explain in plain words, one step at a time, and never ask him to edit code.

Spec: "Rossco Prep System: Spec and Database Schema" (Prep System project). Setup guide: "Step-by-Step Setup Guide". Read the spec before changing the schema or the rules.

## Stack
Next.js (App Router, TypeScript), Supabase (Postgres, Auth, Storage), Vercel. Supabase project ref `qfxduekxnffkbdeaesla`, region eu-west-1.

## Rules that must not be broken
- The database enforces security. Every table has row level security. Never rely on hidden buttons.
- Five roles: admin, office_lead, office, warehouse_lead, warehouse. Matrix is in the spec and in `supabase/migrations/0005_row_level_security.sql`.
- Admin needs two-factor (aal2). Without it the database treats them as `admin_mfa_pending` and grants nothing.
- No hard deletes. Archive with `archived_at`. Only admin restores (lines, kit contents and sub-hire orders can be archived by whoever edits them).
- `line_events`, `stock_adjustments` and `audit_log` are insert-only. `owned_qty` changes only through `stock_adjustments`.
- Quantities only: availability = owned - open issues - allocated, counted only while a job is out. Kit titles hold no stock. Consumables are never short.
- New logins start switched off with no access until an admin grants a role.
- The secret key (`SUPABASE_SECRET_KEY`) is server-only. It lives in Vercel environment variables. Never print it, commit it or ask Mark to paste it into chat. Never import `lib/supabase/admin.ts` from client code.
- Contacts data and import CSVs never go to GitHub (see `.gitignore`).

## Changing the database
- Only through new numbered files in `supabase/migrations/` (next is 0009). Never edit a file Mark has already run; add a new one.
- Mark runs each file once, in order, in the Supabase SQL Editor. Give him the file, the exact steps and what success looks like.
- Test first: `supabase/tests/run_local.sh` rebuilds a throwaway Postgres, applies every migration and runs `01_rls_and_rules.sql` (must end with 0 failed). Add tests for every new rule.
- Never run the test stub (`00_supabase_stub.sql`) on the real project.

## Working
- Work on a branch for anything risky; Vercel builds a private preview. `main` goes live.
- `npm run typecheck` and `npm run build` must pass before pushing.
- Commit messages end with the attribution lines from the session.
