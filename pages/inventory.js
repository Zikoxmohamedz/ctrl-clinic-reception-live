import { supabase, escapeHtml, toast, money, confirmDialog } from '../supabase.js?v=20260730-latin-digits';
import { insert, list } from '../data.js?v=20260730-latin-digits';
import { openTemporaryMaterial } from './temp-material.js?v=20260730-temp-save-v2';

const state = {
  root: null,
  profile: null,
  materials: [],
  sessionId: null,
  snapshot: null,
  channel: null,
  drafts: new Map(),
  saveTimers: new Map(),
  reportSnapshot: null,
  reportSessions: null,
  reportLoadPromise: null,
  filter: '',
  ignoreOwnEntryEventsUntil: 0,
};

export function cleanupInventory() {
  if (state.channel) supabase.removeChannel(state.channel);
  state.channel = null;
  clearTimeout(refreshTimer);
  state.saveTimers.forEach(clearTimeout);
  state.saveTimers.clear();
}

export async function renderInventory(root, profile) {
  cleanupInventory();
  Object.assign(state, {
    root,
    profile,
    materials: [],
    sessionId: null,
    snapshot: null,
    drafts: new Map(),
    reportSnapshot: null,
    reportSessions: null,
    reportLoadPromise: null,
    filter: '',
    ignoreOwnEntryEventsUntil: 0,
  });

  const canViewReports = hasInventoryReportPermission('inventory_reports');
  const canViewAllBranches = hasInventoryReportPermission('inventory_all_reports');
  root.innerHTML = `<div class="page-intro"><div><h2>الجرد</h2><p>جرد مشترك لحظياً بين موظفي فرع ${escapeHtml(profile.branch_name)}.</p></div><button class="btn gold" id="inventory-temp-material">＋ إضافة صنف مؤقت</button></div>
    <section class="panel inventory-shell">
      <div class="tabs inventory-tabs">
        <button class="active" data-inventory-tab="current">الجرد الحالي</button>
        ${canViewReports ? '<button data-inventory-tab="reports">تقارير الجرد</button>' : ''}
        ${canViewAllBranches ? '<button data-inventory-tab="activity">متابعة الفروع الشهرية</button>' : ''}
      </div>
      <div id="inventory-content"><div class="empty-state">جارٍ تحميل الأصناف...</div></div>
    </section>`;

  root.querySelectorAll('[data-inventory-tab]').forEach(button => {
    button.onclick = async () => {
      root.querySelectorAll('[data-inventory-tab]').forEach(item => item.classList.toggle('active', item === button));
      if (button.dataset.inventoryTab === 'reports') await renderReportsTab();
      else if (button.dataset.inventoryTab === 'activity') await renderMonthlyBranchActivity();
      else await renderCurrentTab();
    };
  });
  root.querySelector('#inventory-temp-material').onclick = () => openTemporaryMaterial('', saveTemporaryInventoryMaterial);

  try {
    state.materials = (await list('materials'))
      .filter(material => !material.archived_at)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));
    await renderCurrentTab();
    if (canViewReports) prefetchInventoryReports().catch(() => {});
  } catch (error) {
    showSetupError(error);
  }
}

async function saveTemporaryInventoryMaterial(material) {
  const [saved] = await insert('materials', { ...material, created_by: state.profile.id });
  state.materials.push(saved);
  state.materials.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));
  const currentTab = state.root.querySelector('[data-inventory-tab="current"]');
  if (currentTab?.classList.contains('active')) {
    if (state.snapshot) {
      const joined = state.snapshot.participants.some(person => person.user_id === state.profile.id);
      drawInventory(state.snapshot, joined);
    } else {
      drawIdleInventory();
    }
  }
  toast('تمت إضافة الصنف المؤقت وأصبح جاهزًا للجرد');
}

async function renderCurrentTab() {
  const box = state.root.querySelector('#inventory-content');
  box.innerHTML = '<div class="empty-state">جارٍ البحث عن جرد مفتوح...</div>';
  const { data, error } = await supabase
    .from('inventory_sessions')
    .select('id,status,created_at')
    .eq('branch_id', state.profile.branch_id)
    .eq('status', 'active')
    .maybeSingle();
  if (error) return showSetupError(error);

  if (!data) {
    state.sessionId = null;
    state.snapshot = null;
    drawIdleInventory();
    return;
  }

  const snapshot = await getSnapshot(data.id);
  const joined = snapshot.participants.some(person => person.user_id === state.profile.id);
  if (joined) {
    state.sessionId = data.id;
    state.snapshot = snapshot;
    subscribeToSession(data.id);
  }
  drawInventory(snapshot, joined);
}

function drawIdleInventory() {
  const box = state.root.querySelector('#inventory-content');
  box.innerHTML = `<div class="inventory-start">
      <div><span class="inventory-state-icon">✓</span><h3>لا يوجد جرد مفتوح لهذا الفرع</h3><p>كل الأصناف جاهزة. عند البدء، أي موظف من نفس الفرع يمكنه الانضمام والعمل معك في نفس الجلسة.</p></div>
      <button class="btn primary inventory-start-btn" id="start-inventory">بدء الجرد</button>
    </div>
    ${inventorySearch()}
    <div class="inventory-list is-preview" id="inventory-list">${state.materials.map(material => inventoryPreviewCard(material)).join('')}</div>`;
  wireSearch();
  box.querySelector('#start-inventory').onclick = startOrJoin;
}

function drawInventory(snapshot, joined) {
  state.snapshot = snapshot;
  const box = state.root.querySelector('#inventory-content');
  const mine = snapshot.participants.find(person => person.user_id === state.profile.id);
  const canEdit = joined && snapshot.session.status === 'active' && !mine?.part_completed_at;
  const waiting = joined && snapshot.session.status === 'active' && mine?.part_completed_at;
  const completed = snapshot.session.status === 'completed';
  const unfinished = snapshot.participants.filter(person => !person.part_completed_at);
  const isLastParticipant = canEdit && unfinished.length === 1 && unfinished[0].user_id === state.profile.id;
  const finishLabel = snapshot.participants.length === 1 || isLastParticipant ? 'إنهاء الجرد' : 'حفظ الجزء الخاص بي';
  const countedMaterials = new Set(snapshot.entries.map(entry => entry.material_id)).size;

  box.innerHTML = `<div class="inventory-session-bar">
      <div>
        <span class="badge ${completed ? 'client' : 'temp'}">${completed ? 'مكتمل' : 'جرد مفتوح'}</span>
        <strong>${escapeHtml(snapshot.session.branch_name)}</strong>
        <small>بدأ ${formatDateTime(snapshot.session.created_at)} · ${countedMaterials} من ${state.materials.length} صنف</small>
      </div>
      <div class="inventory-session-actions">
        ${!joined && !completed ? '<button class="btn primary" id="join-inventory">الانضمام للجرد الجاري</button>' : ''}
        ${canEdit ? `<button class="btn gold" id="finish-my-inventory" data-finish-mode="${finishLabel === 'إنهاء الجرد' ? 'session' : 'part'}">${finishLabel}</button>` : ''}
        ${waiting ? '<span class="inventory-waiting">تم إنهاء جزئك — في انتظار باقي الفريق</span>' : ''}
      </div>
    </div>
    <div class="inventory-participants">${snapshot.participants.map(person => `<span class="${person.part_completed_at ? 'done' : ''}"><i>${person.part_completed_at ? '✓' : '•'}</i>${escapeHtml(person.full_name)}<small>${person.part_completed_at ? 'أنهى الجزء الخاص به' : 'يعمل الآن'}</small></span>`).join('')}</div>
    ${inventorySearch()}
    <div class="inventory-list ${canEdit ? '' : 'is-preview'}" id="inventory-list">${state.materials.map(material => inventoryCard(material, snapshot.entries, canEdit)).join('')}</div>`;

  wireSearch();
  wireImageViewers(box);
  if (!joined && !completed) box.querySelector('#join-inventory').onclick = startOrJoin;
  if (canEdit) {
    wireEntryInputs();
    box.querySelector('#finish-my-inventory').onclick = finishMyPart;
  }
}

function inventorySearch() {
  return `<div class="inventory-search">
    <label><span>البحث السريع في الأصناف</span><input id="inventory-search" type="search" autocomplete="off" value="${escapeHtml(state.filter)}" placeholder="اكتب أول كام حرف من اسم الصنف أو الكود"></label>
    <b id="inventory-result-count">${state.materials.length} صنف</b>
  </div>`;
}

function inventoryPreviewCard(material) {
  return `<article class="inventory-item" data-material-card data-search="${escapeHtml(normalize(`${material.name} ${material.code} ${material.category || ''}`))}">
    <div class="inventory-item-head"><div><strong>${escapeHtml(material.name)}</strong><small>${escapeHtml(material.code)} · ${escapeHtml(material.category || 'بدون فئة')}</small></div><span>${escapeHtml(material.unit)}</span></div>
    <div class="inventory-preview-fields"><span>الكمية</span><span>الصلاحية / مستلزمات</span><span>الإجمالي</span></div>
  </article>`;
}

function entryExpiryBatches(entry) {
  if (!entry || entry.is_supply) return [];
  if (Array.isArray(entry.expiry_batches) && entry.expiry_batches.length) {
    return entry.expiry_batches.map(batch => ({
      expiration_date: batch.expiration_date || '',
      quantity_expression: String(batch.quantity_expression ?? batch.quantity ?? ''),
      quantity: Number(batch.quantity || 0),
    }));
  }
  return entry.expiration_date ? [{
    expiration_date: entry.expiration_date,
    quantity_expression: String(entry.quantity_expression || entry.quantity || ''),
    quantity: Number(entry.quantity || 0),
  }] : [];
}

function renderExpiryEditor(mode, batches, totalExpression, canEdit, unit) {
  const rows = batches.length ? batches : [{ expiration_date: '', quantity_expression: '', quantity: 0 }];
  const automaticMode = rows.length > 1 ? 'split' : 'all';
  return `<div class="inventory-expiry-head">
      <div><b>توزيع الكمية على تواريخ الصلاحية</b><small>تاريخ واحد يطبق على كل الكمية تلقائيًا. عند إضافة تاريخ آخر تظهر كمية مستقلة لكل تاريخ.</small></div>
      <span class="inventory-expiry-mode" data-expiry-mode-label>${automaticMode === 'all' ? 'كل الكمية على تاريخ واحد' : `موزعة على ${rows.length} تواريخ`}</span>
    </div>
    <div class="inventory-expiry-batches" data-expiry-batches>
      ${rows.map((batch, index) => expiryBatchRow(batch, index, automaticMode, totalExpression, canEdit, unit)).join('')}
    </div>
    <button type="button" class="btn ghost mini inventory-add-expiry" data-add-expiry ${canEdit ? '' : 'hidden'}>＋ إضافة تاريخ صلاحية آخر</button>
    <div class="inventory-expiry-balance" data-expiry-balance></div>`;
}

function expiryBatchRow(batch, index, mode, totalExpression, canEdit, unit) {
  return `<div class="inventory-expiry-batch" data-expiry-batch>
    <label><span>تاريخ ${index + 1}</span><input type="date" data-batch-date value="${escapeHtml(batch.expiration_date || '')}" ${canEdit ? '' : 'disabled'}></label>
    <label class="batch-quantity"><span>الكمية لهذا التاريخ</span><input data-batch-expression inputmode="decimal" value="${escapeHtml(mode === 'all' ? totalExpression : batch.quantity_expression || '')}" placeholder="مثال: 8" ${mode === 'all' || !canEdit ? 'disabled' : ''}><small data-batch-result>${batch.quantity ? `= ${money(batch.quantity)} ${escapeHtml(unit)}` : ''}</small></label>
    <div class="expiration-shortcuts"><button type="button" data-expiry-shift="day" ${canEdit ? '' : 'disabled'}>+ يوم</button><button type="button" data-expiry-shift="month" ${canEdit ? '' : 'disabled'}>+ شهر</button><button type="button" data-expiry-shift="year" ${canEdit ? '' : 'disabled'}>+ سنة</button></div>
    <button type="button" class="inventory-remove-expiry" data-remove-expiry ${mode === 'split' && canEdit ? '' : 'hidden'} aria-label="حذف التاريخ">×</button>
  </div>`;
}

function inventoryCard(material, entries, canEdit) {
  const contributions = entries.filter(entry => entry.material_id === material.id);
  const savedMine = contributions.find(entry => entry.created_by === state.profile.id);
  const draft = state.drafts.get(material.id);
  const expression = draft?.expression ?? savedMine?.quantity_expression ?? '';
  const isSupply = draft?.isSupply ?? savedMine?.is_supply ?? false;
  const savedBatches = entryExpiryBatches(savedMine);
  const expiryBatches = draft?.batches ?? savedBatches;
  const expiryMode = draft?.expiryMode ?? (expiryBatches.length > 1 ? 'split' : 'all');
  const imagePath = draft?.removeImage ? '' : (draft?.imagePath ?? savedMine?.image_path ?? '');
  const imageLabel = draft?.file?.name || (imagePath ? 'صورة مرفقة' : 'إضافة صورة اختيارية');
  const total = contributions.reduce((sum, entry) => sum + Number(entry.quantity), 0);
  let result = '';
  try { if (expression) result = evaluateExpression(expression); } catch {}

  return `<article class="inventory-item" data-material-card data-material-id="${material.id}" data-search="${escapeHtml(normalize(`${material.name} ${material.code} ${material.category || ''}`))}">
    <div class="inventory-item-head"><div><strong>${escapeHtml(material.name)}</strong><small>${escapeHtml(material.code)} · ${escapeHtml(material.category || 'بدون فئة')}</small></div><span>${escapeHtml(material.unit)}</span></div>
    <div class="inventory-contributions">
      ${contributions.length ? contributions.map(entry => `<span class="${entry.created_by === state.profile.id ? 'mine' : ''}"><b>${escapeHtml(entry.created_by_name)}</b> جرد <strong>${money(entry.quantity)}</strong><small>${escapeHtml(entry.quantity_expression)}${entry.is_supply ? ' · مستلزمات' : ` · ${entryExpiryBatches(entry).map(batch => `${batch.expiration_date}: ${money(batch.quantity)}`).join(' | ')}`}</small>${entry.image_path ? `<button type="button" data-view-entry-image="${escapeHtml(entry.image_path)}">عرض الصورة</button>` : ''}</span>`).join('') : '<small class="no-counts">لم يسجل أحد كمية في هذا الصنف بعد</small>'}
    </div>
    <div class="inventory-entry-grid">
      <label class="inventory-expression"><span>الكمية أو العملية الحسابية</span><input data-entry-expression value="${escapeHtml(expression)}" inputmode="decimal" placeholder="مثال: 10*30" ${canEdit ? '' : 'disabled'}><small data-entry-result>${result !== '' ? `= ${money(result)}` : 'يمكنك استخدام + − × ÷ والأقواس'}</small></label>
      <div class="inventory-expiration span-2" data-expiry-editor ${isSupply ? 'hidden' : ''}>${renderExpiryEditor(expiryMode, expiryBatches, expression, canEdit, material.unit)}</div>
      <label class="inventory-supply"><input data-entry-supply type="checkbox" ${isSupply ? 'checked' : ''} ${canEdit ? '' : 'disabled'}><span><i>✓</i>مستلزمات — بدون صلاحية</span></label>
      <div class="inventory-total"><span>الإجمالي</span><strong data-entry-total>${money(total)}</strong><small>${escapeHtml(material.unit)}</small></div>
    </div>
    <div class="inventory-image-control ${imagePath || draft?.file ? 'has-image' : ''}">
      <div class="inventory-image-copy"><span class="inventory-camera-icon">📷</span><div><b>صورة الصنف أو العبوة</b><small>اختيارية — صوّر بالكاميرا أو اختار صورة من المعرض (حتى 6 ميجابايت)</small></div></div>
      <div class="inventory-image-actions">
        <label class="btn primary mini ${canEdit ? '' : 'disabled'}"><input data-entry-camera type="file" accept="image/*" capture="environment" ${canEdit ? '' : 'disabled'} hidden><span>فتح الكاميرا</span></label>
        <label class="btn ghost mini ${canEdit ? '' : 'disabled'}"><input data-entry-gallery type="file" accept="image/*" ${canEdit ? '' : 'disabled'} hidden><span>اختيار من المعرض</span></label>
        <button type="button" class="btn ghost mini inventory-image-name" data-view-draft-image ${imagePath || draft?.file ? '' : 'hidden'}><span data-entry-image-label>${escapeHtml(imageLabel)}</span></button>
        <button type="button" class="btn ghost mini" data-remove-entry-image ${imagePath || draft?.file ? '' : 'hidden'} ${canEdit ? '' : 'disabled'}>إزالة</button>
      </div>
    </div>
    <div class="inventory-save-state" data-entry-status>${savedMine ? `آخر حفظ ${formatTime(savedMine.updated_at)}` : ''}</div>
  </article>`;
}

function wireSearch() {
  const input = state.root.querySelector('#inventory-search');
  const counter = state.root.querySelector('#inventory-result-count');
  if (!input) return;
  const cards = [...state.root.querySelectorAll('[data-material-card]')].map((card, index) => {
    const text = card.dataset.search || '';
    return { card, index, text, words: text.split(/\s+/) };
  });
  let filterTimer;
  let filterFrame;

  const applyFilter = () => {
    if (!input.isConnected) return;
    const query = normalize(input.value);
    let visible = 0;
    cards.forEach(item => {
      const score = searchScore(item.text, query, item.words);
      const show = !query || score < 99;
      if (item.card.hidden === show) item.card.hidden = !show;
      if (show) {
        visible += 1;
        const order = query ? score * cards.length + item.index : '';
        if (item.card.style.order !== String(order)) item.card.style.order = order;
      } else if (item.card.style.order) {
        item.card.style.order = '';
      }
    });
    counter.textContent = `${visible} صنف`;
  };
  const scheduleFilter = () => {
    state.filter = input.value;
    clearTimeout(filterTimer);
    if (filterFrame) cancelAnimationFrame(filterFrame);
    filterTimer = setTimeout(() => {
      filterFrame = requestAnimationFrame(applyFilter);
    }, 65);
  };
  input.oninput = scheduleFilter;
  input.__applyInventoryFilter = () => {
    state.filter = input.value;
    clearTimeout(filterTimer);
    if (filterFrame) cancelAnimationFrame(filterFrame);
    applyFilter();
  };
  applyFilter();
}

function wireEntryInputs() {
  state.root.querySelectorAll('[data-material-id]').forEach(card => {
    const materialId = card.dataset.materialId;
    const expression = card.querySelector('[data-entry-expression]');
    const supply = card.querySelector('[data-entry-supply]');
    const result = card.querySelector('[data-entry-result]');
    const expiryEditor = card.querySelector('[data-expiry-editor]');
    const modeLabel = card.querySelector('[data-expiry-mode-label]');
    const batchesBox = card.querySelector('[data-expiry-batches]');
    const addExpiry = card.querySelector('[data-add-expiry]');
    const expiryBalance = card.querySelector('[data-expiry-balance]');
    const cameraInput = card.querySelector('[data-entry-camera]');
    const galleryInput = card.querySelector('[data-entry-gallery]');
    const imageLabel = card.querySelector('[data-entry-image-label]');
    const viewDraftImage = card.querySelector('[data-view-draft-image]');
    const removeImage = card.querySelector('[data-remove-entry-image]');
    const savedEntry = state.snapshot.entries.find(entry => entry.material_id === materialId && entry.created_by === state.profile.id);
    const currentMode = () => batchesBox.children.length > 1 ? 'split' : 'all';

    const readBatches = totalQuantity => {
      if (supply.checked) return [];
      const mode = currentMode();
      return [...batchesBox.querySelectorAll('[data-expiry-batch]')].map(row => {
        const batchExpression = mode === 'all' ? expression.value : row.querySelector('[data-batch-expression]').value;
        let quantity = 0;
        try { quantity = evaluateExpression(batchExpression); } catch {}
        return {
          expiration_date: row.querySelector('[data-batch-date]').value,
          quantity_expression: batchExpression.trim(),
          quantity: mode === 'all' ? totalQuantity : quantity,
        };
      });
    };

    const refreshExpiryRows = () => {
      const rows = [...batchesBox.querySelectorAll('[data-expiry-batch]')];
      const mode = currentMode();
      rows.forEach((row, index) => {
        row.querySelector('label > span').textContent = `تاريخ ${index + 1}`;
        const batchInput = row.querySelector('[data-batch-expression]');
        batchInput.disabled = mode === 'all';
        if (mode === 'all') batchInput.value = expression.value;
        row.querySelector('[data-remove-expiry]').hidden = mode === 'all';
      });
      modeLabel.textContent = mode === 'all' ? 'كل الكمية على تاريخ واحد' : `موزعة على ${rows.length} تواريخ`;
    };

    const updateDraft = (saveDelay = 500) => {
      const current = state.drafts.get(materialId) || {};
      let quantity = 0;
      try { quantity = evaluateExpression(expression.value); } catch {}
      const batches = readBatches(quantity);
      const draft = {
        ...current,
        expression: expression.value,
        isSupply: supply.checked,
        expiryMode: currentMode(),
        batches,
        imagePath: current.imagePath ?? savedEntry?.image_path ?? '',
      };
      state.drafts.set(materialId, draft);
      expiryEditor.hidden = supply.checked;
      try {
        quantity = evaluateExpression(expression.value);
        result.textContent = `= ${money(quantity)}`;
        result.classList.remove('error');
        updateLocalTotal(card, materialId, quantity);
        if (!supply.checked) updateExpiryBalance(expiryBalance, batches, quantity, currentMode());
        const expiryError = validateExpiryDraft(draft, quantity);
        markInventoryCardError(card, expiryError);
        scheduleSave(materialId, card, draft, saveDelay);
      } catch (error) {
        const hasExpiryWork = batches.length > 1 || batches.some(batch => batch.expiration_date || batch.quantity_expression);
        const message = expression.value.trim() ? error.message : hasExpiryWork ? 'اكتب إجمالي كمية الصنف أولًا' : '';
        result.textContent = message || 'يمكنك استخدام + − × ÷ والأقواس';
        result.classList.toggle('error', !!message);
        markInventoryCardError(card, message);
      }
    };

    expression.oninput = () => updateDraft();
    supply.onchange = () => updateDraft();
    batchesBox.addEventListener('input', event => {
      if (event.target.matches('[data-batch-expression]')) {
        const resultBox = event.target.closest('[data-expiry-batch]').querySelector('[data-batch-result]');
        try {
          resultBox.textContent = `= ${money(evaluateExpression(event.target.value))}`;
          resultBox.classList.remove('error');
        } catch (error) {
          resultBox.textContent = event.target.value.trim() ? error.message : '';
          resultBox.classList.toggle('error', !!event.target.value.trim());
        }
        updateDraft();
      }
    });
    batchesBox.addEventListener('change', event => {
      if (event.target.matches('[data-batch-date]')) updateDraft();
    });
    card.addEventListener('click', event => {
      const shiftButton = event.target.closest('[data-expiry-shift]');
      if (shiftButton) {
        const dateInput = shiftButton.closest('[data-expiry-batch]').querySelector('[data-batch-date]');
        dateInput.value = shiftExpirationDate(dateInput.value, shiftButton.dataset.expiryShift);
        updateDraft(900);
        return;
      }
      if (event.target.closest('[data-add-expiry]')) {
        const firstInput = batchesBox.querySelector('[data-batch-expression]');
        if (firstInput) firstInput.value = expression.value;
        batchesBox.insertAdjacentHTML('beforeend', expiryBatchRow({}, batchesBox.children.length, 'split', expression.value, true, ''));
        refreshExpiryRows();
        updateDraft();
        return;
      }
      const removeButton = event.target.closest('[data-remove-expiry]');
      if (removeButton) {
        if (batchesBox.children.length === 1) return toast('يجب وجود تاريخ صلاحية واحد على الأقل', 'warning');
        removeButton.closest('[data-expiry-batch]').remove();
        refreshExpiryRows();
        updateDraft();
      }
    });
    refreshExpiryRows();
    const selectImage = input => {
      const file = input.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        toast('اختر ملف صورة فقط', 'warning');
        input.value = '';
        return;
      }
      if (file.size > 6 * 1024 * 1024) {
        toast('حجم الصورة يجب ألا يزيد عن 6 ميجابايت', 'warning');
        input.value = '';
        return;
      }
      const current = state.drafts.get(materialId) || {};
      current.file = file;
      current.removeImage = false;
      current.imagePath ??= savedEntry?.image_path ?? '';
      state.drafts.set(materialId, current);
      imageLabel.textContent = file.name;
      viewDraftImage.hidden = false;
      removeImage.hidden = false;
      card.querySelector('.inventory-image-control')?.classList.add('has-image');
      updateDraft();
    };
    cameraInput.onchange = () => selectImage(cameraInput);
    galleryInput.onchange = () => selectImage(galleryInput);
    viewDraftImage.onclick = async () => {
      const current = state.drafts.get(materialId) || {};
      if (current.file) {
        const url = URL.createObjectURL(current.file);
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return;
      }
      const path = current.imagePath ?? savedEntry?.image_path;
      if (path) await openInventoryImage(path, viewDraftImage);
    };
    removeImage.onclick = () => {
      const current = state.drafts.get(materialId) || {};
      current.file = null;
      current.imagePath = '';
      current.removeImage = true;
      state.drafts.set(materialId, current);
      cameraInput.value = '';
      galleryInput.value = '';
      imageLabel.textContent = 'لا توجد صورة مرفقة';
      viewDraftImage.hidden = true;
      removeImage.hidden = true;
      card.querySelector('.inventory-image-control')?.classList.remove('has-image');
      updateDraft();
    };
  });
}

function updateExpiryBalance(box, batches, totalQuantity, mode) {
  if (mode === 'all') {
    box.className = 'inventory-expiry-balance ok';
    box.textContent = `التاريخ يطبق على كل الكمية: ${money(totalQuantity)}`;
    return;
  }
  const allocated = batches.reduce((sum, batch) => sum + Number(batch.quantity || 0), 0);
  const remaining = totalQuantity - allocated;
  box.className = `inventory-expiry-balance ${Math.abs(remaining) < 0.000001 ? 'ok' : 'warning'}`;
  box.textContent = Math.abs(remaining) < 0.000001
    ? `تم توزيع كل الكمية: ${money(allocated)}`
    : remaining > 0
      ? `تم توزيع ${money(allocated)} — متبقي ${money(remaining)}`
      : `الكميات الموزعة أكبر من الإجمالي بمقدار ${money(Math.abs(remaining))}`;
}

function markInventoryCardError(card, message = '') {
  const hasError = Boolean(message);
  card.classList.toggle('inventory-item-invalid', hasError);
  if (hasError) {
    card.dataset.inventoryError = message;
    const status = card.querySelector('[data-entry-status]');
    status.textContent = message;
    status.className = 'inventory-save-state error';
  } else {
    delete card.dataset.inventoryError;
  }
}

function validateExpiryDraft(draft, totalQuantity) {
  if (draft.isSupply) return null;
  if (!Array.isArray(draft.batches) || !draft.batches.length) return 'أضف تاريخ صلاحية واحدًا على الأقل';
  let allocated = 0;
  for (const batch of draft.batches) {
    if (!batch.expiration_date) return 'يوجد تاريخ صلاحية غير مكتوب';
    try {
      batch.quantity = draft.expiryMode === 'all' ? totalQuantity : evaluateExpression(batch.quantity_expression);
    } catch {
      return 'راجع كمية أحد تواريخ الصلاحية';
    }
    if (!(batch.quantity > 0)) return 'كمية كل تاريخ صلاحية يجب أن تكون أكبر من صفر';
    allocated += Number(batch.quantity);
  }
  if (Math.abs(allocated - totalQuantity) > 0.000001) {
    return `مجموع كميات الصلاحية ${money(allocated)} ويجب أن يساوي إجمالي الصنف ${money(totalQuantity)}`;
  }
  return null;
}

function updateLocalTotal(card, materialId, mineQuantity) {
  const otherTotal = state.snapshot.entries
    .filter(entry => entry.material_id === materialId && entry.created_by !== state.profile.id)
    .reduce((sum, entry) => sum + Number(entry.quantity), 0);
  card.querySelector('[data-entry-total]').textContent = money(otherTotal + mineQuantity);
}

function scheduleSave(materialId, card, draft, delay = 500) {
  clearTimeout(state.saveTimers.get(materialId));
  const status = card.querySelector('[data-entry-status]');
  if (!draft.expression.trim()) {
    status.textContent = 'اكتب الكمية أو العملية الحسابية';
    status.className = 'inventory-save-state';
    return;
  }
  const quantity = evaluateExpression(draft.expression);
  const expiryError = validateExpiryDraft(draft, quantity);
  if (expiryError) {
    markInventoryCardError(card, expiryError);
    status.textContent = expiryError;
    status.className = 'inventory-save-state error';
    return;
  }
  markInventoryCardError(card, '');
  status.textContent = 'جارٍ الحفظ...';
  status.className = 'inventory-save-state saving';
  state.saveTimers.set(materialId, setTimeout(() => saveEntry(materialId, card, draft), delay));
}

async function saveEntry(materialId, card, draft, rethrow = false) {
  state.saveTimers.delete(materialId);
  const status = card.querySelector('[data-entry-status]');
  const savedEntry = state.snapshot.entries.find(entry => entry.material_id === materialId && entry.created_by === state.profile.id);
  const oldImagePath = savedEntry?.image_path || null;
  let uploadedImagePath = null;
  try {
    const quantity = evaluateExpression(draft.expression);
    const expiryError = validateExpiryDraft(draft, quantity);
    if (expiryError) throw new Error(expiryError);
    const expiryBatches = draft.isSupply ? [] : draft.batches.map(batch => ({
      expiration_date: batch.expiration_date,
      quantity_expression: batch.quantity_expression,
      quantity: Number(batch.quantity),
    }));
    const earliestDate = draft.isSupply ? null : expiryBatches.map(batch => batch.expiration_date).sort()[0];
    let imagePath = draft.removeImage ? null : (draft.imagePath || oldImagePath);
    if (draft.file) {
      const extension = safeImageExtension(draft.file);
      uploadedImagePath = `${state.sessionId}/${state.profile.id}/${materialId}-${Date.now()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from('inventory-images').upload(uploadedImagePath, draft.file, {
        cacheControl: '3600',
        contentType: draft.file.type,
        upsert: false,
      });
      if (uploadError) throw uploadError;
      imagePath = uploadedImagePath;
    }
    state.ignoreOwnEntryEventsUntil = Date.now() + 2500;
    const { error } = await supabase.from('inventory_entries').upsert({
      session_id: state.sessionId,
      material_id: materialId,
      created_by: state.profile.id,
      quantity,
      quantity_expression: draft.expression.trim(),
      expiration_date: earliestDate,
      expiry_batches: expiryBatches,
      is_supply: draft.isSupply,
      image_path: imagePath,
    }, { onConflict: 'session_id,material_id,created_by' });
    if (error) throw error;
    if (oldImagePath && oldImagePath !== imagePath) {
      await supabase.storage.from('inventory-images').remove([oldImagePath]);
    }
    draft.imagePath = imagePath || '';
    draft.file = null;
    draft.removeImage = false;
    state.drafts.set(materialId, draft);
    markInventoryCardError(card, '');
    status.textContent = `تم الحفظ ${formatTime(new Date())}`;
    status.className = 'inventory-save-state saved';
  } catch (error) {
    if (uploadedImagePath) await supabase.storage.from('inventory-images').remove([uploadedImagePath]);
    status.textContent = error.message;
    status.className = 'inventory-save-state error';
    markInventoryCardError(card, error.message);
    if (rethrow) throw error;
  }
}

async function startOrJoin() {
  const button = state.root.querySelector('#start-inventory,#join-inventory');
  if (button) button.disabled = true;
  try {
    const { data, error } = await supabase.rpc('start_or_join_inventory', { target_branch: state.profile.branch_id });
    if (error) throw error;
    state.sessionId = data;
    state.snapshot = await getSnapshot(data);
    state.drafts.clear();
    subscribeToSession(data);
    drawInventory(state.snapshot, true);
    toast(state.snapshot.participants.length > 1 ? 'تم الانضمام للجرد المشترك' : 'تم بدء الجرد');
  } catch (error) {
    showSetupError(error);
  }
}

async function finishMyPart() {
  const invalid = validateDrafts();
  if (invalid) {
    toast(invalid.message, 'warning');
    revealInventoryError(invalid);
    return;
  }
  const button = state.root.querySelector('#finish-my-inventory');
  const endingSession = button?.dataset.finishMode === 'session';
  const confirmation = endingSession
    ? 'تأكيد إنهاء الجرد بالكامل؟ بعد التأكيد لن يمكن لأي شخص تعديل الجلسة.'
    : 'تأكيد حفظ الجزء الخاص بك؟ بعد التأكيد لن يمكنك تعديل كمياتك في هذه الجلسة، وسيكمل باقي الفريق.';
  if (!await confirmDialog(
    endingSession ? 'إنهاء الجرد بالكامل؟' : 'حفظ الجزء الخاص بك؟',
    confirmation,
    {
      confirmText: endingSession ? 'إنهاء الجرد' : 'حفظ الجزء',
      cancelText: 'مراجعة الكميات',
      tone: endingSession ? 'gold' : 'primary',
      icon: endingSession ? '✓' : '↗',
    },
  )) return;
  button.disabled = true;
  try {
    await flushPendingSaves();
    const { data, error } = await supabase.rpc('finish_inventory_part', { target_session: state.sessionId });
    if (error) throw error;
    state.snapshot = await getSnapshot(state.sessionId);
    drawInventory(state.snapshot, true);
    toast(data?.status === 'completed' ? 'تم إنهاء الجرد ولا يمكن تعديله' : `تم حفظ جزئك — متبقي ${data?.remaining || 0} مشارك`);
  } catch (error) {
    toast(error.message, 'error');
    const failedCard = state.root.querySelector('.inventory-item-invalid');
    if (failedCard) revealInventoryError({
      card: failedCard,
      message: failedCard.dataset.inventoryError || error.message,
      target: failedCard.querySelector('[data-batch-date], [data-batch-expression], [data-entry-expression]'),
    });
    button.disabled = false;
  }
}

function validateDrafts() {
  for (const [materialId, draft] of state.drafts) {
    const card = state.root.querySelector(`[data-material-id="${materialId}"]`);
    if (!draft.expression.trim()) {
      const hasExpiryWork = draft.batches?.length > 1 || draft.batches?.some(batch => batch.expiration_date || batch.quantity_expression);
      if (hasExpiryWork) return { card, message: 'اكتب إجمالي كمية الصنف أولًا', target: card.querySelector('[data-entry-expression]') };
      continue;
    }
    try {
      const quantity = evaluateExpression(draft.expression);
      const expiryError = validateExpiryDraft(draft, quantity);
      if (expiryError) return { card, message: expiryError, target: findInventoryErrorTarget(card, draft) };
    } catch (error) {
      return { card, message: error.message, target: card.querySelector('[data-entry-expression]') };
    }
  }
  return null;
}

function findInventoryErrorTarget(card, draft) {
  const rows = [...card.querySelectorAll('[data-expiry-batch]')];
  const missingDate = rows.find(row => !row.querySelector('[data-batch-date]').value);
  if (missingDate) return missingDate.querySelector('[data-batch-date]');
  if (draft.expiryMode === 'split') {
    const invalidQuantity = rows.find(row => {
      const input = row.querySelector('[data-batch-expression]');
      try { return evaluateExpression(input.value) <= 0; } catch { return true; }
    });
    if (invalidQuantity) return invalidQuantity.querySelector('[data-batch-expression]');
    return rows.at(-1)?.querySelector('[data-batch-expression]');
  }
  return rows[0]?.querySelector('[data-batch-date]') || card.querySelector('[data-entry-expression]');
}

function revealInventoryError(invalid) {
  const search = state.root.querySelector('#inventory-search');
  if (invalid.card.hidden && search) {
    search.value = '';
    if (search.__applyInventoryFilter) search.__applyInventoryFilter();
    else search.dispatchEvent(new Event('input', { bubbles: true }));
  }
  markInventoryCardError(invalid.card, invalid.message);
  invalid.card.classList.remove('inventory-item-error-pulse');
  void invalid.card.offsetWidth;
  invalid.card.classList.add('inventory-item-error-pulse');
  invalid.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => invalid.target?.focus(), 350);
}

async function flushPendingSaves() {
  const pending = [];
  state.saveTimers.forEach(clearTimeout);
  state.saveTimers.clear();
  state.drafts.forEach((draft, materialId) => {
    const card = state.root.querySelector(`[data-material-id="${materialId}"]`);
    if (card && draftReady(draft)) pending.push(saveEntry(materialId, card, draft, true));
  });
  await Promise.all(pending);
}

function draftReady(draft) {
  if (!draft?.expression.trim()) return false;
  try {
    const quantity = evaluateExpression(draft.expression);
    return !validateExpiryDraft(draft, quantity);
  } catch {
    return false;
  }
}

function subscribeToSession(sessionId) {
  cleanupInventory();
  state.channel = supabase.channel(`inventory:${sessionId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_entries', filter: `session_id=eq.${sessionId}` }, handleInventoryEntryChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_participants', filter: `session_id=eq.${sessionId}` }, refreshSession)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'inventory_sessions', filter: `id=eq.${sessionId}` }, refreshSession)
    .subscribe();
}

function handleInventoryEntryChange(payload) {
  const authorId = payload?.new?.created_by || payload?.old?.created_by;
  if (authorId === state.profile?.id && Date.now() < state.ignoreOwnEntryEventsUntil) return;
  refreshSession();
}

let refreshTimer;
function refreshSession() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!state.sessionId || !state.root?.isConnected || location.hash !== '#inventory') return;
    try {
      state.snapshot = await getSnapshot(state.sessionId);
      drawInventory(state.snapshot, true);
    } catch (error) {
      console.error(error);
    }
  }, 180);
}

async function getSnapshot(sessionId) {
  const { data, error } = await supabase.rpc('inventory_session_snapshot', { target_session: sessionId });
  if (error) throw error;
  return data;
}

function prefetchInventoryReports(force = false) {
  if (state.reportLoadPromise && !force) return state.reportLoadPromise;
  state.reportLoadPromise = supabase
    .rpc('list_inventory_sessions', { target_branch: state.profile.branch_id, max_rows: 100 })
    .then(({ data, error }) => {
      if (error) throw error;
      state.reportSessions = data || [];
      return state.reportSessions;
    })
    .finally(() => { state.reportLoadPromise = null; });
  return state.reportLoadPromise;
}

async function renderReportsTab() {
  if (!hasInventoryReportPermission('inventory_reports')) return toast('لا توجد صلاحية لعرض تقارير الجرد', 'warning');
  cleanupInventory();
  const box = state.root.querySelector('#inventory-content');
  box.innerHTML = `<div class="inventory-report-head"><div><h3>تقارير جرد ${escapeHtml(state.profile.branch_name)}</h3><p>الملخص، تفاصيل كل موظف، تنبيهات الصلاحية والأصناف التي لم تُجرد.</p></div></div>
    <div class="inventory-report-loading"><i></i><span>جارٍ تجهيز جلسات الجرد...</span></div>`;
  try {
    const sessions = state.reportSessions || await prefetchInventoryReports();
    drawReportSessions(box, sessions);
  } catch (error) {
    showSetupError(error);
  }
}

async function renderMonthlyBranchActivity(monthValue = currentMonthValue()) {
  if (!hasInventoryReportPermission('inventory_all_reports')) return toast('لا توجد صلاحية لمتابعة كل الفروع', 'warning');
  cleanupInventory();
  const box = state.root.querySelector('#inventory-content');
  box.innerHTML = `<div class="inventory-report-head branch-activity-head"><div><h3>متابعة نشاط الفروع</h3><p>الجرد والصرف والإضافة لكل فرع خلال الشهر المحدد.</p></div><label>الشهر<input type="month" id="branch-activity-month" value="${escapeHtml(monthValue)}" required></label></div>
    <div class="inventory-report-loading"><i></i><span>جارٍ مراجعة نشاط الفروع...</span></div>`;
  const monthInput = box.querySelector('#branch-activity-month');
  monthInput.onchange = () => monthInput.value && renderMonthlyBranchActivity(monthInput.value);

  const { data, error } = await supabase.rpc('monthly_branch_activity', {
    target_month: `${monthValue}-01`,
  });
  if (error) return showSetupError(error);

  const rows = data || [];
  const inventoryDone = rows.filter(row => row.inventory_completed).length;
  const consumptionDone = rows.filter(row => row.consumption_done).length;
  const additionsDone = rows.filter(row => row.additions_done).length;
  const inactive = rows.filter(row => !row.inventory_completed && !row.consumption_done && !row.additions_done).length;
  const status = (done, yes, no, count) => done
    ? `<span class="branch-activity-status done">✓ ${yes}<small>${count} حركة</small></span>`
    : `<span class="branch-activity-status missing">✕ ${no}</span>`;

  box.innerHTML = `<div class="inventory-report-head branch-activity-head"><div><h3>متابعة نشاط الفروع</h3><p>الجرد والصرف والإضافة لكل فرع خلال ${escapeHtml(monthLabel(monthValue))}.</p></div><label>الشهر<input type="month" id="branch-activity-month" value="${escapeHtml(monthValue)}" required></label></div>
    <div class="branch-activity-metrics">
      <article><span>إجمالي الفروع</span><strong>${rows.length}</strong></article>
      <article><span>أنهت الجرد</span><strong>${inventoryDone}</strong><small>لم تجرد: ${rows.length - inventoryDone}</small></article>
      <article><span>عملت صرف</span><strong>${consumptionDone}</strong><small>بدون صرف: ${rows.length - consumptionDone}</small></article>
      <article><span>عملت إضافة</span><strong>${additionsDone}</strong><small>بدون إضافة: ${rows.length - additionsDone}</small></article>
      <article class="${inactive ? 'danger' : ''}"><span>بدون أي نشاط</span><strong>${inactive}</strong></article>
    </div>
    <div class="table-wrap branch-activity-table"><table class="data-table"><thead><tr><th>الفرع</th><th>الجرد خلال الشهر</th><th>الصرف خلال الشهر</th><th>الإضافة خلال الشهر</th><th>الحالة العامة</th></tr></thead><tbody>${rows.map(row => {
      const allDone = row.inventory_completed && row.consumption_done && row.additions_done;
      const noActivity = !row.inventory_completed && !row.consumption_done && !row.additions_done;
      return `<tr class="${noActivity ? 'branch-no-activity' : ''}"><td class="row-title">${escapeHtml(row.branch_name)}</td><td>${status(row.inventory_completed, 'تم الجرد', 'لم يتم الجرد', row.inventory_count)}${row.latest_inventory_at ? `<small class="branch-activity-date">آخر إنهاء: ${formatDateTime(row.latest_inventory_at)}</small>` : ''}</td><td>${status(row.consumption_done, 'تم الصرف', 'لا يوجد صرف', row.consumption_count)}</td><td>${status(row.additions_done, 'تمت الإضافة', 'لا توجد إضافة', row.additions_count)}</td><td><span class="badge ${allDone ? 'client' : noActivity ? 'danger' : 'temp'}">${allDone ? 'مكتمل النشاط' : noActivity ? 'بدون نشاط' : 'نشاط ناقص'}</span></td></tr>`;
    }).join('') || '<tr><td colspan="5"><div class="empty-state">لا توجد فروع</div></td></tr>'}</tbody></table></div>`;
  box.querySelector('#branch-activity-month').onchange = event => event.currentTarget.value && renderMonthlyBranchActivity(event.currentTarget.value);
}

function monthLabel(value) {
  const [year, month] = String(value).split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('ar-EG-u-nu-latn', { month: 'long', year: 'numeric' });
}

function currentMonthValue() {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

function drawReportSessions(box, sessions) {
  const canExportAll = hasInventoryReportPermission('inventory_all_reports');
  box.innerHTML = `<div class="inventory-report-head"><div><h3>تقارير جرد ${escapeHtml(state.profile.branch_name)}</h3><p>الملخص، تفاصيل كل موظف، تنبيهات الصلاحية والأصناف التي لم تُجرد.</p></div><div class="report-actions">${canExportAll ? '<button class="btn gold mini" id="export-all-branches-inventory">Excel أحدث جرد لكل الفروع ↓</button>' : ''}<button class="btn ghost mini" id="refresh-inventory-reports">تحديث</button></div></div>
    <div class="inventory-report-list">${sessions.length ? sessions.map(session => `<button data-report-session="${session.id}">
      <span><b>${formatDateTime(session.created_at)}</b><small>بدأ بواسطة ${escapeHtml(session.created_by_name)}</small></span>
      <span><strong>${session.material_count}</strong><small>صنف</small></span>
      <span><strong>${session.participant_count}</strong><small>مشارك</small></span>
      <span><strong>${money(session.total_quantity)}</strong><small>إجمالي الكميات</small></span>
      <i class="badge ${session.status === 'completed' ? 'client' : 'temp'}">${session.status === 'completed' ? 'مكتمل' : 'مفتوح'}</i>
    </button>`).join('') : '<div class="empty-state">لا توجد جلسات جرد لهذا الفرع بعد</div>'}</div>
    <div id="inventory-report-view"></div>`;
  box.querySelectorAll('[data-report-session]').forEach(button => button.onclick = () => openReport(button.dataset.reportSession, button));
  if (canExportAll) box.querySelector('#export-all-branches-inventory').onclick = exportAllBranchesExcel;
  box.querySelector('#refresh-inventory-reports').onclick = async event => {
    event.currentTarget.disabled = true;
    try {
      drawReportSessions(box, await prefetchInventoryReports(true));
    } catch (error) {
      showSetupError(error);
    }
  };
}

async function openReport(sessionId, trigger) {
  if (!hasInventoryReportPermission('inventory_reports')) return toast('لا توجد صلاحية لعرض تقارير الجرد', 'warning');
  const view = state.root.querySelector('#inventory-report-view');
  state.root.querySelectorAll('[data-report-session]').forEach(button => button.classList.toggle('active', button === trigger));
  if (trigger) {
    trigger.disabled = true;
    trigger.classList.add('loading');
  }
  view.innerHTML = '<div class="inventory-report-loading"><i></i><span>جارٍ إعداد التقرير...</span></div>';
  try {
    const snapshot = await getSnapshot(sessionId);
    state.reportSnapshot = snapshot;
    const summary = summarizeEntries(snapshot.entries);
    const uncounted = uncountedMaterials(snapshot);
    const expiryAlerts = flattenEntryBatches(snapshot.entries).filter(batch => {
      const status = expirationStatus(batch.expiration_date, batch.is_supply);
      return status.level === 'expired' || status.level === 'warning';
    });
    view.innerHTML = `<section class="inventory-report panel">
      <div class="panel-head gold-line"><div><h3>جرد ${escapeHtml(snapshot.session.branch_name)}</h3><p>${formatDateTime(snapshot.session.created_at)} · ${snapshot.participants.length} مشارك</p></div>
        <div class="report-actions"><button class="btn gold mini" data-inventory-export="summary">Excel تلخيصي شامل ↓</button><button class="btn ghost mini" data-inventory-export="detailed">Excel تفصيلي شامل ↓</button></div>
      </div>
      <div class="inventory-report-metrics">
        <article><span>الأصناف المجردة</span><strong>${summary.length}</strong><small>من ${state.materials.length}</small></article>
        <article class="${uncounted.length ? 'warning' : ''}"><span>لم يتم جردها</span><strong>${uncounted.length}</strong><small>موجودة في شيت منفصل</small></article>
        <article class="${expiryAlerts.length ? 'danger' : ''}"><span>تنبيهات الصلاحية</span><strong>${expiryAlerts.length}</strong><small>منتهي أو أقل من 3 شهور</small></article>
        <article><span>إجمالي الكميات</span><strong>${money(snapshot.entries.reduce((sum, entry) => sum + Number(entry.quantity), 0))}</strong><small>${snapshot.entries.length} تسجيل</small></article>
      </div>
      <div class="inventory-report-block"><h4>التقرير التلخيصي</h4><p>إجمالي الصنف مباشرة بعد جمع كميات كل الموظفين.</p>
        <div class="table-wrap"><table class="data-table inventory-report-table"><thead><tr><th>#</th><th>الفرع</th><th>الصنف</th><th>الكود</th><th>الوحدة</th><th>الإجمالي</th><th>توزيع الصلاحية والكميات</th><th>المتبقي</th></tr></thead><tbody>${summary.map((row, index) => {
          const batches = aggregateExpiryBatches(row.entries);
          const worst = worstExpiryStatus(batches);
          return `<tr class="expiry-row-${worst.level}"><td>${index + 1}</td><td>${escapeHtml(snapshot.session.branch_name)}</td><td class="row-title">${escapeHtml(row.material_name)}</td><td>${escapeHtml(row.material_code)}</td><td>${escapeHtml(row.material_unit)}</td><td><b>${money(row.quantity)}</b></td><td><div class="report-expiry-list">${batches.map(batch => `<span><b>${batch.is_supply ? 'مستلزمات' : escapeHtml(batch.expiration_date)}</b><small>${money(batch.quantity)} ${escapeHtml(row.material_unit)}</small></span>`).join('')}</div></td><td><div class="report-expiry-statuses">${batches.map(batch => { const expiry = expirationStatus(batch.expiration_date, batch.is_supply); return `<span class="expiry-pill ${expiry.level}">${escapeHtml(expiry.label)}</span>`; }).join('')}</div></td></tr>`;
        }).join('') || '<tr><td colspan="8"><div class="empty-state">لا توجد كميات مسجلة</div></td></tr>'}</tbody></table></div>
      </div>
      <div class="inventory-report-block"><h4>التقرير التفصيلي</h4><p>كمية وعملية كل موظف بشكل منفصل.</p>
        <div class="table-wrap"><table class="data-table inventory-report-table"><thead><tr><th>#</th><th>الفرع</th><th>الصنف</th><th>الموظف</th><th>العملية المكتوبة</th><th>الكمية</th><th>توزيع الصلاحية والكميات</th><th>المتبقي</th><th>الصورة</th></tr></thead><tbody>${snapshot.entries.map((entry, index) => {
          const batches = entryExpiryBatches(entry);
          const worst = worstExpiryStatus(entry.is_supply ? [{ is_supply: true }] : batches);
          return `<tr class="expiry-row-${worst.level}"><td>${index + 1}</td><td>${escapeHtml(snapshot.session.branch_name)}</td><td><span class="row-title">${escapeHtml(entry.material_name)}</span><small class="row-sub">${escapeHtml(entry.material_code)} · ${escapeHtml(entry.material_unit)}</small></td><td>${escapeHtml(entry.created_by_name)}</td><td dir="ltr">${escapeHtml(entry.quantity_expression)}</td><td><b>${money(entry.quantity)}</b></td><td><div class="report-expiry-list">${entry.is_supply ? '<span><b>مستلزمات</b><small>كل الكمية</small></span>' : batches.map(batch => `<span><b>${escapeHtml(batch.expiration_date)}</b><small>${money(batch.quantity)} ${escapeHtml(entry.material_unit)}</small></span>`).join('')}</div></td><td><div class="report-expiry-statuses">${entry.is_supply ? '<span class="expiry-pill supply">بدون صلاحية</span>' : batches.map(batch => { const expiry = expirationStatus(batch.expiration_date, false); return `<span class="expiry-pill ${expiry.level}">${escapeHtml(expiry.label)}</span>`; }).join('')}</div></td><td>${entry.image_path ? `<button class="btn primary mini" type="button" data-view-entry-image="${escapeHtml(entry.image_path)}">فتح الصورة</button>` : '—'}</td></tr>`;
        }).join('') || '<tr><td colspan="9"><div class="empty-state">لا توجد كميات مسجلة</div></td></tr>'}</tbody></table></div>
      </div>
      <div class="inventory-report-block"><h4>أصناف لم يتم جردها</h4><p>هذه الأصناف موجودة في قائمة الفرع ولم يسجل عليها أي موظف كمية.</p>
        <div class="inventory-uncounted-grid">${uncounted.length ? uncounted.map(material => `<span><b>${escapeHtml(material.name)}</b><small>${escapeHtml(snapshot.session.branch_name)} · ${escapeHtml(material.code)} · ${escapeHtml(material.unit)}</small></span>`).join('') : '<div class="empty-state compact-empty">تم جرد كل الأصناف ✓</div>'}</div>
      </div>
    </section>`;
    view.querySelectorAll('[data-inventory-export]').forEach(button => button.onclick = () => exportInventoryExcel(button.dataset.inventoryExport));
    wireImageViewers(view);
    view.scrollIntoView({ behavior: 'auto', block: 'start' });
  } catch (error) {
    view.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  } finally {
    if (trigger) {
      trigger.disabled = false;
      trigger.classList.remove('loading');
    }
  }
}

async function exportInventoryExcel(type) {
  if (!hasInventoryReportPermission('inventory_reports')) return toast('لا توجد صلاحية لتصدير تقرير الجرد', 'warning');
  if (!window.ExcelJS) return toast('مكتبة تنسيق Excel غير متاحة', 'error');
  const snapshot = state.reportSnapshot;
  if (!snapshot) return;
  const button = state.root.querySelector(`[data-inventory-export="${type}"]`);
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'جارٍ تجهيز الصور والملف...';
  try {
    const imageLinks = await createExportImageLinks(snapshot.entries);
    const exportRows = type === 'summary' ? makeSummaryExportRows(snapshot) : makeDetailedExportRows(snapshot);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ctrl.';
    workbook.created = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;
    workbook.calcProperties.forceFullCalc = true;

    buildInventoryExcelSheet(
      workbook,
      'Stock Form',
      type === 'summary' ? 'تقرير الجرد التلخيصي' : 'تقرير الجرد التفصيلي',
      exportRows,
      snapshot,
      imageLinks,
    );

    const alerts = makeDetailedExportRows(snapshot)
      .filter(row => ['expired', 'warning'].includes(expirationStatus(row.expirationDate, row.isSupply).level));
    buildInventoryExcelSheet(workbook, 'تنبيهات الصلاحية', 'الأصناف المنتهية أو الأقل من 3 شهور', alerts, snapshot, imageLinks);
    buildUncountedExcelSheet(workbook, uncountedMaterials(snapshot), snapshot);

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `جرد_${snapshot.session.branch_name}_${new Date(snapshot.session.created_at).toLocaleDateString('en-CA')}_${type === 'summary' ? 'تلخيصي' : 'تفصيلي'}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast('تم تصدير تقرير Excel شامل بالصلاحية والصور والأصناف غير المجردة');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function exportAllBranchesExcel(event) {
  if (!hasInventoryReportPermission('inventory_all_reports')) return toast('لا توجد صلاحية لتقرير الجرد المجمع', 'warning');
  if (!window.ExcelJS) return toast('مكتبة تنسيق Excel غير متاحة', 'error');
  const button = event.currentTarget;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'جارٍ جمع جرد كل الفروع...';
  try {
    const allBranches = await list('branches');
    const allowedIds = state.profile.role === 'admin'
      ? new Set(allBranches.map(branch => branch.id))
      : new Set(state.profile.branch_ids?.length ? state.profile.branch_ids : [state.profile.branch_id]);
    const branches = allBranches.filter(branch => allowedIds.has(branch.id));
    const latest = await Promise.all(branches.map(async branch => {
      const { data, error } = await supabase.rpc('list_inventory_sessions', { target_branch: branch.id, max_rows: 1 });
      if (error) throw error;
      const session = data?.[0];
      return session ? { branch, snapshot: await getSnapshot(session.id) } : null;
    }));
    const available = latest.filter(Boolean);
    if (!available.length) return toast('لا توجد جلسات جرد في الفروع المسموحة', 'warning');

    button.textContent = 'جارٍ تجهيز شيتات الفروع والصور...';
    const allEntries = available.flatMap(item => item.snapshot.entries);
    const imageLinks = await createExportImageLinks(allEntries);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ctrl.';
    workbook.created = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;
    workbook.calcProperties.forceFullCalc = true;
    const usedNames = new Set();

    available.forEach(({ branch, snapshot }) => {
      buildInventoryExcelSheet(
        workbook,
        uniqueSheetName(`${branch.name} ملخص`, usedNames),
        `ملخص جرد فرع ${branch.name}`,
        makeSummaryExportRows(snapshot),
        snapshot,
        imageLinks,
      );
      buildInventoryExcelSheet(
        workbook,
        uniqueSheetName(`${branch.name} تفصيلي`, usedNames),
        `تفاصيل جرد فرع ${branch.name}`,
        makeDetailedExportRows(snapshot),
        snapshot,
        imageLinks,
      );
    });

    const uncountedAll = available.flatMap(({ branch, snapshot }) =>
      uncountedMaterials(snapshot).map(material => ({ ...material, branch: branch.name })));
    const combinedSnapshot = {
      session: { branch_name: 'كل الفروع', created_at: new Date().toISOString() },
      participants: available.flatMap(item => item.snapshot.participants),
      entries: allEntries,
    };
    buildUncountedExcelSheet(workbook, uncountedAll, combinedSnapshot);
    buildInventoryExcelSheet(
      workbook,
      uniqueSheetName('كل الفروع', usedNames),
      'ملخص جرد كل الفروع',
      available.flatMap(item => makeSummaryExportRows(item.snapshot)),
      combinedSnapshot,
      imageLinks,
    );

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `جرد_كل_الفروع_${new Date().toLocaleDateString('en-CA')}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast(`تم تصدير جرد ${available.length} فرع في ملف واحد`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function uniqueSheetName(value, usedNames) {
  const base = String(value).replace(/[\\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let name = base;
  let counter = 2;
  while (usedNames.has(name)) {
    const suffix = ` ${counter}`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    counter += 1;
  }
  usedNames.add(name);
  return name;
}

function makeSummaryExportRows(snapshot) {
  return summarizeEntries(snapshot.entries).map(group => {
    const expiryAllocations = aggregateExpiryBatches(group.entries);
    const notes = group.entries.flatMap(entry => {
      const batches = entry.is_supply
        ? [{ expiration_date: '', quantity: Number(entry.quantity), quantity_expression: entry.quantity_expression, is_supply: true }]
        : entryExpiryBatches(entry).map(batch => ({ ...batch, is_supply: false }));
      return batches.map(batch => {
        const expiryLabel = batch.is_supply ? 'مستلزمات' : batch.expiration_date;
        return `${entry.created_by_name}: ${batch.quantity_expression || batch.quantity} = ${money(batch.quantity)} (${expiryLabel})`;
      });
    });
    return {
      branch: snapshot.session.branch_name,
      code: group.material_code,
      name: group.material_name,
      category: group.material_category,
      unit: group.material_unit,
      quantity: Number(group.quantity),
      note: notes.join(' | '),
      expiryAllocations,
      expirationDate: '',
      isSupply: expiryAllocations.length > 0 && expiryAllocations.every(batch => batch.is_supply),
      imagePath: group.entries.find(entry => entry.image_path)?.image_path || '',
    };
  });
}

function makeDetailedExportRows(snapshot) {
  return snapshot.entries.flatMap(entry => {
    const batches = entry.is_supply
      ? [{ expiration_date: '', quantity: Number(entry.quantity), quantity_expression: entry.quantity_expression, is_supply: true }]
      : entryExpiryBatches(entry).map(batch => ({ ...batch, is_supply: false }));
    return batches.map(batch => ({
      branch: snapshot.session.branch_name,
      code: entry.material_code,
      name: entry.material_name,
      category: entry.material_category,
      unit: entry.material_unit,
      quantity: Number(batch.quantity),
      note: `${entry.created_by_name}: ${batch.quantity_expression || batch.quantity} = ${money(batch.quantity)} (إجمالي الموظف ${money(entry.quantity)})`,
      expirationDate: batch.expiration_date,
      isSupply: batch.is_supply,
      imagePath: entry.image_path || '',
    }));
  });
}

function buildInventoryExcelSheet(workbook, sheetName, title, rows, snapshot, imageLinks) {
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ rightToLeft: true, showGridLines: false, state: 'frozen', ySplit: 5 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:5' },
  });
  sheet.mergeCells('A1:K1');
  sheet.getCell('A1').value = `ctrl.  |  ${title}`;
  sheet.getCell('A1').font = { name: 'Arial', size: 20, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172554' } };
  sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 38;
  sheet.mergeCells('A2:K2');
  sheet.getCell('A2').value = `الفرع: ${snapshot.session.branch_name}   |   تاريخ الجرد: ${formatDateTime(snapshot.session.created_at)}   |   المشاركون: ${snapshot.participants.length}`;
  sheet.getCell('A2').font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF1E3A8A' } };
  sheet.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
  sheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(2).height = 25;
  sheet.mergeCells('A3:K3');
  sheet.getCell('A3').value = `عدد الصفوف: ${rows.length}   |   الأصناف غير المجردة: ${uncountedMaterials(snapshot).length}   |   الأحمر = منتهي، الأصفر = أقل من 3 شهور`;
  sheet.getCell('A3').alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getCell('A3').font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF475569' } };

  const headers = ['الفرع', 'الكود', 'اسم الصنف', 'الفئة', 'الوحدة', 'الكمية', 'تفاصيل الموظفين/العملية', 'تاريخ الصلاحية', 'المدة المتبقية', 'الحالة', 'رابط الصورة'];
  sheet.getRow(5).values = headers;
  sheet.getRow(5).height = 30;
  sheet.getRow(5).eachCell(cell => {
    cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF1D4ED8' } } };
  });
  const widths = [20, 16, 30, 20, 12, 13, 42, 28, 34, 18, 20];
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });

  rows.forEach((item, index) => {
    const rowNumber = index + 6;
    const row = sheet.getRow(rowNumber);
    const expiryAllocations = Array.isArray(item.expiryAllocations) ? item.expiryAllocations : null;
    const expiry = expiryAllocations
      ? worstExpiryStatus(expiryAllocations)
      : expirationStatus(item.expirationDate, item.isSupply);
    row.values = [item.branch || snapshot.session.branch_name || '', item.code || '', item.name || '', item.category || '', item.unit || '', Number(item.quantity || 0), item.note || '', '', '', '', ''];
    row.height = expiryAllocations ? Math.min(110, 32 + Math.max(0, expiryAllocations.length - 1) * 18) : 32;
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { name: 'Arial', size: 10, color: { argb: 'FF0F172A' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 ? 'FFF8FAFC' : 'FFFFFFFF' } };
    });
    row.getCell(3).alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
    row.getCell(7).alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
    row.getCell(6).numFmt = '#,##0.00';
    if (expiryAllocations) {
      const datedAllocations = expiryAllocations.filter(batch => !batch.is_supply);
      const supplyAllocations = expiryAllocations.filter(batch => batch.is_supply);
      row.getCell(8).value = [
        ...datedAllocations.map(batch => `تاريخ ${batch.expiration_date} — الكمية ${money(batch.quantity)}`),
        ...supplyAllocations.map(batch => `مستلزمات — الكمية ${money(batch.quantity)}`),
      ].join('\n');
      row.getCell(9).value = expiryAllocations
        .map(batch => `الكمية ${money(batch.quantity)}: ${expirationStatus(batch.expiration_date, batch.is_supply).label}`)
        .join('\n');
      row.getCell(10).value = expiry.status;
      row.getCell(8).alignment = { vertical: 'middle', horizontal: 'right', wrapText: true, readingOrder: 'rtl' };
      row.getCell(9).alignment = { vertical: 'middle', horizontal: 'right', wrapText: true, readingOrder: 'rtl' };
    } else if (item.isSupply) {
      row.getCell(8).value = '';
      row.getCell(9).value = 'بدون صلاحية';
      row.getCell(10).value = 'مستلزمات';
    } else if (item.expirationDate) {
      row.getCell(8).value = new Date(`${item.expirationDate}T12:00:00`);
      row.getCell(8).numFmt = 'yyyy-mm-dd';
      row.getCell(9).value = {
        formula: `IF(H${rowNumber}<TODAY(),"منتهي منذ "&IF(DATEDIF(H${rowNumber},TODAY(),"y")>0,DATEDIF(H${rowNumber},TODAY(),"y")&" سنة و ","")&IF(DATEDIF(H${rowNumber},TODAY(),"ym")>0,DATEDIF(H${rowNumber},TODAY(),"ym")&" شهر و ","")&DATEDIF(H${rowNumber},TODAY(),"md")&" يوم","فاضل "&IF(DATEDIF(TODAY(),H${rowNumber},"y")>0,DATEDIF(TODAY(),H${rowNumber},"y")&" سنة و ","")&IF(DATEDIF(TODAY(),H${rowNumber},"ym")>0,DATEDIF(TODAY(),H${rowNumber},"ym")&" شهر و ","")&DATEDIF(TODAY(),H${rowNumber},"md")&" يوم")`,
        result: expiry.label,
      };
      row.getCell(10).value = {
        formula: `IF(H${rowNumber}<TODAY(),"منتهي",IF(H${rowNumber}<EDATE(TODAY(),3),"أقل من 3 شهور","سليم"))`,
        result: expiry.status,
      };
    }
    if (item.imagePath && imageLinks.get(item.imagePath)) {
      row.getCell(11).value = { text: 'فتح الصورة', hyperlink: imageLinks.get(item.imagePath), tooltip: 'اضغط لفتح صورة الصنف' };
      row.getCell(11).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF2563EB' }, underline: true };
    } else {
      row.getCell(11).value = 'لا توجد';
      row.getCell(11).font = { name: 'Arial', size: 10, color: { argb: 'FF94A3B8' } };
    }
    if (expiry.level === 'expired' || expiry.level === 'warning') {
      const color = expiry.level === 'expired' ? 'FFFEE2E2' : 'FFFEF3C7';
      const accent = expiry.level === 'expired' ? 'FFFCA5A5' : 'FFFDE68A';
      const textColor = expiry.level === 'expired' ? 'FFB91C1C' : 'FF92400E';
      row.eachCell({ includeEmpty: true }, cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }; });
      [8, 9, 10].forEach(column => {
        row.getCell(column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: accent } };
        row.getCell(column).font = { name: 'Arial', size: 10, bold: true, color: { argb: textColor } };
      });
    }
  });
  const lastRow = Math.max(6, rows.length + 5);
  sheet.autoFilter = { from: 'A5', to: `K${lastRow}` };
  sheet.pageSetup.printArea = `A1:K${lastRow}`;
  sheet.headerFooter.oddFooter = '&Cصفحة &P من &N';
}

function buildUncountedExcelSheet(workbook, materials, snapshot) {
  const sheet = workbook.addWorksheet('لم يتم جردها', {
    views: [{ rightToLeft: true, showGridLines: false, state: 'frozen', ySplit: 4 }],
  });
  sheet.mergeCells('A1:F1');
  sheet.getCell('A1').value = 'ctrl.  |  الأصناف التي لم يتم جردها';
  sheet.getCell('A1').font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C2D12' } };
  sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 36;
  sheet.mergeCells('A2:F2');
  sheet.getCell('A2').value = `فرع ${snapshot.session.branch_name} · ${formatDateTime(snapshot.session.created_at)} · العدد ${materials.length}`;
  sheet.getCell('A2').alignment = { horizontal: 'center' };
  sheet.getRow(4).values = ['#', 'الفرع', 'الكود', 'اسم الصنف', 'الفئة', 'الوحدة'];
  sheet.getRow(4).eachCell(cell => {
    cell.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEA580C' } };
    cell.alignment = { horizontal: 'center' };
  });
  [8, 20, 18, 34, 24, 14].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  materials.forEach((material, index) => {
    const row = sheet.getRow(index + 5);
    row.values = [index + 1, material.branch || snapshot.session.branch_name || '', material.code || '', material.name || '', material.category || '', material.unit || ''];
    row.height = 25;
    row.eachCell(cell => {
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFFED7AA' } } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 ? 'FFFFF7ED' : 'FFFFFFFF' } };
    });
  });
  const lastRow = Math.max(5, materials.length + 4);
  sheet.autoFilter = { from: 'A4', to: `F${lastRow}` };
  sheet.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printArea: `A1:F${lastRow}`, printTitlesRow: '1:4' };
}

async function createExportImageLinks(entries) {
  const paths = [...new Set(entries.map(entry => entry.image_path).filter(Boolean))];
  const pairs = await Promise.all(paths.map(async path => {
    const { data, error } = await supabase.storage.from('inventory-images').createSignedUrl(path, 60 * 60 * 24 * 365);
    return [path, error ? '' : data.signedUrl];
  }));
  return new Map(pairs);
}

function summarizeEntries(entries) {
  const groups = new Map();
  entries.forEach(entry => {
    if (!groups.has(entry.material_id)) groups.set(entry.material_id, {
      material_id: entry.material_id,
      material_name: entry.material_name,
      material_code: entry.material_code,
      material_unit: entry.material_unit,
      material_category: entry.material_category,
      quantity: 0,
      entries: [],
    });
    const group = groups.get(entry.material_id);
    group.quantity += Number(entry.quantity);
    group.entries.push(entry);
  });
  return [...groups.values()].sort((a, b) => String(a.material_name).localeCompare(String(b.material_name), 'ar'));
}

function flattenEntryBatches(entries) {
  return entries.flatMap(entry => entry.is_supply
    ? [{ ...entry, expiration_date: '', batch_quantity: Number(entry.quantity), is_supply: true }]
    : entryExpiryBatches(entry).map(batch => ({
        ...entry,
        expiration_date: batch.expiration_date,
        batch_quantity: Number(batch.quantity),
        batch_expression: batch.quantity_expression,
        is_supply: false,
      })));
}

function aggregateExpiryBatches(entries) {
  const groups = new Map();
  flattenEntryBatches(entries).forEach(batch => {
    const key = batch.is_supply ? 'SUPPLY' : batch.expiration_date;
    if (!groups.has(key)) groups.set(key, {
      expiration_date: batch.expiration_date,
      is_supply: batch.is_supply,
      quantity: 0,
    });
    groups.get(key).quantity += Number(batch.batch_quantity);
  });
  return [...groups.values()].sort((a, b) => {
    if (a.is_supply) return 1;
    if (b.is_supply) return -1;
    return String(a.expiration_date).localeCompare(String(b.expiration_date));
  });
}

function worstExpiryStatus(batches) {
  const rank = { expired: 4, warning: 3, missing: 2, safe: 1, supply: 0 };
  return batches
    .map(batch => expirationStatus(batch.expiration_date, batch.is_supply))
    .sort((a, b) => rank[b.level] - rank[a.level])[0] || expirationStatus('', true);
}

function uncountedMaterials(snapshot) {
  const counted = new Set(snapshot.entries.map(entry => entry.material_id));
  return state.materials.filter(material => !counted.has(material.id));
}

function expirationStatus(value, isSupply = false) {
  if (isSupply) return { level: 'supply', status: 'مستلزمات', label: 'بدون صلاحية', months: null, days: null };
  if (!value) return { level: 'missing', status: 'بدون تاريخ', label: 'لم يُكتب تاريخ', months: null, days: null };
  const todayDate = new Date();
  const today = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate(), 12);
  const target = new Date(`${value}T12:00:00`);
  const expired = target < today;
  const start = expired ? target : today;
  const end = expired ? today : target;
  let months = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
  let cursor = addCalendarMonths(start, months);
  if (cursor > end) {
    months -= 1;
    cursor = addCalendarMonths(start, months);
  }
  const days = Math.max(0, Math.round((end - cursor) / 86400000));
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  const duration = [
    years ? `${years} سنة` : '',
    remainingMonths ? `${remainingMonths} شهر` : '',
    days || (!years && !remainingMonths) ? `${days} يوم` : '',
  ].filter(Boolean).join(' و');
  if (expired) return { level: 'expired', status: 'منتهي', label: `منتهي من ${duration}`, months, days };
  const warningEdge = addCalendarMonths(today, 3);
  return {
    level: target < warningEdge ? 'warning' : 'safe',
    status: target < warningEdge ? 'أقل من 3 شهور' : 'سليم',
    label: `فاضل ${duration}`,
    months,
    days,
  };
}

function addCalendarMonths(date, months) {
  const result = new Date(date);
  const originalDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDay, lastDay));
  return result;
}

function shiftExpirationDate(value, unit) {
  const source = value ? new Date(`${value}T12:00:00`) : new Date();
  if (unit === 'day') source.setDate(source.getDate() + 1);
  if (unit === 'month') {
    const originalDay = source.getDate();
    source.setDate(1);
    source.setMonth(source.getMonth() + 1);
    const lastDay = new Date(source.getFullYear(), source.getMonth() + 1, 0).getDate();
    source.setDate(Math.min(originalDay, lastDay));
  }
  if (unit === 'year') {
    const month = source.getMonth();
    source.setFullYear(source.getFullYear() + 1);
    if (source.getMonth() !== month) source.setDate(0);
  }
  return `${source.getFullYear()}-${String(source.getMonth() + 1).padStart(2, '0')}-${String(source.getDate()).padStart(2, '0')}`;
}

function safeImageExtension(file) {
  const fromName = String(file.name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  const allowed = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'];
  if (allowed.includes(fromName)) return fromName;
  return file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
}

function wireImageViewers(root) {
  root.querySelectorAll('[data-view-entry-image]').forEach(button => {
    button.onclick = () => openInventoryImage(button.dataset.viewEntryImage, button);
  });
}

async function openInventoryImage(path, button) {
  button.disabled = true;
  try {
    const { data, error } = await supabase.storage.from('inventory-images').createSignedUrl(path, 120);
    if (error) throw error;
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function evaluateExpression(value) {
  const input = String(value || '').trim()
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[×xX]/g, '*')
    .replace(/[÷]/g, '/')
    .replace(/[٫،,]/g, '.')
    .replace(/٬/g, '');
  if (!input) throw new Error('اكتب الكمية');
  if (!/^[\d+\-*/().\s]+$/.test(input)) throw new Error('العملية تحتوي على رمز غير مسموح');
  let index = 0;
  const peek = () => input[index];
  const skip = () => { while (/\s/.test(peek() || '')) index += 1; };
  const number = () => {
    skip();
    const match = input.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (!match) throw new Error('راجع العملية الحسابية');
    index += match[0].length;
    return Number(match[0]);
  };
  const factor = () => {
    skip();
    if (peek() === '+') { index += 1; return factor(); }
    if (peek() === '-') { index += 1; return -factor(); }
    if (peek() === '(') {
      index += 1;
      const result = expression();
      skip();
      if (peek() !== ')') throw new Error('يوجد قوس غير مكتمل');
      index += 1;
      return result;
    }
    return number();
  };
  const term = () => {
    let result = factor();
    while (true) {
      skip();
      const operator = peek();
      if (operator !== '*' && operator !== '/') break;
      index += 1;
      const right = factor();
      if (operator === '/' && right === 0) throw new Error('لا يمكن القسمة على صفر');
      result = operator === '*' ? result * right : result / right;
    }
    return result;
  };
  const expression = () => {
    let result = term();
    while (true) {
      skip();
      const operator = peek();
      if (operator !== '+' && operator !== '-') break;
      index += 1;
      const right = term();
      result = operator === '+' ? result + right : result - right;
    }
    return result;
  };
  const result = expression();
  skip();
  if (index !== input.length) throw new Error('راجع العملية الحسابية');
  if (!Number.isFinite(result) || result < 0) throw new Error('الكمية يجب أن تكون صفراً أو أكبر');
  return Math.round((result + Number.EPSILON) * 1000000) / 1000000;
}

function normalize(value) {
  return String(value || '').toLocaleLowerCase('ar').normalize('NFD')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function searchScore(text, query, words = null) {
  if (!query) return 0;
  if (text.startsWith(query)) return 0;
  if ((words || text.split(/\s+/)).some(word => word.startsWith(query))) return 1;
  if (text.includes(query)) return 2;
  return 99;
}

function formatDateTime(value) {
  return new Date(value).toLocaleString('ar-EG-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' });
}

function hasInventoryReportPermission(key) {
  const value = state.profile?.permissions?.[key];
  if (value !== undefined) return !!value;
  return key === 'inventory_reports' ? true : state.profile?.role === 'admin';
}

function showSetupError(error) {
  console.error(error);
  const missing = /inventory_|function public\.|relation .* does not exist|Could not find/i.test(error?.message || '');
  state.root.querySelector('#inventory-content').innerHTML = `<div class="inventory-setup-error"><b>تعذر فتح الجرد</b><p>${escapeHtml(error?.message || 'خطأ غير معروف')}</p>${missing ? '<small>نفّذ ملف inventory-upgrade.sql في Supabase SQL Editor أولاً.</small>' : ''}</div>`;
}
