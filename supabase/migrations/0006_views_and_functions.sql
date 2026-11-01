-- 0006 Calculated views and functions: availability, line progress, job status changes.

-- ---------------------------------------------------------------------------
-- Prepped / returned / received quantities per job line, summed from line_events
-- ---------------------------------------------------------------------------
create view public.line_progress with (security_invoker = true) as
select
  l.id     as line_id,
  l.job_id as job_id,
  coalesce(sum(case e.action when 'prepped' then e.qty when 'unprepped' then -e.qty end), 0)::integer
                                                                       as prepped_qty,
  coalesce(sum(e.qty) filter (where e.action = 'returned'),            0)::integer as returned_qty,
  coalesce(sum(e.qty) filter (where e.action = 'missing_on_return'),   0)::integer as missing_qty,
  coalesce(sum(e.qty) filter (where e.action = 'damaged_on_return'),   0)::integer as damaged_qty,
  coalesce(sum(e.qty) filter (where e.action = 'received_sub_hire'),   0)::integer as received_qty,
  max(e.at)                                                            as last_event_at,
  (array_agg(e.user_id order by e.at desc) filter (where e.id is not null))[1] as last_user_id
from public.job_lines l
left join public.line_events e on e.line_id = l.id
group by l.id, l.job_id;

-- ---------------------------------------------------------------------------
-- Availability per equipment type and day.
--   free = owned - open issues - allocated
-- Allocated counts own-stock lines of jobs that are out on that day
-- (out_date <= day <= return_date). Cancelled, returned and closed jobs are ignored.
-- Kit titles and consumables are never counted. Sub-hire lines never use own stock.
-- turnaround is true when one job returns and a different job goes out on that day.
-- ---------------------------------------------------------------------------
create or replace function public.availability_grid(
  p_from                date,
  p_to                  date,
  p_include_provisional boolean default true,
  p_category            uuid    default null
)
returns table (
  type_id    uuid,
  day        date,
  owned      integer,
  in_issue   integer,
  allocated  integer,
  free       integer,
  turnaround boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_to < p_from then
    raise exception 'The end date is before the start date';
  end if;
  if p_to - p_from > 92 then
    raise exception 'Choose a range of 93 days or fewer';
  end if;

  return query
  with days as (
    select g::date as day from generate_series(p_from, p_to, interval '1 day') g
  ),
  types as (
    select t.id, t.owned_qty
    from public.equipment_types t
    where t.kind = 'stock'
      and t.archived_at is null
      and (p_category is null or t.category_id = p_category)
  ),
  issues as (
    select i.type_id, sum(i.qty)::integer as qty
    from public.stock_issues i
    where i.status = 'open'
    group by i.type_id
  ),
  alloc as (
    select l.type_id, j.id as job_id, j.out_date, j.return_date, l.qty_required
    from public.job_lines l
    join public.jobs j on j.id = l.job_id
    where l.archived_at is null
      and l.source = 'own'
      and l.type_id is not null
      and j.archived_at is null
      and j.status not in ('cancelled','returned','closed')
      and (p_include_provisional or j.status <> 'provisional')
      and j.out_date <= p_to
      and j.return_date >= p_from
  )
  select t.id,
         d.day,
         t.owned_qty,
         coalesce(i.qty, 0),
         coalesce(a.qty, 0),
         t.owned_qty - coalesce(i.qty, 0) - coalesce(a.qty, 0),
         coalesce(a.returning_jobs > 0 and a.leaving_jobs > 0 and a.both_jobs >= 2, false)
  from types t
  cross join days d
  left join issues i on i.type_id = t.id
  left join lateral (
    select sum(x.qty_required)::integer                                  as qty,
           count(distinct x.job_id) filter (where x.return_date = d.day) as returning_jobs,
           count(distinct x.job_id) filter (where x.out_date = d.day)    as leaving_jobs,
           count(distinct x.job_id) filter (where x.return_date = d.day or x.out_date = d.day) as both_jobs
    from alloc x
    where x.type_id = t.id and x.out_date <= d.day and x.return_date >= d.day
  ) a on true
  where t.owned_qty > 0 or coalesce(a.qty, 0) > 0
  order by t.id, d.day;
end
$$;

-- ---------------------------------------------------------------------------
-- Job status changes. Office roles may set any status.
-- Warehouse roles may set prepping, prepped, out or returned only.
-- ---------------------------------------------------------------------------
create or replace function public.set_job_status(p_job uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role   text := app.my_role();
  v_status text;
begin
  if v_role is null then
    raise exception 'Not signed in';
  end if;
  if p_status not in ('provisional','confirmed','prepping','prepped','out','returned','closed','cancelled') then
    raise exception 'Unknown status %', p_status;
  end if;

  select status into v_status from public.jobs where id = p_job and archived_at is null;
  if v_status is null then
    raise exception 'Job not found';
  end if;

  if v_role in ('admin','office_lead','office') then
    null;
  elsif v_role in ('warehouse_lead','warehouse') then
    if p_status not in ('prepping','prepped','out','returned') then
      raise exception 'Warehouse can only set a job to prepping, prepped, out or returned';
    end if;
    if v_status in ('closed','cancelled') then
      raise exception 'This job is % and cannot be changed', v_status;
    end if;
  else
    raise exception 'Not allowed';
  end if;

  update public.jobs set status = p_status where id = p_job;
end
$$;

-- Functions are callable only by signed-in users
revoke all on function public.availability_grid(date, date, boolean, uuid) from public, anon;
revoke all on function public.set_job_status(uuid, text)                   from public, anon;
grant execute on function public.availability_grid(date, date, boolean, uuid) to authenticated;
grant execute on function public.set_job_status(uuid, text)                   to authenticated;
grant execute on function app.line_prepped(uuid)                              to authenticated;

revoke all on public.line_progress from anon;
grant select on public.line_progress to authenticated;
