const n = value => Number(value || 0);
const round = value => Math.round(value * 1e6) / 1e6;
const daysBetween = (a,b) => Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000);
const identity = (branch,material) => ({'الفرع':branch.name,'الصنف':material.name,'كود الصنف':material.code||'','الوحدة':material.unit||''});
export const insightLabels = { replenishment:'التغطية واقتراح التوريد', dormant:'أصناف بلا صرف خلال الفترة', abc:'تصنيف ABC حسب الإيراد', branches:'مقارنة الفروع', daily:'الحركة اليومية', expiryAlerts:'تنبيهات الصلاحية', countCoverage:'تغطية الجرد', dataQuality:'نواقص البيانات' };
export const insightNotes = {
 replenishment:'تقدير: متوسط صرف العميلات اليومي = الصرف المسجل ÷ أيام الفترة. التوريد المقترح = متوسط الصرف × أيام التغطية المستهدفة − الرصيد، بحد أدنى صفر. لا يتضمن طلبات شراء معلقة أو مهلة المورد؛ التحويلات ليست استهلاك عميلات.',
 dormant:'أصناف ذات رصيد موجب ولم يسجل لها صرف عميلات خلال الفترة المختارة. هذا ليس عمر دفعات المخزون ولا إثباتًا لتوقف الطلب.',
 abc:'تصنيف الأصناف حسب إيراد صرف العميلات المسجل: A حتى تجاوز أول 80%، ثم B حتى تجاوز 95%، والباقي C. يتم التصنيف بعد تطبيق الفلاتر؛ لا يمثل هامش الربح.',
 branches:'مقارنة الإيراد وعدد الحركات وجودة الأرصدة. القيمة تقديرية بسعر التكلفة الحالي وتشمل الأرصدة الموجبة ذات التكلفة فقط؛ عدد الأرصدة المستبعدة موضح.',
 daily:'يوم وفرع لكل سطر. عدد الحركات والإيراد قابلان للجمع، أما كميات الأصناف المختلفة فلا تجمع في مؤشر واحد.',
 expiryAlerts:'تنبيه حسب تاريخ نهاية الفترة للدفعات المسجلة في آخر جرد لكل صنف: منتهية أو خلال 90 يومًا. الكمية تاريخية وقت الجرد وقد تكون صُرفت بعده؛ راجعها فعليًا.',
 countCoverage:'المقام هو عدد أصناف الفرع ذات سجلات أو الأصناف الموسعة بالفلتر. نسبة التغطية = الأصناف التي لها جرد مكتمل خلال الفترة ÷ الأصناف في النطاق، ولا تثبت صحة الكميات.',
 dataQuality:'استثناءات تمنع الثقة الكاملة في التقارير: رصيد مجهول أو سالب، تكلفة ناقصة، وجرد مفتوح أو فارغ. لا تُعدّل هذه القائمة البيانات تلقائيًا.'
};

export function buildInsights(groups, {from,to,material='',targetDays=14}, expiry=[]) {
  const days=Math.max(1,daysBetween(from,to)+1);
  const rows=groups.flatMap(g=>g.accounts.rows.filter(r=>!material||r.material.id===material).map(r=>({...r,branch:g.branch,source:g.source})));
  const replenishment=rows.map(r=>{
    const average=r.consumed/days;
    const coverage=r.balance===null||r.balance<0||average===0?null:r.balance/average;
    const suggested=r.balance===null||r.balance<0||average===0?null:Math.max(0,average*targetDays-r.balance);
    return {...identity(r.branch,r.material),'الرصيد الدفتري':r.balance,'صرف العميلات':r.consumed,'أيام الفترة':days,'متوسط الصرف اليومي':round(average),'التغطية المقدرة بالأيام':coverage===null?null:round(coverage),'أيام التغطية المستهدفة':targetDays,'كمية توريد مقترحة':suggested===null?null:round(suggested),'الحالة':r.balance===null?'رصيد غير موثق':r.balance<0?'راجع الرصيد السالب':average===0?'لا يوجد صرف لتقدير الطلب':r.balance===0?'نفاد مخزون':coverage<targetDays?'يحتاج توريد':'تغطية كافية'};
  }).sort((a,b)=>(b['كمية توريد مقترحة']??-1)-(a['كمية توريد مقترحة']??-1));
  const dormant=rows.filter(r=>r.balance>0&&r.consumed===0).map(r=>{
    const last=r.source.consumption.filter(c=>c.material_id===r.material.id&&c.record_type!=='transfer'&&c.date<=to).map(c=>c.date).sort().at(-1);
    return {...identity(r.branch,r.material),'الرصيد الدفتري':r.balance,'آخر صرف مسجل':last||'لا يوجد صرف مسجل','أيام منذ آخر صرف':last?daysBetween(last,to):null,'آخر جرد':r.actualDate||'لا يوجد','الوارد في الفترة':r.added,'تحويلات صادرة':r.transferred};
  });
  const abcMap=new Map(),dailyMap=new Map(),branchMap=new Map();
  for(const group of groups){
    const scoped=rows.filter(r=>r.branch.id===group.branch.id);
    const known=scoped.filter(r=>r.balance!==null&&r.balance>=0&&n(r.material.cost_price)>0);
    const open=group.source.sessions.filter(s=>s.inventory_date>=from&&s.inventory_date<=to&&s.status!=='completed'&&(!material||group.source.entries.some(e=>e.session_id===s.id&&e.material_id===material)));
    branchMap.set(group.branch.id,{'الفرع':group.branch.name,'إيراد صرف العميلات':0,'حركات صرف العميلات':0,'حركات وارد':0,'حركات تحويل صادر':0,'أصناف في النطاق':scoped.length,'أرصدة غير موثقة':scoped.filter(r=>r.balance===null).length,'أرصدة سالبة':scoped.filter(r=>r.balance<0).length,'قيمة الأرصدة المعلومة بالتكلفة الحالية':round(known.reduce((sum,r)=>sum+r.balance*n(r.material.cost_price),0)),'أرصدة مستبعدة من التقييم':scoped.length-known.length,'جرود مفتوحة في الفترة':open.length});
    for(const entry of group.accounts.ledger){
      if(material&&entry.material.id!==material)continue;
      if(!['addition','consumption','transfer'].includes(entry.type))continue;
      const key=`${entry.date}|${group.branch.id}`;
      if(!dailyMap.has(key))dailyMap.set(key,{'التاريخ':entry.date,'الفرع':group.branch.name,'حركات صرف العميلات':0,'حركات وارد':0,'حركات تحويل صادر':0,'إيراد صرف العميلات':0});
      const daily=dailyMap.get(key),branch=branchMap.get(group.branch.id);
      const col=entry.type==='addition'?'حركات وارد':entry.type==='transfer'?'حركات تحويل صادر':'حركات صرف العميلات';daily[col]++;branch[col]++;
      if(entry.type==='consumption'){
        const revenue=n(entry.total_selling_price??entry.selling_price);
        daily['إيراد صرف العميلات']+=revenue;branch['إيراد صرف العميلات']+=revenue;
        if(!abcMap.has(entry.material.id))abcMap.set(entry.material.id,{'الصنف':entry.material.name,'كود الصنف':entry.material.code||'','الوحدة':entry.material.unit||'','الكمية المنصرفة':0,'الإيراد':0});
        abcMap.get(entry.material.id)['الإيراد']+=revenue;abcMap.get(entry.material.id)['الكمية المنصرفة']+=n(entry.quantity);
      }
    }
  }
  const abc=[...abcMap.values()].sort((a,b)=>b['الإيراد']-a['الإيراد']||a['كود الصنف'].localeCompare(b['كود الصنف']));
  const totalRevenue=abc.reduce((sum,r)=>sum+r['الإيراد'],0);let accumulated=0;
  for(const r of abc){const prior=totalRevenue?accumulated/totalRevenue:0;accumulated+=r['الإيراد'];r['التصنيف']=r['الإيراد']<=0?'غير مصنف':prior<.8?'A':prior<.95?'B':'C';r['نسبة الإيراد %']=totalRevenue?round(r['الإيراد']/totalRevenue*100):0;r['النسبة التراكمية %']=totalRevenue?round(accumulated/totalRevenue*100):0;}
  const expiryAlerts=expiry.filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r['تاريخ الصلاحية'])&&daysBetween(to,r['تاريخ الصلاحية'])<=90).map(r=>({...r,'الأيام حتى الصلاحية':daysBetween(to,r['تاريخ الصلاحية']),'التنبيه':r['تاريخ الصلاحية']<to?'منتهي في تاريخ التقرير':'خلال 90 يومًا'}));
  const countCoverage=groups.map(g=>{
    const scoped=rows.filter(r=>r.branch.id===g.branch.id),counted=scoped.filter(r=>r.actualDate>=from&&r.actualDate<=to).length;
    return {'الفرع':g.branch.name,'أصناف في النطاق':scoped.length,'أصناف مجرودة في الفترة':counted,'أصناف بلا جرد خلال الفترة':scoped.length-counted,'تغطية الجرد %':scoped.length?round(counted/scoped.length*100):null,'آخر تاريخ جرد مكتمل':scoped.map(r=>r.actualDate).sort().at(-1)||'لا يوجد'};
  });
  const dataQuality=rows.flatMap(r=>{
    const issues=[];if(r.balance===null)issues.push('لا يوجد أساس موثّق للرصيد');else if(r.balance<0)issues.push('رصيد دفتري سالب');if(r.balance>0&&n(r.material.cost_price)<=0)issues.push('سعر التكلفة غير محدد');
    return issues.map(issue=>({...identity(r.branch,r.material),'المشكلة':issue,'الرصيد':r.balance,'آخر جرد':r.actualDate||'لا يوجد'}));
  });
  for(const g of groups)for(const s of g.source.sessions){
    if(s.inventory_date<from||s.inventory_date>to)continue;
    const entries=g.source.entries.filter(e=>e.session_id===s.id);
    if(material&&!entries.some(e=>e.material_id===material))continue;
    if(s.status!=='completed'||entries.length===0)dataQuality.push({'الفرع':g.branch.name,'الصنف':'جلسة جرد','كود الصنف':'','الوحدة':'','المشكلة':s.status!=='completed'?'جرد مفتوح غير معتمد':'جرد فارغ لا يؤسس رصيدًا','الرصيد':null,'آخر جرد':s.inventory_date});
  }
  const branches=[...branchMap.values()];
  const daily=[...dailyMap.values()].sort((a,b)=>a['التاريخ'].localeCompare(b['التاريخ'])||a['الفرع'].localeCompare(b['الفرع']));
  return {replenishment,dormant,abc,branches,daily,expiryAlerts,countCoverage,dataQuality};
}
