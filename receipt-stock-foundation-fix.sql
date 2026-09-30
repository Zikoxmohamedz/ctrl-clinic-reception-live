-- Apply after procurement-upgrade.sql and missing-count-shortage-upgrade.sql.
begin;
-- Receipt-backed balances include all recorded outgoings in the accounting cycle.
-- This does not assert an unrecorded physical opening or overwrite later counts.
create or replace function public.ensure_receipt_foundation(b uuid,m uuid)
returns void language plpgsql security definer set search_path=public as $$
declare anchor date; first_receipt date; first_issue date; first_count date; foundation_date date;
begin
 perform pg_advisory_xact_lock(hashtextextended(b::text||m::text,0));
 select s.inventory_date into anchor from inventory_accounting_baselines a join inventory_sessions s on s.id=a.session_id where a.branch_id=b;
 select min(a.date) into first_receipt from stock_additions a where a.branch_id=b and a.material_id=m and (anchor is null or a.date>anchor);
 if first_receipt is null then return; end if;
 select min(s.inventory_date) into first_count from inventory_sessions s join inventory_entries e on e.session_id=s.id where s.branch_id=b and e.material_id=m and s.status='completed' and (anchor is null or s.inventory_date>=anchor);
 if first_count<=first_receipt then return; end if;
 select min(c.date) into first_issue from consumption_records c where c.branch_id=b and c.material_id=m and (anchor is null or c.date>anchor);
 foundation_date:=least(first_receipt,first_issue);
 insert into stock_receipt_foundations(branch_id,material_id,date) values(b,m,foundation_date)
 on conflict(branch_id,material_id) do update set date=least(stock_receipt_foundations.date,excluded.date);
end $$;
revoke all on function public.ensure_receipt_foundation(uuid,uuid) from public,anon,authenticated;

create or replace function public.establish_receipt_stock()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform ensure_receipt_foundation(new.branch_id,new.material_id);
 return new;
end $$;
drop trigger if exists establish_receipt_stock on stock_additions;
create trigger establish_receipt_stock after insert on stock_additions for each row execute function establish_receipt_stock();

-- Keep future receipts from retroactively making past unknown balances available.
do $$declare definition text;begin
 select pg_get_functiondef('public.stock_quantity_internal(uuid,uuid,date,uuid)'::regprocedure) into definition;
 if position('receipt_foundation_available' in definition)=0 then
  definition:=replace(definition,'f.date<=d','f.date<=d and exists(select 1 from stock_additions receipt_foundation_available where receipt_foundation_available.branch_id=b and receipt_foundation_available.material_id=m and receipt_foundation_available.date<=d)');
  execute definition;
 end if;
 select pg_get_functiondef('public.accounting_report_source(uuid,date)'::regprocedure) into definition;
 if position('receipt_foundation_available' in definition)=0 then
  definition:=replace(definition,'f.date<=through_date','f.date<=through_date and exists(select 1 from stock_additions receipt_foundation_available where receipt_foundation_available.branch_id=target_branch and receipt_foundation_available.material_id=f.material_id and receipt_foundation_available.date<=through_date)');
  execute definition;
 end if;
 select pg_get_functiondef('public.inventory_session_variance(uuid)'::regprocedure) into definition;
 definition:=replace(definition,'coalesce(prior_date,f.date-1) start_date','case when prior_date is not null and stock_quantity_internal(branch,m.material_id,prior_date) is not null then prior_date else f.date-1 end start_date');
 execute definition;
end $$;

-- Private recovery snapshot before repairing only derived foundation metadata.
insert into inventory_recovery.operations(operation,payload)
select 'receipt-foundations-20260930',jsonb_build_object('foundations',(select coalesce(jsonb_agg(to_jsonb(f)),'[]') from stock_receipt_foundations f))
where not exists(select 1 from inventory_recovery.operations where operation='receipt-foundations-20260930');
do $$declare r record;begin
 for r in select distinct branch_id,material_id from stock_additions order by branch_id,material_id loop
  perform ensure_receipt_foundation(r.branch_id,r.material_id);
 end loop;
end $$;
commit;
