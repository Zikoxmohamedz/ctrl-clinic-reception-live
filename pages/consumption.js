import { today, toast, escapeHtml } from '../supabase.js';
import { list, insert, searchMaterials } from '../data.js';
import { openTemporaryMaterial } from './temp-material.js';

export async function renderConsumption(root, profile) {
  const branches = await list('branches');
  let items = [];
  root.innerHTML = `<div class="page-intro"><div><h2>صرف المواد</h2><p>سجّل المواد المستخدمة للعميلة أو المحوّلة إلى فرع آخر.</p></div><button class="btn gold" id="temp-material">＋ إضافة صنف مؤقت</button></div>
  <form class="panel" id="consumption-form">
    <div class="panel-head"><div><h3>بيانات العملية</h3><p>في صرف العميلة يكفي كتابة الاسم أو الكود، وليس الاثنين.</p></div></div>
    <div class="panel-body">
      <div class="form-grid">
        <div class="field"><label>التاريخ <em>*</em><input type="date" name="date" value="${today()}" required></label></div>
        <div class="field"><label>اسم العميلة <small>(الاسم أو الكود)</small><input name="client_name" placeholder="الاسم بالكامل"></label></div>
        <div class="field"><label>كود العميلة <small>(الاسم أو الكود)</small><input name="client_code" placeholder="مثال: C-1048"></label></div>
        <div class="field"><label>نوع العملية <em>*</em><span class="radio-group"><label class="radio-card"><input type="radio" name="record_type" value="client" checked><span>صرف لعميلة</span></label><label class="radio-card"><input type="radio" name="record_type" value="transfer"><span>تحويل لفرع</span></label></span></label></div>
        <div class="field" id="transfer-field" hidden><label>الفرع المستلم <em>*</em><select name="transfer_to"><option value="">اختر الفرع</option>${branches.filter(branch => branch.id !== profile.branch_id).map(branch => `<option value="${branch.id}">${escapeHtml(branch.name)}</option>`).join('')}</select></label></div>
      </div>
      <div class="section-divider"></div>
      <div class="field search-wrap"><label>البحث عن مادة <input id="material-search" autocomplete="off" placeholder="اكتب اسم المادة أو الكود (حرفان على الأقل)"></label><div id="material-results" class="autocomplete" hidden></div></div>
      <div class="table-wrap" style="margin-top:16px"><table class="data-table"><thead><tr><th>المادة</th><th>الوحدة</th><th>الكمية *</th><th>سعر الوحدة للعميلة</th><th></th></tr></thead><tbody id="items-body"></tbody></table><div id="items-empty" class="empty-state"><b>＋</b>ابحث عن مادة وأضفها إلى العملية</div></div>
      <div class="form-actions"><button type="reset" class="btn ghost">مسح البيانات</button><button class="btn primary" type="submit">تسجيل الصرف ←</button></div>
    </div>
  </form>`;

  const form = root.querySelector('#consumption-form');
  const search = root.querySelector('#material-search');
  const results = root.querySelector('#material-results');
  const tbody = root.querySelector('#items-body');
  const saveTemporary = async material => {
    const [saved] = await insert('materials', { ...material, created_by: profile.id });
    items.push(saved);
    renderItems();
    search.value = '';
    results.hidden = true;
    toast('تمت إضافة الصنف المؤقت إلى العملية');
  };

  form.record_type.forEach(radio => radio.onchange = () => {
    const transfer = radio.value === 'transfer' && radio.checked;
    root.querySelector('#transfer-field').hidden = !transfer;
    if (transfer) {
      form.client_name.value = 'تحويل للفرع';
      form.client_code.value = `TR-${Date.now().toString().slice(-5)}`;
    } else if (form.client_name.value === 'تحويل للفرع') {
      form.client_name.value = '';
      form.client_code.value = '';
      form.transfer_to.value = '';
    }
  });

  function renderItems() {
    tbody.innerHTML = items.map((material, index) => `<tr><td><span class="row-title">${escapeHtml(material.name)}</span><small class="row-sub">${escapeHtml(material.code)}</small></td><td>${escapeHtml(material.unit)}</td><td><input class="table-input" type="number" min="0.01" step="any" data-q="${index}" value="${material.quantity || 1}" required></td><td><input class="table-input" type="number" min="0" step="any" data-p="${index}" value="${Number(material.default_price || 0)}" placeholder="0"></td><td><button type="button" class="delete-icon" data-remove="${index}">×</button></td></tr>`).join('');
    root.querySelector('#items-empty').hidden = items.length > 0;
    tbody.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => {
      items.splice(Number(button.dataset.remove), 1);
      renderItems();
    });
  }

  let timer;
  search.oninput = () => {
    clearTimeout(timer);
    const query = search.value.trim();
    if (query.length < 2) { results.hidden = true; return; }
    timer = setTimeout(async () => {
      const found = await searchMaterials(query);
      results.innerHTML = found.map(material => `<button type="button" data-id="${material.id}"><span><b>${escapeHtml(material.name)} ${material.is_temp ? '<i class="badge temp">مؤقت</i>' : ''}</b><small class="row-sub">${escapeHtml(material.category || 'بدون فئة')}</small></span><small>${escapeHtml(material.code)} · ${escapeHtml(material.unit)}</small></button>`).join('') || `<div class="empty-state compact-empty"><b>—</b>الصنف غير موجود<button type="button" class="btn gold" data-create-temp>＋ إضافة «${escapeHtml(query)}» كصنف مؤقت</button></div>`;
      results.hidden = false;
      results.querySelectorAll('button').forEach(button => button.onclick = () => {
        if (button.hasAttribute('data-create-temp')) return openTemporaryMaterial(query, saveTemporary);
        const material = found.find(item => item.id === button.dataset.id);
        if (!items.some(item => item.id === material.id)) items.push(material);
        renderItems();
        search.value = '';
        results.hidden = true;
      });
    }, 220);
  };

  root.querySelector('#temp-material').onclick = () => openTemporaryMaterial('', saveTemporary);

  form.onreset = () => setTimeout(() => {
    items = [];
    renderItems();
    form.date.value = today();
    root.querySelector('#transfer-field').hidden = true;
  }, 0);

  form.onsubmit = async event => {
    event.preventDefault();
    const type = form.record_type.value;
    const clientName = form.client_name.value.trim();
    const clientCode = form.client_code.value.trim();
    if (type === 'client' && !clientName && !clientCode) return toast('اكتب اسم العميلة أو كود العميلة', 'warning');
    if (type === 'transfer' && !form.transfer_to.value) return toast('اختر الفرع المستلم', 'warning');
    if (!items.length) return toast('أضف مادة واحدة على الأقل', 'warning');
    const payload = items.map((material, index) => ({
      date: form.date.value,
      branch_id: profile.branch_id,
      client_name: clientName || null,
      client_code: clientCode || null,
      material_id: material.id,
      quantity: Number(tbody.querySelector(`[data-q="${index}"]`).value),
      unit: material.unit,
      selling_price: Number(tbody.querySelector(`[data-p="${index}"]`).value || 0),
      transfer_to: type === 'transfer' ? form.transfer_to.value : null,
      record_type: type,
      created_by: profile.id,
      notes: null,
    }));
    if (payload.some(row => !row.quantity || row.quantity <= 0)) return toast('راجع الكميات المدخلة', 'warning');
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      await insert('consumption', payload);
      toast(`تم تسجيل ${payload.length} مادة بنجاح`);
      const keptDate = form.date.value;
      form.reset();
      form.date.value = keptDate;
      items = [];
      renderItems();
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  };
}
