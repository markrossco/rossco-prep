-- 0012 Check-in takes account of kit already reported on the job.
-- If a damaged or missing item was reported during the job (Quick report), booking it back at
-- check-in no longer opens a second issue for the same item. Only the difference is added.
-- Replaces check_in_line from 0011. Changes no data.

create or replace function public.check_in_line(
  p_line      uuid,
  p_returned  integer,
  p_missing   integer,
  p_damaged   integer,
  p_note      text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  l          public.job_lines%rowtype;
  v_kind     text;
  v_ref      text;
  v_status   text;
  v_ret      integer := coalesce(p_returned, 0);
  v_mis      integer := coalesce(p_missing, 0);
  v_dam      integer := coalesce(p_damaged, 0);
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_events   integer;
  v_reported integer;
  v_new      integer;
begin
  if v_ret < 0 or v_mis < 0 or v_dam < 0 then
    raise exception 'Quantities cannot be negative';
  end if;
  if v_ret + v_mis + v_dam = 0 then
    raise exception 'Enter a quantity';
  end if;

  select * into l from public.job_lines where id = p_line;
  if l.id is null or l.archived_at is not null then
    raise exception 'That line is not on the job any more';
  end if;
  select ref, status into v_ref, v_status from public.jobs where id = l.job_id;
  if l.type_id is not null then
    select kind into v_kind from public.equipment_types where id = l.type_id;
  end if;

  if v_ret > 0 then
    insert into public.line_events (line_id, action, qty, user_id, note)
    values (l.id, 'returned', v_ret, auth.uid(), v_note);
  end if;

  if v_mis > 0 then
    insert into public.line_events (line_id, action, qty, user_id, note)
    values (l.id, 'missing_on_return', v_mis, auth.uid(), v_note);
    if l.source = 'own' and v_kind = 'stock' then
      -- only the part not already reported on this job for this item becomes a new issue
      select coalesce(sum(e.qty), 0) into v_events
        from public.line_events e join public.job_lines x on x.id = e.line_id
       where x.job_id = l.job_id and x.type_id = l.type_id and e.action = 'missing_on_return';
      select coalesce(sum(qty), 0) into v_reported
        from public.stock_issues where job_id = l.job_id and type_id = l.type_id and issue = 'missing';
      v_new := greatest(0, least(v_mis, v_events - v_reported));
      if v_new > 0 then
        insert into public.stock_issues (type_id, qty, issue, job_id, note, reported_by)
        values (l.type_id, v_new, 'missing', l.job_id, coalesce(v_note, 'Missing on return from ' || v_ref), auth.uid());
      end if;
    end if;
  end if;

  if v_dam > 0 then
    insert into public.line_events (line_id, action, qty, user_id, note)
    values (l.id, 'damaged_on_return', v_dam, auth.uid(), v_note);
    if l.source = 'own' and v_kind = 'stock' then
      select coalesce(sum(e.qty), 0) into v_events
        from public.line_events e join public.job_lines x on x.id = e.line_id
       where x.job_id = l.job_id and x.type_id = l.type_id and e.action = 'damaged_on_return';
      select coalesce(sum(qty), 0) into v_reported
        from public.stock_issues where job_id = l.job_id and type_id = l.type_id and issue = 'damaged';
      v_new := greatest(0, least(v_dam, v_events - v_reported));
      if v_new > 0 then
        insert into public.stock_issues (type_id, qty, issue, job_id, note, reported_by)
        values (l.type_id, v_new, 'damaged', l.job_id, coalesce(v_note, 'Damaged on return from ' || v_ref), auth.uid());
      end if;
    end if;
  end if;

  if v_status = 'out' and not exists (
    select 1
    from public.job_lines x
    left join public.equipment_types t on t.id = x.type_id
    where x.job_id = l.job_id and x.archived_at is null and coalesce(t.kind, 'stock') <> 'kit'
      and app.line_prepped(x.id) > (
        select coalesce(sum(e.qty), 0) from public.line_events e
        where e.line_id = x.id and e.action in ('returned','missing_on_return','damaged_on_return'))
  ) then
    perform public.set_job_status(l.job_id, 'returned');
  end if;

  return jsonb_build_object('status', (select status from public.jobs where id = l.job_id));
end
$$;
