begin;
do $$
declare sid uuid:='7522d9cb-28d2-4524-bf5a-d5efb97aa7f4'; hid uuid:='5bac1a69-9c21-4422-b061-dce7fbd76929';
begin
 if not exists(select 1 from inventory_recovery.operations where operation='nasr-close-helwan-july-20260927') then
  insert into inventory_recovery.operations(operation,payload)
  values('nasr-close-helwan-july-20260927',jsonb_build_object('sessions',(select jsonb_agg(to_jsonb(s)) from inventory_sessions s where id in(sid,hid))));
  if not exists(select 1 from inventory_entries where session_id=sid) then raise exception 'Nasr count empty'; end if;
  update inventory_sessions set status='completed',completed_at=now(),completed_by=created_by where id=sid and status='active';
  update inventory_sessions set inventory_date='2026-07-31' where id=hid and inventory_date='2026-08-02';
 end if;
end $$;
commit;
select b.name,s.inventory_date,s.status,count(e.id) entries from inventory_sessions s join branches b on b.id=s.branch_id left join inventory_entries e on e.session_id=s.id where s.id in('7522d9cb-28d2-4524-bf5a-d5efb97aa7f4','5bac1a69-9c21-4422-b061-dce7fbd76929') group by b.name,s.inventory_date,s.status;

