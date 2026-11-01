-- 0001 Foundation: helper schema, role helpers, profiles
-- Safe to paste into the Supabase SQL Editor and run once.

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- profiles: one row per user, linked to the sign-in account
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  full_name            text not null default '',
  role                 text not null default 'warehouse'
                         check (role in ('admin','office_lead','office','warehouse_lead','warehouse')),
  active               boolean not null default false,   -- a new login sees nothing until an admin switches it on
  must_change_password boolean not null default true,
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Role helpers. SECURITY DEFINER so row level security can read profiles.
-- An admin who has not completed two-factor sign-in (aal2) is treated as
-- 'admin_mfa_pending', which matches no policy except reading their own profile.
-- ---------------------------------------------------------------------------
create or replace function app.my_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when p.role = 'admin'
                and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'
             then 'admin_mfa_pending'
           else p.role
         end
  from public.profiles p
  where p.id = auth.uid() and p.active
$$;

create or replace function app.has_role(variadic allowed text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(app.my_role() = any (allowed), false)
$$;

-- Any signed-in, active user (including an admin who still has to do 2FA)
create or replace function app.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
$$;

grant execute on function app.my_role()            to authenticated, service_role;
grant execute on function app.has_role(text[])     to authenticated, service_role;
grant execute on function app.is_active_user()     to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- New sign-in account -> profile row, switched off until an admin grants a role
-- ---------------------------------------------------------------------------
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(coalesce(new.email, ''), '@', 1))
  );
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

-- A user may only change their own must_change_password flag.
-- Admins (and the SQL Editor / server key, where there is no signed-in user) may change anything.
create or replace function app.guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and app.my_role() is distinct from 'admin' then
    new.role      := old.role;
    new.active    := old.active;
    new.full_name := old.full_name;
    new.id        := old.id;
  end if;
  return new;
end
$$;

create trigger profiles_guard
  before update on public.profiles
  for each row execute function app.guard_profile_update();
