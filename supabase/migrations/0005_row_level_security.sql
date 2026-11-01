-- 0005 Row level security: the five roles enforced in the database.
-- Roles: admin, office_lead, office, warehouse_lead, warehouse.
-- An admin without two-factor sign-in is 'admin_mfa_pending' and matches nothing below
-- except reading their own profile.

-- No hard deletes for anyone using the app or the API. Records are archived instead.
revoke delete, truncate on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke delete, truncate on tables from anon, authenticated;

-- Insert-only tables: the app cannot update them either
revoke update on public.line_events, public.stock_adjustments, public.audit_log from authenticated;
revoke insert on public.audit_log from authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','departments','categories','equipment_types','type_accessories','asset_register',
    'stock_adjustments','stock_issues','organisations','venues','contacts','jobs',
    'sub_hire_orders','job_lines','line_events','audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or app.my_role() is not null and app.my_role() <> 'admin_mfa_pending');
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_update_admin on public.profiles for update to authenticated
  using (app.has_role('admin')) with check (app.has_role('admin'));

-- ---------------------------------------------------------------------------
-- Reference data: everyone signed in can read; the listed roles can write
-- ---------------------------------------------------------------------------
-- departments, categories: admin, office_lead
create policy departments_select on public.departments for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy departments_write on public.departments for all to authenticated
  using (app.has_role('admin','office_lead')) with check (app.has_role('admin','office_lead'));

create policy categories_select on public.categories for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy categories_write on public.categories for all to authenticated
  using (app.has_role('admin','office_lead')) with check (app.has_role('admin','office_lead'));

-- equipment_types: admin, office_lead, office
create policy equipment_types_select on public.equipment_types for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy equipment_types_insert on public.equipment_types for insert to authenticated
  with check (app.has_role('admin','office_lead','office'));
create policy equipment_types_update on public.equipment_types for update to authenticated
  using (app.has_role('admin','office_lead','office')) with check (app.has_role('admin','office_lead','office'));

-- type_accessories (kit contents): admin, office_lead
create policy type_accessories_select on public.type_accessories for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy type_accessories_insert on public.type_accessories for insert to authenticated
  with check (app.has_role('admin','office_lead'));
create policy type_accessories_update on public.type_accessories for update to authenticated
  using (app.has_role('admin','office_lead')) with check (app.has_role('admin','office_lead'));

-- asset_register: admin, office_lead, office, warehouse_lead
create policy asset_register_select on public.asset_register for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy asset_register_insert on public.asset_register for insert to authenticated
  with check (app.has_role('admin','office_lead','office','warehouse_lead'));
create policy asset_register_update on public.asset_register for update to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead'))
  with check (app.has_role('admin','office_lead','office','warehouse_lead'));

-- stock_adjustments: read all; admin any; office_lead and warehouse_lead need a note, never 'import'
create policy stock_adjustments_select on public.stock_adjustments for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy stock_adjustments_insert_admin on public.stock_adjustments for insert to authenticated
  with check (app.has_role('admin'));
create policy stock_adjustments_insert_leads on public.stock_adjustments for insert to authenticated
  with check (
    app.has_role('office_lead','warehouse_lead')
    and reason <> 'import'
    and nullif(btrim(coalesce(note, '')), '') is not null
  );

-- stock_issues: everyone reports; admin, office_lead, warehouse_lead resolve
create policy stock_issues_select on public.stock_issues for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy stock_issues_insert on public.stock_issues for insert to authenticated
  with check (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy stock_issues_update on public.stock_issues for update to authenticated
  using (app.has_role('admin','office_lead','warehouse_lead'))
  with check (app.has_role('admin','office_lead','warehouse_lead'));

-- organisations, venues: admin, office_lead, office write
create policy organisations_select on public.organisations for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy organisations_insert on public.organisations for insert to authenticated
  with check (app.has_role('admin','office_lead','office'));
create policy organisations_update on public.organisations for update to authenticated
  using (app.has_role('admin','office_lead','office')) with check (app.has_role('admin','office_lead','office'));

create policy venues_select on public.venues for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy venues_insert on public.venues for insert to authenticated
  with check (app.has_role('admin','office_lead','office'));
create policy venues_update on public.venues for update to authenticated
  using (app.has_role('admin','office_lead','office')) with check (app.has_role('admin','office_lead','office'));

-- contacts: office roles only, read and write
create policy contacts_select on public.contacts for select to authenticated
  using (app.has_role('admin','office_lead','office'));
create policy contacts_insert on public.contacts for insert to authenticated
  with check (app.has_role('admin','office_lead','office'));
create policy contacts_update on public.contacts for update to authenticated
  using (app.has_role('admin','office_lead','office')) with check (app.has_role('admin','office_lead','office'));

-- ---------------------------------------------------------------------------
-- Jobs, lines, sub-hires
-- ---------------------------------------------------------------------------
create policy jobs_select on public.jobs for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy jobs_insert on public.jobs for insert to authenticated
  with check (app.has_role('admin','office_lead','office'));
create policy jobs_update on public.jobs for update to authenticated
  using (app.has_role('admin','office_lead','office')) with check (app.has_role('admin','office_lead','office'));

create policy job_lines_select on public.job_lines for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy job_lines_insert on public.job_lines for insert to authenticated
  with check (app.has_role('admin','office_lead','office'));
create policy job_lines_update on public.job_lines for update to authenticated
  using (app.has_role('admin','office_lead','office')) with check (app.has_role('admin','office_lead','office'));

create policy sub_hire_orders_select on public.sub_hire_orders for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy sub_hire_orders_insert on public.sub_hire_orders for insert to authenticated
  with check (app.has_role('admin','office_lead','office'));
-- Warehouse roles can update only to record receipt and return (enforced by a trigger)
create policy sub_hire_orders_update on public.sub_hire_orders for update to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'))
  with check (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));

-- line_events: everyone records their own prep and check-in; nobody edits
create policy line_events_select on public.line_events for select to authenticated
  using (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy line_events_insert on public.line_events for insert to authenticated
  with check (app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));

-- audit_log: admin reads; only triggers write
create policy audit_log_select on public.audit_log for select to authenticated
  using (app.has_role('admin'));
