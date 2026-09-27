const amount=v=>v==null?null:Number(v);
export const procurementLabels={purchases:'المشتريات ومصادر الإضافة',margins:'تكلفة الصرف وهامش البيع',currentCost:'قيمة المخزون بالتكلفة المتوسطة الحالية',negativeStock:'الأرصدة السالبة فقط'};
export function procurementReports(groups,{from,to,material=''}){
 const purchases=[],margins=[],currentCost=[],negativeStock=[];
 for(const g of groups){
  const byId=new Map(g.accounts.rows.map(r=>[r.material.id,r]));
  for(const a of g.source.additions.filter(a=>a.date>=from&&a.date<=to&&(!material||a.material_id===material))){const m=byId.get(a.material_id)?.material||{};purchases.push({'التاريخ':a.date,'الفرع':g.branch.name,'الصنف':m.name||a.material_id,'الكود':m.code||'','الوحدة':m.unit||'','المصدر':a.source_kind==='supplier'?'مورد':a.source_kind==='branch'?'فرع':'قديم غير موثق','اسم المصدر':a.supplier_name||a.source_branch_name||'غير مسجل','الكمية':Number(a.quantity),'تكلفة شراء الوحدة':amount(a.unit_cost),'تكلفة الإضافة':a.unit_cost==null?null:Number(a.unit_cost)*Number(a.quantity),'الإذن':a.document_id||a.id,'ملاحظات':a.notes||''});}
  for(const r of g.accounts.rows.filter(r=>!material||r.material.id===material)){
   const base={'الفرع':g.branch.name,'الصنف':r.material.name,'الكود':r.material.code||'','الوحدة':r.material.unit||''};
   const sales=g.source.consumption.filter(c=>c.material_id===r.material.id&&c.record_type!=='transfer'&&c.date>=from&&c.date<=to);
   if(sales.length){const known=sales.filter(c=>c.unit_cost!=null),revenue=cs=>cs.reduce((n,c)=>n+Number(c.total_selling_price??c.selling_price??0),0),cost=known.reduce((n,c)=>n+Number(c.quantity)*Number(c.unit_cost),0),matched=revenue(known);margins.push({...base,'إجمالي البيع المسجل':revenue(sales),'بيع الحركات ذات التكلفة':matched,'تكلفة الكمية المباعة الموثقة':known.length?cost:null,'هامش الحركات الموثقة':known.length?matched-cost:null,'نسبة هامش البيع %':known.length&&matched>0?(matched-cost)/matched*100:null,'حركات بلا تكلفة تاريخية':sales.length-known.length,'بيع غير محسوب الربح':revenue(sales)-matched,'أساس المقارنة':'تكلفة محفوظة وقت الصرف؛ تشمل تقييم تكلفة رصيد الافتتاح، ولا تشمل مصاريف التشغيل'});}
   const pos=(g.source.cost_positions||[]).find(p=>p.material_id===r.material.id);const currentDate=pos?.valued_at?new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(pos.valued_at)):'';const valid=to===currentDate&&r.balance!==null&&r.balance>=0&&pos.unit_cost!=null;
   currentCost.push({...base,'الرصيد الدفتري':r.balance,'متوسط تكلفة الوحدة الحالي':valid?Number(pos.unit_cost):null,'قيمة المخزون الحالية':valid?r.balance*Number(pos.unit_cost):null,'تاريخ التقييم':currentDate||'لم يؤسس تقييم تكلفة','الحالة':!pos?'يلزم تسعير الرصيد الافتتاحي':to!==currentDate?'التكلفة الحالية لا تستخدم لتقييم تاريخ قديم':!valid?'رصيد أو تكلفة غير موثقة':'متوسط مرجح بعد تسعير الافتتاح'});
   if(r.balance!==null&&r.balance<0)negativeStock.push({...base,'افتتاح الفترة':r.opening,'الوارد':r.added,'صرف العميلات':r.consumed,'تحويل صادر':r.transferred,'صافي فروق الجرد':r.adjustment,'الرصيد السالب':r.balance,'آخر كمية فعلية':r.actual,'تاريخ آخر جرد':r.actualDate||'','المراجعة المطلوبة':'راجع الوارد والصرف ووحدة القياس مقابل آخر جرد؛ لا تعتبر السالب عجزًا مثبتًا'});
  }
 }
 return {purchases,margins,currentCost,negativeStock};
}
