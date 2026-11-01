-- 0004 Audit trail, insert-only tables, archive rules and business rules enforced in the database.
-- Every trigger function is SECURITY DEFINER with an empty search_path.
-- Where there is no signed-in user (SQL Editor, import scripts, server key) auth.uid() is null
-- and the per-user rules are skipped; the audit log still records the change.

-- ---------------------------------------------------------------------------
-- Audit log: one row for every insert, update, archive, restore and delete
-- ---------------------------------------------------------------------------
create or replace function app.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_old    jsonb;
  v_new    jsonb;
  v_row    text;
begin
  if tg_op = 'INSERT' then
    v_action := 'insert';
    v_new := to_jsonb(new);
    v_row := v_new ->> 'id';
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_row := v_new ->> 'id';
    if v_old = v_new then
      return null;
    end if;
    v_action := case
      when v_old ->> 'archived_at' is null     and v_new ->> 'archived_at' is not null then 'archive'
      when v_old ->> 'archived_at' is not null and v_new ->> 'archived_at' is null     then 'restore'
      else 'update'
    end;
  else
    v_action := 'delete';
    v_old := to_jsonb(old);
    v_row := v_old ->> 'id';
  end if;

  insert into public.audit_log (table_name, row_id, action, old_data, new_data, user_id)
  values (tg_table_name, v_row, v_action, v_old, v_new, auth.uid());
  return null;
end
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','departments','categories','equipment_types','type_accessories','asset_register',
    'stock_adjustments','stock_issues','organisations','venues','contacts','jobs',
    'sub_hire_orders','job_lines','line_events'
  ] loop
    execute format(
      'create trigger audit_%1$s after insert or update or delete on public.%1$I
         for each row execute function app.audit_row()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Insert-only tables
-- ---------------------------------------------------------------------------
create or replace function app.block_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception '% is insert-only: entries cannot be changed or removed', tg_table_name;
end
$$;

create trigger audit_log_insert_only
  before update or delete on public.audit_log
  for each row execute function app.block_change();
create trigger line_events_insert_only
  before update or delete on public.line_events
  for each row execute function app.block_change();
create trigger stock_adjustments_insert_only
  before update or delete on public.stock_adjustments
  for each row execute function app.block_change();

-- ---------------------------------------------------------------------------
-- Archive rules. Nobody deletes; removing archives. Only an admin restores.
-- Master records (types, clients, venues, contacts, categories, assets, jobs): admin archives.
-- Lines, kit contents and sub-hire orders: whoever can edit them may remove (archive) them.
-- ---------------------------------------------------------------------------
create or replace function app.guard_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  editors_may_archive boolean := coalesce(tg_argv[0], '') = 'editors';
begin
  if old.archived_at is not distinct from new.archived_at or auth.uid() is null then
    return new;
  end if;
  if app.my_role() = 'admin' then
    return new;
  end if;
  if editors_may_archive and old.archived_at is null and new.archived_at is not null then
    return new;
  end if;
  raise exception 'Only an admin can archive or restore this record';
end
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'departments','categories','equipment_types','asset_register',
    'organisations','venues','contacts','jobs'
  ] loop
    execute format(
      'create trigger guard_archive before update on public.%I
         for each row execute function app.guard_archive()', t);
  end loop;
  foreach t in array array['type_accessories','job_lines','sub_hire_orders'] loop
    execute format(
      'create trigger guard_archive before update on public.%I
         for each row execute function app.guard_archive(''editors'')', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Owned quantity only moves through stock_adjustments
-- ---------------------------------------------------------------------------
create or replace function app.guard_owned_qty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.adjusting', true), '') = '1' then
    return new;
  end if;
  if tg_op = 'INSERT' and new.owned_qty <> 0 then
    raise exception 'owned_qty starts at 0 and changes only through stock_adjustments';
  end if;
  if tg_op = 'UPDATE' and new.owned_qty is distinct from old.owned_qty then
    raise exception 'owned_qty changes only through stock_adjustments';
  end if;
  return new;
end
$$;

create trigger guard_owned_qty
  before insert or update on public.equipment_types
  for each row execute function app.guard_owned_qty();

create or replace function app.stock_adjustment_before()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    new.at := now();
  end if;
  return new;
end
$$;

create trigger stock_adjustment_before
  before insert on public.stock_adjustments
  for each row execute function app.stock_adjustment_before();

create or replace function app.stock_adjustment_apply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('app.adjusting', '1', true);
  update public.equipment_types set owned_qty = owned_qty + new.delta where id = new.type_id;
  perform set_config('app.adjusting', '', true);
  return null;
end
$$;

create trigger stock_adjustment_apply
  after insert on public.stock_adjustments
  for each row execute function app.stock_adjustment_apply();

-- ---------------------------------------------------------------------------
-- Stock issues (damaged / missing / in repair)
-- ---------------------------------------------------------------------------
create or replace function app.stock_issue_before()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.reported_by := auth.uid();
      new.reported_at := now();
      new.status := 'open';
      new.resolution := null;
      new.resolved_by := null;
      new.resolved_at := null;
    end if;
    return new;
  end if;

  -- UPDATE: what was reported never changes; a resolved issue stays resolved
  if auth.uid() is not null then
    new.type_id     := old.type_id;
    new.asset_id    := old.asset_id;
    new.qty         := old.qty;
    new.issue       := old.issue;
    new.job_id      := old.job_id;
    new.reported_by := old.reported_by;
    new.reported_at := old.reported_at;
  end if;
  if old.status = 'resolved' and new.status <> 'resolved' then
    raise exception 'A resolved issue cannot be reopened. Report a new issue instead.';
  end if;
  if old.status = 'open' and new.status = 'resolved' then
    if new.resolved_by is null and auth.uid() is not null then new.resolved_by := auth.uid(); end if;
    if new.resolved_at is null then new.resolved_at := now(); end if;
  end if;
  return new;
end
$$;

create trigger stock_issue_before
  before insert or update on public.stock_issues
  for each row execute function app.stock_issue_before();

create or replace function app.stock_issue_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.asset_id is not null and new.status = 'open' then
      update public.asset_register set status = new.issue where id = new.asset_id;
    end if;
    return null;
  end if;

  if old.status = 'open' and new.status = 'resolved' then
    if new.asset_id is not null then
      update public.asset_register
         set status = case when new.resolution = 'written_off' then 'retired' else 'in_service' end
       where id = new.asset_id;
    end if;
    if new.resolution = 'written_off' then
      insert into public.stock_adjustments (type_id, delta, reason, note, user_id)
      values (new.type_id, -new.qty, 'write-off', 'Issue written off', coalesce(new.resolved_by, auth.uid()));
    end if;
  end if;
  return null;
end
$$;

create trigger stock_issue_after
  after insert or update on public.stock_issues
  for each row execute function app.stock_issue_after();

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
create or replace function app.job_before()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  end if;
  return new;
end
$$;

create trigger job_before
  before insert or update on public.jobs
  for each row execute function app.job_before();

-- ---------------------------------------------------------------------------
-- Prepped quantity helper and automatic job status
-- ---------------------------------------------------------------------------
create or replace function app.line_prepped(p_line uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case e.action when 'prepped' then e.qty when 'unprepped' then -e.qty else 0 end), 0)::integer
  from public.line_events e
  where e.line_id = p_line
$$;

create or replace function app.refresh_job_prep_status(p_job uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status  text;
  v_total   integer;
  v_done    integer;
  v_started integer;
begin
  select status into v_status from public.jobs where id = p_job;
  if v_status is null or v_status not in ('provisional','confirmed','prepping','prepped') then
    return;
  end if;

  select count(*),
         count(*) filter (where app.line_prepped(l.id) >= l.qty_required),
         count(*) filter (where app.line_prepped(l.id) > 0)
    into v_total, v_done, v_started
  from public.job_lines l
  left join public.equipment_types t on t.id = l.type_id
  where l.job_id = p_job
    and l.archived_at is null
    and l.qty_required > 0
    and coalesce(t.kind, 'stock') <> 'kit';       -- kit titles are headers, not prepped

  if v_total > 0 and v_done = v_total then
    update public.jobs set status = 'prepped'  where id = p_job and status <> 'prepped';
  elsif v_started > 0 then
    update public.jobs set status = 'prepping' where id = p_job and status <> 'prepping';
  elsif v_status in ('prepping','prepped') then
    update public.jobs set status = 'confirmed' where id = p_job;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Job lines
-- ---------------------------------------------------------------------------
create or replace function app.job_line_before()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_status text;
  v_kind       text;
  v_owned      integer;
  v_prepped    integer;
  v_parent_job uuid;
  v_parent_archived timestamptz;
begin
  select status into v_job_status from public.jobs where id = new.job_id;

  if tg_op = 'INSERT' then
    if v_job_status in ('closed','cancelled') then
      raise exception 'This job is % and cannot be changed', v_job_status;
    end if;
    if auth.uid() is not null then
      new.added_by := auth.uid();
      new.added_at := now();
    end if;
    new.added_late := v_job_status in ('prepping','prepped','out');

    if new.parent_line_id is not null then
      select job_id into v_parent_job from public.job_lines where id = new.parent_line_id;
      if v_parent_job is distinct from new.job_id then
        raise exception 'A kit line and its contents must be on the same job';
      end if;
    end if;

    if new.source = 'own' and new.type_id is not null then
      select kind, owned_qty into v_kind, v_owned from public.equipment_types where id = new.type_id;
      if v_kind = 'stock' and v_owned = 0 then
        raise exception 'This item is not owned. Add it as a sub-hire line.';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  new.job_id := old.job_id;
  new.added_by := old.added_by;
  new.added_at := old.added_at;
  new.added_late := old.added_late;

  if v_job_status in ('closed','cancelled') and auth.uid() is not null then
    raise exception 'This job is % and cannot be changed', v_job_status;
  end if;

  if new.source = 'own' and new.type_id is not null and new.type_id is distinct from old.type_id then
    select kind, owned_qty into v_kind, v_owned from public.equipment_types where id = new.type_id;
    if v_kind = 'stock' and v_owned = 0 then
      raise exception 'This item is not owned. Add it as a sub-hire line.';
    end if;
  end if;

  v_prepped := app.line_prepped(old.id);

  if new.qty_required < v_prepped then
    raise exception 'Cannot reduce below the % already prepped. Unprep first.', v_prepped;
  end if;

  if old.archived_at is null and new.archived_at is not null then
    if v_prepped > 0 then
      raise exception 'This line has % prepped. Unprep it before removing the line.', v_prepped;
    end if;
    if old.mandatory then
      select archived_at into v_parent_archived from public.job_lines where id = old.parent_line_id;
      if v_parent_archived is null then
        raise exception 'This line is mandatory kit content and cannot be removed';
      end if;
    end if;
  end if;
  return new;
end
$$;

create trigger job_line_before
  before insert or update on public.job_lines
  for each row execute function app.job_line_before();

create or replace function app.job_line_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- New or increased line on a prepped job: back to prepping
  if tg_op = 'INSERT' or (new.qty_required > old.qty_required) then
    update public.jobs set status = 'prepping' where id = new.job_id and status = 'prepped';
  end if;

  -- Removing a kit line removes its contents too
  if tg_op = 'UPDATE' and old.archived_at is null and new.archived_at is not null then
    update public.job_lines set archived_at = new.archived_at
     where parent_line_id = new.id and archived_at is null;
    perform app.refresh_job_prep_status(new.job_id);
  end if;
  return null;
end
$$;

create trigger job_line_after
  after insert or update on public.job_lines
  for each row execute function app.job_line_after();

-- ---------------------------------------------------------------------------
-- Line events: who prepped, returned or received what
-- ---------------------------------------------------------------------------
create or replace function app.line_event_before()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  l            public.job_lines%rowtype;
  v_kind       text;
  v_job_status text;
  v_prepped    integer;
  v_own        integer;
  v_back       integer;
  v_received   integer;
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    new.at := now();
  end if;

  select * into l from public.job_lines where id = new.line_id;
  if l.id is null or l.archived_at is not null then
    raise exception 'That line is not on the job any more';
  end if;
  select status into v_job_status from public.jobs where id = l.job_id;
  if v_job_status in ('closed','cancelled') then
    raise exception 'This job is % and cannot be changed', v_job_status;
  end if;
  if l.type_id is not null then
    select kind into v_kind from public.equipment_types where id = l.type_id;
    if v_kind = 'kit' then
      raise exception 'A kit title is a header. Prep the items beneath it.';
    end if;
  end if;

  v_prepped := app.line_prepped(l.id);

  select coalesce(sum(qty), 0) into v_received
    from public.line_events where line_id = l.id and action = 'received_sub_hire';

  if new.action = 'prepped' then
    if v_prepped + new.qty > l.qty_required then
      raise exception 'Cannot prep more than required (% required, % already prepped)', l.qty_required, v_prepped;
    end if;
    if l.source = 'sub_hire' and v_prepped + new.qty > v_received then
      raise exception 'Receive the sub-hire before prepping it (% received)', v_received;
    end if;

  elsif new.action = 'unprepped' then
    if new.qty > v_prepped then
      raise exception 'Only % prepped on this line', v_prepped;
    end if;
    if app.my_role() = 'warehouse' then
      select coalesce(sum(case action when 'prepped' then qty when 'unprepped' then -qty end), 0)
        into v_own
        from public.line_events
       where line_id = l.id and user_id = new.user_id and action in ('prepped','unprepped');
      if new.qty > v_own then
        raise exception 'You can only undo your own entries (you prepped % on this line)', v_own;
      end if;
    end if;

  elsif new.action in ('returned','missing_on_return','damaged_on_return') then
    select coalesce(sum(qty), 0) into v_back
      from public.line_events
     where line_id = l.id and action in ('returned','missing_on_return','damaged_on_return');
    if v_back + new.qty > v_prepped then
      raise exception 'Cannot book back more than went out (% prepped, % already booked back)', v_prepped, v_back;
    end if;

  elsif new.action = 'received_sub_hire' then
    if l.source <> 'sub_hire' then
      raise exception 'Only sub-hire lines can be received';
    end if;
    if v_received + new.qty > l.qty_required then
      raise exception 'Cannot receive more than ordered (% ordered, % already received)', l.qty_required, v_received;
    end if;
  end if;
  return new;
end
$$;

create trigger line_event_before
  before insert on public.line_events
  for each row execute function app.line_event_before();

create or replace function app.line_event_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.action in ('prepped','unprepped') then
    perform app.refresh_job_prep_status((select job_id from public.job_lines where id = new.line_id));
  end if;
  return null;
end
$$;

create trigger line_event_after
  after insert on public.line_events
  for each row execute function app.line_event_after();

-- ---------------------------------------------------------------------------
-- Sub-hire orders: warehouse roles may only record receipt and return
-- ---------------------------------------------------------------------------
create or replace function app.sub_hire_before()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  loose constant text[] := array['status','received_by','received_at','returned_by','returned_at','notes'];
begin
  if tg_op = 'UPDATE' and app.my_role() in ('warehouse','warehouse_lead') then
    if (to_jsonb(new) - loose) is distinct from (to_jsonb(old) - loose) then
      raise exception 'Warehouse can only record receipt and return of a sub-hire order';
    end if;
    if new.status not in ('received','returned') and new.status is distinct from old.status then
      raise exception 'Warehouse can only mark an order received or returned';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.status = 'received' and old.status <> 'received' then
      new.received_by := coalesce(auth.uid(), new.received_by);
      new.received_at := coalesce(new.received_at, now());
    end if;
    if new.status = 'returned' and old.status <> 'returned' then
      new.returned_by := coalesce(auth.uid(), new.returned_by);
      new.returned_at := coalesce(new.returned_at, now());
    end if;
  end if;
  return new;
end
$$;

create trigger sub_hire_before
  before update on public.sub_hire_orders
  for each row execute function app.sub_hire_before();
