-- 0002 Equipment database: departments, categories, equipment types, kit contents,
-- asset register and the stock ledger.

create table public.departments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  sort        integer not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

create table public.categories (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id),
  name          text not null,
  sort          integer not null default 0,   -- doubles as aisle order on warehouse checklists
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (department_id, name)
);

create table public.equipment_types (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  category_id    uuid references public.categories (id),
  tags           text[] not null default '{}',
  kind           text not null default 'stock' check (kind in ('stock','consumable','kit')),
  owned_qty      integer not null default 0 check (owned_qty >= 0),
  can_sub_hire   boolean not null default true,
  active         boolean not null default true,
  accessory_only boolean not null default false,
  barcode        text,
  description    text,
  weight_kg      numeric(8,2),
  image_path     text,
  currentrms_id  bigint unique,
  notes          text,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  constraint kit_holds_no_stock check (kind <> 'kit' or owned_qty = 0)
);
create index equipment_types_category_idx on public.equipment_types (category_id);
create index equipment_types_tags_idx     on public.equipment_types using gin (tags);

create table public.type_accessories (
  id             uuid primary key default gen_random_uuid(),
  parent_type_id uuid not null references public.equipment_types (id),
  child_type_id  uuid not null references public.equipment_types (id),
  inclusion      text not null default 'optional' check (inclusion in ('mandatory','default','optional')),
  qty_per_parent integer not null default 1 check (qty_per_parent > 0),
  sort           integer not null default 0,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  check (parent_type_id <> child_type_id),
  unique (parent_type_id, child_type_id)
);
create index type_accessories_child_idx on public.type_accessories (child_type_id);

create table public.asset_register (
  id          uuid primary key default gen_random_uuid(),
  type_id     uuid not null references public.equipment_types (id),
  asset_no    text not null unique,
  serial_no   text,
  status      text not null default 'in_service'
                check (status in ('in_service','damaged','missing','in_repair','retired')),
  notes       text,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);
create index asset_register_type_idx on public.asset_register (type_id);

-- Insert-only ledger behind equipment_types.owned_qty
create table public.stock_adjustments (
  id         uuid primary key default gen_random_uuid(),
  type_id    uuid not null references public.equipment_types (id),
  delta      integer not null check (delta <> 0),
  reason     text not null check (reason in ('import','purchase','disposal','write-off','correction')),
  note       text,
  user_id    uuid references public.profiles (id),
  at         timestamptz not null default now()
);
create index stock_adjustments_type_idx on public.stock_adjustments (type_id);
