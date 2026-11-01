-- Role, row level security and business-rule tests. Run against the local test database only.
-- Prints a PASS/FAIL line for every check, then a summary.
\set ON_ERROR_STOP off
begin;  -- one transaction, so role and sign-in settings last between checks
create schema t;
create table t.results (name text, pass boolean, detail text);
grant usage on schema t to public;
grant all on t.results to public;

create function t.login(p_email text, p_aal text default 'aal2') returns void language plpgsql as $$
declare v uuid;
begin
  reset role;
  select id into v from auth.users where email = p_email;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v, 'aal', p_aal, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

create function t.logout() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

create function t.scalar(p_sql text) returns text language plpgsql as $$
declare r text;
begin execute p_sql into r; return r; end $$;

create function t.eq(p_name text, p_sql text, p_expected text) returns void language plpgsql as $$
declare r text;
begin
  begin
    execute p_sql into r;
  exception when others then
    insert into t.results values (p_name, false, 'error: ' || sqlerrm);
    return;
  end;
  insert into t.results values (p_name, r is not distinct from p_expected,
    'got ' || coalesce(r, 'NULL') || ', expected ' || coalesce(p_expected, 'NULL'));
end $$;

create function t.ok(p_name text, p_sql text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    insert into t.results values (p_name, false, 'error: ' || sqlerrm);
    return;
  end;
  insert into t.results values (p_name, true, null);
end $$;

create function t.fails(p_name text, p_sql text, p_like text default '%') returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    insert into t.results values (p_name, sqlerrm ilike p_like, sqlerrm);
    return;
  end;
  insert into t.results values (p_name, false, 'expected an error but it succeeded');
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures (as the database owner, like the SQL Editor: no signed-in user)
-- ---------------------------------------------------------------------------
insert into auth.users (email, raw_user_meta_data) values
  ('mark@x.test',  '{"full_name":"Mark"}'),
  ('john@x.test',  '{"full_name":"John"}'),
  ('ross@x.test',  '{"full_name":"Ross"}'),
  ('jonny@x.test', '{"full_name":"Jonny"}'),
  ('lily@x.test',  '{"full_name":"Lily"}'),
  ('donny@x.test', '{"full_name":"Donny"}');
-- a brand-new login starts switched off and sees nothing
select t.eq('new login starts inactive', $q$select (count(*) filter (where active))::text from public.profiles$q$, '0');
update public.profiles set active = true;
update public.profiles set role='admin'          where id=(select id from auth.users where email='mark@x.test');
update public.profiles set role='office_lead'    where id=(select id from auth.users where email='john@x.test');
update public.profiles set role='office'         where id=(select id from auth.users where email='ross@x.test');
update public.profiles set role='warehouse_lead' where id=(select id from auth.users where email='jonny@x.test');
-- lily and donny stay at the default role: warehouse

insert into public.categories (department_id, name, sort)
  select id, 'Mixing Consoles', 1 from public.departments where name='Audio';
insert into public.equipment_types (name, category_id, kind)
  select n, (select id from public.categories where name='Mixing Consoles'), k
  from (values ('Desk','stock'),('Mic','stock'),('Mic Package','kit'),('Gaffer tape','consumable'),('Rare Desk','stock')) v(n,k);
insert into public.stock_adjustments (type_id, delta, reason)
  select id, 3,  'import' from public.equipment_types where name='Desk';
insert into public.stock_adjustments (type_id, delta, reason)
  select id, 10, 'import' from public.equipment_types where name='Mic';
insert into public.stock_adjustments (type_id, delta, reason)
  select id, 50, 'import' from public.equipment_types where name='Gaffer tape';
insert into public.type_accessories (parent_type_id, child_type_id, inclusion, qty_per_parent)
  select p.id, c.id, 'default', 4 from public.equipment_types p, public.equipment_types c
  where p.name='Mic Package' and c.name='Mic';
insert into public.organisations (name, is_client) values ('Acme Events', true);
insert into public.organisations (name, is_supplier) values ('Hire Co', true);
insert into public.venues (name) values ('Town Hall');
insert into public.contacts (name, mobile) values ('Pat Contact', '07000 000000');

insert into public.jobs (ref, name, out_date, return_date, status)
values ('ROS-A','Job A','2026-11-10','2026-11-12','confirmed'),
       ('ROS-B','Job B','2026-11-12','2026-11-14','confirmed'),
       ('ROS-P','Prep job','2027-01-10','2027-01-12','confirmed'),
       ('ROS-X','Cancelled job','2026-11-10','2026-11-12','confirmed'),
       ('ROS-V','Provisional job','2026-11-11','2026-11-11','provisional');
insert into public.job_lines (job_id, type_id, qty_required)
  select j.id, t.id, q from (values ('ROS-A','Desk',2),('ROS-B','Desk',2),('ROS-X','Desk',3),('ROS-V','Desk',1)) v(ref,n,q)
  join public.jobs j on j.ref=v.ref join public.equipment_types t on t.name=v.n;
update public.jobs set status='cancelled' where ref='ROS-X';

-- ---------------------------------------------------------------------------
-- 1. Profiles and two-factor
-- ---------------------------------------------------------------------------
-- a new, switched-off login can read nothing
insert into auth.users (email, raw_user_meta_data) values ('new@x.test', '{"full_name":"New Person"}');
select set_config('t.desk', (select id::text from public.equipment_types where name='Desk'), true);
select t.login('new@x.test');
select t.eq  ('inactive user has no role', $q$select coalesce(app.my_role(), 'none')$q$, 'none');
select t.eq  ('inactive user sees no equipment', $q$select count(*)::text from public.equipment_types$q$, '0');
select t.eq  ('inactive user sees no jobs', $q$select count(*)::text from public.jobs$q$, '0');
select t.fails('inactive user cannot report an issue',
  $q$insert into public.stock_issues (type_id, qty, issue, reported_by) values (current_setting('t.desk')::uuid, 1, 'damaged', auth.uid())$q$,
  '%row-level security%');
select t.logout();

select t.login('lily@x.test');
select t.ok  ('warehouse can clear own must_change_password',
  $q$update public.profiles set must_change_password=false where id=auth.uid()$q$);
select t.ok  ('warehouse role change is silently ignored (attempt)',
  $q$update public.profiles set role='admin' where id=auth.uid()$q$);
select t.eq  ('warehouse role is still warehouse', $q$select app.my_role()$q$, 'warehouse');
select t.eq  ('warehouse sees all profiles', $q$select count(*)::text from public.profiles$q$, '7');
select t.eq  ('warehouse cannot edit someone else',
  $q$with u as (update public.profiles set full_name='X' where full_name='Mark' returning 1) select count(*)::text from u$q$, '0');

select t.login('mark@x.test', 'aal1');
select t.eq  ('admin without 2FA is mfa_pending', $q$select app.my_role()$q$, 'admin_mfa_pending');
select t.eq  ('admin without 2FA sees no equipment', $q$select count(*)::text from public.equipment_types$q$, '0');
select t.eq  ('admin without 2FA can read own profile', $q$select count(*)::text from public.profiles$q$, '1');
select t.eq  ('admin without 2FA sees no audit log', $q$select count(*)::text from public.audit_log$q$, '0');
select t.login('mark@x.test', 'aal2');
select t.eq  ('admin with 2FA is admin', $q$select app.my_role()$q$, 'admin');
select t.eq  ('admin with 2FA sees equipment', $q$select (count(*) > 0)::text from public.equipment_types$q$, 'true');
select t.ok  ('admin can set a role', $q$update public.profiles set role='warehouse' where full_name='Donny'$q$);
select t.eq  ('admin role change worked', $q$select role from public.profiles where full_name='Donny'$q$, 'warehouse');
select t.logout();

-- ---------------------------------------------------------------------------
-- 2. Who can see and edit what
-- ---------------------------------------------------------------------------
select t.login('lily@x.test');
select t.eq  ('warehouse cannot see contacts', $q$select count(*)::text from public.contacts$q$, '0');
select t.eq  ('warehouse sees equipment', $q$select (count(*) > 0)::text from public.equipment_types$q$, 'true');
select t.fails('warehouse cannot add equipment', $q$insert into public.equipment_types (name) values ('Nope')$q$);
select t.fails('warehouse cannot create a job',
  $q$insert into public.jobs (ref,name,out_date,return_date) values ('ROS-N','n','2026-12-01','2026-12-02')$q$);
select t.eq  ('warehouse cannot edit a job',
  $q$with u as (update public.jobs set name='Hacked' returning 1) select count(*)::text from u$q$, '0');
select t.eq  ('warehouse cannot see audit log', $q$select count(*)::text from public.audit_log$q$, '0');
select t.logout();

select t.login('ross@x.test');
select t.eq  ('office sees contacts', $q$select count(*)::text from public.contacts$q$, '1');
select t.ok  ('office adds equipment', $q$insert into public.equipment_types (name, kind) values ('Office Made','stock')$q$);
select t.fails('office cannot archive equipment',
  $q$update public.equipment_types set archived_at=now() where name='Office Made'$q$, '%admin%');
select t.fails('office cannot edit kit contents',
  $q$insert into public.type_accessories (parent_type_id, child_type_id)
     select p.id, c.id from public.equipment_types p, public.equipment_types c where p.name='Mic Package' and c.name='Desk'$q$);
select t.fails('office cannot resolve issues (no rights)',
  $q$insert into public.stock_adjustments (type_id, delta, reason, note) select id, 1, 'purchase', 'x' from public.equipment_types where name='Desk'$q$);
select t.ok  ('office creates a job',
  $q$insert into public.jobs (ref,name,out_date,return_date,client_id,venue_id,site_contact_id)
     select 'ROS-N','New job','2026-12-01','2026-12-02',
            (select id from public.organisations limit 1),(select id from public.venues limit 1),(select id from public.contacts limit 1)$q$);
select t.fails('office cannot see audit log (empty)', $q$select 1/(select count(*)::int from public.audit_log)$q$);
select t.logout();

select t.login('john@x.test');
select t.ok  ('office lead edits kit contents',
  $q$insert into public.type_accessories (parent_type_id, child_type_id, inclusion)
     select p.id, c.id, 'optional' from public.equipment_types p, public.equipment_types c where p.name='Mic Package' and c.name='Gaffer tape'$q$);
select t.ok  ('office lead removes kit content (archive)',
  $q$update public.type_accessories set archived_at=now() where inclusion='optional'$q$);
select t.fails('office lead cannot restore kit content',
  $q$update public.type_accessories set archived_at=null where inclusion='optional'$q$, '%admin%');
select t.logout();

select t.login('mark@x.test');
select t.ok  ('admin archives equipment', $q$update public.equipment_types set archived_at=now() where name='Office Made'$q$);
select t.ok  ('admin restores equipment', $q$update public.equipment_types set archived_at=null where name='Office Made'$q$);
select t.ok  ('admin restores kit content', $q$update public.type_accessories set archived_at=null where inclusion='optional'$q$);
select t.fails('nobody can hard delete (admin)', $q$delete from public.jobs where ref='ROS-N'$q$, '%permission denied%');
select t.fails('nobody can hard delete equipment (admin)', $q$delete from public.equipment_types where name='Desk'$q$, '%permission denied%');
select t.logout();

-- ---------------------------------------------------------------------------
-- 3. Stock adjustments
-- ---------------------------------------------------------------------------
select t.login('mark@x.test');
select t.fails('owned_qty cannot be edited directly (even admin)',
  $q$update public.equipment_types set owned_qty=99 where name='Desk'$q$, '%stock_adjustments%');
select t.ok  ('admin adds a purchase', $q$insert into public.stock_adjustments (type_id, delta, reason, note) select id, 1, 'purchase', 'bought one' from public.equipment_types where name='Desk'$q$);
select t.eq  ('owned_qty follows the ledger', $q$select owned_qty::text from public.equipment_types where name='Desk'$q$, '4');
select t.fails('cannot write off more than owned',
  $q$insert into public.stock_adjustments (type_id, delta, reason, note) select id, -99, 'write-off', 'x' from public.equipment_types where name='Desk'$q$);
select t.fails('adjustment ledger cannot be updated by the app',
  $q$update public.stock_adjustments set delta=5$q$);
select t.fails('adjustment ledger is insert-only (delete)',
  $q$delete from public.stock_adjustments$q$);
select t.logout();
select t.login('john@x.test');
select t.fails('office lead needs a note', $q$insert into public.stock_adjustments (type_id, delta, reason) select id, 1, 'correction' from public.equipment_types where name='Desk'$q$);
select t.fails('office lead cannot use import', $q$insert into public.stock_adjustments (type_id, delta, reason, note) select id, 1, 'import', 'n' from public.equipment_types where name='Desk'$q$);
select t.ok  ('office lead adjusts with a reason', $q$insert into public.stock_adjustments (type_id, delta, reason, note) select id, -1, 'correction', 'miscounted' from public.equipment_types where name='Desk'$q$);
select t.eq  ('adjustment is stamped with the user', $q$select (user_id = auth.uid())::text from public.stock_adjustments where note='miscounted'$q$, 'true');
select t.logout();
select t.login('jonny@x.test');
select t.ok  ('warehouse lead adjusts with a reason', $q$insert into public.stock_adjustments (type_id, delta, reason, note) select id, 1, 'correction', 'found one' from public.equipment_types where name='Desk'$q$);
select t.logout();
select t.login('lily@x.test');
select t.fails('warehouse cannot adjust stock', $q$insert into public.stock_adjustments (type_id, delta, reason, note) select id, 1, 'purchase', 'x' from public.equipment_types where name='Desk'$q$);
select t.logout();
select t.eq  ('Desk owned is 4 after adjustments', $q$select owned_qty::text from public.equipment_types where name='Desk'$q$, '4');
-- put Desk back to 3 for the availability maths below
select t.ok  ('reset Desk to 3', $q$insert into public.stock_adjustments (type_id, delta, reason, note) select id, -1, 'correction', 'test reset' from public.equipment_types where name='Desk'$q$);

-- ---------------------------------------------------------------------------
-- 4. Audit trail and insert-only tables
-- ---------------------------------------------------------------------------
select t.login('mark@x.test');
select t.eq  ('admin sees audit log', $q$select (count(*) > 20)::text from public.audit_log$q$, 'true');
select t.eq  ('audit records archive action', $q$select (count(*) > 0)::text from public.audit_log where action='archive' and table_name='equipment_types'$q$, 'true');
select t.eq  ('audit records restore action', $q$select (count(*) > 0)::text from public.audit_log where action='restore'$q$, 'true');
select t.eq  ('audit records the user', $q$select (count(*) > 0)::text from public.audit_log where user_id is not null$q$, 'true');
select t.fails('app cannot write to the audit log', $q$insert into public.audit_log (table_name, action) values ('x','y')$q$);
select t.fails('app cannot edit the audit log', $q$update public.audit_log set action='z'$q$);
select t.fails('app cannot delete from the audit log', $q$delete from public.audit_log$q$);
select t.logout();
select t.fails('even the owner cannot edit the audit log', $q$update public.audit_log set action='z'$q$, '%insert-only%');
select t.fails('even the owner cannot edit the stock ledger', $q$update public.stock_adjustments set delta=5$q$, '%insert-only%');

-- ---------------------------------------------------------------------------
-- 5. Availability and clashes
-- ---------------------------------------------------------------------------
select t.login('ross@x.test');
select t.eq  ('free on 10 Nov = 3 owned - 2 (A) - 0 = 1',
  $q$select free::text from public.availability_grid('2026-11-10','2026-11-14') g join public.equipment_types t on t.id=g.type_id where t.name='Desk' and day='2026-11-10'$q$, '1');
select t.eq  ('11 Nov counts provisional job V: 3-2-1 = 0',
  $q$select free::text from public.availability_grid('2026-11-10','2026-11-14') g join public.equipment_types t on t.id=g.type_id where t.name='Desk' and day='2026-11-11'$q$, '0');
select t.eq  ('11 Nov with provisional hidden: 1',
  $q$select free::text from public.availability_grid('2026-11-10','2026-11-14', false) g join public.equipment_types t on t.id=g.type_id where t.name='Desk' and day='2026-11-11'$q$, '1');
select t.eq  ('12 Nov is short: 3-2-2 = -1',
  $q$select free::text from public.availability_grid('2026-11-10','2026-11-14') g join public.equipment_types t on t.id=g.type_id where t.name='Desk' and day='2026-11-12'$q$, '-1');
select t.eq  ('12 Nov is a same-day turnaround',
  $q$select turnaround::text from public.availability_grid('2026-11-10','2026-11-14') g join public.equipment_types t on t.id=g.type_id where t.name='Desk' and day='2026-11-12'$q$, 'true');
select t.eq  ('10 Nov is not a turnaround',
  $q$select turnaround::text from public.availability_grid('2026-11-10','2026-11-14') g join public.equipment_types t on t.id=g.type_id where t.name='Desk' and day='2026-11-10'$q$, 'false');
select t.eq  ('14 Nov back to 1 (only B: 3-2)',
  $q$select free::text from public.availability_grid('2026-11-10','2026-11-14') g join public.equipment_types t on t.id=g.type_id where t.name='Desk' and day='2026-11-14'$q$, '1');
select t.eq  ('cancelled job ignored (10 Nov would be -2 otherwise)',
  $q$select (free >= 0)::text from public.availability_grid('2026-11-10','2026-11-10') g join public.equipment_types t on t.id=g.type_id where t.name='Desk'$q$, 'true');
select t.eq  ('kit titles and consumables never appear',
  $q$select count(*)::text from public.availability_grid('2026-11-10','2026-11-14') g join public.equipment_types t on t.id=g.type_id where t.kind <> 'stock'$q$, '0');
select t.fails('range over 93 days is refused', $q$select * from public.availability_grid('2026-01-01','2026-12-31')$q$);
select t.logout();

select t.login('lily@x.test');
select t.ok  ('warehouse reports damaged desk',
  $q$insert into public.stock_issues (type_id, qty, issue, note, reported_by)
     select id, 1, 'damaged', 'fader dead', auth.uid() from public.equipment_types where name='Desk'$q$);
select t.eq  ('issue stamped with reporter', $q$select (reported_by = auth.uid())::text from public.stock_issues limit 1$q$, 'true');
select t.eq  ('open issue reduces free: 10 Nov now 0',
  $q$select free::text from public.availability_grid('2026-11-10','2026-11-10') g join public.equipment_types t on t.id=g.type_id where t.name='Desk'$q$, '0');
select t.eq  ('warehouse cannot resolve an issue',
  $q$with u as (update public.stock_issues set status='resolved', resolution='repaired', resolved_at=now() returning 1) select count(*)::text from u$q$, '0');
select t.logout();
select t.login('jonny@x.test');
select t.ok  ('warehouse lead resolves as written off',
  $q$update public.stock_issues set status='resolved', resolution='written_off', resolved_at=now()$q$);
select t.eq  ('write-off reduced owned qty to 2', $q$select owned_qty::text from public.equipment_types where name='Desk'$q$, '2');
select t.fails('a resolved issue cannot be reopened', $q$update public.stock_issues set status='open', resolution=null, resolved_at=null$q$, '%reopen%');
select t.logout();
select t.login('mark@x.test');
select t.ok  ('admin buys the desk back', $q$insert into public.stock_adjustments (type_id, delta, reason, note) select id, 1, 'purchase', 'replacement' from public.equipment_types where name='Desk'$q$);
select t.logout();

-- ---------------------------------------------------------------------------
-- 6. Job lines, kits, late additions
-- ---------------------------------------------------------------------------
select t.login('ross@x.test');
select t.fails('cannot add an item we do not own as own stock',
  $q$insert into public.job_lines (job_id, type_id, qty_required) select j.id, t.id, 1 from public.jobs j, public.equipment_types t where j.ref='ROS-P' and t.name='Rare Desk'$q$, '%not owned%');
select t.ok  ('desk line', $q$insert into public.job_lines (job_id, type_id, qty_required) select j.id, t.id, 2 from public.jobs j, public.equipment_types t where j.ref='ROS-P' and t.name='Desk'$q$);
select t.ok  ('kit header line', $q$insert into public.job_lines (job_id, type_id, qty_required) select j.id, t.id, 1 from public.jobs j, public.equipment_types t where j.ref='ROS-P' and t.name='Mic Package'$q$);
select t.ok  ('kit content line (mandatory)',
  $q$insert into public.job_lines (job_id, type_id, qty_required, parent_line_id, mandatory)
     select j.id, m.id, 4, k.id, true from public.jobs j, public.equipment_types m, public.job_lines k
     join public.equipment_types kt on kt.id=k.type_id
     where j.ref='ROS-P' and m.name='Mic' and kt.name='Mic Package' and k.job_id=j.id$q$);
select t.ok  ('consumable line', $q$insert into public.job_lines (job_id, type_id, qty_required) select j.id, t.id, 5 from public.jobs j, public.equipment_types t where j.ref='ROS-P' and t.name='Gaffer tape'$q$);
select t.ok  ('free-text line', $q$insert into public.job_lines (job_id, description, qty_required) select id, 'Odd bracket', 1 from public.jobs where ref='ROS-P'$q$);
select t.ok  ('sub-hire order', $q$insert into public.sub_hire_orders (job_id, supplier_id, supplier_ref) select j.id, o.id, 'PO-1' from public.jobs j, public.organisations o where j.ref='ROS-P' and o.name='Hire Co'$q$);
select t.ok  ('sub-hire line for an item we do not own',
  $q$insert into public.job_lines (job_id, type_id, qty_required, source, sub_hire_id)
     select j.id, t.id, 1, 'sub_hire', s.id from public.jobs j, public.equipment_types t, public.sub_hire_orders s where j.ref='ROS-P' and t.name='Rare Desk' and s.job_id=j.id$q$);
select t.fails('line with neither item nor description is refused',
  $q$insert into public.job_lines (job_id, qty_required) select id, 1 from public.jobs where ref='ROS-P'$q$);
select t.fails('mandatory kit content cannot be removed',
  $q$update public.job_lines set archived_at=now() where mandatory$q$, '%mandatory%');
select t.eq  ('lines are not late while job is confirmed',
  $q$select count(*)::text from public.job_lines l join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and l.added_late$q$, '0');
select t.logout();

-- ---------------------------------------------------------------------------
-- 7. Prep, undo own entries, automatic status
-- ---------------------------------------------------------------------------
select t.login('lily@x.test');
select t.fails('warehouse cannot edit lines',
  $q$insert into public.job_lines (job_id, description) select id, 'x' from public.jobs where ref='ROS-P'$q$);
select t.ok  ('Lily preps 1 desk',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 1, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Desk'$q$);
select t.eq  ('job moved to prepping', $q$select status from public.jobs where ref='ROS-P'$q$, 'prepping');
select t.eq  ('event is stamped with Lily even if user_id is forged',
  $q$select (user_id = auth.uid())::text from public.line_events order by at desc limit 1$q$, 'true');
select t.fails('cannot prep more than required',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 2, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Desk'$q$, '%more than required%');
select t.fails('cannot prep a kit title',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 1, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Mic Package'$q$, '%header%');
select t.fails('cannot edit an event', $q$update public.line_events set qty=9$q$);
select t.fails('cannot delete an event', $q$delete from public.line_events$q$);
select t.logout();
select t.login('donny@x.test');
select t.ok  ('Donny preps the second desk',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 1, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Desk'$q$);
select t.fails('Donny cannot undo Lily''s entry beyond his own',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'unprepped', 2, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Desk'$q$, '%your own%');
select t.ok  ('Donny can undo his own entry',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'unprepped', 1, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Desk'$q$);
select t.eq  ('progress view shows 1 prepped',
  $q$select prepped_qty::text from public.line_progress p join public.job_lines l on l.id=p.line_id join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Desk'$q$, '1');
select t.fails('sub-hire cannot be prepped before it is received',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 1, auth.uid() from public.job_lines l where l.source='sub_hire'$q$, '%Receive%');
select t.ok  ('warehouse receives the sub-hire line',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'received_sub_hire', 1, auth.uid() from public.job_lines l where l.source='sub_hire'$q$);
select t.ok  ('warehouse marks order received',
  $q$update public.sub_hire_orders set status='received'$q$);
select t.eq  ('order stamped received_by', $q$select (received_by = auth.uid())::text from public.sub_hire_orders$q$, 'true');
select t.fails('warehouse cannot change the order supplier ref',
  $q$update public.sub_hire_orders set supplier_ref='HACK'$q$, '%only record receipt%');
select t.ok  ('now the sub-hire line can be prepped',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 1, auth.uid() from public.job_lines l where l.source='sub_hire'$q$);
select t.fails('cannot receive more than ordered',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'received_sub_hire', 1, auth.uid() from public.job_lines l where l.source='sub_hire'$q$, '%more than ordered%');
select t.logout();

select t.login('jonny@x.test');
select t.ok  ('warehouse lead preps the rest (desk 1 more)',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 1, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Desk'$q$);
select t.ok  ('mic', $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 4, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Mic'$q$);
select t.ok  ('tape', $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 5, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Gaffer tape'$q$);
select t.eq  ('job not yet prepped: free-text line outstanding', $q$select status from public.jobs where ref='ROS-P'$q$, 'prepping');
select t.ok  ('free-text bracket', $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 1, auth.uid() from public.job_lines l join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and l.description='Odd bracket'$q$);
select t.eq  ('job is now prepped automatically', $q$select status from public.jobs where ref='ROS-P'$q$, 'prepped');
select t.logout();

select t.login('ross@x.test');
select t.ok  ('office adds a late line to the prepped job',
  $q$insert into public.job_lines (job_id, type_id, qty_required) select j.id, t.id, 2 from public.jobs j, public.equipment_types t where j.ref='ROS-P' and t.name='Mic'$q$);
select t.eq  ('late line is flagged', $q$select count(*)::text from public.job_lines l join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and l.added_late$q$, '1');
select t.eq  ('job dropped back to prepping', $q$select status from public.jobs where ref='ROS-P'$q$, 'prepping');
select t.fails('cannot reduce a line below prepped',
  $q$update public.job_lines l set qty_required=1 from public.equipment_types t where t.id=l.type_id and t.name='Desk' and l.job_id=(select id from public.jobs where ref='ROS-P')$q$, '%already prepped%');
select t.fails('cannot remove a prepped line',
  $q$update public.job_lines l set archived_at=now() from public.equipment_types t where t.id=l.type_id and t.name='Desk' and l.job_id=(select id from public.jobs where ref='ROS-P')$q$, '%prepped%');
select t.logout();

-- ---------------------------------------------------------------------------
-- 8. Returns and job status changes
-- ---------------------------------------------------------------------------
select t.login('lily@x.test');
select t.fails('warehouse cannot close a job', $q$select public.set_job_status((select id from public.jobs where ref='ROS-P'), 'closed')$q$);
select t.ok  ('warehouse marks job out', $q$select public.set_job_status((select id from public.jobs where ref='ROS-P'), 'out')$q$);
select t.ok  ('desk returned 1',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'returned', 1, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Desk'$q$);
select t.ok  ('desk missing on return 1',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'missing_on_return', 1, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Desk'$q$);
select t.fails('cannot book back more than went out',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'returned', 1, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id join public.jobs j on j.id=l.job_id where j.ref='ROS-P' and t.name='Desk'$q$, '%more than went out%');
select t.ok  ('warehouse marks job returned', $q$select public.set_job_status((select id from public.jobs where ref='ROS-P'), 'returned')$q$);
select t.logout();
select t.login('ross@x.test');
select t.ok  ('office closes the job', $q$select public.set_job_status((select id from public.jobs where ref='ROS-P'), 'closed')$q$);
select t.fails('closed job refuses new lines',
  $q$insert into public.job_lines (job_id, description) select id, 'x' from public.jobs where ref='ROS-P'$q$, '%closed%');
select t.logout();

select t.fails('even the owner cannot edit line events', $q$update public.line_events set qty=5$q$, '%insert-only%');
select t.logout();

-- ---------------------------------------------------------------------------
-- 9. Phase 2: equipment names, issues, assets, kit contents, register views
-- ---------------------------------------------------------------------------
-- fixtures as the owner (imports run like this)
insert into public.equipment_types (name, kind) values ('  Spare   Speaker ', 'stock'), ('Speaker Stand', 'stock'), ('Big Package', 'kit');
select t.eq  ('names are tidied on the way in', $q$select count(*)::text from public.equipment_types where name = 'Spare Speaker'$q$, '1');
insert into public.stock_adjustments (type_id, delta, reason) select id, 2, 'import' from public.equipment_types where name='Spare Speaker';
insert into public.stock_adjustments (type_id, delta, reason) select id, 5, 'import' from public.equipment_types where name='Speaker Stand';
insert into public.asset_register (type_id, asset_no) select id, 'A-100' from public.equipment_types where name='Spare Speaker';
insert into public.asset_register (type_id, asset_no) select id, 'A-101' from public.equipment_types where name='Spare Speaker';
select t.fails('names that differ only by case are refused',
  $q$insert into public.equipment_types (name) values ('spare speaker')$q$, '%equipment_types_name_ci%');
select t.fails('an asset on a kit title is refused',
  $q$insert into public.asset_register (type_id, asset_no) select id, 'K-1' from public.equipment_types where name='Big Package'$q$, '%stock items%');

select t.login('ross@x.test');
select t.fails('item type cannot change once used on a job',
  $q$update public.equipment_types set kind='consumable' where name='Desk'$q$, '%used on jobs%');
select t.ok  ('item type can change while unused',
  $q$update public.equipment_types set kind='consumable' where name='Speaker Stand'$q$);
select t.ok  ('and back again',
  $q$update public.equipment_types set kind='stock' where name='Speaker Stand'$q$);
select t.ok  ('office switches an item off', $q$update public.equipment_types set active=false where name='Spare Speaker'$q$);
select t.fails('switched-off item cannot go on a job',
  $q$insert into public.job_lines (job_id, type_id, qty_required) select j.id, t.id, 1 from public.jobs j, public.equipment_types t where j.ref='ROS-N' and t.name='Spare Speaker'$q$, '%switched off%');
select t.ok  ('office switches it back on', $q$update public.equipment_types set active=true where name='Spare Speaker'$q$);
select t.ok  ('active item goes on a job',
  $q$insert into public.job_lines (job_id, type_id, qty_required) select j.id, t.id, 1 from public.jobs j, public.equipment_types t where j.ref='ROS-N' and t.name='Spare Speaker'$q$);
select t.logout();
update public.equipment_types set archived_at = now() where name='Speaker Stand';
select t.login('ross@x.test');
select t.fails('archived item cannot go on a job',
  $q$insert into public.job_lines (job_id, type_id, qty_required) select j.id, t.id, 1 from public.jobs j, public.equipment_types t where j.ref='ROS-N' and t.name='Speaker Stand'$q$, '%archived%');
select t.logout();
update public.equipment_types set archived_at = null where name='Speaker Stand';

-- issues
select t.login('lily@x.test');
select t.fails('no issue on a consumable',
  $q$insert into public.stock_issues (type_id, qty, issue, reported_by) select id, 1, 'damaged', auth.uid() from public.equipment_types where name='Gaffer tape'$q$, '%only be reported on stock%');
select t.fails('no issue on a kit title',
  $q$insert into public.stock_issues (type_id, qty, issue, reported_by) select id, 1, 'missing', auth.uid() from public.equipment_types where name='Mic Package'$q$, '%only be reported on stock%');
select t.fails('cannot report more than owned',
  $q$insert into public.stock_issues (type_id, qty, issue, reported_by) select id, 3, 'damaged', auth.uid() from public.equipment_types where name='Spare Speaker'$q$, '%more than is owned%');
select t.fails('asset must belong to the item',
  $q$insert into public.stock_issues (type_id, asset_id, qty, issue, reported_by)
     select t.id, a.id, 1, 'damaged', auth.uid() from public.equipment_types t, public.asset_register a where t.name='Speaker Stand' and a.asset_no='A-100'$q$, '%different item%');
select t.fails('an asset is reported one at a time',
  $q$insert into public.stock_issues (type_id, asset_id, qty, issue, reported_by)
     select t.id, a.id, 2, 'damaged', auth.uid() from public.equipment_types t, public.asset_register a where t.name='Spare Speaker' and a.asset_no='A-100'$q$, '%one at a time%');
select t.ok  ('warehouse reports a damaged asset',
  $q$insert into public.stock_issues (type_id, asset_id, qty, issue, note, reported_by)
     select t.id, a.id, 1, 'damaged', 'cracked cone', auth.uid() from public.equipment_types t, public.asset_register a where t.name='Spare Speaker' and a.asset_no='A-100'$q$);
select t.eq  ('the asset status follows the issue',
  $q$select status from public.asset_register where asset_no='A-100'$q$, 'damaged');
select t.fails('the same asset cannot be reported twice',
  $q$insert into public.stock_issues (type_id, asset_id, qty, issue, reported_by)
     select t.id, a.id, 1, 'missing', auth.uid() from public.equipment_types t, public.asset_register a where t.name='Spare Speaker' and a.asset_no='A-100'$q$, '%already has an open issue%');
select t.logout();

select t.login('jonny@x.test');
select t.fails('cannot hand-edit an asset back to in service while an issue is open',
  $q$update public.asset_register set status='in_service' where asset_no='A-100'$q$, '%open issue%');
select t.fails('cannot hand-edit an asset to damaged',
  $q$update public.asset_register set status='damaged' where asset_no='A-101'$q$, '%Report an issue%');
select t.fails('cannot add an asset already damaged',
  $q$insert into public.asset_register (type_id, asset_no, status) select id, 'A-102', 'damaged' from public.equipment_types where name='Spare Speaker'$q$, '%Report the issue%');
select t.ok  ('warehouse lead adds an asset', $q$insert into public.asset_register (type_id, asset_no, serial_no) select id, ' A-102 ', 'SN1' from public.equipment_types where name='Spare Speaker'$q$);
select t.eq  ('asset number is tidied', $q$select count(*)::text from public.asset_register where asset_no='A-102'$q$, '1');
select t.ok  ('warehouse lead resolves the issue as repaired',
  $q$update public.stock_issues set status='resolved', resolution='repaired', resolved_at=now() where status='open' and asset_id=(select id from public.asset_register where asset_no='A-100')$q$);
select t.eq  ('the asset is back in service', $q$select status from public.asset_register where asset_no='A-100'$q$, 'in_service');
select t.ok  ('warehouse lead retires an asset by hand', $q$update public.asset_register set status='retired' where asset_no='A-102'$q$);
select t.logout();

-- kit contents
select t.login('john@x.test');
select t.fails('a kit cannot contain a kit',
  $q$insert into public.type_accessories (parent_type_id, child_type_id) select p.id, c.id from public.equipment_types p, public.equipment_types c where p.name='Big Package' and c.name='Mic Package'$q$, '%another kit%');
select t.fails('a consumable cannot have contents',
  $q$insert into public.type_accessories (parent_type_id, child_type_id) select p.id, c.id from public.equipment_types p, public.equipment_types c where p.name='Gaffer tape' and c.name='Mic'$q$, '%consumable%');
select t.ok  ('speaker contains stand',
  $q$insert into public.type_accessories (parent_type_id, child_type_id, inclusion) select p.id, c.id, 'default' from public.equipment_types p, public.equipment_types c where p.name='Spare Speaker' and c.name='Speaker Stand'$q$);
select t.fails('stand cannot contain the speaker',
  $q$insert into public.type_accessories (parent_type_id, child_type_id) select p.id, c.id from public.equipment_types p, public.equipment_types c where p.name='Speaker Stand' and c.name='Spare Speaker'$q$, '%contain itself%');
select t.ok  ('stand contains mic',
  $q$insert into public.type_accessories (parent_type_id, child_type_id) select p.id, c.id from public.equipment_types p, public.equipment_types c where p.name='Speaker Stand' and c.name='Mic'$q$);
select t.fails('a loop through three items is refused',
  $q$insert into public.type_accessories (parent_type_id, child_type_id) select p.id, c.id from public.equipment_types p, public.equipment_types c where p.name='Mic' and c.name='Spare Speaker'$q$, '%contain itself%');
select t.logout();
select t.login('mark@x.test');
select t.fails('an item inside other items cannot become a kit',
  $q$update public.equipment_types set kind='kit' where name='Speaker Stand'$q$, '%part of other kits%');
select t.logout();

-- register and issue views
insert into public.jobs (ref, name, out_date, return_date, status)
  values ('ROS-T', 'Today job', current_date, current_date + 1, 'confirmed');
insert into public.job_lines (job_id, type_id, qty_required)
  select j.id, t.id, 1 from public.jobs j, public.equipment_types t where j.ref='ROS-T' and t.name='Spare Speaker';
select t.login('lily@x.test');
select t.eq  ('register shows owned', $q$select owned_qty::text from public.equipment_register where name='Spare Speaker'$q$, '2');
select t.eq  ('register shows booked today', $q$select booked_today::text from public.equipment_register where name='Spare Speaker'$q$, '1');
select t.eq  ('register free today agrees with the clash view',
  $q$select (r.free_today = g.free)::text from public.equipment_register r
       join public.availability_grid(current_date, current_date) g on g.type_id = r.id where r.name='Spare Speaker'$q$, 'true');
select t.eq  ('register has no free figure for a kit', $q$select (free_today is null)::text from public.equipment_register where name='Mic Package'$q$, 'true');
select t.eq  ('register counts assets listed', $q$select assets_listed::text from public.equipment_register where name='Spare Speaker'$q$, '2');
select t.eq  ('asset count matches owned, so no warning', $q$select asset_count_differs::text from public.equipment_register where name='Spare Speaker'$q$, 'false');
select t.eq  ('issue list shows the repaired issue',
  $q$select (status || ' ' || asset_no || ' ' || reported_by_name) from public.issue_list where type_name='Spare Speaker'$q$, 'resolved A-100 Lily');
select t.logout();
-- ---------------------------------------------------------------------------
-- 10. Phase 3: jobs, shortage warnings, adding kits to jobs, sub-hire orders
-- ---------------------------------------------------------------------------
-- fixtures as the owner
insert into public.equipment_types (name, kind) values
  ('Flight Case','stock'), ('Mic Clip','stock'), ('Old Clip','stock'), ('Cable Tie','consumable');
insert into public.stock_adjustments (type_id, delta, reason) select id, 4,  'import' from public.equipment_types where name='Flight Case';
insert into public.stock_adjustments (type_id, delta, reason) select id, 20, 'import' from public.equipment_types where name='Mic Clip';
insert into public.stock_adjustments (type_id, delta, reason) select id, 5,  'import' from public.equipment_types where name='Old Clip';
update public.equipment_types set active=false where name='Old Clip';
insert into public.type_accessories (parent_type_id, child_type_id, inclusion, qty_per_parent)
  select p.id, c.id, 'mandatory', 1 from public.equipment_types p, public.equipment_types c where p.name='Mic Package' and c.name='Mic Clip';
insert into public.type_accessories (parent_type_id, child_type_id, inclusion, qty_per_parent)
  select p.id, c.id, 'mandatory', 1 from public.equipment_types p, public.equipment_types c where p.name='Mic Package' and c.name='Old Clip';
insert into public.type_accessories (parent_type_id, child_type_id, inclusion, qty_per_parent)
  select p.id, c.id, 'default', 1 from public.equipment_types p, public.equipment_types c where p.name='Mic Package' and c.name='Rare Desk';
insert into public.type_accessories (parent_type_id, child_type_id, inclusion, qty_per_parent)
  select p.id, c.id, 'optional', 1 from public.equipment_types p, public.equipment_types c where p.name='Mic Package' and c.name='Cable Tie';

insert into public.jobs (ref, name, out_date, return_date, status) values
  ('ROS-S1','Short one','2027-03-01','2027-03-03','confirmed'),
  ('ROS-S2','Short two','2027-03-03','2027-03-05','confirmed'),
  ('ROS-S3','Fine job','2027-03-10','2027-03-11','confirmed'),
  ('ROS-S4','Cancelled short','2027-03-01','2027-03-05','confirmed'),
  ('ROS-K','Kit job','2027-04-01','2027-04-02','confirmed');
insert into public.job_lines (job_id, type_id, qty_required)
  select j.id, t.id, q from (values ('ROS-S1','Flight Case',3),('ROS-S2','Flight Case',2),('ROS-S3','Flight Case',1),('ROS-S4','Flight Case',4)) v(ref,n,q)
  join public.jobs j on j.ref=v.ref join public.equipment_types t on t.name=v.n;
update public.jobs set status='cancelled' where ref='ROS-S4';

select t.login('ross@x.test');
-- job names and references
select t.ok   ('office creates a job with messy spacing', $q$insert into public.jobs (ref, name, out_date, return_date) values ('  ROS-N2 ', '  Spaced   out  job ', '2027-05-01', '2027-05-02')$q$);
select t.eq   ('job reference and name are tidied', $q$select ref || '|' || name from public.jobs where ref='ROS-N2'$q$, 'ROS-N2|Spaced out job');
select t.fails('a reference differing only by case is refused', $q$insert into public.jobs (ref, name, out_date, return_date) values ('ros-s1', 'Dup', '2027-05-01', '2027-05-02')$q$, '%jobs_ref_ci%');
select t.fails('a job needs a name', $q$insert into public.jobs (ref, name, out_date, return_date) values ('ROS-N3', '   ', '2027-05-01', '2027-05-02')$q$, '%needs a name%');
select t.fails('return before out is refused', $q$insert into public.jobs (ref, name, out_date, return_date) values ('ROS-N4', 'Backwards', '2027-05-03', '2027-05-02')$q$);

-- shortage warnings
select t.eq   ('job S2 is short by 1 on 3 Mar (4 owned, 3 + 2 out)',
  $q$select s.short_by::text || ' ' || s.worst_day::text from public.job_shortages((select id from public.jobs where ref='ROS-S2')) s$q$, '1 2027-03-03');
select t.eq   ('job S1 is short by 1 too (same overlap day)',
  $q$select s.short_by::text from public.job_shortages((select id from public.jobs where ref='ROS-S1')) s$q$, '1');
select t.eq   ('job S3 has enough', $q$select s.short_by::text from public.job_shortages((select id from public.jobs where ref='ROS-S3')) s$q$, '0');
select t.eq   ('shortage shows required, owned and tightest free',
  $q$select s.required::text || '/' || s.owned::text || '/' || s.min_free::text from public.job_shortages((select id from public.jobs where ref='ROS-S2')) s$q$, '2/4/-1');
select t.eq   ('shortage agrees with the clash view',
  $q$select (s.min_free = g.free)::text from public.job_shortages((select id from public.jobs where ref='ROS-S2')) s
       join public.availability_grid('2027-03-03','2027-03-03') g on g.type_id = s.type_id$q$, 'true');
select t.eq   ('a cancelled job has no shortage rows', $q$select count(*)::text from public.job_shortages((select id from public.jobs where ref='ROS-S4'))$q$, '0');
select t.ok   ('adding over the limit is allowed (a warning, not a block)',
  $q$insert into public.job_lines (job_id, type_id, qty_required) select j.id, t.id, 9 from public.jobs j, public.equipment_types t where j.ref='ROS-S3' and t.name='Flight Case'$q$);
select t.eq   ('and it now shows as short', $q$select s.short_by::text from public.job_shortages((select id from public.jobs where ref='ROS-S3')) s$q$, '6');
select t.logout();
update public.job_lines set archived_at = now()
 where job_id = (select id from public.jobs where ref='ROS-S3') and qty_required = 9;
insert into public.stock_issues (type_id, qty, issue, reported_by)
  select id, 1, 'damaged', (select id from auth.users where email='mark@x.test') from public.equipment_types where name='Flight Case';
select t.login('ross@x.test');
select t.eq   ('an open issue makes S3 tight: 4 - 1 = 3, needs 1, free 2',
  $q$select s.min_free::text from public.job_shortages((select id from public.jobs where ref='ROS-S3')) s$q$, '2');
select t.eq   ('and S2 is now short by 2', $q$select s.short_by::text from public.job_shortages((select id from public.jobs where ref='ROS-S2')) s$q$, '2');
select t.logout();

-- sub-hire lines do not use own stock
select t.login('ross@x.test');
select t.ok   ('sub-hire order on S2', $q$insert into public.sub_hire_orders (job_id, supplier_id, supplier_ref, hire_from, hire_to) select j.id, o.id, 'PO-S2', '2027-03-02', '2027-03-06' from public.jobs j, public.organisations o where j.ref='ROS-S2' and o.name='Hire Co'$q$);
select t.ok   ('sub-hire order on K', $q$insert into public.sub_hire_orders (job_id, supplier_id, supplier_ref) select j.id, o.id, 'PO-K' from public.jobs j, public.organisations o where j.ref='ROS-K' and o.name='Hire Co'$q$);
select t.fails('sub-hire dates cannot run backwards', $q$insert into public.sub_hire_orders (job_id, hire_from, hire_to) select id, '2027-03-06', '2027-03-02' from public.jobs where ref='ROS-S2'$q$);
select t.ok   ('add_to_job: sub-hire cases for S2 on its own order',
  $q$select public.add_to_job((select id from public.jobs where ref='ROS-S2'), (select id from public.equipment_types where name='Flight Case'), 2, 'sub_hire', (select id from public.sub_hire_orders where supplier_ref='PO-S2'))$q$);
select t.eq   ('own-stock shortage does not change when a sub-hire line is added',
  $q$select s.required::text from public.job_shortages((select id from public.jobs where ref='ROS-S2')) s$q$, '2');
select t.fails('a line cannot use another job''s sub-hire order',
  $q$select public.add_to_job((select id from public.jobs where ref='ROS-S2'), (select id from public.equipment_types where name='Flight Case'), 1, 'sub_hire', (select id from public.sub_hire_orders where supplier_ref='PO-K'))$q$, '%different job%');
select t.fails('own stock cannot be put on a sub-hire order',
  $q$select public.add_to_job((select id from public.jobs where ref='ROS-S2'), (select id from public.equipment_types where name='Flight Case'), 1, 'own', (select id from public.sub_hire_orders where supplier_ref='PO-S2'))$q$, '%cannot be on a sub-hire%');

-- add_to_job
select t.fails('quantity must be 1 or more', $q$select public.add_to_job((select id from public.jobs where ref='ROS-K'), (select id from public.equipment_types where name='Mic'), 0)$q$, '%1 or more%');
select t.fails('a kit cannot be sub-hired as a package',
  $q$select public.add_to_job((select id from public.jobs where ref='ROS-K'), (select id from public.equipment_types where name='Mic Package'), 1, 'sub_hire')$q$, '%cannot be sub-hired%');
select t.eq   ('adding a kit reports the switched-off content it skipped',
  $q$select (public.add_to_job((select id from public.jobs where ref='ROS-K'), (select id from public.equipment_types where name='Mic Package'), 2)->'skipped'->>0)$q$, 'Old Clip');
select t.eq   ('kit adds its title and mandatory and default contents (4 lines)',
  $q$select count(*)::text from public.job_lines where job_id=(select id from public.jobs where ref='ROS-K') and archived_at is null$q$, '4');
select t.eq   ('default content quantity is times the kit quantity (4 mics x 2 kits = 8)',
  $q$select l.qty_required::text from public.job_lines l join public.equipment_types t on t.id=l.type_id where l.job_id=(select id from public.jobs where ref='ROS-K') and t.name='Mic' and l.parent_line_id is not null$q$, '8');
select t.eq   ('contents are tied to the kit line',
  $q$select count(*)::text from public.job_lines c join public.job_lines p on p.id=c.parent_line_id where c.job_id=(select id from public.jobs where ref='ROS-K')$q$, '3');
select t.eq   ('mandatory content is flagged mandatory',
  $q$select l.mandatory::text from public.job_lines l join public.equipment_types t on t.id=l.type_id where l.job_id=(select id from public.jobs where ref='ROS-K') and t.name='Mic Clip'$q$, 'true');
select t.eq   ('content we do not own goes on as sub-hire',
  $q$select l.source from public.job_lines l join public.equipment_types t on t.id=l.type_id where l.job_id=(select id from public.jobs where ref='ROS-K') and t.name='Rare Desk'$q$, 'sub_hire');
select t.eq   ('optional content is not added',
  $q$select count(*)::text from public.job_lines l join public.equipment_types t on t.id=l.type_id where l.job_id=(select id from public.jobs where ref='ROS-K') and t.name='Cable Tie'$q$, '0');
select t.ok   ('add a plain item', $q$select public.add_to_job((select id from public.jobs where ref='ROS-K'), (select id from public.equipment_types where name='Flight Case'), 1)$q$);
select t.eq   ('adding the same item again reports a merge',
  $q$select (public.add_to_job((select id from public.jobs where ref='ROS-K'), (select id from public.equipment_types where name='Flight Case'), 2)->>'merged')$q$, 'true');
select t.eq   ('the merged line holds 1 + 2 = 3',
  $q$select l.qty_required::text from public.job_lines l join public.equipment_types t on t.id=l.type_id where l.job_id=(select id from public.jobs where ref='ROS-K') and t.name='Flight Case' and l.archived_at is null$q$, '3');
select t.eq   ('the merge left one line, not two',
  $q$select count(*)::text from public.job_lines l join public.equipment_types t on t.id=l.type_id where l.job_id=(select id from public.jobs where ref='ROS-K') and t.name='Flight Case' and l.archived_at is null$q$, '1');
select t.ok   ('add a consumable', $q$select public.add_to_job((select id from public.jobs where ref='ROS-K'), (select id from public.equipment_types where name='Cable Tie'), 50)$q$);
select t.eq   ('consumables and kit titles never show as shortages',
  $q$select count(*)::text from public.job_shortages((select id from public.jobs where ref='ROS-K')) s join public.equipment_types t on t.id=s.type_id where t.kind <> 'stock'$q$, '0');
select t.logout();

select t.login('lily@x.test');
select t.fails('warehouse cannot add to a job',
  $q$select public.add_to_job((select id from public.jobs where ref='ROS-K'), (select id from public.equipment_types where name='Mic'), 1)$q$, '%row-level security%');
select t.fails('warehouse cannot call it without a job either', $q$select public.add_to_job(null, null, 1)$q$);
select t.eq   ('warehouse can read the shortage warning', $q$select count(*)::text from public.job_shortages((select id from public.jobs where ref='ROS-S2'))$q$, '1');
select t.eq   ('warehouse sees the job list', $q$select lines_total::text from public.job_list where ref='ROS-K'$q$, '5');
select t.eq   ('job list shows client and open sub-hire count', $q$select sub_hire_open::text from public.job_list where ref='ROS-K'$q$, '1');
select t.logout();
select t.login('ross@x.test');
select t.eq   ('job list counts real lines (kit title not counted, 5 of 6)',
  $q$select lines_total::text || ' ' || lines_prepped::text from public.job_list where ref='ROS-K'$q$, '5 0');
select t.eq   ('cover: S1 is short by 2 before',
  $q$select s.short_by::text from public.job_shortages((select id from public.jobs where ref='ROS-S1')) s$q$, '2');
select t.eq   ('cover moves 2 of 3 over to sub-hire',
  $q$select public.cover_with_sub_hire((select id from public.jobs where ref='ROS-S1'), (select id from public.equipment_types where name='Flight Case'), 2)::text$q$, '2');
select t.eq   ('cover: own line on S1 is now 1',
  $q$select l.qty_required::text from public.job_lines l join public.equipment_types t on t.id=l.type_id where l.job_id=(select id from public.jobs where ref='ROS-S1') and t.name='Flight Case' and l.source='own'$q$, '1');
select t.eq   ('cover: a sub-hire line of 2 now exists on S1',
  $q$select l.qty_required::text from public.job_lines l join public.equipment_types t on t.id=l.type_id where l.job_id=(select id from public.jobs where ref='ROS-S1') and t.name='Flight Case' and l.source='sub_hire'$q$, '2');
select t.eq   ('cover: S1 is no longer short (4 - 1 issue - 1 - 2 on 3 Mar = 0)',
  $q$select s.short_by::text from public.job_shortages((select id from public.jobs where ref='ROS-S1')) s$q$, '0');
select t.eq   ('cover never moves more than the job has on own stock',
  $q$select public.cover_with_sub_hire((select id from public.jobs where ref='ROS-S1'), (select id from public.equipment_types where name='Flight Case'), 5)::text$q$, '1');
select t.fails('cover refuses a consumable',
  $q$select public.cover_with_sub_hire((select id from public.jobs where ref='ROS-K'), (select id from public.equipment_types where name='Cable Tie'), 1)$q$, '%Only stock%');
select t.fails('cover refuses an item with nothing on own stock',
  $q$select public.cover_with_sub_hire((select id from public.jobs where ref='ROS-S3'), (select id from public.equipment_types where name='Mic'), 1)$q$, '%no own-stock%');
select t.fails('an order with live lines cannot be removed',
  $q$update public.sub_hire_orders set archived_at=now() where supplier_ref='PO-S2'$q$, '%Remove the lines%');
select t.ok   ('remove the line first',
  $q$update public.job_lines set archived_at=now() where sub_hire_id=(select id from public.sub_hire_orders where supplier_ref='PO-S2')$q$);
select t.ok   ('then the order can be removed', $q$update public.sub_hire_orders set archived_at=now() where supplier_ref='PO-S2'$q$);
select t.fails('a removed order cannot take new lines',
  $q$insert into public.job_lines (job_id, type_id, qty_required, source, sub_hire_id)
     select j.id, t.id, 1, 'sub_hire', s.id from public.jobs j, public.equipment_types t, public.sub_hire_orders s where j.ref='ROS-S2' and t.name='Flight Case' and s.supplier_ref='PO-S2'$q$, '%has been removed%');
select t.logout();
update public.sub_hire_orders set status='received' where supplier_ref='PO-K';
select t.login('ross@x.test');
select t.fails('a received order cannot be removed', $q$update public.sub_hire_orders set archived_at=now() where supplier_ref='PO-K'$q$, '%been received%');
select t.logout();
-- ---------------------------------------------------------------------------
-- 11. Phase 4: warehouse prep, sub-hire receipt, check-in, photos
-- ---------------------------------------------------------------------------
insert into public.equipment_types (name, kind) values ('Stage Box','stock'), ('Hire Mixer','stock');
insert into public.stock_adjustments (type_id, delta, reason) select id, 10, 'import' from public.equipment_types where name='Stage Box';
insert into public.jobs (ref, name, out_date, return_date, status) values ('ROS-W','Warehouse job','2027-06-01','2027-06-03','confirmed');
insert into public.sub_hire_orders (job_id, supplier_id, supplier_ref) select j.id, o.id, 'PO-W' from public.jobs j, public.organisations o where j.ref='ROS-W' and o.name='Hire Co';
insert into public.job_lines (job_id, type_id, qty_required)
  select j.id, t.id, 4 from public.jobs j, public.equipment_types t where j.ref='ROS-W' and t.name='Stage Box';
insert into public.job_lines (job_id, type_id, qty_required, source, sub_hire_id)
  select j.id, t.id, 2, 'sub_hire', s.id from public.jobs j, public.equipment_types t, public.sub_hire_orders s where j.ref='ROS-W' and t.name='Hire Mixer' and s.supplier_ref='PO-W';

select t.login('lily@x.test');
select t.fails('cannot book back what has not gone out',
  $q$select public.check_in_line((select l.id from public.job_lines l join public.equipment_types t on t.id=l.type_id where t.name='Stage Box' and l.job_id=(select id from public.jobs where ref='ROS-W')), 1, 0, 0)$q$, '%more than went out%');
select t.fails('cannot prep a sub-hire line before it is received',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 1, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id where t.name='Hire Mixer' and l.job_id=(select id from public.jobs where ref='ROS-W')$q$, '%Receive the sub-hire%');
select t.ok   ('warehouse receives the sub-hire line',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'received_sub_hire', 2, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id where t.name='Hire Mixer' and l.job_id=(select id from public.jobs where ref='ROS-W')$q$);
select t.ok   ('warehouse marks the order received', $q$update public.sub_hire_orders set status='received' where supplier_ref='PO-W'$q$);
select t.ok   ('prep 3 of 4 stage boxes',
  $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 3, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id where t.name='Stage Box' and l.job_id=(select id from public.jobs where ref='ROS-W' )$q$);
select t.eq   ('job goes to prepping', $q$select status from public.jobs where ref='ROS-W'$q$, 'prepping');
select t.ok   ('prep the last stage box', $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 1, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id where t.name='Stage Box' and l.job_id=(select id from public.jobs where ref='ROS-W')$q$);
select t.ok   ('prep the hire mixers', $q$insert into public.line_events (line_id, action, qty, user_id) select l.id, 'prepped', 2, auth.uid() from public.job_lines l join public.equipment_types t on t.id=l.type_id where t.name='Hire Mixer' and l.job_id=(select id from public.jobs where ref='ROS-W')$q$);
select t.eq   ('job goes to prepped when every line is done', $q$select status from public.jobs where ref='ROS-W'$q$, 'prepped');
select t.ok   ('warehouse marks the job out', $q$select public.set_job_status((select id from public.jobs where ref='ROS-W'), 'out')$q$);

select t.fails('check-in needs a quantity', $q$select public.check_in_line((select l.id from public.job_lines l join public.equipment_types t on t.id=l.type_id where t.name='Stage Box' and l.job_id=(select id from public.jobs where ref='ROS-W')), 0, 0, 0)$q$, '%Enter a quantity%');
select t.fails('check-in refuses negative quantities', $q$select public.check_in_line((select l.id from public.job_lines l join public.equipment_types t on t.id=l.type_id where t.name='Stage Box' and l.job_id=(select id from public.jobs where ref='ROS-W')), -1, 2, 0)$q$, '%negative%');
select t.fails('cannot book back more than went out',
  $q$select public.check_in_line((select l.id from public.job_lines l join public.equipment_types t on t.id=l.type_id where t.name='Stage Box' and l.job_id=(select id from public.jobs where ref='ROS-W')), 5, 0, 0)$q$, '%more than went out%');
select t.ok   ('book back 2 returned, 1 missing, 1 damaged',
  $q$select public.check_in_line((select l.id from public.job_lines l join public.equipment_types t on t.id=l.type_id where t.name='Stage Box' and l.job_id=(select id from public.jobs where ref='ROS-W')), 2, 1, 1, 'one bent, one gone')$q$);
select t.eq   ('progress shows 2 returned, 1 missing, 1 damaged',
  $q$select returned_qty::text || '/' || missing_qty::text || '/' || damaged_qty::text from public.line_progress lp join public.job_lines l on l.id=lp.line_id join public.equipment_types t on t.id=l.type_id where t.name='Stage Box' and l.job_id=(select id from public.jobs where ref='ROS-W')$q$, '2/1/1');
select t.eq   ('missing and damaged became two open issues on the job',
  $q$select count(*)::text from public.issue_list where type_name='Stage Box' and status='open' and job_ref='ROS-W'$q$, '2');
select t.eq   ('the register now shows 2 in issue', $q$select open_issue_qty::text from public.equipment_register where name='Stage Box'$q$, '2');
select t.eq   ('the job is still out while the mixers are not back', $q$select status from public.jobs where ref='ROS-W'$q$, 'out');
select t.ok   ('book back the hire mixers',
  $q$select public.check_in_line((select l.id from public.job_lines l join public.equipment_types t on t.id=l.type_id where t.name='Hire Mixer' and l.job_id=(select id from public.jobs where ref='ROS-W')), 2, 0, 0)$q$);
select t.eq   ('the job becomes returned on its own', $q$select status from public.jobs where ref='ROS-W'$q$, 'returned');
select t.eq   ('check-in is stamped with the person', $q$select count(*)::text from public.line_events e join public.job_lines l on l.id=e.line_id where e.action='returned' and e.user_id=auth.uid() and l.job_id=(select id from public.jobs where ref='ROS-W')$q$, '2');

-- photos
select t.fails('an issue photo must be in your own folder',
  $q$insert into public.stock_issues (type_id, qty, issue, photo_path, reported_by) select id, 1, 'damaged', 'someone-else/pic.jpg', auth.uid() from public.equipment_types where name='Stage Box'$q$, '%not uploaded by you%');
select t.ok   ('an issue photo in your own folder is accepted',
  $q$insert into public.stock_issues (type_id, qty, issue, photo_path, reported_by) select id, 1, 'damaged', auth.uid()::text || '/pic.jpg', auth.uid() from public.equipment_types where name='Stage Box'$q$);
select t.logout();
-- ---------------------------------------------------------------------------
-- 12. Check-in does not double-count kit already reported on the job
-- ---------------------------------------------------------------------------
insert into public.jobs (ref, name, out_date, return_date, status) values
  ('ROS-W2','Reported mid-job','2027-07-01','2027-07-03','confirmed'),
  ('ROS-W3','Fully reported','2027-07-05','2027-07-06','confirmed');
insert into public.job_lines (job_id, type_id, qty_required)
  select j.id, t.id, q from (values ('ROS-W2',5),('ROS-W3',2)) v(ref,q)
  join public.jobs j on j.ref=v.ref join public.equipment_types t on t.name='Stage Box';
select t.login('lily@x.test');
select t.ok  ('prep W2', $q$insert into public.line_events (line_id, action, qty) select l.id, 'prepped', 5 from public.job_lines l where l.job_id=(select id from public.jobs where ref='ROS-W2')$q$);
select t.ok  ('prep W3', $q$insert into public.line_events (line_id, action, qty) select l.id, 'prepped', 2 from public.job_lines l where l.job_id=(select id from public.jobs where ref='ROS-W3')$q$);
select t.ok  ('W2 out', $q$select public.set_job_status((select id from public.jobs where ref='ROS-W2'), 'out')$q$);
select t.ok  ('W3 out', $q$select public.set_job_status((select id from public.jobs where ref='ROS-W3'), 'out')$q$);
select t.ok  ('quick report on W2: 1 damaged Stage Box mid-job',
  $q$insert into public.stock_issues (type_id, qty, issue, job_id, note, reported_by) select t.id, 1, 'damaged', j.id, 'cracked', auth.uid() from public.equipment_types t, public.jobs j where t.name='Stage Box' and j.ref='ROS-W2'$q$);
select t.ok  ('quick report on W3: 1 missing Stage Box mid-job',
  $q$insert into public.stock_issues (type_id, qty, issue, job_id, note, reported_by) select t.id, 1, 'missing', j.id, 'not on site', auth.uid() from public.equipment_types t, public.jobs j where t.name='Stage Box' and j.ref='ROS-W3'$q$);
select t.ok  ('check in W2: 3 back, 2 damaged',
  $q$select public.check_in_line((select id from public.job_lines where job_id=(select id from public.jobs where ref='ROS-W2')), 3, 0, 2)$q$);
select t.eq  ('W2 damaged issues total 2: the 1 reported plus only the 1 new',
  $q$select coalesce(sum(qty),0)::text from public.stock_issues where job_id=(select id from public.jobs where ref='ROS-W2') and issue='damaged'$q$, '2');
select t.eq  ('W2 progress shows 2 damaged booked back',
  $q$select damaged_qty::text from public.line_progress where job_id=(select id from public.jobs where ref='ROS-W2')$q$, '2');
select t.ok  ('check in W3: 1 back, 1 missing (already reported)',
  $q$select public.check_in_line((select id from public.job_lines where job_id=(select id from public.jobs where ref='ROS-W3')), 1, 1, 0)$q$);
select t.eq  ('W3 missing issues stay at the 1 reported, no duplicate',
  $q$select coalesce(sum(qty),0)::text from public.stock_issues where job_id=(select id from public.jobs where ref='ROS-W3') and issue='missing'$q$, '1');
select t.eq  ('W3 is returned', $q$select status from public.jobs where ref='ROS-W3'$q$, 'returned');
select t.logout();
commit;

-- ---------------------------------------------------------------------------
-- Summary
-- ---------------------------------------------------------------------------
\echo
select case when pass then 'PASS' else 'FAIL' end as result, name, case when pass then '' else detail end as detail
from t.results order by pass, name;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from t.results;
