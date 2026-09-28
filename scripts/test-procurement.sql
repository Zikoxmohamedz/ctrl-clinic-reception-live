-- Run after the migration inside the same transaction, then roll back all fixtures.
do $$
declare b uuid:=gen_random_uuid(); b2 uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); m2 uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); vendor uuid; u uuid; tid uuid; today_date date:=(now() at time zone 'Africa/Cairo')::date; value numeric; caught boolean;
begin
 select id into u from users where role='admin' limit 1;perform set_config('request.jwt.claim.sub',u::text,true);
 insert into branches(id,name,code) values(b,'TEST PROCUREMENT',b::text),(b2,'TEST DESTINATION',b2::text);
 insert into materials(id,name,code,unit,cost_price) values(m,'TEST MATERIAL',m::text,'ml',0),(m2,'TEST NEW MATERIAL',m2::text,'ml',0);
 insert into inventory_sessions(id,branch_id,inventory_date,status,created_by) values(s,b,today_date-1,'active',u);
 insert into inventory_entries(session_id,material_id,quantity,quantity_expression,expiration_date,is_supply,created_by) values(s,m,10,'10',null,true,u);
 update inventory_sessions set status='completed',completed_at=clock_timestamp(),completed_by=u where id=s;
 perform import_material_prices(jsonb_build_array(jsonb_build_object('code',m::text,'name','TEST MATERIAL','unit','ml','cost_price',2)));
 vendor:=save_supplier(jsonb_build_object('name','TEST SUPPLIER'),jsonb_build_array(jsonb_build_object('material_id',m,'unit_cost',4),jsonb_build_object('material_id',m2,'unit_cost',3)));
 insert into stock_additions(branch_id,material_id,quantity,date,added_by,source_kind,supplier_id,unit_cost) values(b,m,10,today_date,u,'supplier',vendor,4);
 value:=stock_cost_internal(b,m);if abs(value-3)>0.000001 or value is null then raise exception 'Weighted cost expected 3, got %',value; end if;
 insert into consumption_records(branch_id,material_id,quantity,unit,date,created_by,client_name,total_selling_price,selling_price) values(b,m,5,'ml',today_date,u,'TEST CLIENT',50,50);
 if stock_quantity_internal(b,m,today_date)<>15 then raise exception 'Expected 15 available';end if;
 caught:=false;begin
  insert into consumption_records(branch_id,material_id,quantity,unit,date,created_by,client_name) values(b,m,8,'ml',today_date,u,'TEST'),(b,m,8,'ml',today_date,u,'TEST');
 exception when others then caught:=true;end;
 if not caught or stock_quantity_internal(b,m,today_date)<>15 then raise exception 'Multi-row issue was not atomic';end if;
 if (select unit_cost from consumption_records where branch_id=b limit 1)<>3 then raise exception 'Cost snapshot missing';end if;
 caught:=false;begin insert into consumption_records(branch_id,material_id,quantity,unit,date,created_by,client_name) values(b,m,16,'ml',today_date,u,'TEST');exception when others then caught:=true;end;if not caught then raise exception 'Overselling was accepted';end if;
 caught:=false;begin insert into consumption_records(branch_id,material_id,quantity,unit,date,created_by,client_name) values(b,m2,1,'ml',today_date,u,'TEST');exception when others then caught:=true;end;if not caught then raise exception 'Unknown stock accepted';end if;
 insert into stock_additions(branch_id,material_id,quantity,date,added_by,source_kind,supplier_id,unit_cost) values(b,m2,6,today_date,u,'supplier',vendor,3);
 if stock_quantity_internal(b,m2,today_date)<>6 then raise exception 'First receipt foundation failed';end if;
 insert into consumption_records(branch_id,material_id,quantity,unit,date,created_by,record_type,transfer_to) values(b,m,2,'ml',today_date,u,'transfer',b2) returning id into tid;
 insert into stock_additions(branch_id,material_id,quantity,date,added_by,source_kind,source_branch_id,transfer_record_id,unit_cost) values(b2,m,2,today_date,u,'branch',b,tid,999);
 if (select unit_cost from stock_additions where transfer_record_id=tid)<>3 then raise exception 'Transfer cost was not preserved';end if;
 insert into stock_additions(branch_id,material_id,quantity,date,added_by,source_kind,source_branch_id,unit_cost) values(b2,m2,7,today_date,u,'branch',b,999);
 if stock_quantity_internal(b2,m2,today_date)<>7 or stock_quantity_internal(b,m2,today_date)<>6 then raise exception 'Declared receipt must affect recipient only';end if;
 if (select unit_cost from stock_additions where branch_id=b2 and material_id=m2) is not null then raise exception 'Unmatched receipt must not invent a cost';end if;
 caught:=false;begin insert into stock_additions(branch_id,material_id,quantity,date,added_by,source_kind,source_branch_id,transfer_record_id) values(b2,m,2,today_date,u,'branch',b,tid);exception when others then caught:=true;end;if not caught then raise exception 'Duplicate transfer accepted';end if;
 caught:=false;begin perform import_material_prices(jsonb_build_array(jsonb_build_object('code',m::text,'name','TEST','unit','Pack','cost_price',10)));exception when others then caught:=true;end;if not caught then raise exception 'Unit-changing import accepted';end if;
 perform import_material_prices(jsonb_build_array(jsonb_build_object('code',m::text,'name','TEST MATERIAL','unit','ml','cost_price',20)));
 if (select unit_cost from consumption_records where branch_id=b and record_type='client' limit 1)<>3 then raise exception 'Historical sale changed after price edit';end if;
 if (select total_selling_price from consumption_records where branch_id=b and record_type='client' limit 1)<>50 then raise exception 'Selling price changed';end if;
end $$;
select 'PASS: weighted cost, availability, oversell rejection, unknown stock, new receipt foundation, transfer cost and duplicate protection, unit validation, independent historical sale price' test_result;
