-- 0013 Phase 5: the clash view.
-- Adds two functions and changes no data:
--   clash_grid    one row per stock item with how many are booked on each day, for the grid screen
--   move_line_qty move some of an item from one job to another (the "drag between jobs" action)

-- ---------------------------------------------------------------------------
-- 1. Clash grid.
--    Same rule as availability_grid and job_shortages:
--      free = owned - open issues - booked on own-stock lines of live jobs that are out that day
--    Returns one row per item (not one per item per day) with the booked quantity for every day
--    in the range as a list, so a month of the whole catalogue stays small and fast.
--    p_mode: 'booked' (only items booked in the range), 'short' (only items that go short),
--            'all' (every owned or booked item).
--    Rows come back in department, category, name order. total_count is the number of items
--    that match, so the screen can page. At most 93 days.
-- ---------------------------------------------------------------------------
create or replace function public.clash_grid(
  p_from                date,
  p_to                  date,
  p_include_provisional boolean default true,
  p_category            uuid    default null,
  p_department          uuid    default null,
  p_search              text    default null,
  p_mode                text    default 'booked',
  p_limit               integer default 50,
  p_offset              integer default 0
)
returns table (
  type_id         uuid,
  name            text,
  category_name   text,
  department_name text,
  owned           integer,
  in_issue        integer,
  alloc           integer[],
  min_free        integer,
  total_count     bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if p_from is null or p_to is null then
    raise exception 'Choose a start and end date';
  end if;
  if p_to < p_from then
    raise exception 'The end date is before the start date';
  end if;
  if p_to - p_from > 92 then
    raise exception 'Choose a range of 93 days or fewer';
  end if;
  if p_mode not in ('booked','short','all') then
    raise exception 'Unknown mode %', p_mode;
  end if;

  return query
  with days as (
    select g::date as day from generate_series(p_from, p_to, interval '1 day') g
  ),
  types as (
    select t.id, t.name, t.owned_qty,
           c.name as category_name, c.sort as category_sort,
           d.name as department_name, d.sort as department_sort
    from public.equipment_types t
    left join public.categories c on c.id = t.category_id
    left join public.departments d on d.id = c.department_id
    where t.kind = 'stock'
      and t.archived_at is null
      and (p_category   is null or t.category_id = p_category)
      and (p_department is null or c.department_id = p_department)
      and (v_search is null or t.name ilike '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%')
  ),
  issues as (
    select i.type_id, sum(i.qty)::integer as qty
    from public.stock_issues i
    where i.status = 'open'
    group by i.type_id
  ),
  alloc as (
    select l.type_id, j.out_date, j.return_date, l.qty_required
    from public.job_lines l
    join public.jobs j on j.id = l.job_id
    where l.archived_at is null
      and l.source = 'own'
      and l.type_id in (select x.id from types x)
      and j.archived_at is null
      and j.status not in ('cancelled','returned','closed')
      and (p_include_provisional or j.status <> 'provisional')
      and j.out_date <= p_to
      and j.return_date >= p_from
  ),
  per_item as (
    select t.id, t.name, t.category_name, t.category_sort, t.department_name, t.department_sort,
           t.owned_qty,
           coalesce(i.qty, 0) as in_issue,
           (select array_agg(coalesce(x.q, 0) order by d.day)
            from days d
            left join lateral (
              select sum(a.qty_required)::integer as q
              from alloc a
              where a.type_id = t.id and a.out_date <= d.day and a.return_date >= d.day
            ) x on true) as alloc
    from types t
    left join issues i on i.type_id = t.id
  ),
  shaped as (
    select p.*,
           (p.owned_qty - p.in_issue - (select max(v) from unnest(p.alloc) v))::integer as min_free,
           (select max(v) from unnest(p.alloc) v) as peak
    from per_item p
  ),
  picked as (
    select s.*, count(*) over () as total_count
    from shaped s
    where case p_mode
            when 'booked' then s.peak > 0
            when 'short'  then s.min_free < 0
            else s.owned_qty > 0 or s.peak > 0
          end
  )
  select k.id, k.name, k.category_name, k.department_name,
         k.owned_qty, k.in_issue, k.alloc, k.min_free, k.total_count
  from picked k
  order by k.department_sort nulls last, k.department_name nulls last,
           k.category_sort nulls last, k.category_name nulls last, k.name
  limit v_limit offset v_offset;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Move some of an item from one job to another.
--    Own-stock items only, office roles only. The quantity comes off the line and goes onto the
--    other job (joining a line for the same item if it has one). Refused when:
--      - the other job is finished, cancelled or missing, or is the same job
--      - the line is mandatory kit content
--      - more is moved than the line holds, or more than is left after what is already prepped
--    A line that is moved in full is archived (never deleted).
--    Returns the new line on the other job.
-- ---------------------------------------------------------------------------
create or replace function public.move_line_qty(
  p_line   uuid,
  p_to_job uuid,
  p_qty    integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_role   text := app.my_role();
  l        public.job_lines%rowtype;
  v_kind   text;
  v_status text;
  v_arch   timestamptz;
  v_result jsonb;
begin
  if v_role is null or v_role not in ('admin','office_lead','office') then
    raise exception 'Only the office can move kit between jobs';
  end if;
  if p_qty is null or p_qty < 1 then
    raise exception 'The quantity must be 1 or more';
  end if;

  select * into l from public.job_lines where id = p_line for update;
  if l.id is null or l.archived_at is not null then
    raise exception 'That line is not on the job any more';
  end if;
  if l.source <> 'own' or l.type_id is null then
    raise exception 'Only own-stock items can be moved between jobs';
  end if;
  select kind into v_kind from public.equipment_types where id = l.type_id;
  if v_kind is distinct from 'stock' then
    raise exception 'Only stock items can be moved between jobs';
  end if;
  if l.mandatory then
    raise exception 'This is mandatory kit content and has to stay with its kit';
  end if;
  if p_to_job = l.job_id then
    raise exception 'That is the same job. Choose a different one';
  end if;
  if p_qty > l.qty_required then
    raise exception 'The line only has % to move', l.qty_required;
  end if;

  select status, archived_at into v_status, v_arch from public.jobs where id = p_to_job;
  if v_status is null or v_arch is not null then
    raise exception 'The other job was not found';
  end if;
  if v_status in ('cancelled','returned','closed') then
    raise exception 'The other job is % and cannot take more kit', v_status;
  end if;

  if p_qty = l.qty_required then
    -- all of it moves: the line goes (the line guard refuses this if some is already prepped)
    update public.job_lines set archived_at = now() where id = l.id;
  else
    -- the line guard refuses to go below what is already prepped
    update public.job_lines set qty_required = qty_required - p_qty where id = l.id;
  end if;
  if not found then
    raise exception 'You are not allowed to change that line';
  end if;

  v_result := public.add_to_job(p_to_job, l.type_id, p_qty, 'own', null);
  return v_result;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Who may call what
-- ---------------------------------------------------------------------------
revoke all on function public.clash_grid(date, date, boolean, uuid, uuid, text, text, integer, integer) from public, anon;
revoke all on function public.move_line_qty(uuid, uuid, integer) from public, anon;
grant execute on function public.clash_grid(date, date, boolean, uuid, uuid, text, text, integer, integer) to authenticated;
grant execute on function public.move_line_qty(uuid, uuid, integer) to authenticated;
