-- Run after all eight numbered files. Expect: tables_found = 16, tables_with_security = 16.
select
  count(*)                                         as tables_found,
  count(*) filter (where c.relrowsecurity)         as tables_with_security
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r';
