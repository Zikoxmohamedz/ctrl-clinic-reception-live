import './theme.js';
import { supabase } from './supabase.js?v=20260801-audit-context';
import { renderConsumption } from './pages/consumption.js?v=20260901-cost-vials-v1';
import { renderAdditions } from './pages/additions.js?v=20260801-auto-add-v2';
import { renderInventory, cleanupInventory } from './pages/inventory.js?v=20260901-cost-vials-v1';
import { renderReports } from './pages/reports.js?v=20260730-sales-total-v11';
import { renderRecords } from './pages/records.js?v=20260901-notes-v1';
import { renderAuditLogs } from './pages/audit-logs.js?v=20260901-cost-vials-v1';
import { renderSettings } from './pages/settings.js?v=20260901-cost-vials-v1';

const APP_VERSION = '2026.09.01.2';
let versionCheckTimer;

async function checkForRequiredRefresh() {
  try {
    const response = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return;
    const release = await response.json();
    if (!release.version || release.version === APP_VERSION) return;
    clearInterval(versionCheckTimer);
    const overlay = document.createElement('div');
    overlay.className = 'forced-refresh-overlay';
    overlay.innerHTML = `<div><span class="forced-refresh-spinner"></span><h2>يوجد تحديث إجباري للنظام</h2><p>${release.message || 'سيتم تحميل النسخة الجديدة الآن.'}</p><small>بياناتك المحفوظة لن تضيع. جارٍ إعادة التحميل...</small></div>`;
    document.body.appendChild(overlay);
    setTimeout(() => location.reload(), 2500);
  } catch (error) {
    console.warn('Version check failed', error);
  }
}

checkForRequiredRefresh();
versionCheckTimer = setInterval(checkForRequiredRefresh, 30000);
import { list, hydrate } from './data.js?v=20260801-reception-features';

const profile = JSON.parse(sessionStorage.getItem('ctrl_profile') || 'null');
if (!profile || !supabase) {
  sessionStorage.removeItem('ctrl_profile');
  location.replace('login.html');
  throw new Error('AUTH_REQUIRED');
}

const { data: currentAuth } = await supabase.auth.getUser();
if (!currentAuth.user || currentAuth.user.id !== profile.id) {
  sessionStorage.removeItem('ctrl_profile');
  location.replace('login.html');
  throw new Error('AUTH_REQUIRED');
}

async function refreshCurrentAccess() {
  if (!supabase) return;
  const [branchesResult, permissionsResult] = await Promise.all([
    supabase.from('user_branches').select('branch_id').eq('user_id', profile.id),
    supabase.from('user_permissions').select('can_home,can_consumption,can_additions,can_inventory,can_inventory_reports,can_inventory_all_reports,can_inventory_branch_activity,can_reports,can_records,can_edit_records,can_delete_records,can_audit_logs,can_settings').eq('user_id', profile.id).single(),
  ]);
  if (!branchesResult.error && branchesResult.data.length) profile.branch_ids = branchesResult.data.map(row => row.branch_id);
  if (!permissionsResult.error) {
    const row = permissionsResult.data;
    profile.permissions = { home: row.can_home, consumption: row.can_consumption, additions: row.can_additions, inventory: row.can_inventory, inventory_reports: row.can_inventory_reports, inventory_all_reports: row.can_inventory_all_reports, inventory_branch_activity: row.can_inventory_branch_activity, reports: row.can_reports, records: row.can_records, edit_records: row.can_edit_records, delete_records: row.can_delete_records, audit_logs: row.can_audit_logs, settings: row.can_settings };
  }
  sessionStorage.setItem('ctrl_profile', JSON.stringify(profile));
}

await refreshCurrentAccess();

const titles = { home: 'لوحة التحكم', consumption: 'صرف المواد', additions: 'الإضافات', inventory: 'الجرد', reports: 'التقارير', records: 'إدارة السجلات', audit_logs: 'سجل التعديلات', settings: 'الإعدادات' };
const content = document.getElementById('app-content');
const sidebar = document.getElementById('sidebar');
const permissions = profile.permissions || { home: true, consumption: true, additions: true, inventory: true, inventory_reports: true, inventory_all_reports: profile.role === 'admin', inventory_branch_activity: profile.role === 'admin', reports: true, records: profile.role === 'admin', edit_records: profile.role === 'admin', delete_records: profile.role === 'admin', audit_logs: profile.role === 'admin', settings: profile.role === 'admin' };

document.querySelectorAll('[data-user-name]').forEach(item => item.textContent = profile?.full_name || '');
document.querySelectorAll('[data-branch-name]').forEach(item => item.textContent = profile?.branch_name || '');
document.querySelectorAll('[data-user-role]').forEach(item => item.textContent = profile?.role === 'admin' ? 'مدير النظام' : 'موظف استقبال');
document.querySelectorAll('[data-user-initial]').forEach(item => item.textContent = (profile?.full_name || 'م')[0]);
document.querySelectorAll('[data-route]').forEach(link => { if (!permissions[link.dataset.route]) link.remove(); });

document.getElementById('sidebar-toggle').onclick = () => {
  sidebar.classList.toggle('collapsed');
  localStorage.setItem('ctrl_sidebar', sidebar.classList.contains('collapsed'));
};
if (localStorage.getItem('ctrl_sidebar') === 'true') sidebar.classList.add('collapsed');
document.getElementById('mobile-menu').onclick = () => sidebar.classList.add('open');
document.addEventListener('click', event => {
  if (innerWidth <= 760 && !sidebar.contains(event.target) && !event.target.closest('#mobile-menu')) sidebar.classList.remove('open');
});
document.getElementById('logout').onclick = async () => {
  if (supabase) await supabase.auth.signOut();
  sessionStorage.removeItem('ctrl_profile');
  location.href = 'login.html';
};

async function initializeBranchSwitcher() {
  const chip = document.querySelector('.branch-chip');
  const allBranches = await list('branches');
  const allowedIds = profile.branch_ids?.length ? profile.branch_ids : profile.role === 'admin' ? allBranches.map(branch => branch.id) : [profile.branch_id];
  const branches = allBranches.filter(branch => allowedIds.includes(branch.id));
  if (!branches.some(branch => branch.id === profile.branch_id) && branches.length) {
    profile.branch_id = branches[0].id;
    profile.branch_name = branches[0].name;
    sessionStorage.setItem('ctrl_profile', JSON.stringify(profile));
  }
  if (branches.length <= 1) {
    if (chip) chip.title = 'الفرع الوحيد المسموح لحسابك';
    return;
  }
  const card = document.querySelector('.branch-card');
  const label = document.createElement('span');
  label.textContent = 'الفرع الحالي — اضغط للتغيير';
  const select = document.createElement('select');
  select.id = 'branch-switcher';
  select.setAttribute('aria-label', 'تغيير الفرع الحالي');
  branches.forEach(branch => select.add(new Option(branch.name, branch.id, false, branch.id === profile.branch_id)));
  card.replaceChildren(label, select);
  if (chip) {
    chip.classList.add('switchable');
    chip.title = 'تغيير الفرع الحالي';
    chip.textContent = `${profile.branch_name} ▾`;
    chip.onclick = () => select.focus();
  }
  select.onchange = () => {
    const branch = branches.find(item => item.id === select.value);
    profile.branch_id = branch.id;
    profile.branch_name = branch.name;
    sessionStorage.setItem('ctrl_profile', JSON.stringify(profile));
    location.reload();
  };
}

async function home() {
  const date = new Date().toLocaleDateString('en-CA');
  const [consumption, additions] = await Promise.all([list('consumption', { date }), list('additions', { date })]);
  const branchConsumption = consumption.filter(row => row.branch_id === profile.branch_id);
  const branchAdditions = additions.filter(row => row.branch_id === profile.branch_id);
  const revenue = branchConsumption.reduce((sum, row) => sum + Number(row.total_selling_price ?? row.selling_price ?? 0), 0);
  content.innerHTML = `<section class="panel welcome"><div class="panel-body"><p class="eyebrow">${new Date().toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' })}</p><h2>أهلاً، ${profile.full_name.split(' ')[0]} 👋</h2><p>إليك ملخص حركة فرع ${profile.branch_name} اليوم.</p></div></section>
  <section class="stats-grid"><article class="stat-card"><span>عمليات الصرف اليوم</span><strong>${branchConsumption.length}</strong><i>◫</i></article><article class="stat-card"><span>إجمالي الكمية المصروفة</span><strong>${branchConsumption.reduce((sum, row) => sum + Number(row.quantity), 0)}</strong><i>−</i></article><article class="stat-card"><span>الإضافات اليوم</span><strong>${branchAdditions.length}</strong><i>＋</i></article><article class="stat-card"><span>إيراد اليوم</span><strong>${new Intl.NumberFormat('ar-EG-u-nu-latn').format(revenue)} <small>ج.م</small></strong><i>↗</i></article></section>
  <section class="quick-grid"><article class="panel"><div class="panel-head"><h3>إجراءات سريعة</h3></div><div class="panel-body quick-actions"><a href="#consumption"><b>◫</b>تسجيل صرف جديد</a><a href="#additions"><b>＋</b>تسجيل إضافة مخزون</a><a href="#reports"><b>⌁</b>عرض التقارير</a></div></article><article class="panel"><div class="panel-head"><h3>آخر الحركات</h3></div><div class="panel-body">${hydrate(branchConsumption).slice(-3).reverse().map(row => `<div class="summary-row"><span>${row.materials?.name}</span><b>${row.quantity} ${row.unit}</b><small>${new Date(row.created_at).toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' })}</small></div>`).join('') || '<div class="empty-state">لا توجد حركات اليوم</div>'}</div></article></section>`;
}

async function route() {
  const firstAllowed = Object.keys(titles).find(key => permissions[key]);
  let name = location.hash.slice(1) || (permissions.home ? 'home' : firstAllowed);
  if (!permissions[name]) name = firstAllowed;
  document.querySelectorAll('[data-route]').forEach(link => link.classList.toggle('active', link.dataset.route === name));
  document.getElementById('page-title').textContent = titles[name];
  document.getElementById('breadcrumb').textContent = titles[name];
  content.innerHTML = '<div class="empty-state">جارٍ تحميل البيانات...</div>';
  sidebar.classList.remove('open');
  if (name !== 'inventory') cleanupInventory();
  try {
    if (name === 'home') await home();
    if (name === 'consumption') await renderConsumption(content, profile);
    if (name === 'additions') await renderAdditions(content, profile);
    if (name === 'inventory') await renderInventory(content, profile);
    if (name === 'reports') await renderReports(content, profile);
    if (name === 'records') await renderRecords(content, profile);
    if (name === 'audit_logs') await renderAuditLogs(content, profile);
    if (name === 'settings') await renderSettings(content, profile);
    content.focus();
  } catch (error) {
    console.error(error);
    content.innerHTML = `<div class="panel"><div class="empty-state"><b>!</b>تعذر تحميل الصفحة<br><small>${error.message}</small></div></div>`;
  }
}

addEventListener('hashchange', route);
await initializeBranchSwitcher();
route();
