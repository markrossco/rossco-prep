-- 0009 Phase 2: equipment register, issues and kit contents.
-- Adds safety rules and two read-only views. Changes no data.
-- Rules never apply to the owner running SQL in the editor (imports), only to signed-in app users.

-- ---------------------------------------------------------------------------
-- 1. Equipment names: tidy spaces, and no two names that differ only by case or spacing
-- ---------------------------------------------------------------------------
create or replace function app.tidy_names()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'equipment_types' then
    new.name := btrim(regexp_replace(new.name, '\s+', ' ', 'g'));
    if new.name = '' then raise exception 'An item needs a name'; end if;
  elsif tg_table_name = 'asset_register' then
    new.asset_no := btrim(new.asset_no);
    new.serial_no := nullif(btrim(coalesce(new.serial_no, '')), '');
    if new.asset_no = '' then raise exception 'An asset needs an asset number'; end if;
  end if;
  return new;
end
$$;

create trigger tidy_names before insert or update on public.equipment_types
  for each row execute function app.tidy_names();
create trigger tidy_names before insert or update on public.asset_register
  for each row execute function app.tidy_names();

create unique index equipment_types_name_ci on public.equipment_types (lower(name));

-- ---------------------------------------------------------------------------
-- 2. An item's kind cannot change once it is used on a job or has an open issue
-- ---------------------------------------------------------------------------
create or replace function app.equipment_type_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind then
    if exists (select 1 from public.job_lines where type_id = old.id) then
      raise exception 'The type of this item cannot change because it is used on jobs';
    end if;
    if exists (select 1 from public.stock_issues where type_id = old.id and status = 'open') then
      raise exception 'Resolve the open issues before changing the type of this item';
    end if;
    if new.kind = 'kit' and exists (
         select 1 from public.type_accessories where child_type_id = old.id and archived_at is null) then
      raise exception 'This item is part of other kits, so it cannot become a kit itself';
    end if;
    if new.kind = 'consumable' and exists (
         select 1 from public.type_accessories where parent_type_id = old.id and archived_at is null) then
      raise exception 'A consumable cannot have contents. Remove its contents first';
    end if;
  end if;
  return new;
end
$$;

create trigger equipment_type_rules before update on public.equipment_types
  for each row execute function app.equipment_type_rules();

-- ---------------------------------------------------------------------------
-- 3. Switched-off and archived items cannot be added to a job from our own stock
-- ---------------------------------------------------------------------------
create or replace function app.job_line_type_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active   boolean;
  v_archived timestamptz;
begin
  if new.type_id is null or new.source <> 'own' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.type_id is not distinct from old.type_id then
    return new;
  end if;
  select active, archived_at into v_active, v_archived from public.equipment_types where id = new.type_id;
  if v_archived is not null then
    raise exception 'This item is archived and cannot be added to a job';
  end if;
  if not v_active then
    raise exception 'This item is switched off and cannot be added to a job';
  end if;
  return new;
end
$$;

create trigger job_line_type_check before insert or update on public.job_lines
  for each row execute function app.job_line_type_check();

-- ---------------------------------------------------------------------------
-- 4. Reporting an issue
--    Only stock items can have issues (consumables are never short; kit titles hold no stock).
--    An asset-numbered item is reported one at a time, once, and must match its type.
--    More cannot be reported than is owned.
-- ---------------------------------------------------------------------------
create or replace function app.stock_issue_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind   text;
  v_owned  integer;
  v_open   integer;
  v_asset_type uuid;
begin
  select kind, owned_qty into v_kind, v_owned from public.equipment_types where id = new.type_id;
  if v_kind <> 'stock' then
    raise exception 'Issues can only be reported on stock items. Consumables are never short and kit titles hold no stock';
  end if;

  if new.asset_id is not null then
    select type_id into v_asset_type from public.asset_register where id = new.asset_id;
    if v_asset_type is distinct from new.type_id then
      raise exception 'That asset number belongs to a different item';
    end if;
    if new.qty <> 1 then
      raise exception 'An item with an asset number is reported one at a time';
    end if;
    if exists (select 1 from public.stock_issues where asset_id = new.asset_id and status = 'open') then
      raise exception 'This asset already has an open issue';
    end if;
  end if;

  select coalesce(sum(qty), 0) into v_open
  from public.stock_issues where type_id = new.type_id and status = 'open';
  if v_open + new.qty > v_owned then
    raise exception 'That is more than is owned. % owned, % already reported', v_owned, v_open;
  end if;
  return new;
end
$$;

create trigger stock_issue_rules before insert on public.stock_issues
  for each row execute function app.stock_issue_rules();

-- Issues set an asset's status. Mark the change as coming from an issue, so the asset rule
-- below can tell it apart from a hand edit. (Replaces the version in 0004, same behaviour.)
create or replace function app.stock_issue_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('app.issue_sync', '1', true);
  if tg_op = 'INSERT' then
    if new.asset_id is not null and new.status = 'open' then
      update public.asset_register set status = new.issue where id = new.asset_id;
    end if;
    perform set_config('app.issue_sync', '', true);
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
  perform set_config('app.issue_sync', '', true);
  return null;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Assets (items with an asset number)
--    Only stock items have assets. Damaged, missing and in-repair come from issues, not hand edits,
--    so availability always agrees with the asset status.
-- ---------------------------------------------------------------------------
create or replace function app.asset_register_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  select kind into v_kind from public.equipment_types where id = new.type_id;
  if v_kind <> 'stock' then
    raise exception 'Only stock items can have asset numbers';
  end if;

  if auth.uid() is null or coalesce(current_setting('app.issue_sync', true), '') = '1' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status in ('damaged','missing','in_repair') then
      raise exception 'Add the asset as in service, then report the issue';
    end if;
    return new;
  end if;

  if new.type_id is distinct from old.type_id
     and exists (select 1 from public.stock_issues where asset_id = old.id and status = 'open') then
    raise exception 'Resolve the open issue before moving this asset to another item';
  end if;

  if new.status is distinct from old.status then
    if new.status in ('damaged','missing','in_repair') then
      raise exception 'Report an issue instead. The asset status follows the issue';
    end if;
    if exists (select 1 from public.stock_issues where asset_id = old.id and status = 'open') then
      raise exception 'This asset has an open issue. Resolve the issue instead';
    end if;
  end if;
  return new;
end
$$;

create trigger asset_register_rules before insert or update on public.asset_register
  for each row execute function app.asset_register_rules();

-- ---------------------------------------------------------------------------
-- 6. Kit contents
--    Consumables have no contents. A kit cannot contain another kit.
--    Nothing can contain itself, directly or through other items.
-- ---------------------------------------------------------------------------
create or replace function app.type_accessory_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_kind text;
  v_child_kind  text;
begin
  select kind into v_parent_kind from public.equipment_types where id = new.parent_type_id;
  select kind into v_child_kind  from public.equipment_types where id = new.child_type_id;
  if v_parent_kind = 'consumable' then
    raise exception 'A consumable cannot have contents';
  end if;
  if v_child_kind = 'kit' then
    raise exception 'A kit cannot contain another kit. Add its items directly';
  end if;
  if new.archived_at is null and exists (
    with recursive down as (
      select child_type_id from public.type_accessories
       where parent_type_id = new.child_type_id and archived_at is null and id is distinct from new.id
      union
      select a.child_type_id from public.type_accessories a
        join down d on a.parent_type_id = d.child_type_id
       where a.archived_at is null and a.id is distinct from new.id
    )
    select 1 from down where child_type_id = new.parent_type_id
  ) then
    raise exception 'That would make an item contain itself';
  end if;
  return new;
end
$$;

create trigger type_accessory_rules before insert or update on public.type_accessories
  for each row execute function app.type_accessory_rules();

-- ---------------------------------------------------------------------------
-- 7. Views for the Equipment and Issues screens (read-only, follow the caller's access)
--    "booked today" counts own-stock lines on jobs that cover today and are not cancelled,
--    returned or closed, the same rule as the clash view.
-- ---------------------------------------------------------------------------
create view public.equipment_register with (security_invoker = true) as
select
  t.id,
  t.name,
  t.kind,
  t.active,
  t.archived_at,
  t.can_sub_hire,
  t.accessory_only,
  t.tags,
  t.barcode,
  t.currentrms_id,
  t.category_id,
  c.name  as category_name,
  c.sort  as category_sort,
  d.id    as department_id,
  d.name  as department_name,
  d.sort  as department_sort,
  t.owned_qty,
  coalesce(i.qty, 0)::integer                         as open_issue_qty,
  case when t.kind = 'stock' then coalesce(b.qty, 0)::integer end as booked_today,
  case when t.kind = 'stock'
       then t.owned_qty - coalesce(i.qty, 0)::integer - coalesce(b.qty, 0)::integer end as free_today,
  coalesce(a.total, 0)::integer                       as assets_listed,
  coalesce(a.in_service, 0)::integer                  as assets_in_service,
  (coalesce(a.total, 0) > 0 and a.total <> t.owned_qty) as asset_count_differs
from public.equipment_types t
left join public.categories c on c.id = t.category_id
left join public.departments d on d.id = c.department_id
left join lateral (
  select sum(s.qty) as qty from public.stock_issues s where s.type_id = t.id and s.status = 'open'
) i on true
left join lateral (
  select sum(l.qty_required) as qty
  from public.job_lines l
  join public.jobs j on j.id = l.job_id
  where l.type_id = t.id and l.source = 'own' and l.archived_at is null
    and j.archived_at is null
    and j.status not in ('cancelled','returned','closed')
    and j.out_date <= (now() at time zone 'Europe/London')::date
    and j.return_date >= (now() at time zone 'Europe/London')::date
) b on true
left join lateral (
  select count(*) filter (where r.status <> 'retired') as total,
         count(*) filter (where r.status = 'in_service') as in_service
  from public.asset_register r where r.type_id = t.id and r.archived_at is null
) a on true;

create view public.issue_list with (security_invoker = true) as
select
  s.id,
  s.type_id,
  t.name  as type_name,
  s.asset_id,
  r.asset_no,
  s.qty,
  s.issue,
  s.status,
  s.resolution,
  s.note,
  s.photo_path,
  s.job_id,
  j.ref   as job_ref,
  s.reported_by,
  pr.full_name as reported_by_name,
  s.reported_at,
  s.resolved_by,
  pv.full_name as resolved_by_name,
  s.resolved_at,
  (case when s.status = 'open' then now() else s.resolved_at end)::date - s.reported_at::date as days_open
from public.stock_issues s
join public.equipment_types t on t.id = s.type_id
left join public.asset_register r on r.id = s.asset_id
left join public.jobs j on j.id = s.job_id
left join public.profiles pr on pr.id = s.reported_by
left join public.profiles pv on pv.id = s.resolved_by;

grant select on public.equipment_register, public.issue_list to authenticated;
