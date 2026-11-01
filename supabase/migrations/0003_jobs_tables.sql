-- 0003 Clients, venues, contacts, jobs, sub-hires, job lines, events, issues, audit log.

create table public.organisations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  is_client     boolean not null default false,
  is_supplier   boolean not null default false,
  active        boolean not null default true,
  currentrms_id bigint unique,
  archived_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index organisations_name_idx on public.organisations (lower(name));

create table public.venues (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  street        text,
  city          text,
  postcode      text,
  country       text,
  active        boolean not null default true,
  currentrms_id bigint unique,
  archived_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index venues_name_idx on public.venues (lower(name));

create table public.contacts (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  work_phone    text,
  mobile        text,
  work_email    text,
  active        boolean not null default true,
  bookable_crew boolean not null default false,
  currentrms_id bigint unique,
  archived_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index contacts_name_idx on public.contacts (lower(name));

create table public.jobs (
  id              uuid primary key default gen_random_uuid(),
  ref             text not null unique,            -- ROS number
  name            text not null,
  client_id       uuid references public.organisations (id),
  venue_id        uuid references public.venues (id),
  site_contact_id uuid references public.contacts (id),
  out_date        date not null,
  return_date     date not null,
  status          text not null default 'provisional'
                    check (status in ('provisional','confirmed','prepping','prepped','out','returned','closed','cancelled')),
  notes           text,
  created_by      uuid references public.profiles (id),
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  check (return_date >= out_date)
);
create index jobs_dates_idx  on public.jobs (out_date, return_date);
create index jobs_status_idx on public.jobs (status);

create table public.sub_hire_orders (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs (id),
  supplier_id  uuid references public.organisations (id),
  supplier_ref text,
  hire_from    date,
  hire_to      date,
  expected_at  timestamptz,
  status       text not null default 'requested'
                 check (status in ('requested','confirmed','received','returned')),
  received_by  uuid references public.profiles (id),
  received_at  timestamptz,
  returned_by  uuid references public.profiles (id),
  returned_at  timestamptz,
  notes        text,
  archived_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index sub_hire_orders_job_idx on public.sub_hire_orders (job_id);

create table public.job_lines (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.jobs (id),
  type_id        uuid references public.equipment_types (id),   -- null for free-text lines
  description    text,
  qty_required   integer not null default 1 check (qty_required >= 0),
  source         text not null default 'own' check (source in ('own','sub_hire')),
  sub_hire_id    uuid references public.sub_hire_orders (id),
  parent_line_id uuid references public.job_lines (id),
  mandatory      boolean not null default false,                -- mandatory kit contents cannot be removed
  group_name     text,
  sort           integer not null default 0,
  note           text,
  added_late     boolean not null default false,
  added_by       uuid references public.profiles (id),
  added_at       timestamptz not null default now(),
  archived_at    timestamptz,
  check (type_id is not null or nullif(btrim(description), '') is not null),
  check (sub_hire_id is null or source = 'sub_hire')
);
create index job_lines_job_idx    on public.job_lines (job_id);
create index job_lines_type_idx   on public.job_lines (type_id);
create index job_lines_parent_idx on public.job_lines (parent_line_id);

-- Insert-only: the record of who prepped what
create table public.line_events (
  id      uuid primary key default gen_random_uuid(),
  line_id uuid not null references public.job_lines (id),
  action  text not null check (action in
            ('prepped','unprepped','returned','missing_on_return','damaged_on_return','received_sub_hire')),
  qty     integer not null check (qty > 0),
  user_id uuid not null references public.profiles (id),
  at      timestamptz not null default now(),
  note    text
);
create index line_events_line_idx on public.line_events (line_id);
create index line_events_user_idx on public.line_events (user_id, at);

create table public.stock_issues (
  id          uuid primary key default gen_random_uuid(),
  type_id     uuid not null references public.equipment_types (id),
  asset_id    uuid references public.asset_register (id),
  qty         integer not null default 1 check (qty > 0),
  issue       text not null check (issue in ('damaged','missing','in_repair')),
  job_id      uuid references public.jobs (id),
  note        text,
  photo_path  text,
  reported_by uuid not null references public.profiles (id),
  reported_at timestamptz not null default now(),
  status      text not null default 'open' check (status in ('open','resolved')),
  resolution  text check (resolution in ('repaired','found','written_off','replaced')),
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz,
  check ((status = 'open' and resolution is null and resolved_at is null)
      or (status = 'resolved' and resolution is not null and resolved_at is not null))
);
create index stock_issues_type_idx   on public.stock_issues (type_id);
create index stock_issues_status_idx on public.stock_issues (status);

-- Insert-only: written by database triggers on every table
create table public.audit_log (
  id         bigint generated always as identity primary key,
  table_name text not null,
  row_id     text,
  action     text not null,
  old_data   jsonb,
  new_data   jsonb,
  user_id    uuid,
  at         timestamptz not null default now()
);
create index audit_log_row_idx  on public.audit_log (table_name, row_id);
create index audit_log_time_idx on public.audit_log (at desc);
