-- 0008 The ten departments. Categories arrive with the import.
insert into public.departments (name, sort) values
  ('Audio', 1), ('Video', 2), ('IT', 3), ('Power', 4), ('Backline', 5),
  ('Set', 6), ('Lighting', 7), ('Rigging', 8), ('Cases', 9), ('Tools and consumables', 10)
on conflict (name) do nothing;
