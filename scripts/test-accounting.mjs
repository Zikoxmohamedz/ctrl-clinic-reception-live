import assert from 'node:assert/strict';
import { calculateAccounts } from '../pages/accounting-engine.mjs';
const materials=[{id:'m',name:'test',unit:'piece'}];
const source=()=>({openings:[],sessions:[],entries:[],additions:[],consumption:[]});
const count=(s,id,date,quantity,status='completed')=>{s.sessions.push({id,inventory_date:date,status,completed_at:`${date}T20:00:00Z`});s.entries.push({session_id:id,material_id:'m',quantity});};
const run=(s,from='2026-08-01',to='2026-08-31')=>calculateAccounts(s,materials,from,to);
{
 const s=source();count(s,'july','2026-07-31',100);s.additions.push({material_id:'m',date:'2026-08-02',quantity:20});s.consumption.push({material_id:'m',date:'2026-08-03',quantity:10});count(s,'aug','2026-08-31',105);
 const a=run(s);assert.equal(a.rows[0].opening,100);assert.equal(a.rows[0].expected,110);assert.equal(a.rows[0].balance,105);assert.equal(a.variances[0].variance,-5);
 const next=run(s,'2026-09-01','2026-09-30');assert.equal(next.rows[0].opening,105);assert.equal(next.rows[0].balance,105);
}
{
 const s=source();count(s,'first','2026-08-31',4);s.entries.push({session_id:'first',material_id:'m',quantity:6});
 const a=run(s);assert.equal(a.rows[0].balance,10);assert.equal(a.rows[0].opening,null);assert.equal(a.variances[0].variance,null);
}
{
 const s=source();count(s,'july','2026-07-31',20);count(s,'open','2026-08-31',1,'active');s.sessions.push({id:'empty',inventory_date:'2026-08-31',status:'completed'});
 assert.equal(run(s).rows[0].balance,20);assert.equal(run(s).rows[0].actualDate,'2026-07-31');
}
{
 const s=source();count(s,'july','2026-07-31',20);s.openings.push({material_id:'m',quantity:900,opened_at:'2026-08-10T12:00:00Z'});s.consumption.push({material_id:'m',date:'2026-08-31',quantity:3,record_type:'transfer'});count(s,'aug','2026-08-31',17);
 assert.equal(run(s).rows[0].balance,17);assert.equal(run(s).rows[0].transferred,3);assert.equal(run(s).variances[0].variance,0);
}
{
 const s=source();count(s,'july','2026-07-31',0);assert.equal(run(s).rows[0].opening,0);assert.equal(run(source()).rows[0].balance,null);
}
{
 const s=source();count(s,'july','2026-07-31',5);s.consumption.push({material_id:'m',date:'2026-07-31',quantity:2});s.consumption.push({material_id:'m',date:'2026-08-01',quantity:1});assert.equal(run(s).rows[0].opening,5);assert.equal(run(s).rows[0].balance,4);
}
console.log('6 accounting scenarios passed: date boundaries, roll-forward, merged quantities, missing baseline, active/empty counts, and transfer treatment.');
