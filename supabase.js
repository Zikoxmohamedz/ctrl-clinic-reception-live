import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const config = window.CTRL_CONFIG || {};
const publishableKey = config.SUPABASE_PUBLISHABLE_KEY || config.SUPABASE_ANON_KEY;
export const isConfigured = Boolean(config.SUPABASE_URL && publishableKey && !config.SUPABASE_URL.includes('YOUR_'));
export const supabase = isConfigured ? createClient(config.SUPABASE_URL, publishableKey) : null;

export const today = () => new Date().toLocaleDateString('en-CA');
export const money = value => new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 }).format(Number(value || 0));
export const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));

export function getProfile() { try { return JSON.parse(sessionStorage.getItem('ctrl_profile')); } catch { return null; } }
export function toast(message, type = 'success') {
  const root = document.getElementById('toast-container'); if (!root) return;
  const el = document.createElement('div'); el.className = `toast ${type}`; el.innerHTML = `<b>${type === 'success' ? '✓' : type === 'error' ? '!' : 'i'}</b><span>${escapeHtml(message)}</span>`;
  root.append(el); setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, 3000);
}
export function confirmDialog(title, message) {
  return new Promise(resolve => { const root = document.getElementById('modal-root'); root.innerHTML = `<div class="modal-backdrop"><div class="modal small"><button class="modal-x" data-cancel>×</button><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p><div class="modal-actions"><button class="btn ghost" data-cancel>إلغاء</button><button class="btn danger" data-confirm>تأكيد الحذف</button></div></div></div>`; const done = value => { root.innerHTML=''; resolve(value); }; root.querySelectorAll('[data-cancel]').forEach(x=>x.onclick=()=>done(false)); root.querySelector('[data-confirm]').onclick=()=>done(true); });
}
