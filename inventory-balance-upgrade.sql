-- Inventory accounting cycle:
-- 1) the balance that exists when this migration is first run becomes opening stock;
-- 2) movements after that opening (or after the previous completed count) produce book stock;
-- 3) each count is compared with book stock, and then becomes the next period's opening.

create table if not exists public.inventory_opening_balances (
  branch_id uuid not null references public.branches(id) on delete cascade,
  material_id uuid not null references public.materials(id),
  quantity numeric not null default 0,
  opened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (branch_id, material_id)
);

alter table public.inventory_opening_balances enable row level security;

drop policy if exists "allowed users read inventory openings" on public.inventory_opening_balances;
create policy "allowed users read inventory openings"
on public.inventory_opening_balances for select to authenticated
using (public.has_branch_access(branch_id) and public.has_page_permission('inventory'));

-- Idempotent seed. Re-running the upgrade never changes an established opening balance.
insert into public.inventory_opening_balances(branch_id, material_id, quantity, opened_at)
select b.id, m.id,
       coalesce(a.quantity, 0) - coalesce(c.quantity, 0),
       now()
from public.branches b
cross join public.materials m
left join (
  select branch_id, material_id, sum(quantity) quantity
  from public.stock_additions group by branch_id, material_id
) a on a.branch_id = b.id and a.material_id = m.id
left join (
  select branch_id, material_id, sum(quantity) quantity
  from public.consumption_records group by branch_id, material_id
) c on c.branch_id = b.id and c.material_id = m.id
where coalesce(a.quantity, 0) <> 0 or coalesce(c.quantity, 0) <> 0
on conflict (branch_id, material_id) do nothing;

create or replace function public.inventory_session_variance(target_session uuid)
returns table (
  material_id uuid,
  opening_quantity numeric,
  additions_quantity numeric,
  consumption_quantity numeric,
  expected_quantity numeric,
  actual_quantity numeric,
  variance_quantity numeric,
  variance_type text,
  period_started_at timestamptz,
  period_ended_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target_branch uuid;
  target_cutoff timestamptz;
  target_inventory_date date;
begin
  if auth.uid() is null or not public.can_access_inventory_session(target_session) then
    raise exception 'غير مسموح بعرض فروق جلسة الجرد';
  end if;

  select s.branch_id, s.created_at, coalesce(s.inventory_date, (s.created_at at time zone 'Africa/Cairo')::date)
  into target_branch, target_cutoff, target_inventory_date
  from public.inventory_sessions s
  where s.id = target_session;

  return query
  with materials_in_scope as (
    select o.material_id
    from public.inventory_opening_balances o
    where o.branch_id = target_branch
    union
    select e.material_id from public.inventory_entries e where e.session_id = target_session
    union
    select e.material_id
    from public.inventory_entries e
    join public.inventory_sessions prior_session on prior_session.id = e.session_id
    where prior_session.branch_id = target_branch
      and prior_session.status = 'completed'
      and prior_session.completed_at < target_cutoff
    union
    select a.material_id from public.stock_additions a where a.branch_id = target_branch and a.date <= target_inventory_date
    union
    select c.material_id from public.consumption_records c where c.branch_id = target_branch and c.date <= target_inventory_date
  ), baseline as (
    select mis.material_id,
           coalesce(prev.actual_quantity, o.quantity, 0)::numeric as opening_quantity,
           coalesce(prev.created_at, o.opened_at, target_cutoff) as started_at,
           coalesce(prev.inventory_date, (o.opened_at at time zone 'Africa/Cairo')::date, target_inventory_date) as started_date
    from materials_in_scope mis
    left join public.inventory_opening_balances o
      on o.branch_id = target_branch and o.material_id = mis.material_id
    left join lateral (
      select sum(e.quantity)::numeric actual_quantity, s.created_at, s.completed_at,
             coalesce(s.inventory_date, (s.created_at at time zone 'Africa/Cairo')::date) inventory_date
      from public.inventory_sessions s
      join public.inventory_entries e on e.session_id = s.id and e.material_id = mis.material_id
      where s.branch_id = target_branch
        and s.status = 'completed'
        and s.completed_at < target_cutoff
      group by s.id, s.created_at, s.completed_at, s.inventory_date
      order by s.completed_at desc
      limit 1
    ) prev on true
  ), totals as (
    select b.*,
      coalesce((select sum(a.quantity) from public.stock_additions a
                where a.branch_id = target_branch and a.material_id = b.material_id
                  and a.date > b.started_date and a.date <= target_inventory_date), 0)::numeric additions,
      coalesce((select sum(c.quantity) from public.consumption_records c
                where c.branch_id = target_branch and c.material_id = b.material_id
                  and c.date > b.started_date and c.date <= target_inventory_date), 0)::numeric consumption,
      coalesce((select sum(e.quantity) from public.inventory_entries e
                where e.session_id = target_session and e.material_id = b.material_id), 0)::numeric actual
    from baseline b
  )
  select t.material_id, t.opening_quantity, t.additions, t.consumption,
         (t.opening_quantity + t.additions - t.consumption)::numeric expected_quantity,
         t.actual,
         (t.actual - (t.opening_quantity + t.additions - t.consumption))::numeric variance_quantity,
         case when t.actual > t.opening_quantity + t.additions - t.consumption then 'surplus'
              when t.actual < t.opening_quantity + t.additions - t.consumption then 'shortage'
              else 'balanced' end,
         t.started_at, target_cutoff
  from totals t;
end;
$$;

grant select on public.inventory_opening_balances to authenticated;
grant execute on function public.inventory_session_variance(uuid) to authenticated;

comment on table public.inventory_opening_balances is
  'Frozen first-period balances. Completed inventory counts supersede these as the next opening balance.';
