import { today, toast, escapeHtml } from '../supabase.js?v=20260801-audit-context';
import { insert, searchMaterials } from '../data.js?v=20260801-multi-additions';
import { openTemporaryMaterial } from './temp-material.js?v=20260730-temp-save-v2';

export async function renderAdditions(root, profile) {
  let selected = null;
  let lines = [];
  root.innerHTML = `<div class="page-intro"><div><h2>إضافات المخزون</h2><p>أنشئ إذن إضافة واحدًا يحتوي على صنف واحد أو عدة أصناف.</p></div><button class="btn gold" id="add-temp-material">＋ إضافة صنف مؤقت</button></div>
  <form class="panel" id="addition-form"><div class="panel-head"><div><h3>إذن إضافة جديد</h3><p>أضف الأصناف والكميات إلى الإذن، ثم احفظهم كلهم مرة واحدة.</p></div><span class="addition-document-count" id="addition-document-count">0 صنف</span></div><div class="panel-body">
    <div class="form-grid addition-header-fields"><div class="field"><label>التاريخ <em>*</em><input type="date" name="date" value="${today()}" required></label></div><div class="field span-2"><label>ملاحظات الإذن<textarea name="notes" placeholder="رقم الفاتورة أو اسم المورد..."></textarea></label></div></div>
    <div class="addition-line-builder"><div class="field search-wrap"><label>الصنف <em>*</em><input id="add-search" autocomplete="off" placeholder="ابحث بالاسم أو الكود"></label><div id="add-results" class="autocomplete" hidden></div><div id="add-selected"></div></div><div class="field"><label>الكمية <em>*</em><input type="number" id="add-line-quantity" min="0.01" step="any" placeholder="0"></label></div><button type="button" class="btn gold" id="add-line">＋ أضف الصنف للإذن</button></div>
    <div id="addition-lines" class="addition-lines"></div>
    <div class="form-actions"><button type="reset" class="btn ghost">مسح الإذن</button><button type="submit" class="btn primary">حفظ الإذن بالكامل ←</button></div>
  </div></form>`;

  const form = root.querySelector('#addition-form');
  const search = root.querySelector('#add-search');
  const results = root.querySelector('#add-results');
  const selectedBox = root.querySelector('#add-selected');
  const quantity = root.querySelector('#add-line-quantity');
  const linesBox = root.querySelector('#addition-lines');
  const countBox = root.querySelector('#addition-document-count');

  function pick(material) {
    selected = material;
    selectedBox.innerHTML = `<div class="selected-material"><span><b>${escapeHtml(material.name)}</b> · ${escapeHtml(material.code)}</span><span>${escapeHtml(material.unit)}</span></div>`;
    search.value = '';
    results.hidden = true;
    quantity.focus();
  }

  function clearBuilder() {
    selected = null;
    selectedBox.innerHTML = '';
    search.value = '';
    quantity.value = '';
  }

  function drawLines() {
    countBox.textContent = `${lines.length} صنف`;
    linesBox.innerHTML = lines.length ? `<div class="table-wrap"><table class="data-table addition-lines-table"><thead><tr><th>#</th><th>الصنف</th><th>الكود</th><th>الكمية</th><th></th></tr></thead><tbody>${lines.map((line, index) => `<tr><td>${index + 1}</td><td class="row-title">${escapeHtml(line.material.name)}</td><td>${escapeHtml(line.material.code)}</td><td><b>${line.quantity.toLocaleString('ar-EG-u-nu-latn')}</b> ${escapeHtml(line.material.unit)}</td><td><button type="button" class="delete-icon" data-remove-line="${index}" title="حذف الصنف">×</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="addition-empty">لم تضف أصنافًا إلى الإذن بعد.</div>';
    linesBox.querySelectorAll('[data-remove-line]').forEach(button => button.onclick = () => {
      lines.splice(Number(button.dataset.removeLine), 1);
      drawLines();
    });
  }

  function addLine() {
    if (!selected) return toast('اختر الصنف أولًا', 'warning');
    const amount = Number(quantity.value);
    if (!Number.isFinite(amount) || amount <= 0) return toast('اكتب كمية صحيحة', 'warning');
    const existing = lines.find(line => line.material.id === selected.id);
    if (existing) existing.quantity += amount;
    else lines.push({ material: selected, quantity: amount });
    clearBuilder();
    drawLines();
    search.focus();
  }

  const saveTemporary = async material => {
    const [saved] = await insert('materials', { ...material, created_by: profile.id });
    pick(saved);
    toast('تمت إضافة الصنف المؤقت واختياره للإذن');
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
  quantity.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addLine(); } };
  root.querySelector('#add-line').onclick = addLine;
  root.querySelector('#add-temp-material').onclick = () => openTemporaryMaterial('', saveTemporary);
  form.onreset = () => setTimeout(() => { lines = []; clearBuilder(); form.date.value = today(); drawLines(); }, 0);
  form.onsubmit = async event => {
    event.preventDefault();
    if (!lines.length) return toast('أضف صنفًا واحدًا على الأقل إلى الإذن', 'warning');
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const documentId = crypto.randomUUID();
      const notes = form.notes.value.trim();
      await insert('additions', lines.map(line => ({
        document_id: documentId,
        date: form.date.value,
        branch_id: profile.branch_id,
        material_id: line.material.id,
        quantity: line.quantity,
        added_by: profile.id,
        notes,
      })));
      toast(`تم حفظ إذن الإضافة بنجاح (${lines.length} صنف)`);
      const keptDate = form.date.value;
      form.reset();
      form.date.value = keptDate;
    } catch (error) { toast(error.message, 'error'); }
    finally { submit.disabled = false; }
  };
  drawLines();
}
