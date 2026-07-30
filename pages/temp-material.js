import { escapeHtml, toast } from '../supabase.js?v=20260730-latin-digits';

export function openTemporaryMaterial(initialName, onSave) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><form class="modal"><button type="button" class="modal-x">×</button><h3>إضافة صنف مؤقت</h3><p>سيظهر الصنف فورًا للتسجيل، ثم يراجعه المدير من تاب الأصناف المؤقتة لاعتماده أو استبداله.</p><div class="form-grid two"><div class="field"><label>اسم الصنف <em>*</em><input name="name" value="${escapeHtml(initialName || '')}" required></label></div><div class="field"><label>كود مؤقت <em>*</em><input name="code" value="TEMP-${Date.now().toString().slice(-6)}" required></label></div><div class="field"><label>الوحدة <em>*</em><input name="unit" placeholder="ml / g / pcs / Count" required></label></div><div class="field"><label>الفئة<input name="category"></label></div></div><div class="modal-actions"><button type="button" class="btn ghost modal-cancel">إلغاء</button><button type="submit" class="btn primary">حفظ وإضافة</button></div></form></div>`;
  const form = root.querySelector('form');
  const close = () => { root.innerHTML = ''; };
  root.querySelectorAll('.modal-x,.modal-cancel').forEach(button => button.onclick = close);
  form.onsubmit = async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = event.submitter || form.querySelector('[type="submit"]');
    button.disabled = true;
    button.textContent = 'جارٍ الحفظ...';
    try {
      const fields = form.elements;
      await onSave({
        name: fields.namedItem('name').value.trim(),
        code: fields.namedItem('code').value.trim().toUpperCase(),
        unit: fields.namedItem('unit').value.trim(),
        category: fields.namedItem('category').value.trim(),
        default_price: 0,
        scope: 'temporary',
        is_temp: true,
      });
      close();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
      button.textContent = 'حفظ وإضافة';
    }
  };
}
