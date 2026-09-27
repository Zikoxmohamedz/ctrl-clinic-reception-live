-- Execute only after the user identifies these two saved counts as July/August.
begin;
do $$
declare saved jsonb; merged_at timestamptz; older uuid:='161a9fc1-0641-496c-900e-c534bbecff76'; newer uuid:='109210c3-46de-42c2-bad0-2e160f2635bf';
begin
 if exists(select 1 from inventory_recovery.operations where operation='haram-separated-july-august-2026') then return; end if;
 lock table public.inventory_sessions,public.inventory_entries,public.inventory_participants in share row exclusive mode;
 select payload,saved_at into saved,merged_at from inventory_recovery.operations where operation='haram-merge-2026-08-31';
 if saved is null or jsonb_array_length(saved->'entries')<>119 then raise exception 'Original backup missing or unexpected'; end if;
 if exists(select 1 from public.inventory_entries where session_id=newer and updated_at>merged_at) then raise exception 'Count edited since merge; review before restoring'; end if;
 if (select count(*) from public.inventory_entries where session_id=newer)<>90 then raise exception 'Merged count changed'; end if;
 insert into inventory_recovery.operations(operation,payload) select 'haram-separated-july-august-2026',jsonb_build_object(
 'sessions',(select jsonb_agg(to_jsonb(s)) from public.inventory_sessions s where id in(older,newer)),
 'entries',(select jsonb_agg(to_jsonb(e)) from public.inventory_entries e where session_id in(older,newer)),
 'participants',(select jsonb_agg(to_jsonb(p)) from public.inventory_participants p where session_id in(older,newer)),
 'baseline',(select to_jsonb(b) from public.inventory_accounting_baselines b where b.session_id=newer));
 insert into public.inventory_sessions select * from jsonb_populate_recordset(null::public.inventory_sessions,saved->'sessions') on conflict(id) do nothing;
 delete from public.inventory_entries where session_id in(older,newer);
 insert into public.inventory_entries select * from jsonb_populate_recordset(null::public.inventory_entries,saved->'entries');
 delete from public.inventory_participants where session_id in(older,newer);
 insert into public.inventory_participants select * from jsonb_populate_recordset(null::public.inventory_participants,saved->'participants');
 -- User clarified: count entered September 12 is July; entered September 3 is August.
 update public.inventory_sessions set inventory_date=case when id=newer then date '2026-07-31' else date '2026-08-31' end where id in(older,newer);
 update public.inventory_accounting_baselines set session_id=newer,selected_at=now() where branch_id=(select branch_id from public.inventory_sessions where id=newer);
 if exists((select session_id,material_id,sum(quantity) from jsonb_populate_recordset(null::public.inventory_entries,saved->'entries') group by session_id,material_id
 except select session_id,material_id,sum(quantity) from public.inventory_entries where session_id in(older,newer) group by session_id,material_id)) then raise exception 'Restoration quantities differ from originals'; end if;
end $$;
commit;
select s.id,s.inventory_date,count(e.id) entries,count(distinct e.material_id) materials from public.inventory_sessions s join public.inventory_entries e on e.session_id=s.id where s.id in('161a9fc1-0641-496c-900e-c534bbecff76','109210c3-46de-42c2-bad0-2e160f2635bf') group by s.id order by s.inventory_date;
