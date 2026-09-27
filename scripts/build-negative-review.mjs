import {readFile,writeFile} from 'node:fs/promises';
import {calculateAccounts} from '../pages/accounting-engine.mjs';
const data=JSON.parse(await readFile('.local/accounting-source.json','utf8'));
const negatives=[],movements=[];
for(const g of data.groups){
 const ids=new Set([...g.source.entries,...g.source.additions,...g.source.consumption].map(r=>r.material_id));
 const accounts=calculateAccounts(g.source,data.materials.filter(m=>ids.has(m.id)),'2026-07-31','2026-09-27');
 const bad=accounts.rows.filter(r=>r.balance!==null&&r.balance<0);
 for(const r of bad){negatives.push({branch:g.branch.name,code:r.material.code,name:r.material.name,unit:r.material.unit,opening:r.opening,incoming:r.added,outgoing:r.consumed,transfers:r.transferred,count_adjustment:r.adjustment,balance:r.balance,last_count:r.actual,last_count_date:r.actualDate});
 for(const e of accounts.ledger.filter(e=>e.material.id===r.material.id))movements.push({branch:g.branch.name,code:r.material.code,name:r.material.name,unit:r.material.unit,date:e.date,type:e.type,quantity:e.quantity,before:e.before,after:e.balance,excluded:e.excluded,reference:e.id,notes:e.notes||''});}
}
await writeFile('.local/negative-review-data.json',JSON.stringify({negatives,movements}));
console.log(JSON.stringify({negativeRows:negatives.length,branches:[...new Set(negatives.map(r=>r.branch))],movementRows:movements.length}));
