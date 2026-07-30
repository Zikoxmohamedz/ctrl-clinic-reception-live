import { supabase, isConfigured } from './supabase.js?v=20260730-latin-digits';

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');

document.getElementById('show-password')?.addEventListener('click', event => {
  const input = form.password;
  input.type = input.type === 'password' ? 'text' : 'password';
  event.currentTarget.textContent = input.type === 'password' ? '◉' : '◌';
});

form?.addEventListener('submit', async event => {
  event.preventDefault();
  errorBox.textContent = '';
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  button.querySelector('span').textContent = 'جارٍ الدخول...';
  if (!isConfigured) {
    errorBox.textContent = 'إعدادات الاتصال بقاعدة البيانات غير مكتملة.';
    button.disabled = false;
    button.querySelector('span').textContent = 'دخول النظام';
    return;
  }

  const loginName = form.username.value.trim().toLowerCase();
  const email = loginName.includes('@') ? loginName : `${loginName}@users.ctrl.clinic`;
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password: form.password.value });
  if (authError) {
    errorBox.textContent = 'اسم المستخدم أو كلمة المرور غير صحيحة.';
    button.disabled = false;
    button.querySelector('span').textContent = 'دخول النظام';
    return;
  }

  const userId = authData.user.id;
  const [profileResult, branchesResult, permissionsResult] = await Promise.all([
    supabase.from('users').select('id,full_name,username,email,branch_id,role').eq('id', userId).single(),
    supabase.from('user_branches').select('branch_id,branches(name,code)').eq('user_id', userId),
    supabase.from('user_permissions').select('can_home,can_consumption,can_additions,can_inventory,can_inventory_reports,can_inventory_all_reports,can_reports,can_records,can_edit_records,can_delete_records,can_settings').eq('user_id', userId).single(),
  ]);
  if (profileResult.error || branchesResult.error || permissionsResult.error) {
    await supabase.auth.signOut();
    errorBox.textContent = 'الحساب غير مرتبط بصلاحيات صحيحة. تواصل مع المدير.';
    button.disabled = false;
    button.querySelector('span').textContent = 'دخول النظام';
    return;
  }

  const allowedBranches = branchesResult.data.map(item => ({ id: item.branch_id, name: item.branches?.name, code: item.branches?.code }));
  if (!allowedBranches.length) {
    await supabase.auth.signOut();
    errorBox.textContent = 'لا توجد فروع مسموحة لهذا الحساب.';
    button.disabled = false;
    return;
  }
  const profile = profileResult.data;
  const activeBranch = allowedBranches.find(branch => branch.id === profile.branch_id) || allowedBranches[0];
  const permissionRow = permissionsResult.data;
  sessionStorage.setItem('ctrl_profile', JSON.stringify({
    ...profile,
    branch_id: activeBranch.id,
    branch_name: activeBranch.name,
    branch_ids: allowedBranches.map(branch => branch.id),
    allowed_branches: allowedBranches,
    permissions: {
      home: permissionRow.can_home,
      consumption: permissionRow.can_consumption,
      additions: permissionRow.can_additions,
      inventory: permissionRow.can_inventory,
      inventory_reports: permissionRow.can_inventory_reports,
      inventory_all_reports: permissionRow.can_inventory_all_reports,
      reports: permissionRow.can_reports,
      records: permissionRow.can_records,
      edit_records: permissionRow.can_edit_records,
      delete_records: permissionRow.can_delete_records,
      settings: permissionRow.can_settings,
    },
  }));
  location.href = 'dashboard.html';
});
