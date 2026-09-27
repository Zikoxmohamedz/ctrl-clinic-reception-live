begin;
-- Explicitly approved accounting cycle: July 31, or the closest nonempty completed count.
create table if not exists public.inventory_accounting_baselines (
 branch_id uuid primary key references public.branches(id),
 session_id uuid references public.inventory_sessions(id) on delete restrict,
 reference_date date not null default date '2026-07-31',
 selected_at timestamptz not null default now()
);
alter table public.inventory_accounting_baselines enable row level security;
revoke all on public.inventory_accounting_baselines from anon,authenticated;
insert into public.inventory_accounting_baselines(branch_id,session_id)
select b.id,chosen.id from public.branches b left join lateral (
 select s.id from public.inventory_sessions s
 where s.branch_id=b.id and s.status='completed'
 and exists(select 1 from public.inventory_entries e where e.session_id=s.id)
 order by abs(s.inventory_date-date '2026-07-31'),s.inventory_date,s.completed_at desc,s.id desc limit 1
) chosen on true on conflict(branch_id) do nothing;

create or replace function public.accounting_report_source(target_branch uuid, through_date date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if auth.uid() is null or not public.has_branch_access(target_branch)
 or not public.has_page_permission('reports') or not public.has_page_permission('inventory')
 or not public.has_page_permission('inventory_reports') then raise exception 'غير مسموح بعرض الأرصدة والجرد لهذا الفرع'; end if;
 if through_date is null then raise exception 'حدد نهاية الفترة'; end if;
 return jsonb_build_object(
 'baseline',(select jsonb_build_object('session_id',b.session_id,'date',s.inventory_date,'reference_date',b.reference_date) from public.inventory_accounting_baselines b left join public.inventory_sessions s on s.id=b.session_id where b.branch_id=target_branch),
 'openings','[]'::jsonb,
 'sessions',(select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.inventory_sessions s where s.branch_id=target_branch and s.inventory_date<=through_date),
 'entries',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from public.inventory_entries e join public.inventory_sessions s on s.id=e.session_id where s.branch_id=target_branch and s.inventory_date<=through_date),
 'additions',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('actor_name',u.full_name)),'[]') from public.stock_additions a left join public.users u on u.id=a.added_by where a.branch_id=target_branch and a.date<=through_date),
 'consumption',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('actor_name',u.full_name)),'[]') from public.consumption_records c left join public.users u on u.id=c.created_by where c.branch_id=target_branch and c.date<=through_date)
 );
end $$;

create or replace function public.inventory_session_variance(target_session uuid)
returns table(material_id uuid,opening_quantity numeric,additions_quantity numeric,consumption_quantity numeric,expected_quantity numeric,actual_quantity numeric,variance_quantity numeric,variance_type text,period_started_at timestamptz,period_ended_at timestamptz)
language plpgsql stable security definer set search_path=public as $$
declare branch uuid; ending date; anchor date;
begin
 if auth.uid() is null or not public.can_access_inventory_session(target_session) then raise exception 'غير مسموح بعرض فروق جلسة الجرد'; end if;
 select s.branch_id,s.inventory_date into branch,ending from public.inventory_sessions s where s.id=target_session;
 select s.inventory_date into anchor from public.inventory_accounting_baselines b join public.inventory_sessions s on s.id=b.session_id where b.branch_id=branch;
 return query
 with scope as (
 select e.material_id from public.inventory_entries e join public.inventory_sessions s on s.id=e.session_id where s.branch_id=branch and s.inventory_date<=ending
 union select a.material_id from public.stock_additions a where a.branch_id=branch and a.date<=ending
 union select c.material_id from public.consumption_records c where c.branch_id=branch and c.date<=ending
 ), starting as (
 select m.material_id,p.actual opening,p.inventory_date start_date from scope m left join lateral (
 select sum(e.quantity) actual,s.inventory_date from public.inventory_sessions s join public.inventory_entries e on e.session_id=s.id
 where s.branch_id=branch and s.status='completed' and s.inventory_date>=anchor and s.inventory_date<ending and e.material_id=m.material_id
 group by s.id order by s.inventory_date desc,s.completed_at desc,s.id desc limit 1
 )p on true
 ), totals as (
 select b.*,coalesce((select sum(a.quantity) from public.stock_additions a where a.branch_id=branch and a.material_id=b.material_id and a.date>b.start_date and a.date<=ending),0) added,
 coalesce((select sum(c.quantity) from public.consumption_records c where c.branch_id=branch and c.material_id=b.material_id and c.date>b.start_date and c.date<=ending),0) consumed,
 (select sum(e.quantity) from public.inventory_entries e where e.session_id=target_session and e.material_id=b.material_id) actual from starting b
 ) select t.material_id,t.opening,t.added,t.consumed,t.opening+t.added-t.consumed,t.actual,t.actual-(t.opening+t.added-t.consumed),
 case when t.actual is null then 'uncounted' when t.opening is null then 'no_baseline' when t.actual<t.opening+t.added-t.consumed then 'shortage' when t.actual>t.opening+t.added-t.consumed then 'surplus' else 'balanced' end,
 t.start_date::timestamp at time zone 'Africa/Cairo',ending::timestamp at time zone 'Africa/Cairo' from totals t;
end $$;
create or replace function public.list_inventory_sessions(target_branch uuid,max_rows integer default 50)
returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.has_branch_access(target_branch) or not public.has_page_permission('inventory') or not public.has_page_permission('inventory_reports') then raise exception 'غير مسموح بعرض تقارير جرد هذا الفرع'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(r) order by r.inventory_date desc,r.created_at desc),'[]') from (
 select s.id,s.status,s.inventory_date,s.created_at,s.completed_at,u.full_name created_by_name,
 (select count(*) from public.inventory_participants p where p.session_id=s.id) participant_count,
 (select count(distinct e.material_id) from public.inventory_entries e where e.session_id=s.id) material_count,
 (select coalesce(sum(e.quantity),0) from public.inventory_entries e where e.session_id=s.id) total_quantity
 from public.inventory_sessions s join public.users u on u.id=s.created_by where s.branch_id=target_branch
 order by s.inventory_date desc,s.created_at desc limit greatest(1,least(coalesce(max_rows,50),200))
 ) r);
end $$;
create or replace function public.establish_first_inventory_baseline() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.status='completed' and exists(select 1 from public.inventory_entries e where e.session_id=new.id) then
 insert into public.inventory_accounting_baselines(branch_id,session_id) values(new.branch_id,new.id)
 on conflict(branch_id) do update set session_id=excluded.session_id,selected_at=now() where inventory_accounting_baselines.session_id is null;
 end if;
 return new;
end $$;
drop trigger if exists establish_first_inventory_baseline on public.inventory_sessions;
create trigger establish_first_inventory_baseline after insert or update of status on public.inventory_sessions for each row execute function public.establish_first_inventory_baseline();
commit;
