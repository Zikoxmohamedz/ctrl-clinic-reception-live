import { escapeHtml, toast, confirmDialog, supabase } from '../supabase.js?v=20260801-audit-context';
import { list, insert, update, remove } from '../data.js?v=20260901-cost-vials-v1';

const pageLabels = { home: 'لوحة التحكم', consumption: 'صرف المواد', additions: 'الإضافات', inventory: 'الجرد — فتح الصفحة', reports: 'التقارير', records: 'إدارة السجلات', audit_logs: 'سجل التعديلات', settings: 'الإعدادات' };
const actionLabels = {
  inventory_reports: 'عرض وتصدير تقارير الجرد',
  inventory_all_reports: 'تقرير الجرد المجمع لكل الفروع',
  inventory_branch_activity: 'متابعة الفروع الشهرية',
  edit_records: 'تعديل السجلات',
  delete_records: 'حذف السجلات',
};
const accessLabels = { ...pageLabels, ...actionLabels };

export async function renderSettings(root) {
  root.innerHTML = `<div class="page-intro"><div><h2>الإعدادات</h2><p>إدارة الفروع والموظفين والصلاحيات ودليل المواد.</p></div></div><section class="panel"><div class="tabs"><button class="active" data-tab="branches">الفروع</button><button data-tab="users">الموظفون</button><button data-tab="permissions">الصلاحيات</button><button data-tab="temporary-materials">الأصناف المؤقتة</button><button data-tab="materials">المواد</button></div><div id="settings-content"></div></section>`;
  const box = root.querySelector('#settings-content');
  root.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => {
    root.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === button));
    renderTab(button.dataset.tab, box);
  });
  await branchesTab(box);
}

function renderTab(tab, box) {
  if (tab === 'branches') return branchesTab(box);
  if (tab === 'users') return usersTab(box);
  if (tab === 'permissions') return permissionsTab(box);
  if (tab === 'temporary-materials') return temporaryMaterialsTab(box);
  return materialsTab(box);
}

async function branchesTab(box) {
  const rows = await list('branches');
  box.innerHTML = `<div class="panel-body"><form id="branch-form" class="form-grid"><div class="field span-2"><label>اسم الفرع <em>*</em><input name="name" placeholder="مثال: New Cairo" required></label></div><div class="field"><label>كود الفرع <em>*</em><input name="code" placeholder="NEW_CAIRO" required></label></div><button class="btn primary" style="align-self:end">إضافة فرع</button></form></div><div class="table-wrap"><table class="data-table"><thead><tr><th>اسم الفرع</th><th>الكود</th><th>المعرّف</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td class="row-title">${escapeHtml(row.name)}</td><td>${escapeHtml(row.code)}</td><td><small>${row.id}</small></td><td><button class="delete-icon" data-delete="${row.id}">×</button></td></tr>`).join('')}</tbody></table></div>`;
  box.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    await insert('branches', { name: event.currentTarget.name.value.trim(), code: event.currentTarget.code.value.trim().toUpperCase() });
    toast('تمت إضافة الفرع');
    branchesTab(box);
  };
  wireDelete(box, 'branches', branchesTab, 'الفرع');
}

async function usersTab(box) {
  const [users, branches] = await Promise.all([list('users'), list('branches')]);
  const access = await getAccessData(users);
  box.innerHTML = `<div class="panel-body">
    <div class="settings-callout"><div><b>إضافة موظف جديد</b><span>المسمى الوظيفي للتعريف فقط؛ الفروع والصفحات تتحكم فيها أنت.</span></div></div>
    <form id="user-form" class="form-grid">
      <div class="field"><label>الاسم الكامل<input name="full_name" required></label></div>
      <div class="field"><label>اسم المستخدم<input name="username" type="text" minlength="3" maxlength="32" pattern="[A-Za-z0-9._-]+" autocomplete="off" placeholder="مثال: sara.helwan" required><small>حروف إنجليزية وأرقام و . _ - فقط</small></label></div>
      <div class="field"><label>كلمة المرور<input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="8 أحرف على الأقل" required></label></div>
      <div class="field"><label>المسمى الوظيفي<select name="role"><option value="receptionist">موظف استقبال</option><option value="admin">مدير</option></select></label></div>
      <div class="field span-2"><label>الفروع المسموحة <em>*</em></label><div class="check-grid branch-checks">${branches.map((branch, index) => checkCard('branch_ids', branch.id, branch.name, index === 0)).join('')}</div></div>
      <div class="field span-2"><label>الصفحات الظاهرة <em>*</em></label><div class="check-grid permission-checks">${Object.entries(pageLabels).map(([key, label]) => checkCard(`permission_${key}`, '1', label, !['records', 'audit_logs', 'settings'].includes(key))).join('')}</div></div>
      <div class="field span-2"><label>صلاحيات الإجراءات والتقارير</label><div class="check-grid permission-checks">${Object.entries(actionLabels).map(([key, label]) => checkCard(`permission_${key}`, '1', label, false)).join('')}</div></div>
      <button class="btn primary">إضافة الموظف</button>
    </form>
    <div class="section-divider"></div>
    <div class="import-card"><div><b>استيراد الموظفين من Excel</b><p>اكتب username وpassword لكل موظف. branch_codes وpermissions يقبلان أكثر من قيمة مفصولة بفاصلة.</p></div><div class="import-actions"><button type="button" class="btn gold" id="download-users-template">تنزيل قالب فارغ ↓</button><label class="btn ghost file-button">اختيار ملف Excel<input id="users-import-file" type="file" accept=".xlsx,.xls" hidden></label></div><div id="import-status" class="import-status" hidden></div></div>
  </div>
  <div class="table-wrap"><table class="data-table"><thead><tr><th>الموظف</th><th>اسم المستخدم</th><th>المسمى</th><th>الفروع المسموحة</th><th>الصفحات</th><th>الحساب</th></tr></thead><tbody>${users.length ? users.map(user => {
    const branchNames = (access.branches[user.id] || []).map(id => branches.find(branch => branch.id === id)?.name).filter(Boolean);
    const allowedPages = Object.entries(access.permissions[user.id] || {}).filter(([key, allowed]) => allowed && accessLabels[key]).map(([key]) => accessLabels[key]);
    const username = user.username || user.email?.split('@')[0] || '';
    return `<tr><td class="row-title">${escapeHtml(user.full_name)}</td><td><b>${escapeHtml(username || '—')}</b></td><td><span class="badge ${user.role === 'admin' ? 'admin' : 'client'}">${user.role === 'admin' ? 'مدير' : 'استقبال'}</span></td><td><div class="chip-list">${branchNames.map(name => `<span>${escapeHtml(name)}</span>`).join('')}</div></td><td>${escapeHtml(allowedPages.join('، ') || 'بدون صفحات')}</td><td><div class="employee-account-actions"><button type="button" class="btn ghost mini" data-edit-employee="${user.id}" data-user-name="${escapeHtml(user.full_name)}" data-username="${escapeHtml(username)}">تعديل الاسم واليوزر</button><button type="button" class="btn ghost mini" data-change-password="${user.id}" data-user-name="${escapeHtml(user.full_name)}">تغيير الباسورد</button></div></td></tr>`;
  }).join('') : '<tr><td colspan="6"><div class="empty-state">لا يوجد موظفون بعد</div></td></tr>'}</tbody></table></div>`;

  box.querySelector('#user-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const branchIds = [...form.querySelectorAll('[name="branch_ids"]:checked')].map(input => input.value);
    const permissions = Object.fromEntries(Object.keys(accessLabels).map(key => [key, form.querySelector(`[name="permission_${key}"]`).checked]));
    if (!branchIds.length) return toast('اختر فرعاً واحداً على الأقل', 'warning');
    if (!Object.values(permissions).some(Boolean)) return toast('اختر صفحة واحدة على الأقل', 'warning');
    const permissionError = validatePermissionDependencies(permissions);
    if (permissionError) return toast(permissionError, 'warning');
    try {
      await createUser({ full_name: form.full_name.value.trim(), username: form.username.value.trim().toLowerCase(), password: form.password.value, branch_id: branchIds[0], branch_ids: branchIds, role: form.role.value, permissions });
      toast('تمت إضافة الموظف ويمكنه الدخول فورًا');
      usersTab(box);
    } catch (error) { toast(error.message, 'error'); }
  };
  box.querySelector('#download-users-template').onclick = () => downloadUsersTemplate(branches);
  box.querySelector('#users-import-file').onchange = event => importUsersWorkbook(event.target.files[0], branches, box);
  box.querySelectorAll('[data-edit-employee]').forEach(button => button.onclick = () => openEmployeeModal(button.dataset.editEmployee, button.dataset.userName, button.dataset.username, () => usersTab(box)));
  box.querySelectorAll('[data-change-password]').forEach(button => button.onclick = () => openPasswordModal(button.dataset.changePassword, button.dataset.userName));
}

async function permissionsTab(box) {
  const [users, branches] = await Promise.all([list('users'), list('branches')]);
  const access = await getAccessData(users);
  box.innerHTML = `<div class="panel-body"><div class="settings-callout"><div><b>صلاحيات المستخدمين</b><span>اختر الفروع والصفحات لكل شخص بصرف النظر عن مسماه الوظيفي.</span></div></div><div class="access-list">${users.map(user => {
    const userBranches = access.branches[user.id] || [];
    const permissions = access.permissions[user.id] || defaultPermissions(user.role);
    return `<form class="access-card" data-access-user="${user.id}"><div class="access-card-head"><div><span class="avatar">${escapeHtml(user.full_name?.[0] || 'م')}</span><div><b>${escapeHtml(user.full_name)}</b><small>@${escapeHtml(user.username || user.email?.split('@')[0] || '')} · ${user.role === 'admin' ? 'مدير' : 'موظف استقبال'}</small></div></div><button class="btn primary" type="submit">حفظ الصلاحيات</button></div><div class="access-columns"><div><h4>الفروع المسموحة</h4><div class="check-grid">${branches.map(branch => checkCard('branch_ids', branch.id, branch.name, userBranches.includes(branch.id))).join('')}</div></div><div><h4>الصفحات الظاهرة</h4><div class="check-grid pages">${Object.entries(pageLabels).map(([key, label]) => checkCard(`permission_${key}`, '1', label, !!permissions[key])).join('')}</div><h4 class="access-action-title">الإجراءات وتقارير الجرد</h4><div class="check-grid pages">${Object.entries(actionLabels).map(([key, label]) => checkCard(`permission_${key}`, '1', label, !!permissions[key])).join('')}</div></div></div></form>`;
  }).join('')}</div></div>`;
  box.querySelectorAll('[data-access-user]').forEach(form => form.onsubmit = async event => {
    event.preventDefault();
    const userId = form.dataset.accessUser;
    const branchIds = [...form.querySelectorAll('[name="branch_ids"]:checked')].map(input => input.value);
    const permissions = Object.fromEntries(Object.keys(accessLabels).map(key => [key, form.querySelector(`[name="permission_${key}"]`).checked]));
    if (!branchIds.length) return toast('يجب السماح بفرع واحد على الأقل', 'warning');
    if (!Object.values(permissions).some(Boolean)) return toast('يجب إظهار صفحة واحدة على الأقل', 'warning');
    const permissionError = validatePermissionDependencies(permissions);
    if (permissionError) return toast(permissionError, 'warning');
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try { await saveAccess(userId, branchIds, permissions); toast('تم حفظ الفروع والصلاحيات'); }
    catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  });
}

function checkCard(name, value, label, checked) {
  return `<label class="check-card"><input type="checkbox" name="${name}" value="${value}" ${checked ? 'checked' : ''}><span><i>✓</i>${escapeHtml(label)}</span></label>`;
}

function defaultPermissions(role) {
  const admin = role === 'admin';
  return { home: true, consumption: true, additions: true, inventory: true, inventory_reports: true, inventory_all_reports: admin, inventory_branch_activity: admin, reports: true, records: admin, edit_records: admin, delete_records: admin, audit_logs: admin, settings: admin };
}

async function getAccessData(users) {
  const [branchesResult, permissionsResult] = await Promise.all([
    supabase.from('user_branches').select('user_id,branch_id'),
    supabase.from('user_permissions').select('user_id,can_home,can_consumption,can_additions,can_inventory,can_inventory_reports,can_inventory_all_reports,can_inventory_branch_activity,can_reports,can_records,can_edit_records,can_delete_records,can_audit_logs,can_settings'),
  ]);
  if (branchesResult.error) throw branchesResult.error;
  if (permissionsResult.error) throw permissionsResult.error;
  const branches = {};
  branchesResult.data.forEach(row => (branches[row.user_id] ??= []).push(row.branch_id));
  const permissions = Object.fromEntries(permissionsResult.data.map(row => [row.user_id, { home: row.can_home, consumption: row.can_consumption, additions: row.can_additions, inventory: row.can_inventory, inventory_reports: row.can_inventory_reports, inventory_all_reports: row.can_inventory_all_reports, inventory_branch_activity: row.can_inventory_branch_activity, reports: row.can_reports, records: row.can_records, edit_records: row.can_edit_records, delete_records: row.can_delete_records, audit_logs: row.can_audit_logs, settings: row.can_settings }]));
  return { branches, permissions };
}

async function saveAccess(userId, branchIds, permissions) {
  const { error: deleteError } = await supabase.from('user_branches').delete().eq('user_id', userId);
  if (deleteError) throw deleteError;
  const { error: branchError } = await supabase.from('user_branches').insert(branchIds.map(branchId => ({ user_id: userId, branch_id: branchId })));
  if (branchError) throw branchError;
  const { error: profileError } = await supabase.from('users').update({ branch_id: branchIds[0] }).eq('id', userId);
  if (profileError) throw profileError;
  const { error: permissionError } = await supabase.from('user_permissions').upsert({ user_id: userId, can_home: permissions.home, can_consumption: permissions.consumption, can_additions: permissions.additions, can_inventory: permissions.inventory, can_inventory_reports: permissions.inventory_reports, can_inventory_all_reports: permissions.inventory_all_reports, can_inventory_branch_activity: permissions.inventory_branch_activity, can_reports: permissions.reports, can_records: permissions.records, can_edit_records: permissions.edit_records, can_delete_records: permissions.delete_records, can_audit_logs: permissions.audit_logs, can_settings: permissions.settings, updated_at: new Date().toISOString() });
  if (permissionError) throw permissionError;
  const current = JSON.parse(sessionStorage.getItem('ctrl_profile') || 'null');
  if (current?.id === userId) {
    current.branch_ids = branchIds;
    current.branch_id = branchIds.includes(current.branch_id) ? current.branch_id : branchIds[0];
    current.permissions = permissions;
    sessionStorage.setItem('ctrl_profile', JSON.stringify(current));
    setTimeout(() => location.reload(), 700);
  }
}

async function createUser(payload) {
  const { data, error } = await supabase.functions.invoke('invite-user', { body: payload });
  if (error) throw new Error(data?.error || error.message || 'تعذر إنشاء المستخدم');
  if (data?.error) throw new Error(data.error);
  return data;
}

function openEmployeeModal(userId, currentName, currentUsername, onSaved) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><form class="modal small employee-edit-modal"><button type="button" class="modal-x">×</button><p class="eyebrow">إدارة حساب الموظف</p><h3>تعديل بيانات الموظف</h3><p>تغيير اسم المستخدم سيغيّر الاسم الذي يدخل به الموظف في المرة القادمة.</p><div class="field"><label>اسم الموظف <em>*</em><input name="full_name" value="${escapeHtml(currentName)}" required></label></div><div class="field"><label>اسم المستخدم <em>*</em><input name="username" value="${escapeHtml(currentUsername)}" minlength="3" maxlength="32" pattern="[A-Za-z0-9._-]+" autocomplete="off" required><small>حروف إنجليزية وأرقام و . _ - فقط</small></label></div><div class="modal-actions"><button type="button" class="btn ghost modal-cancel">إلغاء</button><button class="btn primary" type="submit">حفظ التعديل</button></div></form></div>`;
  const form = root.querySelector('form');
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.modal-x').onclick = close;
  root.querySelector('.modal-cancel').onclick = close;
  form.onsubmit = async event => {
    event.preventDefault();
    const fullName = form.full_name.value.trim();
    const username = form.username.value.trim().toLowerCase();
    if (!fullName) return toast('اكتب اسم الموظف', 'warning');
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const { data, error } = await supabase.functions.invoke('invite-user', { body: { action: 'update_user', user_id: userId, full_name: fullName, username } });
      if (error || data?.error) throw new Error(data?.error || error?.message || 'تعذر تعديل بيانات الموظف');
      close();
      toast('تم تعديل اسم الموظف واسم المستخدم');
      await onSaved?.();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  };
  form.full_name.focus();
}

function openPasswordModal(userId, userName) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><form class="modal small password-modal"><button type="button" class="modal-x">×</button><p class="eyebrow">إدارة حساب الموظف</p><h3>تغيير باسورد ${escapeHtml(userName)}</h3><p>لن تظهر كلمة المرور داخل سجل التعديلات؛ سيسجل النظام فقط أن المدير غيّرها.</p><div class="field"><label>الباسورد الجديد <em>*</em><input name="password" type="password" minlength="8" autocomplete="new-password" required placeholder="8 أحرف على الأقل"></label></div><div class="field"><label>تأكيد الباسورد <em>*</em><input name="confirm_password" type="password" minlength="8" autocomplete="new-password" required></label></div><div class="modal-actions"><button type="button" class="btn ghost modal-cancel">إلغاء</button><button class="btn primary" type="submit">حفظ الباسورد</button></div></form></div>`;
  const form = root.querySelector('form');
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.modal-x').onclick = close;
  root.querySelector('.modal-cancel').onclick = close;
  form.onsubmit = async event => {
    event.preventDefault();
    if (form.password.value !== form.confirm_password.value) return toast('تأكيد الباسورد غير مطابق', 'warning');
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const { data, error } = await supabase.functions.invoke('invite-user', { body: { action: 'change_password', user_id: userId, password: form.password.value } });
      if (error || data?.error) throw new Error(data?.error || error?.message || 'تعذر تغيير الباسورد');
      close();
      toast('تم تغيير الباسورد بنجاح');
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  };
  form.password.focus();
}

function downloadUsersTemplate(branches) {
  if (!window.XLSX) return toast('مكتبة Excel غير متاحة', 'error');
  const workbook = XLSX.utils.book_new();
  const usersSheet = XLSX.utils.aoa_to_sheet([['full_name', 'username', 'password', 'branch_codes', 'role', 'permissions']]);
  usersSheet['!cols'] = [{ wch: 24 }, { wch: 22 }, { wch: 20 }, { wch: 34 }, { wch: 18 }, { wch: 44 }];
  const branchesSheet = XLSX.utils.json_to_sheet(branches.map(branch => ({ branch_name: branch.name, branch_code: branch.code })));
  const pagesSheet = XLSX.utils.json_to_sheet(Object.entries(accessLabels).map(([page_key, page_name]) => ({ page_key, page_name })));
  XLSX.utils.book_append_sheet(workbook, usersSheet, 'Employees');
  XLSX.utils.book_append_sheet(workbook, branchesSheet, 'Branch Codes');
  XLSX.utils.book_append_sheet(workbook, pagesSheet, 'Page Permissions');
  XLSX.writeFile(workbook, 'ctrl_employees_permissions_template.xlsx');
  toast('تم تنزيل قالب الموظفين والصلاحيات');
}

async function importUsersWorkbook(file, branches, box) {
  if (!file) return;
  const status = box.querySelector('#import-status');
  status.hidden = false;
  status.className = 'import-status';
  status.textContent = 'جارٍ قراءة الملف والتحقق من البيانات...';
  try {
    if (!window.XLSX) throw new Error('مكتبة Excel غير متاحة');
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
    if (!rawRows.length) throw new Error('الملف لا يحتوي على موظفين');
    const normalized = rawRows.map((row, index) => normalizeEmployeeRow(row, index + 2, branches));
    const duplicates = normalized.filter((row, index) => normalized.findIndex(other => other.username === row.username) !== index);
    if (duplicates.length) throw new Error(`يوجد اسم مستخدم مكرر داخل الملف: ${duplicates[0].username}`);
    let completed = 0;
    const failures = [];
    for (const row of normalized) {
      status.textContent = `جارٍ إضافة الموظفين: ${completed + 1} من ${normalized.length}`;
      try { await createUser(row); completed += 1; }
      catch (error) { failures.push(`${row.username}: ${error.message}`); }
    }
    status.className = `import-status ${failures.length ? 'warning' : 'success'}`;
    status.innerHTML = `<b>تمت إضافة ${completed} من ${normalized.length} موظف.</b>${failures.length ? `<span>${escapeHtml(failures.slice(0, 3).join(' | '))}</span>` : ''}`;
    if (completed) toast(`تم استيراد ${completed} موظف`);
    if (!failures.length) setTimeout(() => usersTab(box), 900);
  } catch (error) {
    status.className = 'import-status error';
    status.textContent = error.message;
    toast(error.message, 'error');
  }
}

function normalizeEmployeeRow(row, rowNumber, branches) {
  const get = (...keys) => keys.map(key => row[key]).find(value => String(value ?? '').trim() !== '');
  const full_name = String(get('full_name', 'الاسم الكامل', 'اسم الموظف') || '').trim();
  const username = String(get('username', 'اسم المستخدم', 'يوزر') || '').trim().toLowerCase();
  const password = String(get('password', 'كلمة المرور', 'الباسورد') || '');
  const branchValues = splitList(get('branch_codes', 'branch_code', 'branch_name', 'الفروع', 'كود الفرع'));
  const roleValue = String(get('role', 'المسمى الوظيفي', 'الدور') || 'receptionist').trim().toLowerCase();
  const permissionValues = splitList(get('permissions', 'الصفحات', 'صلاحيات الصفحات') || 'home,consumption,additions,inventory,reports').map(value => value.toLowerCase());
  const branchIds = branchValues.map(value => branches.find(item => item.code.toLowerCase() === value.toLowerCase() || item.name.toLowerCase() === value.toLowerCase())).filter(Boolean).map(branch => branch.id);
  const roleMap = { admin: 'admin', 'مدير': 'admin', receptionist: 'receptionist', reception: 'receptionist', 'استقبال': 'receptionist', 'موظف استقبال': 'receptionist' };
  if (!full_name) throw new Error(`الاسم ناقص في الصف ${rowNumber}`);
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error(`اسم المستخدم غير صحيح في الصف ${rowNumber}`);
  if (password.length < 8) throw new Error(`كلمة المرور يجب ألا تقل عن 8 أحرف في الصف ${rowNumber}`);
  if (!branchValues.length || branchIds.length !== branchValues.length) throw new Error(`يوجد فرع غير معروف في الصف ${rowNumber}`);
  if (!roleMap[roleValue]) throw new Error(`المسمى الوظيفي غير صحيح في الصف ${rowNumber}`);
  if (permissionValues.some(value => !accessLabels[value])) throw new Error(`يوجد مفتاح صلاحية غير صحيح في الصف ${rowNumber}`);
  const permissions = Object.fromEntries(Object.keys(accessLabels).map(key => [key, permissionValues.includes(key)]));
  const permissionError = validatePermissionDependencies(permissions);
  if (permissionError) throw new Error(`${permissionError} في الصف ${rowNumber}`);
  return { full_name, username, password, branch_id: branchIds[0], branch_ids: [...new Set(branchIds)], role: roleMap[roleValue], permissions };
}

function splitList(value) { return String(value || '').split(/[,;|]/).map(item => item.trim()).filter(Boolean); }

function validatePermissionDependencies(permissions) {
  if (permissions.inventory_reports && !permissions.inventory) return 'فعّل صفحة الجرد مع صلاحية تقارير الجرد';
  if (permissions.inventory_all_reports && !permissions.inventory_reports) return 'فعّل تقارير الجرد مع صلاحية التقرير المجمع';
  if (permissions.inventory_branch_activity && !permissions.inventory) return 'فعّل صفحة الجرد مع صلاحية متابعة الفروع الشهرية';
  if ((permissions.edit_records || permissions.delete_records) && !permissions.records) return 'فعّل صفحة إدارة السجلات مع صلاحية التعديل أو الحذف';
  return '';
}

async function temporaryMaterialsTab(box) {
  const [materials, users] = await Promise.all([list('materials'), list('users')]);
  const temporary = materials.filter(material => material.is_temp && !material.archived_at).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const permanent = materials.filter(material => !material.is_temp && !material.archived_at).sort((a, b) => a.name.localeCompare(b.name));
  const userNames = Object.fromEntries(users.map(user => [user.id, user.full_name]));
  box.innerHTML = `<div class="panel-body"><div class="settings-callout temp-review-callout"><div><b>مراجعة الأصناف المؤقتة</b><span>الصنف المؤقت يظهر فورًا لكل الموظفين ويمكن استخدامه في الصرف والإضافات. عند تعديله أو استبداله بعد استخدامه ستختار بين تحديث كل الحركات أو التطبيق من الآن فقط.</span></div><span class="badge temp">${temporary.length} مؤقت</span></div></div><div class="table-wrap">${temporary.length ? `<table class="data-table"><thead><tr><th>الصنف المؤقت</th><th>الكود الحالي</th><th>الوحدة</th><th>الفئة</th><th>أضيف بواسطة</th><th>تاريخ الإضافة</th><th>الإجراءات</th></tr></thead><tbody>${temporary.map(material => `<tr><td class="row-title">${escapeHtml(material.name)}</td><td>${escapeHtml(material.code)}</td><td>${escapeHtml(material.unit)}</td><td>${escapeHtml(material.category || '—')}</td><td>${escapeHtml(userNames[material.created_by] || 'غير مسجل')}</td><td>${material.created_at ? new Date(material.created_at).toLocaleString('ar-EG-u-nu-latn') : '—'}</td><td><div class="record-actions temp-actions"><button class="btn primary mini" data-review-temp="${material.id}">مراجعة واعتماد</button><button class="btn ghost mini" data-replace-temp="${material.id}">استبدال بالصنف الصحيح</button><button class="delete-icon" data-delete-temp="${material.id}" title="حذف">×</button></div></td></tr>`).join('')}</tbody></table>` : '<div class="empty-state"><b>✓</b>لا توجد أصناف مؤقتة تحتاج إلى مراجعة</div>'}</div>`;
  box.querySelectorAll('[data-review-temp]').forEach(button => button.onclick = () => openTemporaryReview(temporary.find(material => material.id === button.dataset.reviewTemp), box));
  box.querySelectorAll('[data-replace-temp]').forEach(button => button.onclick = () => openTemporaryReplacement(temporary.find(material => material.id === button.dataset.replaceTemp), permanent, box));
  box.querySelectorAll('[data-delete-temp]').forEach(button => button.onclick = async () => {
    const material = temporary.find(item => item.id === button.dataset.deleteTemp);
    if (!await confirmDialog('حذف الصنف المؤقت', `حذف «${material.name}»؟ إذا كان مرتبطًا بحركات فلن يُحذف ويجب استبداله بالصنف الصحيح.`)) return;
    try { await remove('materials', material.id); toast('تم حذف الصنف المؤقت'); temporaryMaterialsTab(box); }
    catch { toast('الصنف مستخدم في حركات. استخدم «استبدال بالصنف الصحيح» حتى لا تضيع السجلات.', 'warning'); }
  });
}

function openTemporaryReview(material, box) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><form class="modal"><button type="button" class="modal-x">×</button><h3>مراجعة الصنف المؤقت</h3><p>يمكنك تعديل البيانات وحفظه مؤقتًا، أو إدخال الكود الأصلي ثم اعتماده نهائيًا.</p><div class="form-grid two"><div class="field"><label>اسم الصنف <em>*</em><input name="name" value="${escapeHtml(material.name)}" required></label></div><div class="field"><label>الكود الأصلي <em>*</em><input name="code" value="${escapeHtml(material.code)}" required></label></div><div class="field"><label>الوحدة <em>*</em><input name="unit" value="${escapeHtml(material.unit)}" required></label></div><div class="field"><label>الفئة<input name="category" value="${escapeHtml(material.category || '')}"></label></div><div class="field"><label>السعر الافتراضي<input type="number" name="default_price" min="0" step="any" value="${Number(material.default_price || 0)}"></label></div></div><div class="modal-actions"><button type="button" class="btn ghost modal-cancel">إلغاء</button><button class="btn ghost" type="submit" data-mode="temporary">حفظ التعديل كمؤقت</button><button class="btn primary" type="submit" data-mode="approve">اعتماد الصنف نهائيًا</button></div></form></div>`;
  const form = root.querySelector('form');
  const close = () => { root.innerHTML = ''; };
  root.querySelectorAll('.modal-x,.modal-cancel').forEach(button => button.onclick = close);
  form.onsubmit = async event => {
    event.preventDefault();
    const approve = event.submitter?.dataset.mode === 'approve';
    const button = event.submitter;
    button.disabled = true;
    try {
      const payload = { name: form.name.value.trim(), code: form.code.value.trim().toUpperCase(), unit: form.unit.value.trim(), category: form.category.value.trim(), default_price: Number(form.default_price.value || 0) };
      const changed = ['name', 'code', 'unit', 'category', 'default_price'].some(key => String(payload[key] ?? '') !== String(material[key] ?? (key === 'default_price' ? 0 : '')));
      let applyToHistory = true;
      if (changed) {
        const usage = await getTemporaryUsage(material.id);
        if (usage.total_count > 0) {
          const choice = await chooseHistoryScope(material.name, usage, approve ? 'اعتماد وتحديث كل الحركات' : 'تعديل كل الحركات', approve ? 'اعتماد من الآن فقط' : 'إنشاء نسخة جديدة من الآن فقط');
          if (!choice) { button.disabled = false; return; }
          applyToHistory = choice === 'all';
        }
      }
      const { error } = await supabase.rpc('resolve_temporary_material', { source_material: material.id, material_data: payload, approve_material: approve, apply_to_history: applyToHistory });
      if (error) throw error;
      toast(applyToHistory ? (approve ? 'تم اعتماد الصنف وتحديث الحركات المرتبطة' : 'تم حفظ التعديل على الصنف وحركاته') : 'تم حفظ القديم للسجلات السابقة وتفعيل الصنف الجديد من الآن');
      close();
      temporaryMaterialsTab(box);
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  };
}

function openTemporaryReplacement(material, permanentMaterials, box) {
  const root = document.getElementById('modal-root');
  let selectedId = '';
  root.innerHTML = `<div class="modal-backdrop"><form class="modal"><button type="button" class="modal-x">×</button><h3>استبدال الصنف المؤقت</h3><p>اختر الصنف الصحيح. إذا كانت هناك حركات سابقة سيسألك النظام هل تريد نقلها كلها، أم استخدام الصنف الصحيح من الآن فقط.</p><div class="field"><label>البحث عن الصنف الأصلي<input type="search" name="target_search" autocomplete="off" placeholder="اسم الصنف أو الكود"></label></div><div class="replacement-list" id="replacement-list"></div><div class="modal-actions"><button type="button" class="btn ghost modal-cancel">إلغاء</button><button class="btn primary" type="submit" disabled>متابعة الاستبدال</button></div></form></div>`;
  const form = root.querySelector('form');
  const listBox = root.querySelector('#replacement-list');
  const submit = form.querySelector('[type="submit"]');
  const close = () => { root.innerHTML = ''; };
  const drawTargets = query => {
    const normalized = String(query || '').trim().toLowerCase();
    const shown = permanentMaterials.filter(item => !normalized || `${item.name} ${item.code}`.toLowerCase().includes(normalized)).slice(0, 50);
    listBox.innerHTML = shown.map(item => `<button type="button" class="replacement-option ${selectedId === item.id ? 'selected' : ''}" data-target-material="${item.id}"><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.code)}</small></span><span>${escapeHtml(item.unit)}</span></button>`).join('') || '<div class="empty-state">لا يوجد صنف أصلي مطابق</div>';
    listBox.querySelectorAll('[data-target-material]').forEach(button => button.onclick = () => { selectedId = button.dataset.targetMaterial; submit.disabled = false; drawTargets(form.target_search.value); });
  };
  root.querySelectorAll('.modal-x,.modal-cancel').forEach(button => button.onclick = close);
  form.target_search.oninput = () => drawTargets(form.target_search.value);
  form.onsubmit = async event => {
    event.preventDefault();
    if (!selectedId) return;
    submit.disabled = true;
    try {
      const usage = await getTemporaryUsage(material.id);
      let applyToHistory = true;
      if (usage.total_count > 0) {
        const choice = await chooseHistoryScope(material.name, usage, 'استبدال في كل الحركات القديمة', 'استخدام الصنف الصحيح من الآن فقط');
        if (!choice) { submit.disabled = false; return; }
        applyToHistory = choice === 'all';
      }
      const { data, error } = await supabase.rpc('resolve_temporary_replacement', { source_material: material.id, target_material: selectedId, apply_to_history: applyToHistory });
      if (error) throw error;
      toast(applyToHistory ? `تم نقل ${Number(data?.consumption_moved || 0) + Number(data?.additions_moved || 0)} حركة إلى الصنف الصحيح` : 'تم حفظ الحركات القديمة كما هي واستخدام الصنف الصحيح من الآن');
      close();
      temporaryMaterialsTab(box);
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
  };
  drawTargets('');
}

async function getTemporaryUsage(materialId) {
  const { data, error } = await supabase.rpc('temporary_material_usage', { material: materialId });
  if (error) throw error;
  return {
    consumption_count: Number(data?.consumption_count || 0),
    additions_count: Number(data?.additions_count || 0),
    total_count: Number(data?.total_count || 0),
  };
}

function chooseHistoryScope(materialName, usage, allLabel, futureLabel) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal history-choice-modal"><button type="button" class="modal-x" data-history-cancel>×</button><h3>الصنف مستخدم في حركات سابقة</h3><p>«${escapeHtml(materialName)}» مرتبط بـ <b>${usage.total_count}</b> حركة: ${usage.consumption_count} صرف و${usage.additions_count} إضافة.</p><div class="history-choice-list"><button type="button" class="history-choice-card primary-choice" data-history-choice="all"><b>${escapeHtml(allLabel)}</b><span>سيظهر الاسم والكود والوحدة الجديدة داخل كل التقارير والحركات القديمة المرتبطة بالصنف.</span></button><button type="button" class="history-choice-card" data-history-choice="future"><b>${escapeHtml(futureLabel)}</b><span>سنحفظ الصنف القديم للسجلات السابقة، ويبدأ استخدام الصنف الجديد في الحركات القادمة فقط.</span></button></div><div class="modal-actions"><button type="button" class="btn ghost" data-history-cancel>رجوع بدون حفظ</button></div></div></div>`;
    const done = value => { root.innerHTML = ''; resolve(value); };
    root.querySelectorAll('[data-history-cancel]').forEach(button => button.onclick = () => done(null));
    root.querySelectorAll('[data-history-choice]').forEach(button => button.onclick = () => done(button.dataset.historyChoice));
  });
}

async function materialsTab(box) {
  const rows = (await list('materials')).filter(row => !row.is_temp && !row.archived_at);
  box.innerHTML = `<div class="panel-body"><form id="material-form" class="form-grid"><div class="field"><label>اسم المادة<input name="name" required></label></div><div class="field"><label>الكود<input name="code" required></label></div><div class="field"><label>الوحدة<input name="unit" placeholder="ml / gm / Pack" required></label></div><div class="field"><label>الفئة<input name="category"></label></div><div class="field"><label>سعر تكلفة الوحدة <em>*</em><input name="cost_price" type="number" min="0" step="any" value="0" required></label></div><button class="btn primary">إضافة مادة</button></form><div class="field" style="margin-top:18px"><label>بحث<input id="material-filter" placeholder="ابحث بالاسم أو الكود أو الباركود أو الفئة"></label></div></div><div id="materials-table"></div>`;
  const draw = filter => {
    const shown = rows.filter(row => !filter || `${row.name} ${row.code} ${row.barcode} ${row.category}`.toLowerCase().includes(filter.toLowerCase()));
    box.querySelector('#materials-table').innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>المادة</th><th>الكود / الباركود</th><th>الوحدة</th><th>الفئة</th><th>سعر التكلفة</th><th>الحالة</th><th></th></tr></thead><tbody>${shown.map(row => `<tr><td class="row-title">${escapeHtml(row.name)}</td><td>${escapeHtml(row.code)}<small class="row-sub">${escapeHtml(row.barcode || '—')}</small></td><td>${escapeHtml(row.unit)}</td><td>${escapeHtml(row.category || '—')}</td><td><div class="cost-price-editor"><input type="number" min="0" step="any" value="${Number(row.cost_price || 0)}" data-cost-price="${row.id}"><button class="btn primary mini" type="button" data-save-cost="${row.id}">حفظ</button></div></td><td><span class="badge ${row.is_temp ? 'temp' : 'client'}">${row.is_temp ? 'مؤقت' : 'دائم'}</span></td><td><button class="delete-icon" data-delete="${row.id}">×</button></td></tr>`).join('')}</tbody></table></div>`;
    box.querySelectorAll('[data-save-cost]').forEach(button => button.onclick = async () => {
      const input = box.querySelector(`[data-cost-price="${button.dataset.saveCost}"]`);
      const costPrice = Number(input.value);
      if (!Number.isFinite(costPrice) || costPrice < 0) return toast('اكتب سعر تكلفة صحيحًا', 'warning');
      button.disabled = true;
      try {
        await update('materials', button.dataset.saveCost, { cost_price: costPrice });
        const material = rows.find(item => item.id === button.dataset.saveCost);
        if (material) material.cost_price = costPrice;
        toast('تم حفظ سعر تكلفة المادة');
      } catch (error) { toast(error.message, 'error'); }
      finally { button.disabled = false; }
    });
    wireDelete(box.querySelector('#materials-table'), 'materials', () => materialsTab(box), 'المادة');
  };
  draw('');
  box.querySelector('#material-filter').oninput = event => draw(event.target.value);
  box.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    await insert('materials', { name: form.name.value.trim(), code: form.code.value.trim().toUpperCase(), unit: form.unit.value.trim(), category: form.category.value.trim(), default_price: 0, cost_price: Number(form.cost_price.value || 0), scope: 'default', is_temp: false });
    toast('تمت إضافة المادة');
    materialsTab(box);
  };
}

function wireDelete(root, type, rerender, label) {
  root.querySelectorAll('[data-delete]').forEach(button => button.onclick = async () => {
    if (await confirmDialog(`حذف ${label}`, `هل أنت متأكد من حذف ${label}؟ قد تمنع قاعدة البيانات الحذف إذا كان مرتبطاً بسجلات.`)) {
      try { await remove(type, button.dataset.delete); toast(`تم حذف ${label}`); rerender(root.closest('#settings-content') || root); }
      catch (error) { toast(error.message, 'error'); }
    }
  });
}
