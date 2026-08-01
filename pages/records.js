import { today, toast, escapeHtml, money, confirmDialog } from '../supabase.js?v=20260801-audit-context';
import { list, hydrate, update, remove } from '../data.js?v=20260801-reception-features';

const PAGE_SIZE = 20;
let currentPage = 1;

export async function renderRecords(root, profile) {
  const [allBranches, materials] = await Promise.all([list('branches'), list('materials')]);
  const allowedIds = profile.branch_ids?.length ? profile.branch_ids : [profile.branch_id];
  const branches = allBranches.filter(branch => allowedIds.includes(branch.id));
  const monthStart = new Date();
  monthStart.setDate(1);
  root.innerHTML = `<div class="page-intro"><div><h2>إدارة السجلات</h2><p>اختر فترة زمنية لمراجعة وتعديل أو حذف حركات الصرف والإضافات حسب صلاحياتك.</p></div></div>
  <section class="panel"><div class="panel-body"><form class="filters records-filters" id="records-filters">
    <div class="field"><label>من تاريخ<input type="date" name="from" value="${monthStart.toLocaleDateString('en-CA')}" required></label></div>
    <div class="field"><label>إلى تاريخ<input type="date" name="to" value="${today()}" required></label></div>
    <div class="field"><label>الفرع<select name="branch"><option value="">كل الفروع المسموحة</option>${branches.map(branch => `<option value="${branch.id}">${escapeHtml(branch.name)}</option>`).join('')}</select></label></div>
    <div class="field"><label>نوع الحركة<select name="type"><option value="all">الصرف والإضافات</option><option value="consumption">الصرف فقط</option><option value="additions">الإضافات فقط</option></select></label></div>
    <div class="field"><label>العميلة<input type="search" name="client_search" autocomplete="off" placeholder="اسم العميلة أو الكود"></label></div>
    <div class="field"><label>الصنف<input type="search" name="material_search" autocomplete="off" placeholder="اسم الصنف أو كوده"></label></div>
    <button class="btn primary" type="submit">عرض السجلات</button>
  </form></div></section><div id="records-output"></div>`;
  const form = root.querySelector('#records-filters');
  let cachedRows = [];
  const showFilteredRows = () => {
    const clientQuery = normalizeSearch(form.client_search.value);
    const materialQuery = normalizeSearch(form.material_search.value);
    const rows = cachedRows.filter(row => {
      const clientText = normalizeSearch([row.client_name, row.client_code].join(' '));
      const materialText = normalizeSearch([row.materials?.name, row.materials?.code].join(' '));
      return (!clientQuery || clientText.includes(clientQuery)) && (!materialQuery || materialText.includes(materialQuery));
    });
    drawRows(root.querySelector('#records-output'), rows, branches, allBranches, materials, profile, load);
  };
  const load = async (resetPage = false) => {
    if (form.from.value > form.to.value) return toast('تاريخ البداية يجب أن يكون قبل تاريخ النهاية', 'warning');
    if (resetPage) currentPage = 1;
    const filters = { date_from: form.from.value, date_to: form.to.value };
    if (form.branch.value) filters.branch_id = form.branch.value;
    const type = form.type.value;
    const output = root.querySelector('#records-output');
    output.innerHTML = '<div class="empty-state">جارٍ تحميل السجلات...</div>';
    const [consumption, additions] = await Promise.all([
      type === 'additions' ? [] : list('consumption', filters),
      type === 'consumption' ? [] : list('additions', filters),
    ]);
    cachedRows = [
      ...hydrate(consumption).map(row => ({ ...row, movement: 'consumption' })),
      ...hydrate(additions).map(row => ({ ...row, movement: 'additions' })),
    ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    showFilteredRows();
  };
  form.onsubmit = event => { event.preventDefault(); load(true); };
  [form.client_search, form.material_search].forEach(input => input.oninput = () => { currentPage = 1; showFilteredRows(); });
  await load(true);
}

function normalizeSearch(value) {
  return String(value || '').toLocaleLowerCase('ar').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim();
}

function drawRows(output, rows, branches, allBranches, materials, profile, reload) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), pages);
  const visible = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const canEdit = !!profile.permissions?.edit_records;
  const canDelete = !!profile.permissions?.delete_records;
  const actionHeader = canEdit || canDelete ? '<th>الإجراءات</th>' : '';
  output.innerHTML = `<section class="panel"><div class="panel-head"><div><h3>السجلات المطابقة</h3><p>${rows.length} حركة — يعرض كل صفحة 20 سجلًا</p></div><div class="record-access-hint">${canEdit ? '<span class="badge client">تعديل مسموح</span>' : ''}${canDelete ? '<span class="badge delete-badge">حذف مسموح</span>' : ''}</div></div><div class="table-wrap">${rows.length ? `<table class="data-table"><thead><tr><th>التاريخ</th><th>الوقت</th><th>الفرع</th><th>الحركة</th><th>العميلة / البيان</th><th>الصنف</th><th>الكمية</th><th>القيمة</th><th>بواسطة</th>${actionHeader}</tr></thead><tbody>${visible.map(row => recordRow(row, canEdit, canDelete)).join('')}</tbody></table>` : '<div class="empty-state"><b>—</b>لا توجد سجلات في الفترة المختارة</div>'}</div>${pagination(rows.length, pages)}</section>`;
  output.querySelectorAll('[data-record-edit]').forEach(button => button.onclick = () => {
    const row = rows.find(item => item.id === button.dataset.recordEdit && item.movement === button.dataset.kind);
    openEditModal(row, branches, allBranches, materials, reload);
  });
  output.querySelectorAll('[data-record-delete]').forEach(button => button.onclick = async () => {
    const kind = button.dataset.kind;
    if (!await confirmDialog('حذف السجل', 'سيتم حذف الحركة نهائيًا من التقارير والأرصدة. هل تريد المتابعة؟')) return;
    try {
      await remove(kind, button.dataset.recordDelete);
      toast('تم حذف السجل');
      await reload();
    } catch (error) { toast(error.message, 'error'); }
  });
  output.querySelectorAll('[data-record-page]').forEach(button => button.onclick = () => {
    currentPage = Number(button.dataset.recordPage);
    drawRows(output, rows, branches, allBranches, materials, profile, reload);
  });
}

function recordRow(row, canEdit, canDelete) {
  const consumption = row.movement === 'consumption';
  const description = consumption
    ? `<span class="row-title">${escapeHtml(row.client_name || 'بدون اسم')}</span><small class="row-sub">${escapeHtml(row.client_code || 'بدون كود')}</small>`
    : escapeHtml(row.notes || 'إضافة مخزون');
  const actions = canEdit || canDelete ? `<td><div class="record-actions">${canEdit ? `<button class="edit-icon" data-record-edit="${row.id}" data-kind="${row.movement}" title="تعديل">✎</button>` : ''}${canDelete ? `<button class="delete-icon" data-record-delete="${row.id}" data-kind="${row.movement}" title="حذف">×</button>` : ''}</div></td>` : '';
  return `<tr><td>${escapeHtml(row.date)}</td><td>${new Date(row.created_at).toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' })}</td><td>${escapeHtml(row.branches?.name || '—')}</td><td><span class="badge ${consumption ? row.record_type : 'admin'}">${consumption ? row.record_type === 'transfer' ? 'تحويل' : 'صرف' : 'إضافة'}</span></td><td>${description}</td><td><span class="row-title">${escapeHtml(row.materials?.name || '—')}</span><small class="row-sub">${escapeHtml(row.materials?.code || '')}</small></td><td>${money(row.quantity)} ${escapeHtml(row.unit || row.materials?.unit || '')}</td><td>${consumption ? money(Number(row.total_selling_price ?? row.selling_price ?? 0)) + ' ج.م' : '—'}</td><td>${escapeHtml(row.users?.full_name || '—')}</td>${actions}</tr>`;
}

function pagination(total, pages) {
  if (!total) return '';
  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, total);
  return `<div class="pagination-bar"><span>عرض ${start}–${end} من ${total}</span>${pages > 1 ? `<div class="pagination-controls"><button data-record-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>السابق</button><b>${currentPage} / ${pages}</b><button data-record-page="${currentPage + 1}" ${currentPage === pages ? 'disabled' : ''}>التالي</button></div>` : '<b>صفحة 1 / 1</b>'}</div>`;
}

function openEditModal(row, branches, allBranches, materials, reload) {
  const root = document.getElementById('modal-root');
  const consumption = row.movement === 'consumption';
  const branchOptions = branches.map(branch => `<option value="${branch.id}" ${branch.id === row.branch_id ? 'selected' : ''}>${escapeHtml(branch.name)}</option>`).join('');
  const materialOptions = materials.map(material => `<option value="${material.id}" ${material.id === row.material_id ? 'selected' : ''}>${escapeHtml(material.name)} — ${escapeHtml(material.code)}</option>`).join('');
  const transferOptions = allBranches.filter(branch => branch.id !== row.branch_id).map(branch => `<option value="${branch.id}" ${branch.id === row.transfer_to ? 'selected' : ''}>${escapeHtml(branch.name)}</option>`).join('');
  root.innerHTML = `<div class="modal-backdrop"><form class="modal record-edit-modal"><button type="button" class="modal-x">×</button><h3>تعديل ${consumption ? 'سجل الصرف' : 'سجل الإضافة'}</h3><p>أي تعديل هنا يظهر فورًا في التقارير والأرصدة.</p><div class="form-grid two">
    <div class="field"><label>التاريخ <em>*</em><input type="date" name="date" value="${row.date}" required></label></div>
    <div class="field"><label>الفرع <em>*</em><select name="branch_id" required>${branchOptions}</select></label></div>
    <div class="field span-2"><label>الصنف <em>*</em><select name="material_id" required>${materialOptions}</select></label></div>
    <div class="field"><label>الكمية <em>*</em><input type="number" name="quantity" min="0.01" step="any" value="${Number(row.quantity)}" required></label></div>
    ${consumption ? `<div class="field"><label>الوحدة <em>*</em><input name="unit" value="${escapeHtml(row.unit || row.materials?.unit || '')}" required></label></div><div class="field"><label>اسم العميلة <small>(الاسم أو الكود)</small><input name="client_name" value="${escapeHtml(row.client_name || '')}"></label></div><div class="field"><label>كود العميلة <small>(الاسم أو الكود)</small><input name="client_code" value="${escapeHtml(row.client_code || '')}"></label></div><div class="field"><label>إجمالي سعر البيع<input type="number" name="selling_price" min="0" step="any" value="${Number(row.total_selling_price ?? row.selling_price ?? 0)}"></label></div><div class="field"><label>نوع الحركة<select name="record_type"><option value="client" ${row.record_type === 'client' ? 'selected' : ''}>صرف لعميلة</option><option value="transfer" ${row.record_type === 'transfer' ? 'selected' : ''}>تحويل لفرع</option></select></label></div><div class="field" data-transfer-edit ${row.record_type === 'transfer' ? '' : 'hidden'}><label>الفرع المستلم<select name="transfer_to"><option value="">اختر الفرع</option>${transferOptions}</select></label></div>` : `<div class="field span-2"><label>ملاحظات<textarea name="notes">${escapeHtml(row.notes || '')}</textarea></label></div>`}
  </div><div class="modal-actions"><button type="button" class="btn ghost modal-cancel">إلغاء</button><button type="submit" class="btn primary">حفظ التعديل</button></div></form></div>`;
  const form = root.querySelector('form');
  const close = () => { root.innerHTML = ''; };
  root.querySelectorAll('.modal-x,.modal-cancel').forEach(button => button.onclick = close);
  if (consumption) form.record_type.onchange = () => { form.querySelector('[data-transfer-edit]').hidden = form.record_type.value !== 'transfer'; };
  form.onsubmit = async event => {
    event.preventDefault();
    const payload = { date: form.date.value, branch_id: form.branch_id.value, material_id: form.material_id.value, quantity: Number(form.quantity.value) };
    if (consumption) {
      payload.client_name = form.client_name.value.trim() || null;
      payload.client_code = form.client_code.value.trim() || null;
      payload.unit = form.unit.value.trim();
      payload.selling_price = Number(form.selling_price.value || 0);
      payload.total_selling_price = Number(form.selling_price.value || 0);
      payload.record_type = form.record_type.value;
      payload.transfer_to = form.record_type.value === 'transfer' ? form.transfer_to.value || null : null;
      if (payload.record_type === 'client' && !payload.client_name && !payload.client_code) return toast('اكتب اسم العميلة أو كودها', 'warning');
      if (payload.record_type === 'transfer' && !payload.transfer_to) return toast('اختر الفرع المستلم', 'warning');
    } else payload.notes = form.notes.value.trim();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    button.textContent = 'جارٍ الحفظ...';
    try {
      await update(row.movement, row.id, payload);
      toast('تم حفظ التعديل');
      close();
      await reload();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
      button.textContent = 'حفظ التعديل';
    }
  };
}
