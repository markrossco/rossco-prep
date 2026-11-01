-- 0007 Private storage buckets for issue photos and equipment images.
-- Files are served through short-lived signed links, never public URLs.

insert into storage.buckets (id, name, public)
values ('issue-photos', 'issue-photos', false),
       ('equipment-images', 'equipment-images', false)
on conflict (id) do nothing;

create policy issue_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'issue-photos'
         and app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy issue_photos_add on storage.objects for insert to authenticated
  with check (bucket_id = 'issue-photos'
         and app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));

create policy equipment_images_read on storage.objects for select to authenticated
  using (bucket_id = 'equipment-images'
         and app.has_role('admin','office_lead','office','warehouse_lead','warehouse'));
create policy equipment_images_add on storage.objects for insert to authenticated
  with check (bucket_id = 'equipment-images' and app.has_role('admin','office_lead','office'));
create policy equipment_images_replace on storage.objects for update to authenticated
  using (bucket_id = 'equipment-images' and app.has_role('admin','office_lead','office'))
  with check (bucket_id = 'equipment-images' and app.has_role('admin','office_lead','office'));
