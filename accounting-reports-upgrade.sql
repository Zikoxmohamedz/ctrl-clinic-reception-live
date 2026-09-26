begin;
-- One consistent database snapshot, with no REST row-limit truncation.
create or replace function public.accounting_report_source(target_branch uuid, through_date date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.has_branch_access(target_branch)
     or not public.has_page_permission('reports')
     or not public.has_page_permission('inventory')
     or not public.has_page_permission('inventory_reports') then
    raise exception 'غير مسموح بعرض الأرصدة والجرد لهذا الفرع';
  end if;
  if through_date is null then raise exception 'حدد نهاية الفترة'; end if;
  return jsonb_build_object(
    'openings', (select coalesce(jsonb_agg(to_jsonb(o)), '[]') from public.inventory_opening_balances o where o.branch_id=target_branch),
    'sessions', (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from public.inventory_sessions s where s.branch_id=target_branch and s.inventory_date<=through_date),
    'entries', (select coalesce(jsonb_agg(to_jsonb(e)), '[]') from public.inventory_entries e join public.inventory_sessions s on s.id=e.session_id where s.branch_id=target_branch and s.inventory_date<=through_date),
    'additions', (select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('actor_name',u.full_name)), '[]') from public.stock_additions a left join public.users u on u.id=a.added_by where a.branch_id=target_branch and a.date<=through_date),
    'consumption', (select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('actor_name',u.full_name)), '[]') from public.consumption_records c left join public.users u on u.id=c.created_by where c.branch_id=target_branch and c.date<=through_date)
  );
end $$;
revoke all on function public.accounting_report_source(uuid,date) from public, anon;
grant execute on function public.accounting_report_source(uuid,date) to authenticated;
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
      and prior_session.inventory_date < target_inventory_date
    union
    select a.material_id from public.stock_additions a where a.branch_id = target_branch and a.date <= target_inventory_date
    union
    select c.material_id from public.consumption_records c where c.branch_id = target_branch and c.date <= target_inventory_date
  ), baseline as (
    select mis.material_id,
           coalesce(prev.actual_quantity, o.quantity)::numeric as opening_quantity,
           coalesce(prev.inventory_date::timestamp at time zone 'Africa/Cairo', o.opened_at, target_cutoff) as started_at,
           coalesce(prev.inventory_date, (o.opened_at at time zone 'Africa/Cairo')::date, target_inventory_date) as started_date
    from materials_in_scope mis
    left join public.inventory_opening_balances o
      on o.branch_id = target_branch and o.material_id = mis.material_id
      and (o.opened_at at time zone 'Africa/Cairo')::date <= target_inventory_date
    left join lateral (
      select sum(e.quantity)::numeric actual_quantity, s.created_at, s.completed_at,
             coalesce(s.inventory_date, (s.created_at at time zone 'Africa/Cairo')::date) inventory_date
      from public.inventory_sessions s
      join public.inventory_entries e on e.session_id = s.id and e.material_id = mis.material_id
      where s.branch_id = target_branch
        and s.status = 'completed'
        and s.id <> target_session
        and s.inventory_date < target_inventory_date
      group by s.id, s.created_at, s.completed_at, s.inventory_date
      order by s.inventory_date desc, s.completed_at desc, s.id desc
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
      (select sum(e.quantity) from public.inventory_entries e
                where e.session_id = target_session and e.material_id = b.material_id)::numeric actual
    from baseline b
  )
  select t.material_id, t.opening_quantity, t.additions, t.consumption,
         (t.opening_quantity + t.additions - t.consumption)::numeric expected_quantity,
         t.actual,
         (t.actual - (t.opening_quantity + t.additions - t.consumption))::numeric variance_quantity,
         case when t.actual is null then 'uncounted'
              when t.opening_quantity is null then 'no_baseline'
              when t.actual > t.opening_quantity + t.additions - t.consumption then 'surplus'
              when t.actual < t.opening_quantity + t.additions - t.consumption then 'shortage'
              else 'balanced' end,
         t.started_at, target_cutoff
  from totals t;
end;
$$;


commit;
