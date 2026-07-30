import { today, toast, escapeHtml } from '../supabase.js?v=20260730-latin-digits';
import { insert, searchMaterials } from '../data.js?v=20260730-latin-digits';
import { openTemporaryMaterial } from './temp-material.js?v=20260730-temp-save-v2';

export async function renderAdditions(root, profile) {
  let selected = null;
  root.innerHTML = `<div class="page-intro"><div><h2>إضافات المخزون</h2><p>سجّل الكميات الجديدة الواردة إلى الفرع.</p></div><button class="btn gold" id="add-temp-material">＋ إضافة صنف مؤقت</button></div>
  <form class="panel" id="addition-form"><div class="panel-head"><div><h3>إضافة جديدة</h3><p>اختر الصنف وحدد الكمية الواردة. تعديل الحركات السابقة موجود في صفحة إدارة السجلات.</p></div></div><div class="panel-body"><div class="form-grid"><div class="field"><label>التاريخ <em>*</em><input type="date" name="date" value="${today()}" required></label></div><div class="field span-2 search-wrap"><label>المادة <em>*</em><input id="add-search" autocomplete="off" placeholder="ابحث بالاسم أو الكود"></label><div id="add-results" class="autocomplete" hidden></div><div id="add-selected"></div></div><div class="field"><label>الكمية المضافة <em>*</em><input type="number" name="quantity" min="0.01" step="any" placeholder="0" required></label></div><div class="field span-2"><label>ملاحظات<textarea name="notes" placeholder="رقم الفاتورة أو اسم المورد..."></textarea></label></div></div><div class="form-actions"><button type="reset" class="btn ghost">مسح</button><button type="submit" class="btn primary">تسجيل الإضافة ←</button></div></div></form>`;
  const form = root.querySelector('form');
  const search = root.querySelector('#add-search');
  const results = root.querySelector('#add-results');
  const selectedBox = root.querySelector('#add-selected');
  function pick(material) {
    selected = material;
    selectedBox.innerHTML = `<div class="selected-material"><span><b>${escapeHtml(material.name)}</b> · ${escapeHtml(material.code)}</span><span>${escapeHtml(material.unit)}</span></div>`;
    search.value = '';
    results.hidden = true;
  }
  const saveTemporary = async material => {
    const [saved] = await insert('materials', { ...material, created_by: profile.id });
    pick(saved);
    toast('تمت إضافة الصنف المؤقت واختياره للإضافة');
  };
  let timer;
  search.oninput = () => {
    clearTimeout(timer);
    if (search.value.trim().length < 2) { results.hidden = true; return; }
    timer = setTimeout(async () => {
      const found = await searchMaterials(search.value.trim());
      const query = search.value.trim();
      results.innerHTML = found.map(material => `<button type="button" data-id="${material.id}"><b>${escapeHtml(material.name)} ${material.is_temp ? '<i class="badge temp">مؤقت</i>' : ''}</b><small>${escapeHtml(material.code)} · ${escapeHtml(material.unit)}</small></button>`).join('') || `<div class="empty-state compact-empty"><b>—</b>الصنف غير موجود<button type="button" class="btn gold" data-create-temp>＋ إضافة «${escapeHtml(query)}» كصنف مؤقت</button></div>`;
      results.hidden = false;
      results.querySelectorAll('button').forEach(button => button.onclick = () => button.hasAttribute('data-create-temp') ? openTemporaryMaterial(query, saveTemporary) : pick(found.find(material => material.id === button.dataset.id)));
    }, 200);
  };
  root.querySelector('#add-temp-material').onclick = () => openTemporaryMaterial('', saveTemporary);
  form.onreset = () => setTimeout(() => { selected = null; selectedBox.innerHTML = ''; form.date.value = today(); }, 0);
  form.onsubmit = async event => {
    event.preventDefault();
    if (!selected) return toast('اختر المادة أولًا', 'warning');
    try {
      await insert('additions', { date: form.date.value, branch_id: profile.branch_id, material_id: selected.id, quantity: Number(form.quantity.value), added_by: profile.id, notes: form.notes.value.trim() });
      toast('تم تسجيل الإضافة بنجاح');
      const keptDate = form.date.value;
      form.reset();
      form.date.value = keptDate;
    } catch (error) { toast(error.message, 'error'); }
  };
}
