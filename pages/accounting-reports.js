import { supabase, today, escapeHtml, toast } from '../supabase.js?v=20260801-audit-context';
import { list } from '../data.js?v=20260926-accounting';
import { calculateAccounts } from './accounting-engine.mjs?v=20260926-accounting';
import { buildInsights, insightLabels, insightNotes } from './inventory-insights.mjs?v=20260926-dashboard';
import { dashboardHtml } from './accounting-dashboard.mjs?v=20260926-dashboard';

const labels = { dashboard:'لوحة المتابعة', balances: 'الأرصدة التفصيلية', consolidated: 'مجمع كل الأرصدة', ledger: 'كشف حركة صنف', variances: 'العجز والزيادة', additions: 'الوارد', consumption: 'الصرف', transfers: 'التحويلات', summary: 'ملخص حركة الأصناف والفروع', history: 'سجل الجرد', review: 'أرصدة تحتاج مراجعة', valuation: 'قيمة المخزون', expiry: 'صلاحيات آخر جرد', ...insightLabels };
const types = { opening: 'رصيد تأسيسي', addition: 'إضافة', consumption: 'صرف', transfer: 'تحويل صادر', count: 'جرد فعلي' };
const fmt = value => value == null ? 'غير متاح' : typeof value === 'number' ? new Intl.NumberFormat('ar-EG-u-nu-latn', { maximumFractionDigits: 4 }).format(value) : String(value);
const round = value => Math.round(value * 1e8) / 1e8;
const sumKnown = (rows, key) => rows.every(r => r[key] != null) ? round(rows.reduce((n,r) => n+r[key],0)) : null;
const base = r => ({ 'الفرع': r.branch.name, 'الصنف': r.material.name, 'كود الصنف': r.material.code || '', 'الوحدة': r.material.unit || '' });

export function reportTables(groups, materialId = '') {
  const rows = groups.flatMap(g => g.accounts.rows.map(r => ({ ...r, branch: g.branch }))).filter(r => !materialId || r.material.id === materialId);
  const ledger = groups.flatMap(g => g.accounts.ledger.map(r => ({ ...r, branch: g.branch }))).filter(r => !materialId || r.material.id === materialId);
  const balances = rows.map(r => ({ ...base(r), 'رصيد أول الفترة': r.opening, 'الوارد': r.added, 'الصرف': r.consumed, 'التحويل الصادر': r.transferred, 'الدفتري قبل تسويات الجرد': r.expected, 'عجز جرود الفترة': r.shortage, 'زيادة جرود الفترة': r.surplus, 'صافي تسويات الجرد': r.adjustment, 'رصيد نهاية الفترة': r.balance, 'آخر جرد فعلي': r.actual, 'تاريخ آخر جرد': r.actualDate || 'لم يجرد', 'الحالة': r.status }));
  const materialGroups = new Map();
  rows.forEach(r => { if (!materialGroups.has(r.material.id)) materialGroups.set(r.material.id,[]); materialGroups.get(r.material.id).push(r); });
  const consolidated = [...materialGroups.values()].map(items => ({ 'الصنف': items[0].material.name, 'كود الصنف': items[0].material.code || '', 'الوحدة': items[0].material.unit || '', 'عدد الفروع': items.length,
    'رصيد أول الفترة': sumKnown(items,'opening'), 'الوارد': sumKnown(items,'added'), 'الصرف': sumKnown(items,'consumed'), 'التحويل الصادر': sumKnown(items,'transferred'), 'رصيد نهاية الفترة': sumKnown(items,'balance'), 'مجموع الأرصدة المعروفة فقط': round(items.reduce((n,r)=>n+(r.balance??0),0)), 'فروع بلا رصيد موثق': items.filter(r => r.balance===null).length }));
  const movement = r => ({ ...base(r), 'التاريخ': r.date, 'نوع الحركة': types[r.type], 'الرصيد السابق': r.before, 'الكمية': Number(r.quantity), 'تغير الرصيد': r.delta, 'الرصيد بعد الحركة': r.balance, 'العميلة': r.client_name || '', 'كود العميلة': r.client_code || '', 'جهة التحويل': r.destination || '', 'إجمالي سعر البيع': r.type==='consumption' ? Number(r.total_selling_price ?? r.selling_price ?? 0) : null, 'بواسطة':r.actor_name||'', 'ملاحظات': r.notes || '', 'مرجع الحركة': r.id || '' });
  const variances = groups.flatMap(g => g.accounts.variances.filter(r => !materialId || r.material.id===materialId).map(r => ({ ...base({ ...r,branch:g.branch }), 'تاريخ الجرد':r.date, 'الدفتري قبل الجرد':r.expected, 'الجرد الفعلي':r.actual, 'العجز':r.variance===null?null:Math.max(0,-r.variance), 'الزيادة':r.variance===null?null:Math.max(0,r.variance), 'الحالة':r.variance===null?'لا يوجد رصيد سابق للمقارنة':r.variance<0?'عجز':r.variance>0?'زيادة':'مطابق' })));
  const history = groups.flatMap(g => g.source.sessions.map(s => {
    const allEntries=g.source.entries.filter(e=>e.session_id===s.id);
    const entries=allEntries.filter(e=>!materialId||e.material_id===materialId);
    if(materialId && !entries.length) return null;
    return { 'الفرع':g.branch.name,'تاريخ الجرد':s.inventory_date,'الحالة':s.status==='completed'?'مكتمل':'مفتوح — غير معتمد','عدد الأصناف':new Set(entries.map(e=>e.material_id)).size,'عدد السطور':entries.length,'وقت الإدخال':s.created_at,'وقت الإقفال':s.completed_at||'','ملاحظة':!allEntries.length?'جرد فارغ لا يؤسس رصيدًا':'','مرجع الجرد':s.id };
  }).filter(Boolean)).sort((a,b)=>b['تاريخ الجرد'].localeCompare(a['تاريخ الجرد']));
  const expiry = groups.flatMap(g => {
    const latest=new Map();
    g.source.sessions.filter(s=>s.status==='completed').sort((a,b)=>a.inventory_date.localeCompare(b.inventory_date)||String(a.completed_at).localeCompare(String(b.completed_at))).forEach(s=>g.source.entries.filter(e=>e.session_id===s.id).forEach(e=>latest.set(e.material_id,s)));
    return g.source.entries.filter(e=>(!materialId||e.material_id===materialId)&&latest.get(e.material_id)?.id===e.session_id).flatMap(e=>{
      const r=g.accounts.rows.find(r=>r.material.id===e.material_id);
      return (e.is_supply?[{quantity:e.quantity,expiration_date:null}]:e.expiry_batches?.length?e.expiry_batches:[{quantity:e.quantity,expiration_date:e.expiration_date}]).map(batch=>({...base({...r,branch:g.branch}),'تاريخ الجرد':latest.get(e.material_id).inventory_date,'تاريخ الصلاحية':batch.expiration_date||'لا ينطبق','كمية وقت الجرد':Number(batch.quantity),'الوصف':'كمية تاريخية وقت الجرد؛ لا تخصم الحركات من دفعات الصلاحية'}));
    });
  });
  return { balances, consolidated, ledger:ledger.map(movement), variances,
    additions:ledger.filter(r=>r.type==='addition').map(movement), consumption:ledger.filter(r=>r.type==='consumption').map(movement), transfers:ledger.filter(r=>r.type==='transfer').map(movement), history,
    summary:rows.map(r=>({...base(r),'الوارد':r.added,'صرف العميلات':r.consumed,'التحويل الصادر':r.transferred,'صافي حركة الفترة':round(r.added-r.consumed-r.transferred),'إيراد صرف العميلات':round(ledger.filter(l=>l.branch.id===r.branch.id&&l.material.id===r.material.id&&l.type==='consumption').reduce((n,l)=>n+Number(l.total_selling_price??l.selling_price??0),0))})),
    review:balances.filter(r=>r['رصيد نهاية الفترة']===null||r['رصيد نهاية الفترة']<0||r['الحالة']!=='جرد فعلي بنهاية الفترة'),
    valuation:rows.map(r=>({...base(r),'رصيد نهاية الفترة':r.balance,'سعر التكلفة الحالي':Number(r.material.cost_price||0),'قيمة بالتكلفة الحالية':r.balance===null||!Number(r.material.cost_price)?null:round(r.balance*Number(r.material.cost_price)),'ملاحظة':!Number(r.material.cost_price)?'سعر التكلفة غير محدد':'تقييم بسعر التكلفة الحالي، وليس تكلفة تاريخية'})), expiry };
}

export async function renderAccountingReports(root, profile, showHistory) {
  let version=0, groups=[], tables={}, active='dashboard', page=1;
  const allBranches=await list('branches');
  const allowed=profile.branch_ids?.length?profile.branch_ids:profile.role==='admin'?allBranches.map(b=>b.id):[profile.branch_id];
  const branches=allBranches.filter(b=>allowed.includes(b.id));
  const materials=await list('materials');
  const now=today();
  root.innerHTML=`<style>
    #account-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:16px;align-items:end}
    #account-form label{display:flex;flex-direction:column;gap:7px;min-width:0;font-weight:600}
    #account-form input,#account-form select{width:100%;min-width:0;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:9px;background:var(--panel,#fff);color:inherit;font:inherit}
    #account-form .account-check{flex-direction:row;align-items:center;font-size:13px}#account-form input[type=checkbox]{width:18px}
    #account-output .table-wrap{max-width:100%;overflow:auto}#account-output table{font-size:13px;white-space:nowrap}
    #account-output th{position:sticky;top:0}#account-status{margin:16px 0;line-height:1.8}#account-tabs [hidden]{display:none}#account-mobile-picker{display:none}
    .account-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:20px}.account-kpi{border:1px solid #dce3ef;border-top:4px solid #2563eb;border-radius:14px;padding:20px;text-align:right;background:var(--panel,#fff);color:inherit;cursor:pointer;display:flex;flex-direction:column;gap:10px}.account-kpi strong{font-size:25px;color:#2563eb}.account-kpi small{line-height:1.7;color:var(--muted,#64748b)}
    .account-alerts{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px}.account-alerts button{padding:12px;border:1px solid #e6cf9d;border-radius:10px;background:#fffbeb;color:#854d0e;cursor:pointer;font:inherit}.account-chart-grid{display:grid;grid-template-columns:1.15fr 1fr;gap:18px;margin-bottom:20px}.account-chart{padding:20px;border:1px solid #dce3ef;border-radius:14px;min-width:0}.account-chart h3{margin:0 0 8px}.account-chart p{font-size:13px;color:var(--muted,#64748b);line-height:1.8}.account-chart svg{width:100%;direction:ltr}.account-chart svg text{font:12px Arial;fill:var(--muted,#64748b)}.account-bar{margin:14px 0}.account-bar>div:first-child{display:flex;justify-content:space-between;gap:8px}.account-bar-track{height:9px;background:#e2e8f0;border-radius:6px;margin-top:6px}.account-bar-track i{display:block;height:9px;background:#2563eb;border-radius:6px}.account-chart .btn{margin-top:15px}.account-dashboard{white-space:normal}
    @media(max-width:1000px){.account-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.account-chart-grid{grid-template-columns:1fr}}@media(max-width:500px){.account-kpis{grid-template-columns:1fr}.account-chart{padding:12px}}
    @media(max-width:600px){#account-form{grid-template-columns:minmax(0,1fr)}#account-tabs,#account-search-label{display:none}#account-mobile-picker{display:block;width:100%;padding:12px;margin:12px 0;border-radius:10px;font:inherit}#account-output{padding:12px}}
    </style><div class="page-intro"><div><h2>تقارير المحاسب</h2><p>اختار الفترة والفرع والصنف؛ كل تقرير جاهز للعرض والطباعة وExcel.</p></div><button class="btn" id="account-history">تفاصيل الجرد والصور</button></div>
    <section class="panel"><form class="panel-body filters" id="account-form">
    <label>من تاريخ<input type="date" name="from" value="${now.slice(0,7)}-01" required></label>
    <label>إلى تاريخ<input type="date" name="to" value="${now}" max="${now}" required></label>
    <label>الفرع<select name="branch"><option value="">كل الفروع المسموحة</option>${branches.map(b=>`<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('')}</select></label>
    <label>ابحث عن صنف<input name="search" type="search" placeholder="اسم الصنف أو الكود"></label>
    <label>الصنف<select name="material"><option value="">كل الأصناف</option></select></label>
    <label>تغطية التوريد المستهدفة<select name="target_days"><option value="7">7 أيام</option><option value="14" selected>14 يومًا</option><option value="30">30 يومًا</option><option value="60">60 يومًا</option></select></label>
    <label class="account-check"><input type="checkbox" name="include_empty">إظهار أصناف بلا سجلات أيضًا</label>
    <button class="btn primary" type="submit">عرض التقارير</button><button class="btn" type="button" id="account-august">جرد 31/8/2026</button>
    </form></section>
    <p class="muted">رصيد النهاية = رصيد البداية + الوارد − الصرف − التحويل الصادر + تسويات الجرد. الجرد محسوب في نهاية اليوم، ويؤسس رصيد اليوم التالي. «غير متاح» تعني أن البيانات لا تكفي لإثبات الرصيد؛ الصنف غير المسجل في الجرد لا يُعتبر صفرًا.</p>
    <div id="account-status" role="status"></div><label id="account-search-label">الوصول السريع لتقرير<input id="account-report-search" type="search" placeholder="اكتب مثلًا: توريد، صنف، عجز" aria-label="البحث في أسماء التقارير"></label><select id="account-mobile-picker" aria-label="اختار التقرير">${Object.entries(labels).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select><nav class="reports-tab-nav" id="account-tabs">${Object.entries(labels).map(([key,label])=>`<button class="reports-tab-btn" type="button" data-tab="${key}">${label}</button>`).join('')}</nav>
    <section class="panel"><div class="panel-head"><h3 id="account-title"></h3><div class="reports-header-actions"><button class="btn" data-download="one">Excel التقرير</button><button class="btn primary" data-download="all">Excel شامل</button><button class="btn" id="account-print">طباعة / PDF</button></div></div><div class="panel-body" id="account-output"></div></section>`;
  const form=root.querySelector('#account-form'), output=root.querySelector('#account-output'), status=root.querySelector('#account-status');
  const materialSelect=form.elements.material;
  const chooseMaterials=()=>{
    const query=form.elements.search.value.trim().toLocaleLowerCase('ar');
    const selected=materialSelect.value;
    materialSelect.innerHTML='<option value="">كل الأصناف</option>'+materials.filter(m=>`${m.name} ${m.code}`.toLocaleLowerCase('ar').includes(query)).map(m=>`<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} · ${escapeHtml(m.code||'')}</option>`).join('');
    if([...materialSelect.options].some(o=>o.value===selected)) materialSelect.value=selected;
  };
  chooseMaterials(); form.elements.search.oninput=chooseMaterials;
  const tableHtml=rows=>{
    if(!rows.length)return '<div class="empty-state">لا توجد بيانات مطابقة للفلاتر.</div>';
    const headers=Object.keys(rows[0]);
    return `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${headers.map(h=>`<td>${escapeHtml(fmt(r[h]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  };
  let applied={from:'',to:'',branch:'',material:''};
  const draw=()=>{
    const rows=tables[active]||[];
    const pages=Math.max(1,Math.ceil(rows.length/50));page=Math.min(page,pages);
    root.querySelector('#account-title').textContent=labels[active];
    root.querySelector('#account-mobile-picker').value=active;
    root.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===active));
    if(active==='dashboard'){
      output.innerHTML=Object.keys(tables).length?`<p>${escapeHtml(applied.from)} إلى ${escapeHtml(applied.to)} · ${escapeHtml(groups.map(g=>g.branch.name).join('، '))}</p>${dashboardHtml(tables,applied,fmt,escapeHtml)}`:'<p>اعرض البيانات أولًا.</p>';
      output.querySelectorAll('[data-dashboard-tab]').forEach(button=>button.onclick=()=>{active=button.dataset.dashboardTab;page=1;draw();});return;
    }
    output.innerHTML=`<p>${rows.length} سطر · ${escapeHtml(applied.from)} إلى ${escapeHtml(applied.to)} · الأرقام تخص الفلاتر المطبقة عند الضغط على عرض التقارير</p>${active==='ledger'?'<p>اختار صنفًا واحدًا لمتابعة رصيده بعد كل حركة. رصيد كل صنف وفرع مستقل.</p>':''}${active==='consolidated'?'<p>الجمع لكل صنف ووحدته عبر الفروع المختارة. الرصيد المجمع غير متاح إذا نقص رصيد أحد الفروع.</p>':''}${tableHtml(rows.slice((page-1)*50,page*50))}<div class="pagination"><button class="btn" id="account-prev" ${page===1?'disabled':''}>السابق</button><span>${page} / ${pages}</span><button class="btn" id="account-next" ${page===pages?'disabled':''}>التالي</button></div>`;
    output.querySelector('#account-prev').onclick=()=>{page--;draw();};output.querySelector('#account-next').onclick=()=>{page++;draw();};
    if(insightNotes[active])output.insertAdjacentHTML('afterbegin',`<p class="report-definition">${escapeHtml(insightNotes[active])}</p>`);
  };
  root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{active=b.dataset.tab;page=1;draw();});
  root.querySelector('#account-mobile-picker').onchange=event=>{active=event.target.value;page=1;draw();};
  root.querySelector('#account-report-search').oninput=event=>root.querySelectorAll('[data-tab]').forEach(b=>{b.hidden=!b.textContent.includes(event.target.value.trim());});
  root.querySelector('#account-history').onclick=()=>showHistory(root,profile);
  const download=async all=>{
    if(!Object.keys(tables).length)return toast('اعرض البيانات أولًا','warning');
    if(!window.ExcelJS)return toast('مكتبة Excel غير متاحة؛ يمكنك الطباعة','error');
    const workbook=new window.ExcelJS.Workbook();
    for(const key of all?Object.keys(labels):[active]){
      const rows=tables[key]||[];
      const sheet=workbook.addWorksheet(labels[key].slice(0,31),{views:[{rightToLeft:true,state:'frozen',ySplit:3}]});
      sheet.addRow([labels[key],applied.from,applied.to]);
      sheet.addRow([insightNotes[key]||'غير متاح = لا يكفي المصدر لإثبات الرصيد. الأرصدة في نهاية اليوم؛ آخر جرد فعلي له تاريخه الموضح.',`تغطية مستهدفة ${applied.targetDays} يومًا`]);
      if(rows.length){const headers=Object.keys(rows[0]);sheet.addRow(headers);rows.forEach(r=>sheet.addRow(headers.map(h=>r[h]??'غير متاح')));sheet.autoFilter={from:{row:3,column:1},to:{row:3,column:headers.length}};sheet.columns=headers.map(()=>({width:23}));sheet.getRow(3).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(3).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF142A55'}};}
      else sheet.addRow(['لا توجد بيانات مطابقة']);
      sheet.pageSetup={orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:3'};
    }
    const blob=new Blob([await workbook.xlsx.writeBuffer()],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`تقارير_${all?'شاملة':active}_${applied.from}_${applied.to}.xlsx`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  root.querySelectorAll('[data-download]').forEach(b=>b.onclick=()=>download(b.dataset.download==='all').catch(e=>toast(e.message,'error')));
  root.querySelector('#account-print').onclick=()=>{
    if(!Object.keys(tables).length)return toast('اعرض البيانات أولًا','warning');
    const win=window.open('','_blank');if(!win)return toast('اسمح بنافذة الطباعة','warning');
    const printBody=active==='dashboard'?dashboardHtml(tables,applied,fmt,escapeHtml):tableHtml(tables[active]||[]);
    const reportNote=insightNotes[active]?`<p>${escapeHtml(insightNotes[active])}</p>`:'';
    win.document.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${labels[active]}</title><style>@page{size:A4 landscape;margin:8mm}body{font-family:Tahoma;font-size:9px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #bbb;padding:5px}th{background:#eee}thead{display:table-header-group}tr{break-inside:avoid}</style><style>${active==='dashboard'?root.querySelector('style').textContent:''}@media print{button{display:none!important}.account-chart-grid{grid-template-columns:1fr 1fr}.account-kpis{grid-template-columns:repeat(4,1fr)}}</style></head><body><h2>${labels[active]}</h2><p>${escapeHtml(applied.from)} — ${escapeHtml(applied.to)} · ${escapeHtml(groups.map(g=>g.branch.name).join('، '))}</p><p>غير متاح = بيانات غير كافية. آخر جرد فعلي مرتبط بتاريخه؛ رصيد النهاية يشمل الحركات حتى نهاية الفترة.</p>${reportNote}${printBody}</body></html>`);win.document.close();win.focus();win.print();
  };
  const load=async()=>{
    if(!form.reportValidity())return;
    if(form.elements.from.value>form.elements.to.value)return toast('بداية الفترة يجب أن تسبق نهايتها','warning');
    const query=form.elements.search.value.trim();
    if(query&&!materialSelect.value)return toast('اختار الصنف من القائمة أو امسح البحث لعرض كل الأصناف','warning');
    const ticket=++version;
    tables={};output.innerHTML='جارٍ تحميل الأرصدة والجرد والحركات كاملة…';status.textContent='';
    const params={from:form.elements.from.value,to:form.elements.to.value,branch:form.elements.branch.value,material:materialSelect.value,includeEmpty:form.elements.include_empty.checked,targetDays:Number(form.elements.target_days.value)};
    try{
      const loaded=await Promise.all(branches.filter(b=>!params.branch||b.id===params.branch).map(async branch=>{
        const {data,error}=await supabase.rpc('accounting_report_source',{target_branch:branch.id,through_date:params.to});
        if(error)throw error;
        const source=data;
        source.consumption=source.consumption.map(r=>({...r,destination:allBranches.find(b=>b.id===r.transfer_to)?.name||''}));
        const relevant=new Set([...source.entries,...source.additions,...source.consumption,...source.openings].map(r=>r.material_id));
        const scope=materials.filter(m=>params.includeEmpty||relevant.has(m.id)||m.id===params.material);
        return {branch,source,accounts:calculateAccounts(source,scope,params.from,params.to)};
      }));
      if(ticket!==version||!root.contains(output))return;
      groups=loaded;applied=params;tables=reportTables(groups,params.material);page=1;
      Object.assign(tables,buildInsights(groups,params,tables.expiry));
      tables.dashboard=tables.branches;
      const open=groups.flatMap(g=>g.source.sessions).filter(s=>s.status!=='completed').length;
      status.textContent=`تم تحميل ${groups.length} فرع. ${open?`${open} جرد مفتوح لا يدخل في الرصيد المعتمد. `:''}كل الصادرات تشمل جميع السطور المطابقة، وليس الصفحة الظاهرة فقط.`;
      draw();
    }catch(error){if(ticket!==version)return;tables={};output.innerHTML='<div class="empty-state">تعذر تحميل التقرير كاملًا. حاول مرة أخرى.</div>';status.textContent=error.message||'خطأ في الاتصال';}
  };
  form.onsubmit=e=>{e.preventDefault();load();};
  root.querySelector('#account-august').onclick=()=>{form.elements.from.value='2026-08-01';form.elements.to.value='2026-08-31';load();};
  await load();
}
