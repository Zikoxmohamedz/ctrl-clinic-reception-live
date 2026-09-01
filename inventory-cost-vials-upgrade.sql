-- Material valuation and richer physical inventory details.
alter table public.materials
  add column if not exists cost_price numeric not null default 0
  check (cost_price >= 0);

alter table public.inventory_entries
  add column if not exists closed_vials numeric,
  add column if not exists open_vials numeric;

alter table public.inventory_entries
  drop constraint if exists inventory_entry_vial_counts_nonnegative;
alter table public.inventory_entries
  add constraint inventory_entry_vial_counts_nonnegative check (
    (closed_vials is null or closed_vials >= 0)
    and (open_vials is null or open_vials >= 0)
  );

alter table public.inventory_sessions
  add column if not exists inventory_date date not null default current_date;

-- Requested historical presentation date. Technical timestamps stay intact for ordering/audit.
update public.inventory_sessions
set inventory_date = date '2026-07-31'
where status = 'completed';

update public.inventory_sessions
set inventory_date = (created_at at time zone 'Africa/Cairo')::date
where status = 'active';

comment on column public.materials.cost_price is
  'Cost per inventory unit, used only for stock valuation and never as selling price.';
comment on column public.inventory_entries.closed_vials is 'Physical count of closed vials.';
comment on column public.inventory_entries.open_vials is 'Physical count of open vials.';
