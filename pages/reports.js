import { supabase, today, money, escapeHtml, toast } from '../supabase.js?v=20260801-audit-context';
import { list, hydrate } from '../data.js?v=20260801-reception-features';
import { renderAccountingReports } from './accounting-reports.js?v=20260927-procurement';

const stockValue = value => value == null ? 'غير متاح' : Number(value);
const stockDisplay = value => value == null ? 'غير متاح' : money(value);

const PAGE_SIZE = 25;
let reportState = {};
let pageState = {};
let reportRoot = null;

function saleTotal(row) {
  return Number(row?.total_selling_price ?? row?.selling_price ?? 0);
}

export async function renderReports(root, profile) {
  return renderAccountingReports(root, profile, renderHistoricalReports);
}

async function renderHistoricalReports(root, profile) {
  reportState = { activeTab: 'inventory-history' };
  reportRoot = root;
  const allBranches = await list('branches');
  const allowedIds = profile.branch_ids?.length ? profile.branch_ids : profile.role === 'admin' ? allBranches.map(branch => branch.id) : [profile.branch_id];
  const branches = allBranches.filter(branch => allowedIds.includes(branch.id));
  const materials = await list('materials');
  const from = new Date();
  from.setDate(1);

  root.innerHTML = `
    <div class="page-intro">
      <div>
        <h2>التقارير وحركة المخزون</h2>
        <p>تحليل شامل ومفصل لحركة المواد، استهلاك الفروع، الأرصدة، وسحب كافة الجرود التاريخية.</p>
      </div>
      <div class="reports-header-actions">
        <button class="btn gold" id="btn-pull-all-branches-inventory" type="button">📥 سحب كل الفروع بالتواريخ والأرصدة</button>
        <button class="btn primary" id="btn-export-all-reports" type="button">العودة لتقارير المحاسب</button>
      </div>
    </div>

    <section class="panel report-filter-panel">
      <div class="panel-body">
        <form class="filters report-filters" id="report-filters">
          <div class="field"><label>من تاريخ<input name="from" id="report-from" type="date" value="${from.toLocaleDateString('en-CA')}" required></label></div>
          <div class="field"><label>إلى تاريخ<input name="to" id="report-to" type="date" value="${today()}" required></label></div>
          ${branches.length > 1 ? `<div class="field"><label>الفرع<select name="branch" id="report-branch"><option value="">كل الفروع المسموحة</option>${branches.map(branch => `<option value="${branch.id}">${escapeHtml(branch.name)}</option>`).join('')}</select></label></div>` : ''}
          <div class="field search-wrap report-material-picker"><label>الصنف<input type="search" name="material_search" autocomplete="off" placeholder="اكتب أول حروف اسم الصنف"></label><input type="hidden" name="material"><div class="autocomplete" data-material-results hidden></div></div>
          <button class="btn primary" type="submit">تحديث البيانات</button>
        </form>

        <div class="reports-quick-dates">
          <span>فترات سريعة:</span>
          <button type="button" class="reports-date-chip" data-preset="today">اليوم</button>
          <button type="button" class="reports-date-chip" data-preset="last7">آخر 7 أيام</button>
          <button type="button" class="reports-date-chip active" data-preset="thisMonth">هذا الشهر</button>
          <button type="button" class="reports-date-chip" data-preset="lastMonth">الشهر السابق</button>
          <button type="button" class="reports-date-chip" data-preset="allTime">كل المدة</button>
        </div>
      </div>
    </section>

    <div id="reports-output"></div>
  `;

  // Wire quick date presets
  root.querySelectorAll('[data-preset]').forEach(chip => {
    chip.onclick = () => {
      root.querySelectorAll('[data-preset]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      applyDatePreset(chip.dataset.preset, root.querySelector('#report-filters'));
      loadReport(profile, branches, materials, new FormData(root.querySelector('#report-filters')));
    };
  });

  const resolveMaterialSelection = setupMaterialAutocomplete(root.querySelector('#report-filters'), materials);
  root.querySelector('form').onsubmit = event => {
    event.preventDefault();
    if (!resolveMaterialSelection()) return;
    loadReport(profile, branches, materials, new FormData(event.currentTarget));
  };

  root.querySelector('#btn-pull-all-branches-inventory').onclick = () => {
    switchReportTab('inventory-history');
  };

  root.querySelector('#btn-export-all-reports').onclick = () => {
    renderReports(root, profile);
  };

  await loadReport(profile, branches, materials, new FormData(root.querySelector('form')));
}

function applyDatePreset(preset, form) {
  const fromInput = form.querySelector('#report-from');
  const toInput = form.querySelector('#report-to');
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA');

  if (preset === 'today') {
    fromInput.value = todayStr;
    toInput.value = todayStr;
  } else if (preset === 'last7') {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    fromInput.value = d.toLocaleDateString('en-CA');
    toInput.value = todayStr;
  } else if (preset === 'thisMonth') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    fromInput.value = d.toLocaleDateString('en-CA');
    toInput.value = todayStr;
  } else if (preset === 'lastMonth') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    fromInput.value = start.toLocaleDateString('en-CA');
    toInput.value = end.toLocaleDateString('en-CA');
  } else if (preset === 'allTime') {
    fromInput.value = '2025-01-01';
    toInput.value = todayStr;
  }
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

async function loadReport(profile, branches, materials, formData) {
  const output = reportRoot.querySelector('#reports-output');
  output.innerHTML = '<div class="empty-state">جارٍ تجهيز وحساب بيانات التقارير...</div>';
  const from = formData.get('from');
  const to = formData.get('to');
  const allowedBranchIds = new Set(branches.map(item => item.id));
  const branch = branches.length > 1 ? formData.get('branch') : branches[0]?.id;
  const material = formData.get('material');
  const activeTab = reportState.activeTab || 'overview';

  let rawConsumption = await list('consumption');
  let rawAdditions = await list('additions');
  let consumption = hydrate(rawConsumption);
  let additions = hydrate(rawAdditions);

  const matches = row => allowedBranchIds.has(row.branch_id) && row.date >= from && row.date <= to && (!branch || row.branch_id === branch) && (!material || row.material_id === material);
  consumption = consumption.filter(matches).sort((a, b) => a.branch_id.localeCompare(b.branch_id) || a.date.localeCompare(b.date));
  additions = additions.filter(matches).sort((a, b) => a.branch_id.localeCompare(b.branch_id) || a.date.localeCompare(b.date));

  const summary = groupSummary(consumption, branches);
  const additionsSummary = groupSummary(additions, branches);
  if (!branch && summary.length > 1) summary.push(overallSummary(summary));
  if (!branch && additionsSummary.length > 1) additionsSummary.push(overallSummary(additionsSummary));

  reportState = {
    consumption,
    additions,
    summary,
    additionsSummary,
    balance: makeBalance(consumption, additions),
    profile,
    from,
    to,
    branch,
    branches,
    materials,
    activeTab,
    inventoryHistory: null,
    inventoryHistoryLoading: false,
  };

  pageState = { detailed: 1, additions: 1, balance: 1 };
  summary.forEach(group => pageState[`summary:${group.key}`] = 1);
  additionsSummary.forEach(group => pageState[`additions-summary:${group.key}`] = 1);

  renderOutput();
}

function renderOutput(focusTarget) {
  const output = reportRoot.querySelector('#reports-output');
  const active = reportState.activeTab || 'overview';

  output.innerHTML = `
    <div id="reports-tab-content">${renderTabContent(active)}</div>
  `;

  // Wire Tab Buttons
  output.querySelectorAll('[data-report-tab]').forEach(btn => {
    btn.onclick = () => switchReportTab(btn.dataset.reportTab);
  });

  // Wire Common Actions
  output.querySelectorAll('[data-export]').forEach(button => {
    button.onclick = () => {
      const type = button.dataset.export;
      if (type === 'all-branches-history') exportAllBranchesHistoryExcel();
      else exportExcel(type);
    };
  });
  output.querySelectorAll('[data-csv]').forEach(button => button.onclick = () => exportCsv(button.dataset.csv));
  output.querySelectorAll('[data-print]').forEach(button => button.onclick = () => printReport(button.dataset.print));
  output.querySelectorAll('[data-page-key]').forEach(button => button.onclick = () => {
    pageState[button.dataset.pageKey] = Number(button.dataset.page);
    renderOutput(button.dataset.target);
  });

  // Wire Live Table Search
  wireLiveTableSearch(output);

  if (active === 'inventory-history' && !reportState.inventoryHistory && !reportState.inventoryHistoryLoading) {
    loadAllBranchesInventoryHistory();
  }

  if (focusTarget) requestAnimationFrame(() => document.getElementById(focusTarget)?.scrollIntoView({ block: 'nearest' }));
}

function switchReportTab(tabKey) {
  reportState.activeTab = tabKey;
  renderOutput();
}

function renderKpiCards() {
  const { consumption, additions } = reportState;
  const totalConsumptionQty = consumption.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const totalRevenue = consumption.reduce((sum, row) => sum + saleTotal(row), 0);
  const totalAdditionsQty = additions.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const activeMaterials = new Set([...consumption.map(r => r.material_id), ...additions.map(r => r.material_id)]).size;
  const totalOps = consumption.length + additions.length;

  return `
    <div class="reports-kpi-grid">
      <article class="reports-kpi-card gold">
        <span>إجمالي إيرادات الصرف</span>
        <strong>${money(totalRevenue)} <small>ج.م</small></strong>
        <small>${consumption.length} حركة صرف</small>
      </article>
      <article class="reports-kpi-card blue">
        <span>إجمالي الكميات المنصرفة</span>
        <strong>${money(totalConsumptionQty)}</strong>
        <small>خلال الفترة المحددة</small>
      </article>
      <article class="reports-kpi-card ok">
        <span>إجمالي الكميات المضافة</span>
        <strong>${money(totalAdditionsQty)}</strong>
        <small>${additions.length} حركة إضافة</small>
      </article>
      <article class="reports-kpi-card warn">
        <span>الأصناف المتداولة</span>
        <strong>${activeMaterials}</strong>
        <small>من أصل ${reportState.materials?.length || 0} صنف مسجل</small>
      </article>
    </div>
  `;
}

function renderTabNavigation(active) {
  const tabs = [
    { key: 'overview', label: '📊 نظرة عامة', highlight: false },
    { key: 'detailed', label: '📋 الصرف المفصل', highlight: false },
    { key: 'summary', label: '🏢 استهلاك الفروع', highlight: false },
    { key: 'additions', label: '➕ الإضافات', highlight: false },
    { key: 'balance', label: '📦 الأرصدة وحركة المخزون', highlight: false },
    { key: 'inventory-history', label: '📑 سحب كل الجرود لكل فرع بالتواريخ', highlight: true },
  ];

  return `
    <nav class="reports-tab-nav">
      ${tabs.map(tab => `
        <button type="button" class="reports-tab-btn ${tab.highlight ? 'highlight' : ''} ${active === tab.key ? 'active' : ''}" data-report-tab="${tab.key}">
          ${tab.label}
        </button>
      `).join('')}
    </nav>
  `;
}

function renderTabContent(active) {
  switch (active) {
    case 'overview':
      return renderOverviewSection();
    case 'detailed':
      return renderDetailedSection();
    case 'summary':
      return renderSummarySection();
    case 'additions':
      return renderAdditionsSection();
    case 'balance':
      return renderBalanceSection();
    case 'inventory-history':
      return renderInventoryHistorySection();
    default:
      return renderOverviewSection();
  }
}

function renderOverviewSection() {
  const topConsumed = [...reportState.consumption]
    .reduce((acc, row) => {
      acc[row.material_id] ??= { material: row.materials, qty: 0, revenue: 0 };
      acc[row.material_id].qty += Number(row.quantity);
      acc[row.material_id].revenue += saleTotal(row);
      return acc;
    }, {});

  const topItems = Object.values(topConsumed).sort((a, b) => b.qty - a.qty).slice(0, 10);
  const branchName = reportState.branch
    ? reportState.branches.find(b => b.id === reportState.branch)?.name
    : 'كل الفروع المسموحة';

  return `
    <section class="panel report-section" id="report-overview">
      <div class="panel-head gold-line">
        <div>
          <h3>ملخص النشاط العام للفترة</h3>
          <p>${escapeHtml(branchName)} · من ${reportState.from} إلى ${reportState.to}</p>
        </div>
        ${actions('all')}
      </div>
      <div class="panel-body">
        <h4 style="margin-bottom: 12px; font-size: 1.05rem;">أعلى 10 أصناف استهلاكاً خلال الفترة</h4>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>الصنف</th>
                <th>كود الصنف</th>
                <th>الوحدة</th>
                <th>إجمالي الكمية المنصرفة</th>
                <th>إجمالي الإيراد المحقق</th>
              </tr>
            </thead>
            <tbody>
              ${topItems.length ? topItems.map((item, idx) => `
                <tr>
                  <td>${idx + 1}</td>
                  <td class="row-title"><b>${escapeHtml(item.material?.name || '—')}</b></td>
                  <td>${escapeHtml(item.material?.code || '—')}</td>
                  <td>${escapeHtml(item.material?.unit || '—')}</td>
                  <td><b>${money(item.qty)}</b></td>
                  <td><b>${money(item.revenue)} ج.م</b></td>
                </tr>
              `).join('') : '<tr><td colspan="6"><div class="empty-state">لا توجد حركات استهلاك في الفترة المحددة</div></td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderDetailedSection() {
  const rows = reportState.consumption;
  const page = validPage(pageState.detailed, rows.length);
  pageState.detailed = page;
  const visible = pageSlice(rows, page);
  const totalQuantity = rows.reduce((sum, row) => sum + Number(row.quantity), 0);
  const totalRevenue = rows.reduce((sum, row) => sum + saleTotal(row), 0);

  return `
    <section class="panel report-section" id="report-detailed">
      <div class="panel-head gold-line">
        <div>
          <h3>تقرير الصرف المفصل</h3>
          <p>${rows.length} حركة صرف مطابقة للفلاتر</p>
        </div>
        ${actions('detailed')}
      </div>
      <div class="panel-body" style="padding-top:0;">
        <div class="reports-live-search">
          <input type="search" placeholder="بحث سريع في جدول الصرف (العميلة، الصنف، الفرع...)" data-live-search>
        </div>
        <div class="table-wrap">
          ${rows.length ? `
            <table class="data-table" data-filterable-table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>التاريخ</th>
                  <th>الفرع</th>
                  <th>العميلة</th>
                  <th>الصنف</th>
                  <th>الوحدة</th>
                  <th>الكمية</th>
                  <th>إجمالي سعر البيع</th>
                  <th>النوع</th>
                  <th>بواسطة</th>
                </tr>
              </thead>
              <tbody>
                ${visible.map((row, index) => `
                  <tr>
                    <td>${(page - 1) * PAGE_SIZE + index + 1}</td>
                    <td>${row.date}</td>
                    <td><b>${escapeHtml(row.branches?.name)}</b></td>
                    <td><span class="row-title">${escapeHtml(row.client_name)}</span><small class="row-sub">${escapeHtml(row.client_code)}</small></td>
                    <td><span class="row-title">${escapeHtml(row.materials?.name)}</span><small class="row-sub">${escapeHtml(row.materials?.code)}</small></td>
                    <td>${escapeHtml(row.unit)}</td>
                    <td><b>${row.quantity}</b></td>
                    <td><b>${money(saleTotal(row))} ج.م</b></td>
                    <td><span class="badge ${row.record_type}">${row.record_type === 'client' ? 'عميلة' : 'تحويل'}</span></td>
                    <td>${escapeHtml(row.users?.full_name || '—')}</td>
                  </tr>
                `).join('')}
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="6">إجمالي كل النتائج</td>
                  <td><b>${money(totalQuantity)}</b></td>
                  <td><b>${money(totalRevenue)} ج.م</b></td>
                  <td colspan="2"></td>
                </tr>
              </tfoot>
            </table>
          ` : empty('لا توجد بيانات صرف مطابقة')}
        </div>
        ${pagination('detailed', rows.length, page, 'report-detailed')}
      </div>
    </section>
  `;
}

function renderSummarySection() {
  return `
    <section class="panel report-section" id="report-summary">
      <div class="panel-head gold-line">
        <div>
          <h3>ملخص استهلاك الأصناف لكل فرع</h3>
          <p>إجمالي الكميات والإيرادات لكل صنف مقسمة حسب الفرع</p>
        </div>
        ${actions('summary')}
      </div>
      <div class="panel-body">
        <div class="summary-grid">${renderSummaryCards(reportState.summary)}</div>
      </div>
    </section>
  `;
}

function renderSummaryCards(groups) {
  if (!groups.length) return empty('لا توجد بيانات للملخص');
  return groups.map(group => {
    const items = Object.values(group.items);
    const stateKey = `summary:${group.key}`;
    const page = validPage(pageState[stateKey], items.length);
    pageState[stateKey] = page;
    const cardId = `summary-${group.key}`;
    return `
      <article class="summary-card" id="${cardId}">
        <h4>${escapeHtml(group.branch?.name)}</h4>
        <div class="summary-card-items">
          ${pageSlice(items, page).map(item => `
            <div class="summary-row">
              <span>${escapeHtml(item.material?.name)}</span>
              <b>${money(item.quantity)} ${escapeHtml(item.material?.unit)}</b>
              <span>${money(item.revenue)} ج.م</span>
            </div>
          `).join('')}
        </div>
        <div class="summary-total">
          <span>إجمالي الفرع</span>
          <span>${money(items.reduce((sum, item) => sum + item.revenue, 0))} ج.م</span>
        </div>
        ${pagination(stateKey, items.length, page, cardId, true)}
      </article>
    `;
  }).join('');
}

function renderAdditionsSection() {
  const rows = reportState.additions;
  const page = validPage(pageState.additions, rows.length);
  pageState.additions = page;
  return `
    <section class="panel report-section" id="report-additions">
      <div class="panel-head gold-line">
        <div>
          <h3>تقرير الإضافات المفصل</h3>
          <p>${rows.length} حركة إضافة مخزنية</p>
        </div>
        ${actions('additions')}
      </div>
      <div class="panel-body" style="padding-top:0;">
        <div class="reports-live-search">
          <input type="search" placeholder="بحث سريع في جدول الإضافات..." data-live-search>
        </div>
        <div class="table-wrap">${renderAdditionsTable(pageSlice(rows, page))}</div>
        ${pagination('additions', rows.length, page, 'report-additions')}
      </div>
    </section>
  `;
}

function renderAdditionsSummarySection() {
  return `
    <section class="panel report-section" id="report-additions-summary">
      <div class="panel-head gold-line">
        <div>
          <h3>ملخص الإضافات لكل فرع</h3>
          <p>إجمالي الكميات الواردة لكل صنف</p>
        </div>
        ${actions('additions-summary')}
      </div>
      <div class="panel-body">
        <div class="summary-grid">${renderAdditionsSummaryCards(reportState.additionsSummary)}</div>
      </div>
    </section>
  `;
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
    return `
      <article class="summary-card" id="${cardId}">
        <h4>${escapeHtml(group.branch?.name)}</h4>
        <div class="summary-card-items">
          ${pageSlice(items, page).map(item => `
            <div class="summary-row">
              <span>${escapeHtml(item.material?.name)}</span>
              <b>${money(item.quantity)} ${escapeHtml(item.material?.unit)}</b>
              <span>مضاف</span>
            </div>
          `).join('')}
        </div>
        <div class="summary-total">
          <span>إجمالي الكمية المضافة</span>
          <span>${money(totalQuantity)}</span>
        </div>
        ${pagination(stateKey, items.length, page, cardId, true)}
      </article>
    `;
  }).join('');
}

function renderBalanceSection() {
  const rows = reportState.balance;
  const page = validPage(pageState.balance, rows.length);
  pageState.balance = page;

  return `
    <section class="panel report-section" id="report-balance">
      <div class="panel-head gold-line">
        <div>
          <h3>حركة وصافي المخزون التقديري</h3>
          <p>صافي حركة الفترة (الوارد المضاف − المنصرف المستهلك خلال الفترة المحددة)</p>
        </div>
        ${actions('balance')}
      </div>
      <div class="panel-body" style="padding-top:0;">
        <div class="reports-live-search">
          <input type="search" placeholder="بحث سريع في حركة الأصناف..." data-live-search>
        </div>
        <div class="table-wrap">${renderBalanceTable(pageSlice(rows, page))}</div>
        ${pagination('balance', rows.length, page, 'report-balance')}
      </div>
    </section>
  `;
}

// -------------------------------------------------------------
// ALL BRANCHES INVENTORY HISTORY PULL (سحب كل الجرود لكل فرع بالتواريخ)
// -------------------------------------------------------------
function renderInventoryHistorySection() {
  if (reportState.inventoryHistoryLoading) {
    return `
      <section class="panel report-section">
        <div class="empty-state">
          <span class="forced-refresh-spinner" style="border-color: rgba(0,0,0,.15); border-top-color: var(--blue);"></span>
          <br><br>
          <b>جارٍ سحب وتجميع كل جلسات الجرد لجميع الفروع بالتواريخ والأرصدة...</b>
          <p>يتم الآن قراءة الأصناف، الأرصدة الدفترية، الجرد الفعلي، الفروق، والتكاليف لكل فرع.</p>
        </div>
      </section>
    `;
  }

  const history = reportState.inventoryHistory;
  if (!history || !history.length) {
    return `
      <section class="panel report-section">
        <div class="panel-head gold-line">
          <div>
            <h3>سجل كل الجرود لكل فرع تحت بعض بالتواريخ والأرصدة</h3>
            <p>سحب شامل لكافة جلسات الجرد التاريخية مع الأرصدة والفروق والتكلفة</p>
          </div>
          <button class="btn gold" onclick="loadAllBranchesInventoryHistory(true)">إعادة تحميل الجرود 🔄</button>
        </div>
        <div class="empty-state">
          <b>—</b>لا توجد جلسات جرد مكتملة مسجلة في الفروع المحددة.
        </div>
      </section>
    `;
  }

  const totalSessionsCount = history.reduce((sum, b) => sum + b.snapshots.length, 0);

  return `
    <section class="panel report-section" id="report-inventory-history">
      <div class="panel-head gold-line">
        <div>
          <h3>سجل كل الجرود لكل فرع تحت بعض بالتواريخ والأرصدة</h3>
          <p>تم سحب ${totalSessionsCount} جلسة جرد مكتملة عبر ${history.length} فرع مرتبة زمنياً.</p>
        </div>
        <div class="report-actions">
          <button class="btn gold" data-export="all-branches-history">تنزيل سحبة كل الجرود Excel شامل ↓</button>
          <button class="btn ghost mini" onclick="loadAllBranchesInventoryHistory(true)">تحديث 🔄</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="reports-live-search">
          <input type="search" placeholder="بحث سريع في كل الفروع والجرود (اسم الصنف، الكود، الفرع...)" data-live-search>
        </div>

        <div class="branch-history-container">
          ${history.map(bItem => renderBranchHistoryCard(bItem)).join('')}
        </div>
      </div>
    </section>
  `;
}

function renderBranchHistoryCard({ branch, snapshots }) {
  const materialById = new Map((reportState.materials || []).map(m => [m.id, m]));

  return `
    <div class="branch-history-block" data-branch-block>
      <div class="branch-history-head">
        <h4>
          <span>🏢</span> فرع ${escapeHtml(branch.name)}
          <span class="branch-history-badge">${snapshots.length} جرد مسجل</span>
        </h4>
      </div>

      <div class="branch-history-sessions">
        ${snapshots.map((snapshot, sIdx) => {
          const sDate = formatInventorySessionDate(snapshot.session);
          const entries = snapshot.entries || [];
          const variance = snapshot.stock_variance || [];
          const varianceByMat = new Map(variance.map(v => [v.material_id, v]));
          const totalValuation = variance.reduce((sum, v) => sum + Number(v.actual_quantity || 0) * Number(materialById.get(v.material_id)?.cost_price || 0), 0);
          const shortageCount = variance.filter(v => Number(v.variance_quantity || 0) < 0).length;
          const surplusCount = variance.filter(v => Number(v.variance_quantity || 0) > 0).length;

          // Combine entries and variance into distinct rows
          const materialsInSession = [...new Set([...entries.map(e => e.material_id), ...variance.map(v => v.material_id)])];

          return `
            <div class="session-timeline-card">
              <div class="session-timeline-head">
                <div class="session-timeline-date">
                  <span>📅 جرد تاريخ: <b>${escapeHtml(sDate)}</b></span>
                  <i>الجرد #${sIdx + 1}</i>
                </div>
                <div class="session-timeline-meta">
                  <span>قيمة الجرد بالتكلفة: <b>${money(totalValuation)} ج.م</b></span> · 
                  <span style="color: ${shortageCount ? '#dc2626' : '#6b7280'}; font-weight: bold;">عجز: ${shortageCount} صنف</span> · 
                  <span style="color: ${surplusCount ? '#16a34a' : '#6b7280'}; font-weight: bold;">زيادة: ${surplusCount} صنف</span> · 
                  <span>بواسطة: ${escapeHtml(snapshot.session.created_by_name || '—')}</span>
                </div>
              </div>

              <div class="table-wrap">
                <table class="data-table" data-filterable-table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>كود الصنف</th>
                      <th>اسم الصنف</th>
                      <th>الوحدة</th>
                      <th>رصيد أول المدة</th>
                      <th>الإضافات</th>
                      <th>الصرف</th>
                      <th>الرصيد المتوقع</th>
                      <th>الجرد الفعلي</th>
                      <th>العجز / الزيادة</th>
                      <th>تكلفة الوحدة</th>
                      <th>إجمالي القيمة</th>
                      <th>الملاحظات وتوزيع الصلاحية</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${materialsInSession.map((mId, idx) => {
                      const mat = materialById.get(mId) || {};
                      const stock = varianceByMat.get(mId) || {};
                      const matEntries = entries.filter(e => e.material_id === mId);
                      const costPrice = Number(mat.cost_price || 0);
                      const actualQty = Number(stock.actual_quantity ?? matEntries.reduce((s, e) => s + Number(e.quantity || 0), 0));
                      const diff = stockValue(stock.variance_quantity);
                      const val = actualQty * costPrice;
                      const statusBadge = stock.variance_quantity == null ? '<span class="badge">غير متاح</span>' : diff < 0
                        ? `<span class="badge danger">عجز ${money(Math.abs(diff))}</span>`
                        : diff > 0
                        ? `<span class="badge temp">زيادة ${money(diff)}</span>`
                        : `<span class="badge client">مطابق</span>`;

                      const notesList = matEntries.flatMap(e => {
                        if (e.is_supply) return [`مستلزمات (${money(e.quantity)})`];
                        return (e.expiry_batches || []).map(b => `${b.expiration_date}: ${money(b.quantity)}`);
                      }).join(' | ');

                      return `
                        <tr class="${diff < 0 ? 'negative-row' : ''}">
                          <td>${idx + 1}</td>
                          <td>${escapeHtml(mat.code || '—')}</td>
                          <td class="row-title"><b>${escapeHtml(mat.name || 'صنف غير معروف')}</b></td>
                          <td>${escapeHtml(mat.unit || '—')}</td>
                          <td>${stockDisplay(stock.opening_quantity)}</td>
                          <td>${money(stock.additions_quantity)}</td>
                          <td>${money(stock.consumption_quantity)}</td>
                          <td><b>${stockDisplay(stock.expected_quantity)}</b></td>
                          <td style="font-weight: 900; color: #142a55;">${money(actualQty)}</td>
                          <td>${statusBadge}</td>
                          <td>${money(costPrice)} ج.م</td>
                          <td><b>${money(val)} ج.م</b></td>
                          <td><small>${escapeHtml(notesList || eNotes(matEntries) || '—')}</small></td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colspan="4">إجمالي جرد ${escapeHtml(sDate)}</td>
                      <td colspan="4"></td>
                      <td><b>${money(variance.reduce((s, v) => s + Number(v.actual_quantity || 0), 0))}</b></td>
                      <td><b>${money(variance.reduce((s, v) => s + Number(v.variance_quantity || 0), 0))}</b></td>
                      <td></td>
                      <td><b>${money(totalValuation)} ج.م</b></td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function eNotes(entries) {
  return entries.map(e => e.notes).filter(Boolean).join(' | ');
}

async function loadAllBranchesInventoryHistory(force = false) {
  if (reportState.inventoryHistory && !force) return reportState.inventoryHistory;
  reportState.inventoryHistoryLoading = true;
  renderOutput();

  try {
    const branches = scopedBranches();
    const branchHistory = await Promise.all(branches.map(async branch => {
      const { data, error } = await supabase.rpc('accounting_report_source', { target_branch: branch.id, through_date: reportState.to });
      if (error) throw error;
      const completed = (data.sessions || []).filter(session => session.status === 'completed' && session.inventory_date >= reportState.from);
      const snapshots = await Promise.all(completed.map(session => getInventorySessionSnapshot(session.id)));
      snapshots.sort((a, b) => String(a.session.inventory_date || a.session.created_at).localeCompare(String(b.session.inventory_date || b.session.created_at)));
      return { branch, snapshots };
    }));

    reportState.inventoryHistory = branchHistory.filter(b => b.snapshots.length > 0);
  } catch (err) {
    console.error('Failed to load all branch inventory history:', err);
    reportState.inventoryHistory = [];
    toast('تعذر سحب كامل الجرود لجميع الفروع', 'error');
  } finally {
    reportState.inventoryHistoryLoading = false;
    renderOutput();
  }
}

async function getInventorySessionSnapshot(sessionId) {
  const [snapshotResult, varianceResult, sessionResult] = await Promise.all([
    supabase.rpc('inventory_session_snapshot', { target_session: sessionId }),
    supabase.rpc('inventory_session_variance', { target_session: sessionId }),
    supabase.from('inventory_sessions').select('id,inventory_date').eq('id', sessionId).single(),
  ]);

  if (snapshotResult.error) throw snapshotResult.error;
  if (varianceResult.error) throw varianceResult.error;
  if (sessionResult.error) throw sessionResult.error;
  const data = snapshotResult.data || {};
  data.stock_variance = varianceResult?.data || [];
  if (sessionResult?.data?.inventory_date) data.session.inventory_date = sessionResult.data.inventory_date;
  return data;
}

function formatInventorySessionDate(session) {
  if (!session) return '';
  if (session.inventory_date) return session.inventory_date;
  const raw = session.completed_at || session.created_at;
  return raw ? String(raw).slice(0, 10) : '';
}

function wireLiveTableSearch(container) {
  const inputs = container.querySelectorAll('[data-live-search]');
  inputs.forEach(input => {
    input.oninput = () => {
      const query = normalizeMaterialSearch(input.value);
      const section = input.closest('section') || input.closest('.branch-history-block') || container;
      const tables = section.querySelectorAll('[data-filterable-table]');

      tables.forEach(table => {
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(tr => {
          if (!query) {
            tr.style.display = '';
            return;
          }
          const text = normalizeMaterialSearch(tr.innerText);
          tr.style.display = text.includes(query) ? '' : 'none';
        });
      });
    };
  });
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
    map[branchId].items[row.material_id].revenue += saleTotal(row);
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
  return rows.length ? `<table class="data-table" data-filterable-table><thead><tr><th>التاريخ</th><th>الفرع</th><th>الصنف</th><th>كود الصنف</th><th>الوحدة</th><th>الكمية</th><th>بواسطة</th></tr></thead><tbody>${rows.map(row => `<tr><td>${row.date}</td><td><b>${escapeHtml(row.branches?.name)}</b></td><td><span class="row-title">${escapeHtml(row.materials?.name)}</span></td><td>${escapeHtml(row.materials?.code)}</td><td>${escapeHtml(row.materials?.unit)}</td><td><b>${row.quantity}</b></td><td>${escapeHtml(row.users?.full_name || '—')}</td></tr>`).join('')}</tbody></table>` : empty('لا توجد إضافات مطابقة');
}

function renderBalanceTable(rows) {
  return rows.length ? `<table class="data-table" data-filterable-table><thead><tr><th>الفرع</th><th>الصنف</th><th>كود الصنف</th><th>الوحدة</th><th>الوارد (الإضافات)</th><th>المنصرف (الصرف)</th><th>صافي الحركة</th></tr></thead><tbody>${rows.map(row => `<tr class="${row.balance < 0 ? 'negative-row' : ''}"><td><b>${escapeHtml(row.branch?.name)}</b></td><td class="row-title">${escapeHtml(row.material?.name)}</td><td>${escapeHtml(row.material?.code || '—')}</td><td>${escapeHtml(row.material?.unit)}</td><td>${money(row.added)}</td><td>${money(row.consumed)}</td><td style="font-weight: 800; color: ${row.balance < 0 ? '#dc2626' : row.balance > 0 ? '#16a34a' : '#111'};">${money(row.balance)}</td></tr>`).join('')}</tbody></table>` : empty('لا توجد حركات لحساب الرصيد');
}

function rowsFor(type) {
  const state = reportState;
  if (type === 'detailed') return state.consumption.map(row => ({ 'التاريخ': row.date, 'الفرع': row.branches?.name, 'العميلة': row.client_name, 'كود العميلة': row.client_code, 'الصنف': row.materials?.name, 'كود الصنف': row.materials?.code, 'الوحدة': row.unit, 'الكمية': row.quantity, 'إجمالي سعر البيع': saleTotal(row), 'النوع': row.record_type === 'client' ? 'عميلة' : 'تحويل', 'بواسطة': row.users?.full_name || '' }));
  if (type === 'summary') return state.summary.flatMap(group => Object.values(group.items).map(item => ({ 'الفرع': group.branch?.name, 'الصنف': item.material?.name, 'كود الصنف': item.material?.code, 'الوحدة': item.material?.unit, 'إجمالي الكمية': item.quantity, 'إجمالي الإيراد': item.revenue })));
  if (type === 'additions') return state.additions.map(row => ({ 'التاريخ': row.date, 'الفرع': row.branches?.name, 'الصنف': row.materials?.name, 'كود الصنف': row.materials?.code, 'الوحدة': row.materials?.unit, 'الكمية المضافة': row.quantity, 'بواسطة': row.users?.full_name || '' }));
  if (type === 'additions-summary') return state.additionsSummary.flatMap(group => Object.values(group.items).map(item => ({ 'الفرع': group.branch?.name, 'الصنف': item.material?.name, 'كود الصنف': item.material?.code, 'الوحدة': item.material?.unit, 'إجمالي الكمية المضافة': item.quantity })));
  return state.balance.map(row => ({ 'الفرع': row.branch?.name, 'الصنف': row.material?.name, 'كود الصنف': row.material?.code, 'الوحدة': row.material?.unit, 'إجمالي المضاف': row.added, 'إجمالي المصروف': row.consumed, 'صافي الحركة': row.balance }));
}

const MOVEMENT_HEADERS = ['التاريخ', 'الفرع', 'نوع الحركة', 'الصنف', 'كود الصنف', 'الوحدة', 'الكمية', 'إجمالي سعر البيع', 'العميلة', 'كود العميلة', 'نوع الصرف', 'بواسطة'];
const FULL_SUMMARY_HEADERS = ['الفرع', 'الصنف', 'كود الصنف', 'الوحدة', 'إجمالي المضاف', 'إجمالي المصروف', 'صافي الحركة', 'إجمالي الإيراد'];

function scopedBranches() {
  return reportState.branch ? reportState.branches.filter(branch => branch.id === reportState.branch) : reportState.branches;
}

function movementRows(branchId = '') {
  const consumption = reportState.consumption
    .filter(row => !branchId || row.branch_id === branchId)
    .map(row => ({
      'التاريخ': row.date, 'الفرع': row.branches?.name || '', 'نوع الحركة': 'صرف',
      'الصنف': row.materials?.name || '', 'كود الصنف': row.materials?.code || '', 'الوحدة': row.unit || row.materials?.unit || '',
      'الكمية': Number(row.quantity || 0), 'إجمالي سعر البيع': saleTotal(row),
      'العميلة': row.client_name || '', 'كود العميلة': row.client_code || '', 'نوع الصرف': row.record_type === 'client' ? 'عميلة' : 'تحويل',
      'بواسطة': row.users?.full_name || ''
    }));
  const additions = reportState.additions
    .filter(row => !branchId || row.branch_id === branchId)
    .map(row => ({
      'التاريخ': row.date, 'الفرع': row.branches?.name || '', 'نوع الحركة': 'إضافة',
      'الصنف': row.materials?.name || '', 'كود الصنف': row.materials?.code || '', 'الوحدة': row.materials?.unit || '',
      'الكمية': Number(row.quantity || 0), 'إجمالي سعر البيع': 0,
      'العميلة': '', 'كود العميلة': '', 'نوع الصرف': '', 'بواسطة': row.users?.full_name || ''
    }));
  return [...consumption, ...additions].sort((a, b) => String(a['التاريخ']).localeCompare(String(b['التاريخ'])) || String(a['الفرع']).localeCompare(String(b['الفرع'])));
}

function fullSummaryRows(branchId = '') {
  const revenue = new Map();
  reportState.consumption.filter(row => !branchId || row.branch_id === branchId).forEach(row => {
    const key = `${row.branch_id}|${row.material_id}`;
    revenue.set(key, (revenue.get(key) || 0) + saleTotal(row));
  });
  return reportState.balance
    .filter(row => !branchId || row.branch_id === branchId)
    .map(row => {
      const key = `${row.branch_id}|${row.material_id}`;
      return {
        'الفرع': row.branch?.name || '', 'الصنف': row.material?.name || '', 'كود الصنف': row.material?.code || '', 'الوحدة': row.material?.unit || '',
        'إجمالي المضاف': Number(row.added || 0), 'إجمالي المصروف': Number(row.consumed || 0), 'صافي الحركة': Number(row.balance || 0), 'إجمالي الإيراد': Number(revenue.get(key) || 0)
      };
    })
    .sort((a, b) => String(a['الفرع']).localeCompare(String(b['الفرع'])) || String(a['الصنف']).localeCompare(String(b['الصنف'])));
}

function withTotals(rows, headers, label) {
  if (!rows.length) return rows;
  const total = Object.fromEntries(headers.map(header => [header, '']));
  total[headers[0]] = label;
  const numeric = headers.filter(header => rows.some(row => typeof row[header] === 'number'));
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
      if (['صافي الحركة', 'الرصيد', 'العجز / الزيادة'].includes(headers[columnNumber - 1]) && Number(cell.value) < 0) {
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
    const preferred = ['الصنف', 'العميلة', 'بواسطة', 'الملاحظات'].includes(header) ? 28 : header === 'الفرع' ? 20 : Math.max(12, widestValue + 3);
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

// -------------------------------------------------------------
// EXCEL EXPORT MASTER: ALL BRANCHES HISTORICAL AUDITS
// -------------------------------------------------------------
async function exportAllBranchesHistoryExcel() {
  if (!window.ExcelJS) return toast('مكتبة تنسيق Excel غير متاحة', 'error');

  toast('جارٍ جمع وإعداد ملف سحب كل الجرود والأرصدة...');
  let history = reportState.inventoryHistory;
  if (!history || !history.length) {
    await loadAllBranchesInventoryHistory(true);
    history = reportState.inventoryHistory;
  }
  if (!history || !history.length) return toast('لا توجد بيانات جرود للتصدير', 'warning');

  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ctrl.';
    workbook.company = 'ctrl.';
    workbook.subject = 'سجل كل الجرود التاريخية لكل الفروع';
    workbook.created = new Date();
    const used = new Set();
    const logoId = workbook.addImage({ base64: createCtrlLogo(), extension: 'png' });
    const materialById = new Map((reportState.materials || []).map(m => [m.id, m]));

    // 1. MASTER TIMELINE SHEET: Every row from every branch and date
    const masterRows = [];
    history.forEach(({ branch, snapshots }) => {
      snapshots.forEach(snapshot => {
        const sDate = formatInventorySessionDate(snapshot.session);
        const entries = snapshot.entries || [];
        const variance = snapshot.stock_variance || [];
        const varianceByMat = new Map(variance.map(v => [v.material_id, v]));
        const allMatIds = [...new Set([...entries.map(e => e.material_id), ...variance.map(v => v.material_id)])];

        allMatIds.forEach(mId => {
          const mat = materialById.get(mId) || {};
          const stock = varianceByMat.get(mId) || {};
          const matEntries = entries.filter(e => e.material_id === mId);
          const cost = Number(mat.cost_price || 0);
          const actual = Number(stock.actual_quantity ?? matEntries.reduce((s, e) => s + Number(e.quantity || 0), 0));
          const diff = stockValue(stock.variance_quantity);
          const val = actual * cost;

          const notes = matEntries.flatMap(e => {
            if (e.is_supply) return [`مستلزمات (${money(e.quantity)})`];
            return (e.expiry_batches || []).map(b => `${b.expiration_date}: ${money(b.quantity)}`);
          }).join(' | ') || eNotes(matEntries);

          masterRows.push({
            'الفرع': branch.name,
            'تاريخ الجرد': sDate,
            'كود الصنف': mat.code || '',
            'اسم الصنف': mat.name || 'صنف غير معروف',
            'الفئة': mat.category || '',
            'الوحدة': mat.unit || '',
            'رصيد أول المدة': stockValue(stock.opening_quantity),
            'الإضافات': Number(stock.additions_quantity || 0),
            'الصرف': Number(stock.consumption_quantity || 0),
            'الرصيد المتوقع': stockValue(stock.expected_quantity),
            'الجرد الفعلي': actual,
            'العجز / الزيادة': diff,
            'الحالة': stock.variance_quantity == null ? 'غير متاح' : diff < 0 ? 'عجز' : diff > 0 ? 'زيادة' : 'مطابق',
            'تكلفة الوحدة': cost,
            'إجمالي قيمة المخزون': val,
            'الملاحظات وتوزيع الصلاحيات': notes,
            'القائم بالجرد': snapshot.session.created_by_name || '',
          });
        });
      });
    });

    const masterHeaders = [
      'الفرع', 'تاريخ الجرد', 'كود الصنف', 'اسم الصنف', 'الفئة', 'الوحدة',
      'رصيد أول المدة', 'الإضافات', 'الصرف', 'الرصيد المتوقع', 'الجرد الفعلي',
      'العجز / الزيادة', 'الحالة', 'تكلفة الوحدة', 'إجمالي قيمة المخزون',
      'الملاحظات وتوزيع الصلاحيات', 'القائم بالجرد'
    ];

    appendStyledReportSheet(
      workbook,
      logoId,
      used,
      'كل_الجرود_بالتواريخ',
      'سجل كل الجرود لكل الفروع مرتبة بالتواريخ والأرصدة',
      masterRows,
      masterHeaders,
      'الإجمالي العام',
      'كل الفروع'
    );

    // 2. COMPARISON SUMMARY SHEET
    const comparisonRows = [];
    history.forEach(({ branch, snapshots }) => {
      snapshots.forEach((snapshot, sIdx) => {
        const sDate = formatInventorySessionDate(snapshot.session);
        const variance = snapshot.stock_variance || [];
        const totalActual = variance.reduce((s, v) => s + Number(v.actual_quantity || 0), 0);
        const totalVal = variance.reduce((s, v) => s + Number(v.actual_quantity || 0) * Number(materialById.get(v.material_id)?.cost_price || 0), 0);
        const shortages = variance.filter(v => Number(v.variance_quantity || 0) < 0);
        const surpluses = variance.filter(v => Number(v.variance_quantity || 0) > 0);

        comparisonRows.push({
          'الفرع': branch.name,
          'رقم الجرد': `الجرد #${sIdx + 1}`,
          'تاريخ الجرد': sDate,
          'عدد الأصناف': variance.length,
          'إجمالي الكميات الفعلية': totalActual,
          'قيمة المخزون بالتكلفة': totalVal,
          'عدد أصناف العجز': shortages.length,
          'كمية العجز': shortages.reduce((s, v) => s + Math.abs(Number(v.variance_quantity || 0)), 0),
          'عدد أصناف الزيادة': surpluses.length,
          'كمية الزيادة': surpluses.reduce((s, v) => s + Number(v.variance_quantity || 0), 0),
          'مسجل الجرد': snapshot.session.created_by_name || '',
        });
      });
    });

    const compHeaders = [
      'الفرع', 'رقم الجرد', 'تاريخ الجرد', 'عدد الأصناف',
      'إجمالي الكميات الفعلية', 'قيمة المخزون بالتكلفة',
      'عدد أصناف العجز', 'كمية العجز', 'عدد أصناف الزيادة', 'كمية الزيادة',
      'مسجل الجرد'
    ];

    appendStyledReportSheet(
      workbook,
      logoId,
      used,
      'ملخص_الفروع_والجرود',
      'ملخص مقارنة جرود الفروع وتطور الأرصدة',
      comparisonRows,
      compHeaders,
      'الإجمالي',
      'كل الفروع'
    );

    // 3. INDIVIDUAL SHEET FOR EACH BRANCH
    history.forEach(({ branch, snapshots }) => {
      const bRows = masterRows.filter(r => r['الفرع'] === branch.name);
      appendStyledReportSheet(
        workbook,
        logoId,
        used,
        branch.name,
        `جرود فرع ${branch.name} مرتبة بالتواريخ والأرصدة`,
        bRows,
        masterHeaders,
        `إجمالي فرع ${branch.name}`,
        branch.name
      );
    });

    const dateScope = today();
    await saveStyledWorkbook(workbook, `ctrl_سحب_كل_الجرود_لكل_الفروع_بالتواريخ_${dateScope}.xlsx`);
    toast(`تم تصدير سجل كل الجرود بنجاح (${workbook.worksheets.length} شيت منسق)`);
  } catch (err) {
    console.error('Error generating all branches inventory history Excel:', err);
    toast('تعذر تجهيز ملف Excel المجمع للجرود', 'error');
  }
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
    balance: ['الأرصدة', 'تقرير حركة وصافي المخزون'],
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
  const titles = {
    detailed: 'تقرير مفصل للصرف',
    summary: 'ملخص الاستهلاك لكل فرع',
    additions: 'تقرير الإضافات',
    'additions-summary': 'ملخص الإضافات لكل فرع',
    balance: 'تقرير حركة وصافي المخزون',
    all: 'التقرير الشامل لحركة المواد'
  };
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
    const headers = data[0]
      ? Object.keys(data[0])
      : type === 'detailed'
      ? ['التاريخ', 'الفرع', 'العميلة', 'كود العميلة', 'الصنف', 'كود الصنف', 'الوحدة', 'الكمية', 'إجمالي سعر البيع', 'النوع', 'بواسطة']
      : type === 'additions'
      ? ['التاريخ', 'الفرع', 'الصنف', 'كود الصنف', 'الوحدة', 'الكمية المضافة', 'بواسطة']
      : FULL_SUMMARY_HEADERS.slice(0, 7);

    content = printTable(headers, data, row => Number(row['صافي الحركة'] || row['الرصيد']) < 0 ? 'negative' : '');
  }

  printWindow.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${titles[type] || 'تقرير'}</title><style>
    @page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;color:#111;background:#fff;margin:0;font-size:10px}header{border-bottom:3px solid #b38b36;margin-bottom:14px;padding:0 0 10px;display:flex;justify-content:space-between;align-items:end}h1{margin:0;font-size:21px;color:#142a55}h2{font-size:16px;margin:12px 0 7px;color:#142a55}.meta{line-height:1.8;text-align:left;color:#444}table{width:100%;border-collapse:collapse;table-layout:auto;margin-bottom:14px}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}th{background:#142a55!important;color:#fff!important;font-weight:700;padding:6px 5px;border:1px solid #8993a5;white-space:nowrap}td{padding:5px;border:1px solid #bbb;text-align:center;vertical-align:middle}tbody tr:nth-child(even) td{background:#f3f5f8}.negative td{background:#fee2e2!important;color:#991b1b;font-weight:700}.branch-section{break-after:page}.branch-section:last-child{break-after:auto}.empty-print{padding:30px;color:#666}.brand{font-weight:900;font-size:28px;color:#b38b36}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body><header><div><div class="brand">Ctrl.</div><h1>${titles[type] || 'تقرير'}</h1></div><div class="meta">الفترة: ${reportState.from} إلى ${reportState.to}<br>الفرع: ${escapeHtml(branchScope || '')}<br>تاريخ الطباعة: ${new Date().toLocaleString('ar-EG-u-nu-latn')}</div></header>${content}<script>window.onload=()=>setTimeout(()=>{window.print();window.onafterprint=()=>window.close()},250)<\/script></body></html>`);
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
