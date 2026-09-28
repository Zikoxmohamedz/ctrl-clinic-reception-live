begin;
-- Owner-approved rule: a positive balance omitted from a nonempty completed count is zero.
-- No physical-count entries are invented or overwritten; the omission remains identifiable.
create or replace function public.stock_quantity_internal(b uuid,m uuid,d date,omit uuid default null)
returns numeric language plpgsql volatile security definer set search_path=public as $$
declare q numeric:=null; anchor date; r record;
begin
 select s.inventory_date into anchor from inventory_accounting_baselines a join inventory_sessions s on s.id=a.session_id where a.branch_id=b;
 for r in
  select f.date event_day,-1 priority,''::text ordering,0::numeric qty,'foundation' kind from stock_receipt_foundations f where f.branch_id=b and f.material_id=m and f.date<=d
  union all select a.date,0,a.created_at::text||a.id::text,a.quantity,'movement' from stock_additions a where a.branch_id=b and a.material_id=m and a.date<=d
  union all select c.date,0,c.created_at::text||c.id::text,-c.quantity,'movement' from consumption_records c where c.branch_id=b and c.material_id=m and c.date<=d and (omit is null or c.id<>omit)
  union all select s.inventory_date,2,coalesce(s.completed_at,s.created_at)::text||s.id::text,(select sum(e.quantity) from inventory_entries e where e.session_id=s.id and e.material_id=m),'count' from inventory_sessions s where s.branch_id=b and s.status='completed' and s.inventory_date>=anchor and s.inventory_date<=d and exists(select 1 from inventory_entries e where e.session_id=s.id)
  order by event_day,priority,ordering
 loop
  if r.kind='foundation' then if q is null then q:=0;end if;
  elsif r.kind='count' then if r.qty is not null then q:=r.qty;elsif q>0 then q:=0;end if;
  elsif q is not null then q:=q+r.qty;
  end if;
 end loop;
 return q;
end $$;
revoke all on function public.stock_quantity_internal(uuid,uuid,date,uuid) from public,anon,authenticated;

create or replace function public.inventory_session_variance(target_session uuid)
returns table(material_id uuid,opening_quantity numeric,additions_quantity numeric,consumption_quantity numeric,expected_quantity numeric,actual_quantity numeric,variance_quantity numeric,variance_type text,period_started_at timestamptz,period_ended_at timestamptz)
language plpgsql volatile security definer set search_path=public as $$
declare branch uuid; ending date; anchor date; prior_date date; apply_missing boolean;
begin
 if auth.uid() is null or not can_access_inventory_session(target_session) then raise exception 'غير مسموح بعرض فروق جلسة الجرد';end if;
 select s.branch_id,s.inventory_date,s.status='completed' and exists(select 1 from inventory_entries e where e.session_id=s.id) into branch,ending,apply_missing from inventory_sessions s where s.id=target_session;
 select s.inventory_date into anchor from inventory_accounting_baselines b join inventory_sessions s on s.id=b.session_id where b.branch_id=branch;
 select max(s.inventory_date) into prior_date from inventory_sessions s where s.branch_id=branch and s.status='completed' and s.inventory_date>=anchor and s.inventory_date<ending and exists(select 1 from inventory_entries e where e.session_id=s.id);
 return query with scope as (
  select e.material_id from inventory_entries e join inventory_sessions s on s.id=e.session_id where s.branch_id=branch and s.inventory_date<=ending
  union select a.material_id from stock_additions a where a.branch_id=branch and a.date<=ending
  union select c.material_id from consumption_records c where c.branch_id=branch and c.date<=ending
 ), starts as (
  select m.material_id,coalesce(prior_date,f.date-1) start_date,f.date receipt_date from scope m left join stock_receipt_foundations f on f.branch_id=branch and f.material_id=m.material_id and f.date<=ending
 ), totals as (
  select s.*,case when s.start_date is null then null when s.start_date=s.receipt_date-1 then 0 else stock_quantity_internal(branch,s.material_id,s.start_date) end opening,
   coalesce((select sum(a.quantity) from stock_additions a where a.branch_id=branch and a.material_id=s.material_id and a.date>s.start_date and a.date<=ending),0) added,
   coalesce((select sum(c.quantity) from consumption_records c where c.branch_id=branch and c.material_id=s.material_id and c.date>s.start_date and c.date<=ending),0) consumed,
   (select sum(e.quantity) from inventory_entries e where e.session_id=target_session and e.material_id=s.material_id) observed from starts s
 ), expected as(select t.*,t.opening+t.added-t.consumed predicted from totals t), result as (
  select t.*,case when t.observed is null and apply_missing and t.predicted>0 then 0 else t.observed end actual from expected t
 ) select t.material_id,t.opening,t.added,t.consumed,t.predicted,t.actual,t.actual-t.predicted,
 case when t.observed is null and t.actual=0 then 'shortage_unlisted' when t.actual is null then 'uncounted' when t.predicted is null then 'no_baseline' when t.actual<t.predicted then 'shortage' when t.actual>t.predicted then 'surplus' else 'balanced' end,
 t.start_date::timestamp at time zone 'Africa/Cairo',ending::timestamp at time zone 'Africa/Cairo' from result t;
end $$;
-- Publish the rule with report data, avoiding a silent semantic change for cached clients.
do $$declare definition text;begin
 select pg_get_functiondef('public.accounting_report_source(uuid,date)'::regprocedure) into definition;
 if position('missing_count_policy' in definition)=0 then definition:=replace(definition,'''openings'',''[]''::jsonb','''missing_count_policy'',''shortage'',''openings'',''[]''::jsonb');execute definition;end if;
end $$;
do $$declare definition text; name text;begin
 foreach name in array array['guard_stock_issue','guard_stock_receipt'] loop
  select pg_get_functiondef(('public.'||name||'()')::regprocedure) into definition;
  definition:=replace(definition,'s.branch_id=new.branch_id and e.material_id=new.material_id','s.branch_id=new.branch_id');
  execute definition;
 end loop;
 select pg_get_functiondef('public.stock_cost_internal(uuid,uuid)'::regprocedure) into definition;
 definition:=replace(definition,'join inventory_entries e on e.session_id=s.id where s.branch_id=b and e.material_id=m','left join inventory_entries e on e.session_id=s.id and e.material_id=m where s.branch_id=b and exists(select 1 from inventory_entries all_entries where all_entries.session_id=s.id)');
 definition:=replace(definition,'if r.counted is not null then q:=r.counted;value:=q*avg_cost;','if r.priority=2 then q:=coalesce(r.counted,case when q>0 then 0 else q end);value:=q*avg_cost;');
 execute definition;
end $$;
commit;
