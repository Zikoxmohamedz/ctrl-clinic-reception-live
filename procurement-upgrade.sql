begin;
create table if not exists public.suppliers (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name))>0),
 phone text not null default '', address text not null default '', notes text not null default '',
 created_at timestamptz not null default now()
);
create table if not exists public.supplier_materials (
 supplier_id uuid references public.suppliers(id) on delete cascade,
 material_id uuid references public.materials(id) on delete restrict,
 unit_cost numeric check(unit_cost>=0), primary key(supplier_id,material_id)
);
alter table public.suppliers enable row level security;
alter table public.supplier_materials enable row level security;
drop policy if exists suppliers_read on public.suppliers;
create policy suppliers_read on public.suppliers for select to authenticated using(true);
drop policy if exists suppliers_manage on public.suppliers;
create policy suppliers_manage on public.suppliers for all to authenticated using(public.has_page_permission('settings')) with check(public.has_page_permission('settings'));
drop policy if exists supplier_materials_read on public.supplier_materials;
create policy supplier_materials_read on public.supplier_materials for select to authenticated using(true);
drop policy if exists supplier_materials_manage on public.supplier_materials;
create policy supplier_materials_manage on public.supplier_materials for all to authenticated using(public.has_page_permission('settings')) with check(public.has_page_permission('settings'));
grant select,insert,update,delete on public.suppliers,public.supplier_materials to authenticated;
alter table public.stock_additions add column if not exists source_kind text check(source_kind in('supplier','branch'));
alter table public.stock_additions add column if not exists supplier_id uuid references public.suppliers(id);
alter table public.stock_additions add column if not exists source_branch_id uuid references public.branches(id);
alter table public.stock_additions add column if not exists transfer_record_id uuid references public.consumption_records(id);
alter table public.stock_additions add column if not exists unit_cost numeric check(unit_cost>=0);
create unique index if not exists additions_transfer_once on public.stock_additions(transfer_record_id) where transfer_record_id is not null;
alter table public.consumption_records add column if not exists unit_cost numeric check(unit_cost>=0);
alter table public.consumption_records add column if not exists cost_basis text;
create table if not exists public.stock_receipt_foundations (
 branch_id uuid references public.branches(id),material_id uuid references public.materials(id),date date not null,
 primary key(branch_id,material_id)
);
create table if not exists public.stock_cost_openings (
 branch_id uuid references public.branches(id),material_id uuid references public.materials(id),
 quantity numeric not null,unit_cost numeric not null check(unit_cost>=0),effective_at timestamptz not null default now(),
 primary key(branch_id,material_id)
);
alter table public.stock_receipt_foundations enable row level security;
alter table public.stock_cost_openings enable row level security;
revoke all on public.stock_receipt_foundations,public.stock_cost_openings from anon,authenticated;

-- Private calculation: count at end of day, followed by movements on later days.
create or replace function public.stock_quantity_internal(b uuid,m uuid,d date,omit uuid default null)
returns numeric language plpgsql volatile security definer set search_path=public as $$
declare q numeric; start_date date; anchor date;
begin
 select s.inventory_date into anchor from inventory_accounting_baselines a join inventory_sessions s on s.id=a.session_id where a.branch_id=b;
 select s.inventory_date,sum(e.quantity) into start_date,q from inventory_sessions s join inventory_entries e on e.session_id=s.id
 where s.branch_id=b and e.material_id=m and s.status='completed' and s.inventory_date>=anchor and s.inventory_date<=d
 group by s.id order by s.inventory_date desc,s.completed_at desc,s.id desc limit 1;
 if start_date is null then
  select f.date-1,0 into start_date,q from stock_receipt_foundations f where f.branch_id=b and f.material_id=m and f.date<=d;
 end if;
 if start_date is null then return null; end if;
 return q+coalesce((select sum(quantity) from stock_additions where branch_id=b and material_id=m and date>start_date and date<=d),0)
 -coalesce((select sum(quantity) from consumption_records where branch_id=b and material_id=m and date>start_date and date<=d and (omit is null or id<>omit)),0);
end $$;
revoke all on function public.stock_quantity_internal(uuid,uuid,date,uuid) from public,anon,authenticated;

create or replace function public.available_stock(target_branch uuid,target_material uuid,at_date date)
returns numeric language plpgsql volatile security definer set search_path=public as $$
begin
 if auth.uid() is null or not has_branch_access(target_branch) or not (has_page_permission('consumption') or has_page_permission('additions') or has_page_permission('reports')) then raise exception 'غير مسموح'; end if;
 return stock_quantity_internal(target_branch,target_material,least(at_date,(now() at time zone 'Africa/Cairo')::date));
end $$;
grant execute on function public.available_stock(uuid,uuid,date) to authenticated;

-- Cost starts from an explicit current-stock valuation, never rewrites old sales.
create or replace function public.stock_cost_internal(b uuid,m uuid)
returns numeric language plpgsql volatile security definer set search_path=public as $$
declare base stock_cost_openings; r record; q numeric; value numeric; avg_cost numeric;
begin
 select * into base from stock_cost_openings where branch_id=b and material_id=m;
 if not found then return null; end if;
 q:=base.quantity; value:=q*base.unit_cost;avg_cost:=base.unit_cost;
 for r in
  select a.created_at ts,0 priority,a.id,a.quantity delta,a.unit_cost price,null::numeric counted from stock_additions a where a.branch_id=b and a.material_id=m and a.created_at>base.effective_at
  union all select c.created_at,1,c.id,-c.quantity,c.unit_cost,null from consumption_records c where c.branch_id=b and c.material_id=m and c.created_at>base.effective_at
  union all select s.completed_at,2,s.id,0,null,sum(e.quantity) from inventory_sessions s join inventory_entries e on e.session_id=s.id where s.branch_id=b and e.material_id=m and s.status='completed' and s.completed_at>base.effective_at and s.inventory_date>=(base.effective_at at time zone 'Africa/Cairo')::date group by s.id
  order by ts,priority,id
 loop
  if r.counted is not null then q:=r.counted;value:=q*avg_cost;
  elsif r.delta>0 then
   if q=0 then value:=r.delta*r.price; else value:=value+r.delta*r.price; end if;
   q:=q+r.delta;avg_cost:=case when q>0 then value/q else avg_cost end;
  else q:=q+r.delta;value:=q*avg_cost;
  end if;
 end loop;
 return case when q<0 then null else avg_cost end;
end $$;
revoke all on function public.stock_cost_internal(uuid,uuid) from public,anon,authenticated;

create or replace function public.seed_current_cost(m uuid,price numeric)
returns void language plpgsql security definer set search_path=public as $$
declare b record; q numeric;
begin
 for b in select id from branches order by id loop
  perform pg_advisory_xact_lock(hashtextextended(b.id::text||m::text,0));
  q:=stock_quantity_internal(b.id,m,(now() at time zone 'Africa/Cairo')::date);
  if q>=0 then insert into stock_cost_openings(branch_id,material_id,quantity,unit_cost) values(b.id,m,q,price) on conflict do nothing; end if;
 end loop;
end $$;
revoke all on function public.seed_current_cost(uuid,numeric) from public,anon,authenticated;

create or replace function public.guard_stock_issue()
returns trigger language plpgsql security definer set search_path=public as $$
declare available numeric; ending date; check_date date; last_count date; omit uuid; today_date date:=(now() at time zone 'Africa/Cairo')::date;
begin
 if TG_OP='UPDATE' and (new.branch_id,new.material_id,new.date,new.quantity,new.unit,new.record_type,new.transfer_to) is not distinct from (old.branch_id,old.material_id,old.date,old.quantity,old.unit,old.record_type,old.transfer_to) then
  new.unit_cost:=old.unit_cost;new.cost_basis:=old.cost_basis;return new;
 end if;
 if TG_OP='UPDATE' then raise exception 'لتعديل كمية أو صنف صرف: احذف الحركة وأعد تسجيلها بعد مراجعة الرصيد'; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.branch_id::text||new.material_id::text,0));
 new.created_at:=clock_timestamp();
 if new.quantity::text in('NaN','Infinity','-Infinity') or new.quantity<=0 then raise exception 'كمية غير صالحة'; end if;
 if new.date>today_date then raise exception 'لا يمكن صرف مخزون بتاريخ مستقبلي'; end if;
 if new.unit is distinct from (select unit from materials where id=new.material_id) then raise exception 'وحدة الصرف لا تطابق وحدة الصنف'; end if;
 select max(s.inventory_date) into last_count from inventory_sessions s join inventory_entries e on e.session_id=s.id where s.branch_id=new.branch_id and e.material_id=new.material_id and s.status='completed';
 if new.date<=last_count then raise exception 'هذا التاريخ مقفل بجرد فعلي؛ سجّل الصرف بعد تاريخ آخر جرد %',last_count; end if;
 if exists(select 1 from stock_cost_openings o where o.branch_id=new.branch_id and o.material_id=new.material_id and new.date<(o.effective_at at time zone 'Africa/Cairo')::date) then raise exception 'التاريخ يسبق افتتاح التكلفة؛ راجع المحاسب'; end if;
 for check_date in select new.date union select date from consumption_records where branch_id=new.branch_id and material_id=new.material_id and date>=new.date and date<=today_date union select today_date loop
  available:=stock_quantity_internal(new.branch_id,new.material_id,check_date);
  if available is null then raise exception 'لا يوجد رصيد موثق لهذا الصنف؛ يلزم جرد أو أول استلام موثق'; end if;
  if available<new.quantity then raise exception 'الكمية غير متاحة. الرصيد المتاح % والمطلوب %',available,new.quantity; end if;
 end loop;
 new.unit_cost:=stock_cost_internal(new.branch_id,new.material_id);
 new.cost_basis:=case when new.unit_cost is null then 'unknown' else 'weighted_opening_valuation' end;
 return new;
end $$;
drop trigger if exists enforce_available_stock on public.consumption_records;
create trigger enforce_available_stock before insert or update on public.consumption_records for each row execute function public.guard_stock_issue();

create or replace function public.guard_stock_receipt()
returns trigger language plpgsql security definer set search_path=public as $$
declare tr consumption_records; prior numeric; last_count date; today_date date:=(now() at time zone 'Africa/Cairo')::date;
begin
 if TG_OP='DELETE' then
  if old.source_kind is not null then raise exception 'إذن مسعر لا يحذف؛ يلزم مستند تصحيح محاسبي'; end if;
  perform pg_advisory_xact_lock(hashtextextended(old.branch_id::text||old.material_id::text,0));
  select max(s.inventory_date) into last_count from inventory_sessions s join inventory_entries e on e.session_id=s.id where s.branch_id=old.branch_id and e.material_id=old.material_id and s.status='completed';
  if last_count is null or old.date>last_count then
   prior:=stock_quantity_internal(old.branch_id,old.material_id,today_date);
   if prior-old.quantity<0 then raise exception 'حذف الوارد سيجعل الرصيد سالبًا؛ راجع الحركات المرتبطة'; end if;
  end if;return old;
 end if;
 if TG_OP='UPDATE' then
  if (new.branch_id,new.material_id,new.quantity,new.date,new.source_kind,new.supplier_id,new.source_branch_id,new.transfer_record_id,new.unit_cost) is distinct from (old.branch_id,old.material_id,old.quantity,old.date,old.source_kind,old.supplier_id,old.source_branch_id,old.transfer_record_id,old.unit_cost) then raise exception 'لا تعدل كمية أو تكلفة إذن محفوظ؛ راجع المحاسب لتصحيح موثق'; end if;
  return new;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(new.branch_id::text||new.material_id::text,0));
 new.created_at:=clock_timestamp();
 if new.quantity::text in('NaN','Infinity','-Infinity') or new.quantity<=0 or new.unit_cost::text in('NaN','Infinity','-Infinity') then raise exception 'كمية أو تكلفة غير صالحة'; end if;
 if new.source_kind is null then raise exception 'حدد مصدر الإضافة: مورد أو فرع'; end if;
 if new.date>today_date then raise exception 'لا يمكن استلام مخزون بتاريخ مستقبلي'; end if;
 select max(s.inventory_date) into last_count from inventory_sessions s join inventory_entries e on e.session_id=s.id where s.branch_id=new.branch_id and e.material_id=new.material_id and s.status='completed';
 if new.date<=last_count then raise exception 'التاريخ مقفل بجرد؛ الاستلام يجب أن يكون بعد %',last_count; end if;
 if exists(select 1 from stock_cost_openings o where o.branch_id=new.branch_id and o.material_id=new.material_id and new.date<(o.effective_at at time zone 'Africa/Cairo')::date) then raise exception 'تاريخ الإضافة يسبق افتتاح التكلفة'; end if;
 if new.source_kind='supplier' then
  if new.supplier_id is null or new.source_branch_id is not null or new.transfer_record_id is not null then raise exception 'بيانات المورد غير صحيحة'; end if;
  if not exists(select 1 from supplier_materials where supplier_id=new.supplier_id and material_id=new.material_id) then raise exception 'الصنف غير مرتبط بالمورد المختار'; end if;
  if new.unit_cost is null then raise exception 'أدخل تكلفة وحدة المخزون'; end if;
 else
  select * into tr from consumption_records where id=new.transfer_record_id for update;
  if not found or tr.record_type<>'transfer' or tr.transfer_to<>new.branch_id or tr.branch_id is distinct from new.source_branch_id or tr.material_id<>new.material_id or tr.quantity<>new.quantity or new.supplier_id is not null or tr.date>new.date then raise exception 'الاستلام يجب أن يطابق تحويلًا صادرًا للفرع: الصنف والكمية والتاريخ'; end if;
  new.unit_cost:=tr.unit_cost;
 end if;
 prior:=stock_quantity_internal(new.branch_id,new.material_id,new.date);
 if prior is null and not exists(select 1 from stock_additions where branch_id=new.branch_id and material_id=new.material_id) and not exists(select 1 from consumption_records where branch_id=new.branch_id and material_id=new.material_id) and not exists(select 1 from inventory_entries e join inventory_sessions s on s.id=e.session_id where s.branch_id=new.branch_id and e.material_id=new.material_id) then
  insert into stock_receipt_foundations values(new.branch_id,new.material_id,new.date) on conflict do nothing;prior:=0;
 end if;
 if prior=0 and new.unit_cost is not null then insert into stock_cost_openings(branch_id,material_id,quantity,unit_cost,effective_at) values(new.branch_id,new.material_id,0,new.unit_cost,new.created_at-interval '1 microsecond') on conflict do nothing; end if;
 return new;
end $$;
drop trigger if exists validate_receipt_source on public.stock_additions;
create trigger validate_receipt_source before insert or update or delete on public.stock_additions for each row execute function public.guard_stock_receipt();

create or replace function public.guard_linked_issue_delete()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if old.cost_basis is not null then raise exception 'حركة صرف محكومة بالمخزون والتكلفة؛ يلزم مستند تصحيح بدل الحذف'; end if;return old;
end $$;
drop trigger if exists preserve_costed_issue on consumption_records;
create trigger preserve_costed_issue before delete on consumption_records for each row execute function guard_linked_issue_delete();

create or replace function public.pending_stock_transfers(target_branch uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 if auth.uid() is null or not has_branch_access(target_branch) or not has_page_permission('additions') then raise exception 'غير مسموح'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('material_name',m.name,'material_code',m.code,'source_name',b.name)),'[]') from consumption_records c join materials m on m.id=c.material_id join branches b on b.id=c.branch_id where c.record_type='transfer' and c.transfer_to=target_branch and not exists(select 1 from stock_additions a where a.transfer_record_id=c.id));
end $$;
grant execute on function public.pending_stock_transfers(uuid) to authenticated;

create or replace function public.import_material_prices(rows jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare r jsonb; mid uuid; current_unit text; price numeric; count_rows integer:=0;
begin
 if auth.uid() is null or not has_page_permission('settings') then raise exception 'غير مسموح'; end if;
 if jsonb_typeof(rows)<>'array' or jsonb_array_length(rows)>5000 then raise exception 'ملف غير صالح أو أكثر من 5000 سطر'; end if;
 if exists(select 1 from jsonb_array_elements(rows) x group by upper(trim(x->>'code')) having count(*)>1) then raise exception 'كود مكرر داخل الملف'; end if;
 for r in select value from jsonb_array_elements(rows) order by value->>'code' loop
  if nullif(trim(r->>'code'),'') is null or nullif(trim(r->>'name'),'') is null or nullif(trim(r->>'unit'),'') is null or nullif(r->>'cost_price','') is null then raise exception 'الكود والاسم والوحدة والتكلفة مطلوبة'; end if;
  price:=(r->>'cost_price')::numeric;if price<0 or price::text in('NaN','Infinity','-Infinity') then raise exception 'تكلفة غير صالحة'; end if;
  select id,unit into mid,current_unit from materials where upper(code)=upper(trim(r->>'code'));
  if found then
   if current_unit<>trim(r->>'unit') then raise exception 'وحدة الصنف % تختلف؛ لا يمكن تغيير الوحدة باستيراد الأسعار',r->>'code'; end if;
   update materials set cost_price=price where id=mid;
  else
   if exists(select 1 from materials where lower(trim(name))=lower(trim(r->>'name')) and lower(trim(unit))=lower(trim(r->>'unit')) and archived_at is null) then raise exception 'اسم ووحدة موجودان بكود آخر: %',r->>'name'; end if;
   insert into materials(name,code,unit,category,cost_price,default_price,is_temp,created_by) values(trim(r->>'name'),upper(trim(r->>'code')),trim(r->>'unit'),coalesce(r->>'category',''),price,0,false,auth.uid()) returning id into mid;
  end if;
  perform seed_current_cost(mid,price);count_rows:=count_rows+1;
 end loop;
 return count_rows;
end $$;
grant execute on function public.import_material_prices(jsonb) to authenticated;
create or replace function public.supplier_catalog()
returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 if auth.uid() is null then raise exception 'غير مسموح'; end if;
 return jsonb_build_object('suppliers',(select coalesce(jsonb_agg(to_jsonb(s) order by s.name),'[]') from suppliers s),'links',(select coalesce(jsonb_agg(to_jsonb(l)),'[]') from supplier_materials l));
end $$;
create or replace function public.save_supplier(supplier_data jsonb,items jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare sid uuid; r jsonb;
begin
 if auth.uid() is null or not has_page_permission('settings') then raise exception 'غير مسموح'; end if;
 sid:=nullif(supplier_data->>'id','')::uuid;
 if sid is null then
  insert into suppliers(name,phone,address,notes) values(trim(supplier_data->>'name'),coalesce(supplier_data->>'phone',''),coalesce(supplier_data->>'address',''),coalesce(supplier_data->>'notes','')) returning id into sid;
 else
  update suppliers set name=trim(supplier_data->>'name'),phone=coalesce(supplier_data->>'phone',''),address=coalesce(supplier_data->>'address',''),notes=coalesce(supplier_data->>'notes','') where id=sid;
  if not found then raise exception 'المورد غير موجود'; end if;
 end if;
 delete from supplier_materials where supplier_id=sid;
 for r in select value from jsonb_array_elements(items) loop
  insert into supplier_materials values(sid,(r->>'material_id')::uuid,nullif(r->>'unit_cost','')::numeric);
 end loop;
 return sid;
end $$;
grant execute on function public.supplier_catalog(),public.save_supplier(jsonb,jsonb) to authenticated;

create or replace function public.capture_material_cost_opening()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.cost_price is not null and (TG_OP='INSERT' or new.cost_price is distinct from old.cost_price) then perform seed_current_cost(new.id,new.cost_price); end if;
 return new;
end $$;
drop trigger if exists material_cost_opening on materials;
create trigger material_cost_opening after insert or update of cost_price on materials for each row execute function capture_material_cost_opening();

create or replace function public.accounting_report_source(target_branch uuid, through_date date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if auth.uid() is null or not has_branch_access(target_branch) or not has_page_permission('reports') or not has_page_permission('inventory') or not has_page_permission('inventory_reports') then raise exception 'غير مسموح بعرض الأرصدة والجرد لهذا الفرع'; end if;
 if through_date is null then raise exception 'حدد نهاية الفترة'; end if;
 return jsonb_build_object(
 'baseline',(select jsonb_build_object('session_id',b.session_id,'date',s.inventory_date,'reference_date',b.reference_date) from inventory_accounting_baselines b left join inventory_sessions s on s.id=b.session_id where b.branch_id=target_branch),
 'openings','[]'::jsonb,'receipt_foundations',(select coalesce(jsonb_agg(to_jsonb(f)),'[]') from stock_receipt_foundations f where f.branch_id=target_branch and f.date<=through_date),
 'cost_positions',(select coalesce(jsonb_agg(jsonb_build_object('material_id',o.material_id,'unit_cost',stock_cost_internal(target_branch,o.material_id),'valued_at',now())),'[]') from stock_cost_openings o where o.branch_id=target_branch),
 'sessions',(select coalesce(jsonb_agg(to_jsonb(s)),'[]') from inventory_sessions s where s.branch_id=target_branch and s.inventory_date<=through_date),
 'entries',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from inventory_entries e join inventory_sessions s on s.id=e.session_id where s.branch_id=target_branch and s.inventory_date<=through_date),
 'additions',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('actor_name',u.full_name,'supplier_name',v.name,'source_branch_name',b.name)),'[]') from stock_additions a left join users u on u.id=a.added_by left join suppliers v on v.id=a.supplier_id left join branches b on b.id=a.source_branch_id where a.branch_id=target_branch and a.date<=through_date),
 'consumption',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('actor_name',u.full_name)),'[]') from consumption_records c left join users u on u.id=c.created_by where c.branch_id=target_branch and c.date<=through_date)
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
 select m.material_id,coalesce(p.actual,case when f.date is not null then 0 end) opening,coalesce(p.inventory_date,f.date-1) start_date from scope m left join lateral (
 select sum(e.quantity) actual,s.inventory_date from public.inventory_sessions s join public.inventory_entries e on e.session_id=s.id
 where s.branch_id=branch and s.status='completed' and s.inventory_date>=anchor and s.inventory_date<ending and e.material_id=m.material_id
 group by s.id order by s.inventory_date desc,s.completed_at desc,s.id desc limit 1
 )p on true left join stock_receipt_foundations f on f.branch_id=branch and f.material_id=m.material_id and f.date<=ending
 ), totals as (
 select b.*,coalesce((select sum(a.quantity) from public.stock_additions a where a.branch_id=branch and a.material_id=b.material_id and a.date>b.start_date and a.date<=ending),0) added,
 coalesce((select sum(c.quantity) from public.consumption_records c where c.branch_id=branch and c.material_id=b.material_id and c.date>b.start_date and c.date<=ending),0) consumed,
 (select sum(e.quantity) from public.inventory_entries e where e.session_id=target_session and e.material_id=b.material_id) actual from starting b
 ) select t.material_id,t.opening,t.added,t.consumed,t.opening+t.added-t.consumed,t.actual,t.actual-(t.opening+t.added-t.consumed),
 case when t.actual is null then 'uncounted' when t.opening is null then 'no_baseline' when t.actual<t.opening+t.added-t.consumed then 'shortage' when t.actual>t.opening+t.added-t.consumed then 'surplus' else 'balanced' end,
 t.start_date::timestamp at time zone 'Africa/Cairo',ending::timestamp at time zone 'Africa/Cairo' from totals t;
end $$;

commit;
