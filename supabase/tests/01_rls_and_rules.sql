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
commit;

-- ---------------------------------------------------------------------------
-- Summary
-- ---------------------------------------------------------------------------
\echo
select case when pass then 'PASS' else 'FAIL' end as result, name, case when pass then '' else detail end as detail
from t.results order by pass, name;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from t.results;
