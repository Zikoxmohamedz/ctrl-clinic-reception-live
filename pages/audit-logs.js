import { escapeHtml, supabase, today, toast } from '../supabase.js';
import { list } from '../data.js';

const PAGE_SIZE = 25;
const pageLabels = { consumption: 'صرف المواد', additions: 'الإضافات', records: 'إدارة السجلات', settings: 'الإعدادات' };
const tableLabels = { consumption_records: 'سجل صرف', stock_additions: 'سجل إضافة', materials: 'صنف', branches: 'فرع', users: 'مستخدم', user_branches: 'فروع المستخدم', user_permissions: 'صلاحيات المستخدم' };
const actionLabels = { INSERT: 'إضافة', UPDATE: 'تعديل', DELETE: 'حذف' };
const fieldLabels = {
  quantity: 'الكمية', selling_price: 'إجمالي سعر البيع', date: 'التاريخ', material_id: 'الصنف', branch_id: 'الفرع',
  client_name: 'اسم العميلة', client_code: 'كود العميلة', unit: 'الوحدة', notes: 'الملاحظات', record_type: 'نوع الحركة',
  transfer_to: 'الفرع المستلم', name: 'الاسم', code: 'الكود', barcode: 'الباركود', category: 'التصنيف',
  default_price: 'إجمالي سعر البيع الافتراضي', scope: 'نطاق الصنف', is_temp: 'صنف مؤقت', archived_at: 'حالة الأرشفة',
  full_name: 'الاسم الكامل', username: 'اسم المستخدم', email: 'البريد الإلكتروني', role: 'المسمى الوظيفي', user_id: 'المستخدم',
  can_home: 'لوحة التحكم', can_consumption: 'صرف المواد', can_additions: 'الإضافات', can_reports: 'التقارير',
  can_records: 'إدارة السجلات', can_edit_records: 'تعديل السجلات', can_delete_records: 'حذف السجلات',
  can_audit_logs: 'سجل التعديلات', can_settings: 'الإعدادات',
};
let currentPage = 1;

export async function renderAuditLogs(root, profile) {
  const monthStart = new Date();
  monthStart.setDate(1);
  const [allBranches, users, materials] = await Promise.all([list('branches'), list('users'), list('materials')]);
  const allowedIds = profile.branch_ids?.length ? profile.branch_ids : [profile.branch_id];
  const branches = allBranches.filter(branch => allowedIds.includes(branch.id));
  const lookup = {
    branches: new Map(allBranches.map(item => [item.id, item.name])),
    users: new Map(users.map(item => [item.id, item.full_name || item.username])),
    materials: new Map(materials.map(item => [item.id, item.name])),
  };

  root.innerHTML = `<div class="page-intro audit-intro"><div><p class="eyebrow">رقابة واضحة وآمنة</p><h2>سجل التعديلات</h2><p>اعرف مين غيّر إيه، والقيمة كانت كام وبقت كام. هذه الصفحة للعرض فقط ولا يمكن تعديل أو حذف أي سجل منها.</p></div><span class="audit-readonly">للعرض فقط</span></div>
  <section class="panel audit-filter-panel"><div class="panel-body"><form class="filters audit-filters" id="audit-filters">
    <div class="field"><label>من تاريخ<input type="date" name="from" value="${monthStart.toLocaleDateString('en-CA')}" required></label></div>
    <div class="field"><label>إلى تاريخ<input type="date" name="to" value="${today()}" required></label></div>
    <div class="field"><label>الفرع<select name="branch"><option value="">كل الفروع المسموحة</option>${branches.map(branch => `<option value="${branch.id}">${escapeHtml(branch.name)}</option>`).join('')}</select></label></div>
    <div class="field"><label>المستخدم<select name="actor"><option value="">كل المستخدمين</option>${users.map(user => `<option value="${user.id}">${escapeHtml(user.full_name || user.username)}</option>`).join('')}<option value="system">النظام</option></select></label></div>
    <div class="field"><label>نوع الإجراء<select name="action"><option value="">كل الإجراءات</option><option value="UPDATE">التعديلات فقط</option><option value="INSERT">الإضافات فقط</option><option value="DELETE">الحذف فقط</option></select></label></div>
    <div class="field"><label>الصفحة<select name="page"><option value="">كل الصفحات</option>${Object.entries(pageLabels).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label></div>
    <div class="field audit-search"><label>بحث<input type="search" name="search" autocomplete="off" placeholder="اسم الصنف أو المستخدم أو القيمة"></label></div>
    <button class="btn primary" type="submit">عرض السجل</button>
  </form></div></section><div id="audit-output"></div>`;

  const form = root.querySelector('#audit-filters');
  let cachedRows = [];
  const redraw = () => {
    const term = normalize(form.search.value);
    const filtered = term ? cachedRows.filter(row => normalize(searchText(row, lookup)).includes(term)) : cachedRows;
    drawRows(root.querySelector('#audit-output'), filtered, lookup);
  };
  const load = async resetPage => {
    if (form.from.value > form.to.value) return toast('تاريخ البداية يجب أن يكون قبل تاريخ النهاية', 'warning');
    if (resetPage) currentPage = 1;
    root.querySelector('#audit-output').innerHTML = '<div class="empty-state">جارٍ تحميل سجل التعديلات...</div>';
    let query = supabase.from('audit_logs')
      .select('*,actors:users!audit_logs_actor_id_fkey(full_name,username),branches(name)')
      .gte('occurred_at', new Date(`${form.from.value}T00:00:00`).toISOString())
      .lte('occurred_at', new Date(`${form.to.value}T23:59:59.999`).toISOString())
      .order('occurred_at', { ascending: false }).limit(1000);
    if (form.branch.value) query = query.eq('branch_id', form.branch.value);
    if (form.actor.value === 'system') query = query.is('actor_id', null);
    else if (form.actor.value) query = query.eq('actor_id', form.actor.value);
    if (form.action.value) query = query.eq('action', form.action.value);
    if (form.page.value) query = query.eq('page_key', form.page.value);
    const { data, error } = await query;
    if (error) throw error;
    cachedRows = data || [];
    redraw();
  };
  form.onsubmit = event => { event.preventDefault(); load(true).catch(showError); };
  form.search.oninput = () => { currentPage = 1; redraw(); };
  await load(true);
}

function drawRows(output, rows, lookup) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), pages);
  const visible = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const updated = rows.filter(row => row.action === 'UPDATE').length;
  const deleted = rows.filter(row => row.action === 'DELETE').length;
  output.innerHTML = `<section class="audit-stats"><article><span>إجمالي الحركات</span><strong>${rows.length}</strong></article><article class="audit-stat-update"><span>تعديلات</span><strong>${updated}</strong></article><article class="audit-stat-delete"><span>حذف</span><strong>${deleted}</strong></article></section>
  <section class="panel audit-results"><div class="panel-head"><div><h3>الحركات المسجلة</h3><p>${rows.length ? `يعرض الأحدث أولًا · ${rows.length} حركة` : 'لا توجد حركات مطابقة للفلاتر المختارة'}</p></div><span class="audit-lock">لا يمكن التعديل أو الحذف</span></div>
  <div class="table-wrap">${rows.length ? `<table class="data-table audit-table"><thead><tr><th>التاريخ والوقت</th><th>المستخدم</th><th>الصفحة</th><th>الإجراء</th><th>السجل</th><th>تفاصيل التغيير</th><th></th></tr></thead><tbody>${visible.map(row => auditRow(row, lookup)).join('')}</tbody></table>` : '<div class="empty-state"><b>—</b>لا توجد تعديلات في الفترة المختارة</div>'}</div>${pagination(rows.length, pages)}</section>`;
  output.querySelectorAll('[data-audit-details]').forEach(button => button.onclick = () => openDetails(rows.find(item => String(item.id) === button.dataset.auditDetails), lookup));
  output.querySelectorAll('[data-audit-page]').forEach(button => button.onclick = () => { currentPage = Number(button.dataset.auditPage); drawRows(output, rows, lookup); });
}

function auditRow(row, lookup) {
  const timestamp = new Date(row.occurred_at);
  const actor = row.actors?.full_name || row.actors?.username || 'النظام';
  return `<tr><td><span class="row-title">${timestamp.toLocaleDateString('ar-EG')}</span><small class="row-sub">${timestamp.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</small></td>
    <td><span class="audit-user-dot">${escapeHtml(actor[0] || 'ن')}</span><span class="row-title">${escapeHtml(actor)}</span></td>
    <td><span class="row-title">${escapeHtml(pageLabels[row.page_key] || row.page_key)}</span><small class="row-sub">${escapeHtml(row.branches?.name || 'عام على النظام')}</small></td>
    <td><span class="audit-action ${row.action.toLowerCase()}">${actionLabels[row.action] || row.action}</span></td>
    <td>${escapeHtml(entityName(row, lookup))}<small class="row-sub">${escapeHtml(tableLabels[row.table_name] || row.table_name)}</small></td>
    <td class="audit-change-cell">${changeSummary(row, lookup)}</td><td><button class="btn ghost audit-details-btn" data-audit-details="${row.id}">التفاصيل</button></td></tr>`;
}

function changeSummary(row, lookup) {
  if (row.action === 'INSERT') return '<span class="audit-created">تم إنشاء سجل جديد</span>';
  if (row.action === 'DELETE') return '<span class="audit-deleted">تم حذف السجل</span>';
  const changes = visibleChanges(row);
  if (!changes.length) return '<span class="muted">تم تحديث بيانات السجل</span>';
  return changes.slice(0, 2).map(change => `<div><b>${escapeHtml(fieldLabels[change.field] || change.field)}</b><span>من <del>${escapeHtml(displayValue(change.field, change.before, lookup))}</del> إلى <ins>${escapeHtml(displayValue(change.field, change.after, lookup))}</ins></span></div>`).join('') + (changes.length > 2 ? `<small class="audit-more">+ ${changes.length - 2} تغييرات أخرى</small>` : '');
}

function openDetails(row, lookup) {
  const root = document.getElementById('modal-root');
  const changes = visibleChanges(row);
  const detailRows = changes.length ? changes.map(change => `<div class="audit-detail-row"><b>${escapeHtml(fieldLabels[change.field] || change.field)}</b><div><span><small>قبل</small>${escapeHtml(displayValue(change.field, change.before, lookup))}</span><i>←</i><span class="after"><small>بعد</small>${escapeHtml(displayValue(change.field, change.after, lookup))}</span></div></div>`).join('') : `<div class="empty-state">${row.action === 'INSERT' ? 'تم إنشاء السجل' : row.action === 'DELETE' ? 'تم حذف السجل' : 'لا توجد قيم متغيرة للعرض'}</div>`;
  const timestamp = new Date(row.occurred_at);
  root.innerHTML = `<div class="modal-backdrop"><div class="modal audit-modal"><button class="modal-x">×</button><p class="eyebrow">تفاصيل الحركة</p><h3>${escapeHtml(actionLabels[row.action])} ${escapeHtml(entityName(row, lookup))}</h3><div class="audit-modal-meta"><span><small>المستخدم</small>${escapeHtml(row.actors?.full_name || row.actors?.username || 'النظام')}</span><span><small>التاريخ والوقت</small>${timestamp.toLocaleString('ar-EG')}</span><span><small>الصفحة</small>${escapeHtml(pageLabels[row.page_key] || row.page_key)}</span><span><small>الفرع</small>${escapeHtml(row.branches?.name || 'عام على النظام')}</span></div><div class="audit-detail-list">${detailRows}</div><div class="modal-actions"><button class="btn primary modal-close">تم</button></div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.modal-x').onclick = close;
  root.querySelector('.modal-close').onclick = close;
}

function visibleChanges(row) {
  const ignored = new Set(['id', 'created_by', 'added_by', 'created_at', 'updated_at']);
  return (Array.isArray(row.changed_fields) ? row.changed_fields : []).filter(change => !ignored.has(change.field));
}
function entityName(row, lookup) {
  const data = row.new_data || row.old_data || {};
  if (['consumption_records', 'stock_additions'].includes(row.table_name)) {
    const material = lookup.materials.get(data.material_id) || 'صنف غير معروف';
    return data.client_name ? `${material} · ${data.client_name}` : material;
  }
  if (['materials', 'branches'].includes(row.table_name)) return data.name || tableLabels[row.table_name];
  if (row.table_name === 'users') return data.full_name || data.username || 'مستخدم';
  if (['user_permissions', 'user_branches'].includes(row.table_name)) return lookup.users.get(data.user_id) || 'مستخدم';
  return tableLabels[row.table_name] || 'سجل';
}
function displayValue(field, value, lookup) {
  if (value == null || value === '') return 'فارغ';
  if (field === 'material_id') return lookup.materials.get(value) || value;
  if (field === 'branch_id' || field === 'transfer_to') return lookup.branches.get(value) || value;
  if (field === 'user_id') return lookup.users.get(value) || value;
  if (typeof value === 'boolean') return value ? 'مسموح / نعم' : 'غير مسموح / لا';
  if (field === 'role') return value === 'admin' ? 'مدير' : 'موظف استقبال';
  if (field === 'record_type') return value === 'transfer' ? 'تحويل لفرع' : 'صرف لعميلة';
  return String(value);
}
function searchText(row, lookup) {
  return [row.actors?.full_name, row.actors?.username, row.branches?.name, pageLabels[row.page_key], actionLabels[row.action], entityName(row, lookup), ...visibleChanges(row).flatMap(change => [fieldLabels[change.field], displayValue(change.field, change.before, lookup), displayValue(change.field, change.after, lookup)])].filter(Boolean).join(' ');
}
function normalize(value) {
  return String(value || '').toLocaleLowerCase('ar').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim();
}
function pagination(total, pages) {
  if (!total) return '';
  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, total);
  return `<div class="pagination-bar"><span>عرض ${start}–${end} من ${total}</span>${pages > 1 ? `<div class="pagination-controls"><button data-audit-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>السابق</button><b>${currentPage} / ${pages}</b><button data-audit-page="${currentPage + 1}" ${currentPage === pages ? 'disabled' : ''}>التالي</button></div>` : '<b>صفحة 1 / 1</b>'}</div>`;
}
function showError(error) {
  console.error(error);
  toast(error.message || 'تعذر تحميل سجل التعديلات', 'error');
}
