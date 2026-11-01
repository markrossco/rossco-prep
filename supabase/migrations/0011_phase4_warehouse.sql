-- 0011 Phase 4: warehouse check-in and issue photos.
-- Adds one function to book a line back in (returned, missing, damaged) and a rule that
-- an issue photo must be the reporter's own upload. Changes no data.

-- ---------------------------------------------------------------------------
-- 1. Book a line back in.
--    Writes the returned / missing / damaged events (the database already stops more coming back
--    than went out). Missing and damaged own-stock items also become open issues, so they stop
--    counting as free straight away. Sub-hire lines and consumables record the events only.
--    When every prepped line on an "out" job is fully booked back, the job becomes "returned".
-- ---------------------------------------------------------------------------
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
  l        public.job_lines%rowtype;
  v_kind   text;
  v_ref    text;
  v_status text;
  v_ret    integer := coalesce(p_returned, 0);
  v_mis    integer := coalesce(p_missing, 0);
  v_dam    integer := coalesce(p_damaged, 0);
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
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
      insert into public.stock_issues (type_id, qty, issue, job_id, note, reported_by)
      values (l.type_id, v_mis, 'missing', l.job_id, coalesce(v_note, 'Missing on return from ' || v_ref), auth.uid());
    end if;
  end if;

  if v_dam > 0 then
    insert into public.line_events (line_id, action, qty, user_id, note)
    values (l.id, 'damaged_on_return', v_dam, auth.uid(), v_note);
    if l.source = 'own' and v_kind = 'stock' then
      insert into public.stock_issues (type_id, qty, issue, job_id, note, reported_by)
      values (l.type_id, v_dam, 'damaged', l.job_id, coalesce(v_note, 'Damaged on return from ' || v_ref), auth.uid());
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

revoke all on function public.check_in_line(uuid, integer, integer, integer, text) from public, anon;
grant execute on function public.check_in_line(uuid, integer, integer, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. An issue photo must sit in the reporter's own folder of the photo store
--    (the app uploads to <user id>/<file>), so nobody can attach someone else's file.
-- ---------------------------------------------------------------------------
create or replace function app.stock_issue_photo_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.photo_path is not null and auth.uid() is not null
     and new.photo_path not like auth.uid()::text || '/%' then
    raise exception 'That photo was not uploaded by you';
  end if;
  return new;
end
$$;

create trigger stock_issue_photo_check before insert on public.stock_issues
  for each row execute function app.stock_issue_photo_check();
