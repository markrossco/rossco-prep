-- Run ONCE, after Mark has been added under Authentication > Users.
-- Makes Mark the Admin. Change the email if needed.
update public.profiles
   set role = 'admin', active = true, full_name = 'Mark'
 where id = (select id from auth.users where email = 'mark@rossco.co.uk');

-- Check: this should return one row showing role = admin
select p.full_name, p.role, p.active, u.email
  from public.profiles p join auth.users u on u.id = p.id;
