begin;
do $$
declare b uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); u uuid; sid uuid:=gen_random_uuid(); other_m uuid:=gen_random_uuid(); d date:=(now() at time zone 'Africa/Cairo')::date; q numeric;
begin
 select x.id into u from users x join user_permissions p on p.user_id=x.id where p.can_settings and p.can_inventory and p.can_inventory_reports limit 1;
 perform set_config('request.jwt.claim.sub',u::text,true);
 insert into branches(id,name,code) values(b,'RECEIPT FIX TEST',b::text);
 insert into user_branches(user_id,branch_id) values(u,b);
 insert into materials(id,name,code,unit) values(m,'RECEIPT FIX ITEM',m::text,'ml'),(other_m,'COUNTED ITEM',other_m::text,'ml');
 insert into inventory_sessions(id,branch_id,inventory_date,status,created_by) values(sid,b,d-10,'active',u);
 insert into inventory_entries(session_id,material_id,quantity,quantity_expression,is_supply,created_by) values(sid,other_m,5,'5',true,u);
 update inventory_sessions set status='completed',completed_at=clock_timestamp() where id=sid;
 -- Simulate genuine legacy movements without the newer receipt/source restrictions.
 alter table consumption_records disable trigger enforce_available_stock;
 alter table stock_additions disable trigger validate_receipt_source;
 alter table stock_additions disable trigger establish_receipt_stock;
 insert into consumption_records(branch_id,material_id,quantity,unit,date,created_by,client_name) values(b,m,2,'ml',d-4,u,'TEST');
 insert into stock_additions(branch_id,material_id,quantity,date,added_by) values(b,m,10,d-3,u);
 alter table consumption_records enable trigger enforce_available_stock;
 alter table stock_additions enable trigger validate_receipt_source;
 alter table stock_additions enable trigger establish_receipt_stock;
 perform ensure_receipt_foundation(b,m);
 q:=stock_quantity_internal(b,m,d);if q is distinct from 8 then raise exception 'Expected 10 receipts minus 2 prior issues = 8; got %',q;end if;
 if stock_quantity_internal(b,m,d-4) is not null then raise exception 'Future receipt leaked into past availability';end if;
 insert into consumption_records(branch_id,material_id,quantity,unit,date,created_by,client_name) values(b,m,3,'ml',d,u,'TEST');
 if stock_quantity_internal(b,m,d)<>5 then raise exception 'Issue did not deduct from receipt-backed stock';end if;
 begin
  insert into consumption_records(branch_id,material_id,quantity,unit,date,created_by,client_name) values(b,m,6,'ml',d,u,'TEST OVERSPEND');
  raise exception 'OVERSPEND WAS ACCEPTED';
 exception when others then
  if sqlerrm not like '%الكمية غير متاحة%' then raise; end if;
 end;
 -- Existing legacy history must not prevent a new receipt from establishing a foundation.
 delete from stock_receipt_foundations where branch_id=b and material_id=m;
 insert into stock_additions(branch_id,material_id,quantity,date,added_by,source_kind,source_branch_id) values(b,m,4,d,u,'branch',(select id from branches where id<>b limit 1));
 if stock_quantity_internal(b,m,d)<>9 then raise exception 'New receipt failed to establish legacy balance';end if;
 -- A later completed omission must still be a shortage under the approved rule.
 insert into inventory_sessions(branch_id,inventory_date,status,created_by) values(b,d,'active',u) returning id into sid;
 insert into inventory_entries(session_id,material_id,quantity,quantity_expression,is_supply,created_by) values(sid,other_m,5,'5',true,u);
 update inventory_sessions set status='completed',completed_at=clock_timestamp() where id=sid;
 if stock_quantity_internal(b,m,d)<>0 then raise exception 'Omission shortage rule regressed';end if;
end $$;
select 'PASS legacy receipts, prior issues, no future leakage, new receipt repair, successful issue, later count omission' result;
rollback;
