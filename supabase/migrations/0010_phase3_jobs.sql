-- 0010 Phase 3: jobs, equipment lists and sub-hire orders.
-- Adds tidy-up and safety rules, shortage warnings (a warning only, never a block),
-- one function that adds an item or a whole kit to a job, and a job list view. Changes no data.

-- ---------------------------------------------------------------------------
-- 1. Jobs: tidy the reference and name; no two references that differ only by case or spaces
-- ---------------------------------------------------------------------------
create or replace function app.tidy_jobs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.ref  := btrim(regexp_replace(new.ref,  '\s+', ' ', 'g'));
  new.name := btrim(regexp_replace(new.name, '\s+', ' ', 'g'));
  if new.ref = ''  then raise exception 'A job needs a reference'; end if;
  if new.name = '' then raise exception 'A job needs a name'; end if;
  return new;
end
$$;

create trigger tidy_jobs before insert or update on public.jobs
  for each row execute function app.tidy_jobs();

create unique index jobs_ref_ci on public.jobs (lower(ref));

-- ---------------------------------------------------------------------------
-- 2. Sub-hire orders: sensible dates, and no removing an order that still matters
-- ---------------------------------------------------------------------------
alter table public.sub_hire_orders
  add constraint sub_hire_dates check (hire_from is null or hire_to is null or hire_to >= hire_from);

create or replace function app.sub_hire_archive_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.archived_at is null and new.archived_at is not null then
    if new.status in ('received','returned') then
      raise exception 'This order has been received, so it cannot be removed';
    end if;
    if exists (select 1 from public.job_lines where sub_hire_id = old.id and archived_at is null) then
      raise exception 'Remove the lines on this order first';
    end if;
  end if;
  return new;
end
$$;

create trigger sub_hire_archive_rules before update on public.sub_hire_orders
  for each row execute function app.sub_hire_archive_rules();

-- ---------------------------------------------------------------------------
-- 3. A line on a sub-hire order must be on the same job, and the order must still be live
-- ---------------------------------------------------------------------------
create or replace function app.job_line_sub_hire_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      uuid;
  v_archived timestamptz;
begin
  if new.sub_hire_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.sub_hire_id is not distinct from old.sub_hire_id then
    return new;
  end if;
  select job_id, archived_at into v_job, v_archived from public.sub_hire_orders where id = new.sub_hire_id;
  if v_job is distinct from new.job_id then
    raise exception 'That sub-hire order belongs to a different job';
  end if;
  if v_archived is not null then
    raise exception 'That sub-hire order has been removed';
  end if;
  return new;
end
$$;

create trigger job_line_sub_hire_check before insert or update on public.job_lines
  for each row execute function app.job_line_sub_hire_check();

-- ---------------------------------------------------------------------------
-- 4. Shortages on a job. A warning, never a block.
--    For each stock item on the job's own-stock lines, finds the tightest day while the job is out:
--      free = owned - open issues - allocated to every live job that day (this job included)
--    Same rule as the clash view. short_by is 0 when there is enough.
--    Nothing is returned for a cancelled, returned or closed job.
-- ---------------------------------------------------------------------------
create or replace function public.job_shortages(p_job uuid)
returns table (
  type_id   uuid,
  type_name text,
  required  integer,
  owned     integer,
  in_issue  integer,
  min_free  integer,
  worst_day date,
  short_by  integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  j     public.jobs%rowtype;
  v_end date;
begin
  select * into j from public.jobs where id = p_job;
  if j.id is null or j.archived_at is not null or j.status in ('cancelled','returned','closed') then
    return;
  end if;
  v_end := least(j.return_date, j.out_date + 92);

  return query
  with mine as (
    select l.type_id, sum(l.qty_required)::integer as qty
    from public.job_lines l
    join public.equipment_types t on t.id = l.type_id
    where l.job_id = p_job and l.archived_at is null and l.source = 'own' and t.kind = 'stock'
    group by l.type_id
  ),
  days as (
    select g::date as day from generate_series(j.out_date, v_end, interval '1 day') g
  ),
  issues as (
    select i.type_id, sum(i.qty)::integer as qty
    from public.stock_issues i
    where i.status = 'open' and i.type_id in (select m.type_id from mine m)
    group by i.type_id
  ),
  per_day as (
    select m.type_id, d.day,
           (t.owned_qty - coalesce(i.qty, 0) - coalesce((
              select sum(l2.qty_required)
              from public.job_lines l2
              join public.jobs j2 on j2.id = l2.job_id
              where l2.type_id = m.type_id and l2.archived_at is null and l2.source = 'own'
                and j2.archived_at is null
                and j2.status not in ('cancelled','returned','closed')
                and j2.out_date <= d.day and j2.return_date >= d.day), 0))::integer as free
    from mine m
    join public.equipment_types t on t.id = m.type_id
    cross join days d
    left join issues i on i.type_id = m.type_id
  ),
  worst as (
    select distinct on (p.type_id) p.type_id, p.free, p.day
    from per_day p
    order by p.type_id, p.free, p.day
  )
  select m.type_id, t.name, m.qty, t.owned_qty, coalesce(i.qty, 0), w.free, w.day, greatest(0, -w.free)
  from mine m
  join public.equipment_types t on t.id = m.type_id
  join worst w on w.type_id = m.type_id
  left join issues i on i.type_id = m.type_id
  order by t.name;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Add an item or a whole kit to a job in one step.
--    A kit adds its title line plus its "mandatory" and "default" contents (times the kit quantity).
--    Contents we do not own go on as sub-hire lines. Switched-off or archived contents are skipped
--    and named in the answer. Adding the same plain item again increases its line.
--    It never refuses for a shortage: shortages show as warnings (job_shortages).
-- ---------------------------------------------------------------------------
create or replace function public.add_to_job(
  p_job       uuid,
  p_type      uuid,
  p_qty       integer,
  p_source    text default 'own',
  p_sub_hire  uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t          public.equipment_types%rowtype;
  c          public.equipment_types%rowtype;
  a          record;
  v_line     uuid;
  v_existing uuid;
  v_skipped  text[] := '{}';
begin
  if p_qty is null or p_qty < 1 then
    raise exception 'The quantity must be 1 or more';
  end if;
  if p_source not in ('own','sub_hire') then
    raise exception 'The source must be own stock or sub-hire';
  end if;
  if p_source = 'own' and p_sub_hire is not null then
    raise exception 'Own stock cannot be on a sub-hire order';
  end if;

  select * into t from public.equipment_types where id = p_type;
  if t.id is null then
    raise exception 'Item not found';
  end if;
  if t.kind = 'kit' and p_source = 'sub_hire' then
    raise exception 'A kit cannot be sub-hired as a package. Add its items one by one';
  end if;

  if t.kind <> 'kit' then
    select id into v_existing
    from public.job_lines
    where job_id = p_job and type_id = p_type and source = p_source
      and sub_hire_id is not distinct from p_sub_hire
      and parent_line_id is null and archived_at is null
    limit 1;
    if v_existing is not null then
      update public.job_lines set qty_required = qty_required + p_qty where id = v_existing;
      return jsonb_build_object('line_id', v_existing, 'merged', true, 'skipped', '[]'::jsonb);
    end if;
  end if;

  insert into public.job_lines (job_id, type_id, qty_required, source, sub_hire_id)
  values (p_job, p_type, p_qty, p_source, p_sub_hire)
  returning id into v_line;

  if t.kind = 'kit' then
    for a in
      select ta.child_type_id, ta.inclusion, ta.qty_per_parent
      from public.type_accessories ta
      where ta.parent_type_id = p_type and ta.archived_at is null and ta.inclusion in ('mandatory','default')
      order by ta.sort, ta.created_at
    loop
      select * into c from public.equipment_types where id = a.child_type_id;
      if c.archived_at is not null or not c.active then
        v_skipped := array_append(v_skipped, c.name);
        continue;
      end if;
      insert into public.job_lines (job_id, type_id, qty_required, source, parent_line_id, mandatory)
      values (p_job, a.child_type_id, a.qty_per_parent * p_qty,
              case when c.kind = 'stock' and c.owned_qty = 0 then 'sub_hire' else 'own' end,
              v_line, a.inclusion = 'mandatory');
    end loop;
  end if;

  return jsonb_build_object('line_id', v_line, 'merged', false, 'skipped', to_jsonb(v_skipped));
end
$$;

-- ---------------------------------------------------------------------------
-- 5b. Cover a shortage: move some of an item's own-stock quantity on a job over to sub-hire.
--     Takes from the largest own-stock lines first, then adds (or tops up) a sub-hire line.
--     All or nothing: if a line has more prepped than would be left, nothing changes.
--     Returns how many were moved (never more than the job has on own stock).
-- ---------------------------------------------------------------------------
create or replace function public.cover_with_sub_hire(
  p_job       uuid,
  p_type      uuid,
  p_qty       integer,
  p_sub_hire  uuid default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  l       record;
  v_kind  text;
  v_left  integer := p_qty;
  v_take  integer;
  v_moved integer := 0;
begin
  if p_qty is null or p_qty < 1 then
    raise exception 'The quantity must be 1 or more';
  end if;
  select kind into v_kind from public.equipment_types where id = p_type;
  if v_kind is distinct from 'stock' then
    raise exception 'Only stock items can be moved to sub-hire';
  end if;

  for l in
    select id, qty_required
    from public.job_lines
    where job_id = p_job and type_id = p_type and source = 'own' and archived_at is null and qty_required > 0
    order by qty_required desc, added_at
  loop
    exit when v_left = 0;
    v_take := least(l.qty_required, v_left);
    update public.job_lines set qty_required = qty_required - v_take where id = l.id;
    v_left  := v_left - v_take;
    v_moved := v_moved + v_take;
  end loop;

  if v_moved = 0 then
    raise exception 'This item has no own-stock quantity on the job';
  end if;
  perform public.add_to_job(p_job, p_type, v_moved, 'sub_hire', p_sub_hire);
  return v_moved;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Job list for the Jobs screen (follows the caller's access)
--    lines_total counts real lines (kit titles and zero quantities are not counted)
-- ---------------------------------------------------------------------------
create view public.job_list with (security_invoker = true) as
select
  j.id,
  j.ref,
  j.name,
  j.status,
  j.out_date,
  j.return_date,
  j.archived_at,
  j.client_id,
  o.name as client_name,
  j.venue_id,
  v.name as venue_name,
  coalesce(l.total, 0)::integer       as lines_total,
  coalesce(l.done, 0)::integer        as lines_prepped,
  coalesce(s.open_orders, 0)::integer as sub_hire_open
from public.jobs j
left join public.organisations o on o.id = j.client_id
left join public.venues v on v.id = j.venue_id
left join lateral (
  select count(*) filter (where x.qty_required > 0 and coalesce(t.kind, 'stock') <> 'kit') as total,
         count(*) filter (where x.qty_required > 0 and coalesce(t.kind, 'stock') <> 'kit'
                            and app.line_prepped(x.id) >= x.qty_required)                   as done
  from public.job_lines x
  left join public.equipment_types t on t.id = x.type_id
  where x.job_id = j.id and x.archived_at is null
) l on true
left join lateral (
  select count(*) as open_orders
  from public.sub_hire_orders so
  where so.job_id = j.id and so.archived_at is null and so.status in ('requested','confirmed')
) s on true;

-- ---------------------------------------------------------------------------
-- 7. Who may call what
-- ---------------------------------------------------------------------------
revoke all on function public.job_shortages(uuid)                          from public, anon;
revoke all on function public.add_to_job(uuid, uuid, integer, text, uuid)  from public, anon;
revoke all on function public.cover_with_sub_hire(uuid, uuid, integer, uuid) from public, anon;
grant execute on function public.job_shortages(uuid)                          to authenticated;
grant execute on function public.add_to_job(uuid, uuid, integer, text, uuid)  to authenticated;
grant execute on function public.cover_with_sub_hire(uuid, uuid, integer, uuid) to authenticated;

revoke all on public.job_list from anon;
grant select on public.job_list to authenticated;
