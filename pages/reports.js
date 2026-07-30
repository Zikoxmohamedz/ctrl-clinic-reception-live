import { today, money, escapeHtml, toast } from '../supabase.js?v=20260730-latin-digits';
import { list, hydrate } from '../data.js?v=20260730-latin-digits';

const PAGE_SIZE = 20;
let reportState = {};
let pageState = {};
let reportRoot = null;

export async function renderReports(root, profile) {
  reportRoot = root;
  const allBranches = await list('branches');
  const allowedIds = profile.branch_ids?.length ? profile.branch_ids : profile.role === 'admin' ? allBranches.map(branch => branch.id) : [profile.branch_id];
  const branches = allBranches.filter(branch => allowedIds.includes(branch.id));
  const materials = await list('materials');
  const from = new Date();
  from.setDate(1);
  root.innerHTML = `<div class="page-intro"><div><h2>التقارير</h2><p>تحليل تفصيلي لحركة المواد والإيرادات بين الفروع.</p></div></div>
  <section class="panel report-filter-panel"><div class="panel-body"><form class="filters report-filters" id="report-filters">
    <div class="field"><label>من تاريخ<input name="from" type="date" value="${from.toLocaleDateString('en-CA')}" required></label></div>
    <div class="field"><label>إلى تاريخ<input name="to" type="date" value="${today()}" required></label></div>
    ${branches.length > 1 ? `<div class="field"><label>الفرع<select name="branch"><option value="">كل الفروع المسموحة</option>${branches.map(branch => `<option value="${branch.id}">${escapeHtml(branch.name)}</option>`).join('')}</select></label></div>` : ''}
    <div class="field"><label>نوع التقرير<select name="report_view"><option value="all">كل التقارير</option><option value="detailed">تقرير الصرف المفصل</option><option value="summary">ملخص الاستهلاك لكل فرع</option><option value="additions">تقرير الإضافات المفصل</option><option value="additions-summary">ملخص الإضافات لكل فرع</option><option value="balance">الرصيد التقديري</option></select></label></div>
    <div class="field search-wrap report-material-picker"><label>الصنف<input type="search" name="material_search" autocomplete="off" placeholder="اكتب أول حروف اسم الصنف"></label><input type="hidden" name="material"><div class="autocomplete" data-material-results hidden></div></div>
    <button class="btn primary" type="submit">عرض التقرير</button>
  </form></div></section><div id="reports-output"></div>`;
  const resolveMaterialSelection = setupMaterialAutocomplete(root.querySelector('#report-filters'), materials);
  root.querySelector('form').onsubmit = event => {
    event.preventDefault();
    if (!resolveMaterialSelection()) return;
    loadReport(profile, branches, new FormData(event.currentTarget));
  };
  await loadReport(profile, branches, new FormData(root.querySelector('form')));
}

function setupMaterialAutocomplete(form, materials) {
  const input = form.elements.material_search;
  const selectedId = form.elements.material;
  const results = form.querySelector('[data-material-results]');
  let matches = [];

  const close = () => {
    results.hidden = true;
    results.innerHTML = '';
  };

  const choose = material => {
    input.value = material.name;
    selectedId.value = material.id;
    close();
  };

  const showMatches = () => {
    const query = normalizeMaterialSearch(input.value);
    selectedId.value = '';
    if (!query) return close();

    matches = materials
      .map(material => {
        const name = normalizeMaterialSearch(material.name);
        const code = normalizeMaterialSearch(material.code);
        const words = name.split(/\s+/);
        const score = name.startsWith(query) ? 0 : words.some(word => word.startsWith(query)) ? 1 : name.includes(query) ? 2 : code.startsWith(query) ? 3 : code.includes(query) ? 4 : 99;
        return { material, score };
      })
      .filter(item => item.score < 99)
      .sort((a, b) => a.score - b.score || String(a.material.name).localeCompare(String(b.material.name), 'ar'))
      .slice(0, 8)
      .map(item => item.material);

    results.innerHTML = matches.length
      ? matches.map(material => `<button type="button" data-material-id="${material.id}"><span><b>${escapeHtml(material.name)}</b><small class="row-sub">${escapeHtml(material.category || 'بدون فئة')}</small></span><small>${escapeHtml(material.code || '')} · ${escapeHtml(material.unit || '')}</small></button>`).join('')
      : '<div class="empty-state compact-empty"><b>—</b>لا يوجد صنف مطابق</div>';
    results.hidden = false;
    results.querySelectorAll('[data-material-id]').forEach(button => {
      button.onmousedown = event => event.preventDefault();
      button.onclick = () => choose(matches.find(material => material.id === button.dataset.materialId));
    });
  };

  input.oninput = showMatches;
  input.onfocus = () => input.value.trim() && showMatches();
  input.onkeydown = event => {
    if (event.key === 'Enter' && !results.hidden && matches.length) {
      event.preventDefault();
      choose(matches[0]);
    }
    if (event.key === 'Escape') close();
  };
  input.onblur = () => setTimeout(close, 120);
  return () => {
    if (!input.value.trim()) {
      selectedId.value = '';
      return true;
    }
    if (selectedId.value) return true;
    if (matches.length) {
      choose(matches[0]);
      return true;
    }
    toast('اختر صنفًا من نتائج البحث أو امسح خانة الصنف', 'warning');
    input.focus();
    return false;
  };
}

function normalizeMaterialSearch(value) {
  return String(value || '')
    .toLocaleLowerCase('ar')
    .normalize('NFD')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

async function loadReport(profile, branches, formData) {
  const output = reportRoot.querySelector('#reports-output');
  output.innerHTML = '<div class="empty-state">جارٍ إعداد التقرير...</div>';
  const from = formData.get('from');
  const to = formData.get('to');
  const allowedBranchIds = new Set(branches.map(item => item.id));
  const branch = branches.length > 1 ? formData.get('branch') : branches[0]?.id;
  const material = formData.get('material');
  const reportView = formData.get('report_view') || 'all';
  let consumption = hydrate(await list('consumption'));
  let additions = hydrate(await list('additions'));
  const matches = row => allowedBranchIds.has(row.branch_id) && row.date >= from && row.date <= to && (!branch || row.branch_id === branch) && (!material || row.material_id === material);
  consumption = consumption.filter(matches).sort((a, b) => a.branch_id.localeCompare(b.branch_id) || a.date.localeCompare(b.date));
  additions = additions.filter(matches).sort((a, b) => a.branch_id.localeCompare(b.branch_id) || a.date.localeCompare(b.date));
  const summary = groupSummary(consumption, branches);
  const additionsSummary = groupSummary(additions, branches);
  if (!branch && summary.length > 1) summary.push(overallSummary(summary));
  if (!branch && additionsSummary.length > 1) additionsSummary.push(overallSummary(additionsSummary));
  reportState = { consumption, additions, summary, additionsSummary, balance: makeBalance(consumption, additions), profile, from, to, branch, branches, reportView };
  pageState = { detailed: 1, additions: 1, balance: 1 };
  summary.forEach(group => pageState[`summary:${group.key}`] = 1);
  additionsSummary.forEach(group => pageState[`additions-summary:${group.key}`] = 1);
  renderOutput();
}

function renderOutput(focusTarget) {
  const output = reportRoot.querySelector('#reports-output');
  const sections = {
    detailed: renderDetailedSection,
    summary: renderSummarySection,
    additions: renderAdditionsSection,
    'additions-summary': renderAdditionsSummarySection,
    balance: renderBalanceSection,
  };
  const selected = reportState.reportView;
  output.innerHTML = selected === 'all'
    ? `${renderAllReportsToolbar()}${Object.values(sections).map(render => render()).join('')}`
    : (sections[selected] || sections.detailed)();
  output.querySelectorAll('[data-export]').forEach(button => button.onclick = () => exportExcel(button.dataset.export));
  output.querySelectorAll('[data-csv]').forEach(button => button.onclick = () => exportCsv(button.dataset.csv));
  output.querySelectorAll('[data-print]').forEach(button => button.onclick = () => printReport(button.dataset.print));
  output.querySelectorAll('[data-page-key]').forEach(button => button.onclick = () => {
    pageState[button.dataset.pageKey] = Number(button.dataset.page);
    renderOutput(button.dataset.target);
  });
  if (focusTarget) requestAnimationFrame(() => document.getElementById(focusTarget)?.scrollIntoView({ block: 'nearest' }));
}

function renderAllReportsToolbar() {
  const branchName = reportState.branch
    ? reportState.branches.find(branch => branch.id === reportState.branch)?.name
    : 'كل الفروع المسموحة';
  return `<div class="all-reports-toolbar"><div><strong>كل التقارير</strong><span>${escapeHtml(branchName || '')} · من ${reportState.from} إلى ${reportState.to}</span></div>${actions('all')}</div>`;
}

function renderDetailedSection() {
  const rows = reportState.consumption;
  const page = validPage(pageState.detailed, rows.length);
  pageState.detailed = page;
  const visible = pageSlice(rows, page);
  const totalQuantity = rows.reduce((sum, row) => sum + Number(row.quantity), 0);
  const totalRevenue = rows.reduce((sum, row) => sum + Number(row.quantity) * Number(row.selling_price || 0), 0);
  return `<section class="panel report-section" id="report-detailed"><div class="panel-head gold-line"><div><h3>تقرير مفصل للصرف</h3><p>${rows.length} سجل مطابق للفلاتر</p></div>${actions('detailed')}</div><div class="table-wrap">${rows.length ? `<table class="data-table"><thead><tr><th>#</th><th>التاريخ</th><th>الفرع</th><th>العميلة</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th><th>النوع</th><th>بواسطة</th></tr></thead><tbody>${visible.map((row, index) => `<tr><td>${(page - 1) * PAGE_SIZE + index + 1}</td><td>${row.date}</td><td>${escapeHtml(row.branches?.name)}</td><td><span class="row-title">${escapeHtml(row.client_name)}</span><small class="row-sub">${escapeHtml(row.client_code)}</small></td><td><span class="row-title">${escapeHtml(row.materials?.name)}</span><small class="row-sub">${escapeHtml(row.materials?.code)}</small></td><td>${escapeHtml(row.unit)}</td><td>${row.quantity}</td><td>${money(row.selling_price)}</td><td><b>${money(row.quantity * row.selling_price)}</b></td><td><span class="badge ${row.record_type}">${row.record_type === 'client' ? 'عميلة' : 'تحويل'}</span></td><td>${escapeHtml(row.users?.full_name || '—')}</td></tr>`).join('')}</tbody><tfoot><tr><td colspan="6">إجمالي كل النتائج</td><td>${money(totalQuantity)}</td><td></td><td>${money(totalRevenue)} ج.م</td><td colspan="2"></td></tr></tfoot></table>` : empty('لا توجد بيانات مطابقة')}</div>${pagination('detailed', rows.length, page, 'report-detailed')}</section>`;
}

function renderSummarySection() {
  return `<section class="panel report-section" id="report-summary"><div class="panel-head gold-line"><div><h3>ملخص الاستهلاك لكل فرع</h3><p>كل كارت يعرض 20 صنفاً في الصفحة</p></div>${actions('summary')}</div><div class="panel-body"><div class="summary-grid">${renderSummaryCards(reportState.summary)}</div></div></section>`;
}

function renderSummaryCards(groups) {
  if (!groups.length) return empty('لا توجد بيانات للملخص');
  return groups.map(group => {
    const items = Object.values(group.items);
    const stateKey = `summary:${group.key}`;
    const page = validPage(pageState[stateKey], items.length);
    pageState[stateKey] = page;
    const cardId = `summary-${group.key}`;
    return `<article class="summary-card" id="${cardId}"><h4>${escapeHtml(group.branch?.name)}</h4><div class="summary-card-items">${pageSlice(items, page).map(item => `<div class="summary-row"><span>${escapeHtml(item.material?.name)}</span><b>${money(item.quantity)} ${escapeHtml(item.material?.unit)}</b><span>${money(item.revenue)} ج.م</span></div>`).join('')}</div><div class="summary-total"><span>إجمالي الفرع</span><span>${money(items.reduce((sum, item) => sum + item.revenue, 0))} ج.م</span></div>${pagination(stateKey, items.length, page, cardId, true)}</article>`;
  }).join('');
}

function renderAdditionsSection() {
  const rows = reportState.additions;
  const page = validPage(pageState.additions, rows.length);
  pageState.additions = page;
  return `<section class="panel report-section" id="report-additions"><div class="panel-head gold-line"><div><h3>تقرير الإضافات</h3><p>${rows.length} حركة إضافة</p></div>${actions('additions')}</div><div class="table-wrap">${renderAdditionsTable(pageSlice(rows, page))}</div>${pagination('additions', rows.length, page, 'report-additions')}</section>`;
}

function renderAdditionsSummarySection() {
  return `<section class="panel report-section" id="report-additions-summary"><div class="panel-head gold-line"><div><h3>ملخص الإضافات لكل فرع</h3><p>إجمالي الكمية المضافة لكل صنف خلال الفترة المحددة</p></div>${actions('additions-summary')}</div><div class="panel-body"><div class="summary-grid">${renderAdditionsSummaryCards(reportState.additionsSummary)}</div></div></section>`;
}

function renderAdditionsSummaryCards(groups) {
  if (!groups.length) return empty('لا توجد إضافات للملخص');
  return groups.map(group => {
    const items = Object.values(group.items);
    const stateKey = `additions-summary:${group.key}`;
    const page = validPage(pageState[stateKey], items.length);
    pageState[stateKey] = page;
    const cardId = `additions-summary-${group.key}`;
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    return `<article class="summary-card" id="${cardId}"><h4>${escapeHtml(group.branch?.name)}</h4><div class="summary-card-items">${pageSlice(items, page).map(item => `<div class="summary-row"><span>${escapeHtml(item.material?.name)}</span><b>${money(item.quantity)} ${escapeHtml(item.material?.unit)}</b><span>مضاف</span></div>`).join('')}</div><div class="summary-total"><span>إجمالي الكمية المضافة</span><span>${money(totalQuantity)}</span></div>${pagination(stateKey, items.length, page, cardId, true)}</article>`;
  }).join('');
}

function renderBalanceSection() {
  const rows = reportState.balance;
  const page = validPage(pageState.balance, rows.length);
  pageState.balance = page;
  return `<section class="panel report-section" id="report-balance"><div class="panel-head gold-line"><div><h3>الرصيد التقديري</h3><p>إجمالي المضاف ناقص إجمالي المصروف</p></div>${actions('balance')}</div><div class="table-wrap">${renderBalanceTable(pageSlice(rows, page))}</div>${pagination('balance', rows.length, page, 'report-balance')}</section>`;
}

function pagination(key, total, page, target, compact = false) {
  if (!total) return '';
  const pages = Math.ceil(total / PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);
  return `<div class="pagination-bar ${compact ? 'compact' : ''}"><span>عرض ${start}–${end} من ${total}</span>${pages > 1 ? `<div class="pagination-controls"><button ${page === 1 ? 'disabled' : ''} data-page-key="${key}" data-page="${page - 1}" data-target="${target}">السابق</button><b>${page} / ${pages}</b><button ${page === pages ? 'disabled' : ''} data-page-key="${key}" data-page="${page + 1}" data-target="${target}">التالي</button></div>` : '<b>صفحة 1 / 1</b>'}</div>`;
}

function validPage(page = 1, total) { return Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / PAGE_SIZE))); }
function pageSlice(rows, page) { return rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE); }
function empty(message) { return `<div class="empty-state"><b>—</b>${message}</div>`; }
function actions(type) {
  if (type === 'all') return `<div class="report-actions"><button class="btn gold mini" data-export="all">تنزيل Excel شامل ↓</button></div>`;
  return `<div class="report-actions"><button class="btn gold mini" data-export="${type}">Excel ↓</button><button class="btn ghost mini" data-csv="${type}">CSV</button><button class="btn ghost mini" data-print="${type}">طباعة</button></div>`;
}

function groupSummary(rows, branches) {
  const map = {};
  rows.forEach(row => {
    const branchId = row.branch_id;
    map[branchId] ??= { key: branchId, branch: row.branches || branches.find(branch => branch.id === branchId), items: {} };
    map[branchId].items[row.material_id] ??= { material: row.materials, quantity: 0, revenue: 0 };
    map[branchId].items[row.material_id].quantity += Number(row.quantity);
    map[branchId].items[row.material_id].revenue += Number(row.quantity) * Number(row.selling_price || 0);
  });
  return Object.values(map);
}

function overallSummary(groups) {
  const result = { key: 'all', branch: { name: 'إجمالي كل الفروع' }, items: {} };
  groups.forEach(group => Object.entries(group.items).forEach(([id, item]) => {
    result.items[id] ??= { material: item.material, quantity: 0, revenue: 0 };
    result.items[id].quantity += item.quantity;
    result.items[id].revenue += item.revenue;
  }));
  return result;
}

function makeBalance(consumption, additions) {
  const map = {};
  [...consumption, ...additions].forEach(row => {
    const key = `${row.branch_id}|${row.material_id}`;
    map[key] ??= { branch_id: row.branch_id, material_id: row.material_id, branch: row.branches, material: row.materials, added: 0, consumed: 0 };
    if ('added_by' in row) map[key].added += Number(row.quantity);
    else map[key].consumed += Number(row.quantity);
  });
  return Object.values(map).map(row => ({ ...row, balance: row.added - row.consumed }));
}

function renderAdditionsTable(rows) {
  return rows.length ? `<table class="data-table"><thead><tr><th>التاريخ</th><th>الفرع</th><th>الصنف</th><th>كود الصنف</th><th>الوحدة</th><th>الكمية</th><th>بواسطة</th></tr></thead><tbody>${rows.map(row => `<tr><td>${row.date}</td><td>${escapeHtml(row.branches?.name)}</td><td>${escapeHtml(row.materials?.name)}</td><td>${escapeHtml(row.materials?.code)}</td><td>${escapeHtml(row.materials?.unit)}</td><td>${row.quantity}</td><td>${escapeHtml(row.users?.full_name || '—')}</td></tr>`).join('')}</tbody></table>` : empty('لا توجد إضافات مطابقة');
}

function renderBalanceTable(rows) {
  return rows.length ? `<table class="data-table"><thead><tr><th>الفرع</th><th>الصنف</th><th>الوحدة</th><th>مضاف</th><th>مصروف</th><th>الرصيد</th></tr></thead><tbody>${rows.map(row => `<tr class="${row.balance < 0 ? 'negative-row' : ''}"><td>${escapeHtml(row.branch?.name)}</td><td>${escapeHtml(row.material?.name)}</td><td>${escapeHtml(row.material?.unit)}</td><td>${money(row.added)}</td><td>${money(row.consumed)}</td><td>${money(row.balance)}</td></tr>`).join('')}</tbody></table>` : empty('لا توجد حركات لحساب الرصيد');
}

function rowsFor(type) {
  const state = reportState;
  if (type === 'detailed') return state.consumption.map(row => ({ 'التاريخ': row.date, 'الفرع': row.branches?.name, 'العميلة': row.client_name, 'كود العميلة': row.client_code, 'الصنف': row.materials?.name, 'كود الصنف': row.materials?.code, 'الوحدة': row.unit, 'الكمية': row.quantity, 'سعر الوحدة': row.selling_price || 0, 'الإجمالي': row.quantity * (row.selling_price || 0), 'النوع': row.record_type === 'client' ? 'عميلة' : 'تحويل', 'بواسطة': row.users?.full_name || '' }));
  if (type === 'summary') return state.summary.flatMap(group => Object.values(group.items).map(item => ({ 'الفرع': group.branch?.name, 'الصنف': item.material?.name, 'كود الصنف': item.material?.code, 'الوحدة': item.material?.unit, 'إجمالي الكمية': item.quantity, 'إجمالي الإيراد': item.revenue })));
  if (type === 'additions') return state.additions.map(row => ({ 'التاريخ': row.date, 'الفرع': row.branches?.name, 'الصنف': row.materials?.name, 'كود الصنف': row.materials?.code, 'الوحدة': row.materials?.unit, 'الكمية المضافة': row.quantity, 'بواسطة': row.users?.full_name || '' }));
  if (type === 'additions-summary') return state.additionsSummary.flatMap(group => Object.values(group.items).map(item => ({ 'الفرع': group.branch?.name, 'الصنف': item.material?.name, 'كود الصنف': item.material?.code, 'الوحدة': item.material?.unit, 'إجمالي الكمية المضافة': item.quantity })));
  return state.balance.map(row => ({ 'الفرع': row.branch?.name, 'الصنف': row.material?.name, 'كود الصنف': row.material?.code, 'الوحدة': row.material?.unit, 'إجمالي المضاف': row.added, 'إجمالي المصروف': row.consumed, 'الرصيد': row.balance }));
}

const MOVEMENT_HEADERS = ['التاريخ', 'الفرع', 'نوع الحركة', 'الصنف', 'كود الصنف', 'الوحدة', 'الكمية', 'سعر الوحدة', 'الإجمالي', 'العميلة', 'كود العميلة', 'نوع الصرف', 'بواسطة'];
const FULL_SUMMARY_HEADERS = ['الفرع', 'الصنف', 'كود الصنف', 'الوحدة', 'إجمالي المضاف', 'إجمالي المصروف', 'الرصيد', 'إجمالي الإيراد'];

function scopedBranches() {
  return reportState.branch ? reportState.branches.filter(branch => branch.id === reportState.branch) : reportState.branches;
}

function movementRows(branchId = '') {
  const consumption = reportState.consumption
    .filter(row => !branchId || row.branch_id === branchId)
    .map(row => ({
      'التاريخ': row.date, 'الفرع': row.branches?.name || '', 'نوع الحركة': 'صرف',
      'الصنف': row.materials?.name || '', 'كود الصنف': row.materials?.code || '', 'الوحدة': row.unit || row.materials?.unit || '',
      'الكمية': Number(row.quantity || 0), 'سعر الوحدة': Number(row.selling_price || 0), 'الإجمالي': Number(row.quantity || 0) * Number(row.selling_price || 0),
      'العميلة': row.client_name || '', 'كود العميلة': row.client_code || '', 'نوع الصرف': row.record_type === 'client' ? 'عميلة' : 'تحويل',
      'بواسطة': row.users?.full_name || ''
    }));
  const additions = reportState.additions
    .filter(row => !branchId || row.branch_id === branchId)
    .map(row => ({
      'التاريخ': row.date, 'الفرع': row.branches?.name || '', 'نوع الحركة': 'إضافة',
      'الصنف': row.materials?.name || '', 'كود الصنف': row.materials?.code || '', 'الوحدة': row.materials?.unit || '',
      'الكمية': Number(row.quantity || 0), 'سعر الوحدة': 0, 'الإجمالي': 0,
      'العميلة': '', 'كود العميلة': '', 'نوع الصرف': '', 'بواسطة': row.users?.full_name || ''
    }));
  return [...consumption, ...additions].sort((a, b) => String(a['التاريخ']).localeCompare(String(b['التاريخ'])) || String(a['الفرع']).localeCompare(String(b['الفرع'])));
}

function fullSummaryRows(branchId = '') {
  const revenue = new Map();
  reportState.consumption.filter(row => !branchId || row.branch_id === branchId).forEach(row => {
    const key = `${row.branch_id}|${row.material_id}`;
    revenue.set(key, (revenue.get(key) || 0) + Number(row.quantity || 0) * Number(row.selling_price || 0));
  });
  return reportState.balance
    .filter(row => !branchId || row.branch_id === branchId)
    .map(row => {
      const key = `${row.branch_id}|${row.material_id}`;
      return {
        'الفرع': row.branch?.name || '', 'الصنف': row.material?.name || '', 'كود الصنف': row.material?.code || '', 'الوحدة': row.material?.unit || '',
        'إجمالي المضاف': Number(row.added || 0), 'إجمالي المصروف': Number(row.consumed || 0), 'الرصيد': Number(row.balance || 0), 'إجمالي الإيراد': Number(revenue.get(key) || 0)
      };
    })
    .sort((a, b) => String(a['الفرع']).localeCompare(String(b['الفرع'])) || String(a['الصنف']).localeCompare(String(b['الصنف'])));
}

function withTotals(rows, headers, label) {
  if (!rows.length) return rows;
  const total = Object.fromEntries(headers.map(header => [header, '']));
  total[headers[0]] = label;
  const numeric = headers.filter(header => header !== 'سعر الوحدة' && rows.some(row => typeof row[header] === 'number'));
  numeric.forEach(header => total[header] = rows.reduce((sum, row) => sum + Number(row[header] || 0), 0));
  return [...rows, total];
}

function safeSheetName(raw, used) {
  const base = String(raw).replace(/[\\/\?\*\[\]:]/g, '-').trim().slice(0, 31) || 'Sheet';
  let name = base;
  let counter = 2;
  while (used.has(name)) {
    const suffix = `_${counter++}`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name);
  return name;
}

function createCtrlLogo() {
  const canvas = document.createElement('canvas');
  canvas.width = 420;
  canvas.height = 130;
  const context = canvas.getContext('2d');
  context.fillStyle = '#142A55';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.direction = 'ltr';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.font = '900 84px Arial';
  context.fillStyle = '#FFFFFF';
  context.fillText('ctrl', 34, 68);
  context.fillStyle = '#C9A44C';
  context.beginPath();
  context.arc(226, 91, 9, 0, Math.PI * 2);
  context.fill();
  return canvas.toDataURL('image/png');
}

function appendStyledReportSheet(workbook, logoId, used, name, title, rows, headers, totalLabel, branchLabel) {
  const sheet = workbook.addWorksheet(safeSheetName(name, used), {
    properties: { tabColor: { argb: 'FFC9A44C' }, defaultRowHeight: 20 },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  const lastColumn = headers.length;
  const titleStart = Math.min(3, lastColumn);
  sheet.views = [{ rightToLeft: true, state: 'frozen', xSplit: 0, ySplit: 5, activeCell: 'A6' }];
  sheet.mergeCells(1, 1, 3, Math.min(2, lastColumn));
  sheet.mergeCells(1, titleStart, 1, lastColumn);
  sheet.mergeCells(2, titleStart, 2, lastColumn);
  sheet.mergeCells(3, titleStart, 3, lastColumn);
  [1, 2, 3].forEach(rowNumber => {
    const row = sheet.getRow(rowNumber);
    row.height = rowNumber === 1 ? 32 : 24;
    for (let column = 1; column <= lastColumn; column += 1) {
      row.getCell(column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF142A55' } };
    }
  });
  sheet.getCell(1, titleStart).value = title;
  sheet.getCell(1, titleStart).font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell(2, titleStart).value = `الفترة: ${reportState.from} إلى ${reportState.to}`;
  sheet.getCell(3, titleStart).value = `الفرع: ${branchLabel || 'كل الفروع المسموحة'}`;
  [2, 3].forEach(rowNumber => {
    sheet.getCell(rowNumber, titleStart).font = { name: 'Arial', size: 10, color: { argb: 'FFD6DEEE' } };
  });
  [1, 2, 3].forEach(rowNumber => {
    sheet.getCell(rowNumber, titleStart).alignment = { horizontal: 'right', vertical: 'middle', readingOrder: 'rtl' };
  });
  sheet.addImage(logoId, { tl: { col: 0.15, row: 0.2 }, ext: { width: 105, height: 34 }, editAs: 'oneCell' });
  sheet.getRow(4).height = 9;

  const headerRow = sheet.getRow(5);
  headerRow.values = headers;
  headerRow.height = 28;
  headerRow.eachCell(cell => {
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF142A55' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8D6A8' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rtl', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFC9A44C' } },
      bottom: { style: 'medium', color: { argb: 'FFC9A44C' } },
      left: { style: 'thin', color: { argb: 'FFD6DEEA' } },
      right: { style: 'thin', color: { argb: 'FFD6DEEA' } },
    };
  });

  rows.forEach((data, index) => {
    const row = sheet.addRow(headers.map(header => data[header] ?? ''));
    row.height = 23;
    row.eachCell((cell, columnNumber) => {
      cell.font = { name: 'Arial', size: 10, color: { argb: 'FF26364F' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 ? 'FFF3F6FA' : 'FFFFFFFF' } };
      cell.alignment = { horizontal: typeof cell.value === 'number' ? 'center' : 'right', vertical: 'middle', readingOrder: 'rtl', wrapText: true };
      cell.border = {
        bottom: { style: 'hair', color: { argb: 'FFD9E0EA' } },
        left: { style: 'hair', color: { argb: 'FFE4E9F0' } },
        right: { style: 'hair', color: { argb: 'FFE4E9F0' } },
      };
      if (typeof cell.value === 'number') cell.numFmt = '#,##0.00';
      if (headers[columnNumber - 1] === 'الرصيد' && Number(cell.value) < 0) {
        cell.font = { ...cell.font, bold: true, color: { argb: 'FFB42318' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE7E5' } };
      }
    });
  });

  if (!rows.length) {
    const emptyRow = sheet.addRow(['لا توجد بيانات مطابقة']);
    sheet.mergeCells(emptyRow.number, 1, emptyRow.number, lastColumn);
    emptyRow.height = 34;
    emptyRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rtl' };
    emptyRow.getCell(1).font = { name: 'Arial', italic: true, color: { argb: 'FF667085' } };
  } else {
    const totals = withTotals(rows, headers, totalLabel).at(-1);
    const totalRow = sheet.addRow(headers.map(header => totals[header] ?? ''));
    totalRow.height = 27;
    totalRow.eachCell(cell => {
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF142A55' } };
      cell.alignment = { horizontal: typeof cell.value === 'number' ? 'center' : 'right', vertical: 'middle', readingOrder: 'rtl' };
      if (typeof cell.value === 'number') cell.numFmt = '#,##0.00';
    });
  }

  headers.forEach((header, index) => {
    const widestValue = rows.reduce((width, row) => Math.max(width, String(row[header] ?? '').length), header.length);
    const preferred = ['الصنف', 'العميلة', 'بواسطة'].includes(header) ? 28 : header === 'الفرع' ? 20 : Math.max(12, widestValue + 3);
    sheet.getColumn(index + 1).width = Math.min(preferred, 34);
  });
  sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: lastColumn } };
  sheet.headerFooter.oddFooter = '&Rctrl.  |  &D&Cصفحة &P من &N';
  sheet.pageSetup.margins = { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
}

async function saveStyledWorkbook(workbook, filename) {
  const buffer = await workbook.xlsx.writeBuffer();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function exportExcel(type = 'all') {
  if (!window.ExcelJS) return toast('مكتبة تنسيق Excel غير متاحة', 'error');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ctrl.';
  workbook.company = 'ctrl.';
  workbook.subject = 'تقارير حركة المواد';
  workbook.created = new Date();
  const used = new Set();
  const logoId = workbook.addImage({ base64: createCtrlLogo(), extension: 'png' });
  const branches = scopedBranches();
  const branchLabel = reportState.branch ? branches[0]?.name || 'فرع' : 'كل الفروع المسموحة';
  const titles = {
    detailed: ['صرف_مفصل', 'تقرير الصرف المفصل'],
    summary: ['ملخص_الاستهلاك', 'ملخص الاستهلاك لكل فرع'],
    additions: ['إضافات_مفصلة', 'تقرير الإضافات المفصل'],
    'additions-summary': ['ملخص_الإضافات', 'ملخص الإضافات لكل فرع'],
    balance: ['الرصيد', 'الرصيد التقديري'],
  };
  try {
    if (type !== 'all') {
      const rows = rowsFor(type);
      if (!rows.length) return toast('لا توجد بيانات للتصدير', 'warning');
      const headers = Object.keys(rows[0]);
      appendStyledReportSheet(workbook, logoId, used, titles[type]?.[0] || 'التقرير', titles[type]?.[1] || 'تقرير ctrl.', rows, headers, 'الإجمالي', branchLabel);
      await saveStyledWorkbook(workbook, `ctrl_${titles[type]?.[0] || 'report'}_${reportState.from}_${reportState.to}.xlsx`);
      toast('تم تجهيز ملف Excel المنسق للتقرير المحدد');
      return;
    }
    appendStyledReportSheet(workbook, logoId, used, 'مجمع_تفصيلي', 'التقرير الشامل لحركة المواد', movementRows(), MOVEMENT_HEADERS, 'إجمالي كل الحركات', branchLabel);
    appendStyledReportSheet(workbook, logoId, used, 'مجمع_كامل', 'الملخص الشامل للمخزون والإيراد', fullSummaryRows(), FULL_SUMMARY_HEADERS, 'الإجمالي العام', branchLabel);
    branches.forEach(branch => {
      appendStyledReportSheet(workbook, logoId, used, `تفصيلي_${branch.name}`, `الحركات التفصيلية — ${branch.name}`, movementRows(branch.id), MOVEMENT_HEADERS, `إجمالي ${branch.name}`, branch.name);
      appendStyledReportSheet(workbook, logoId, used, `ملخص_${branch.name}`, `ملخص الفرع — ${branch.name}`, fullSummaryRows(branch.id), FULL_SUMMARY_HEADERS, `إجمالي ${branch.name}`, branch.name);
    });
    const scope = reportState.branch ? branches[0]?.name || 'فرع' : 'كل_الفروع';
    await saveStyledWorkbook(workbook, `ctrl_تقرير_شامل_${scope}_${reportState.from}_${reportState.to}.xlsx`);
    toast(`تم تجهيز ملف Excel منسق (${workbook.worksheets.length} شيت)`);
  } catch (error) {
    console.error(error);
    toast('تعذر تجهيز ملف Excel المنسق', 'error');
  }
}

function printTable(headers, rows, rowClass = () => '') {
  const body = rows.length
    ? rows.map(row => `<tr class="${rowClass(row)}">${headers.map(header => `<td>${escapeHtml(String(row[header] ?? ''))}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="empty-print">لا توجد بيانات مطابقة</td></tr>`;
  return `<table><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
}

function printReport(type) {
  const printWindow = window.open('', '_blank', 'width=1200,height=800');
  if (!printWindow) return toast('اسمح بفتح النوافذ المنبثقة لإتمام الطباعة', 'warning');
  const titles = { detailed: 'تقرير مفصل للصرف', summary: 'ملخص الاستهلاك لكل فرع', additions: 'تقرير الإضافات', 'additions-summary': 'ملخص الإضافات لكل فرع', balance: 'الرصيد التقديري' };
  const branchScope = reportState.branch ? scopedBranches()[0]?.name : 'كل الفروع المسموحة';
  let content = '';
  if (type === 'summary' || type === 'additions-summary') {
    content = scopedBranches().map(branch => {
      const rows = rowsFor(type).filter(row => row['الفرع'] === branch.name);
      const headers = type === 'summary'
        ? ['الفرع', 'الصنف', 'كود الصنف', 'الوحدة', 'إجمالي الكمية', 'إجمالي الإيراد']
        : ['الفرع', 'الصنف', 'كود الصنف', 'الوحدة', 'إجمالي الكمية المضافة'];
      return `<section class="branch-section"><h2>${escapeHtml(branch.name)}</h2>${printTable(headers, rows)}</section>`;
    }).join('');
  } else {
    const data = rowsFor(type);
    const headers = data[0] ? Object.keys(data[0]) : type === 'detailed' ? ['التاريخ', 'الفرع', 'العميلة', 'كود العميلة', 'الصنف', 'كود الصنف', 'الوحدة', 'الكمية', 'سعر الوحدة', 'الإجمالي', 'النوع', 'بواسطة'] : type === 'additions' ? ['التاريخ', 'الفرع', 'الصنف', 'كود الصنف', 'الوحدة', 'الكمية المضافة', 'بواسطة'] : FULL_SUMMARY_HEADERS.slice(0, 7);
    content = printTable(headers, data, row => Number(row['الرصيد']) < 0 ? 'negative' : '');
  }
  printWindow.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${titles[type]}</title><style>
    @page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;color:#111;background:#fff;margin:0;font-size:10px}header{border-bottom:3px solid #b38b36;margin-bottom:14px;padding:0 0 10px;display:flex;justify-content:space-between;align-items:end}h1{margin:0;font-size:21px;color:#142a55}h2{font-size:16px;margin:12px 0 7px;color:#142a55}.meta{line-height:1.8;text-align:left;color:#444}table{width:100%;border-collapse:collapse;table-layout:auto;margin-bottom:14px}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}th{background:#142a55!important;color:#fff!important;font-weight:700;padding:6px 5px;border:1px solid #8993a5;white-space:nowrap}td{padding:5px;border:1px solid #bbb;text-align:center;vertical-align:middle}tbody tr:nth-child(even) td{background:#f3f5f8}.negative td{background:#fee2e2!important;color:#991b1b;font-weight:700}.branch-section{break-after:page}.branch-section:last-child{break-after:auto}.empty-print{padding:30px;color:#666}.brand{font-weight:900;font-size:28px;color:#b38b36}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body><header><div><div class="brand">Ctrl.</div><h1>${titles[type]}</h1></div><div class="meta">الفترة: ${reportState.from} إلى ${reportState.to}<br>الفرع: ${escapeHtml(branchScope || '')}<br>تاريخ الطباعة: ${new Date().toLocaleString('ar-EG-u-nu-latn')}</div></header>${content}<script>window.onload=()=>setTimeout(()=>{window.print();window.onafterprint=()=>window.close()},250)<\/script></body></html>`);
  printWindow.document.close();
}

function exportCsv(type) {
  const data = rowsFor(type);
  if (!data.length) return toast('لا توجد بيانات للتصدير', 'warning');
  const keys = Object.keys(data[0]);
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = '\uFEFF' + [keys.map(quote).join(','), ...data.map(row => keys.map(key => quote(row[key])).join(','))].join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `ctrl_report_${type}_${today()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
