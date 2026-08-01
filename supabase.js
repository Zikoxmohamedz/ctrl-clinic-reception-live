import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const config = window.CTRL_CONFIG || {};
const publishableKey = config.SUPABASE_PUBLISHABLE_KEY || config.SUPABASE_ANON_KEY;
export const isConfigured = Boolean(config.SUPABASE_URL && publishableKey && !config.SUPABASE_URL.includes('YOUR_'));
const sessionKey = 'ctrl_audit_session';
let auditSession = sessionStorage.getItem(sessionKey);
if (!auditSession) {
  auditSession = crypto.randomUUID();
  sessionStorage.setItem(sessionKey, auditSession);
}
const deviceType = /iPad|Tablet/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent))
  ? 'tablet'
  : /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
const auditHeaders = {
  'x-ctrl-user-agent': navigator.userAgent.slice(0, 500),
  'x-ctrl-device': deviceType,
  'x-ctrl-platform': String(navigator.userAgentData?.platform || navigator.platform || '').slice(0, 100),
  'x-ctrl-session': auditSession,
};
export const supabase = isConfigured ? createClient(config.SUPABASE_URL, publishableKey, { global: { headers: auditHeaders } }) : null;

export const today = () => new Date().toLocaleDateString('en-CA');
export const money = value => new Intl.NumberFormat('ar-EG-u-nu-latn', { maximumFractionDigits: 2 }).format(Number(value || 0));
export const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));

export function getProfile() { try { return JSON.parse(sessionStorage.getItem('ctrl_profile')); } catch { return null; } }
export function toast(message, type = 'success') {
  const root = document.getElementById('toast-container'); if (!root) return;
  const el = document.createElement('div'); el.className = `toast ${type}`; el.innerHTML = `<b>${type === 'success' ? '✓' : type === 'error' ? '!' : 'i'}</b><span>${escapeHtml(message)}</span>`;
  root.append(el); setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, 3000);
}
export function confirmDialog(title, message, options = {}) {
  const {
    confirmText = 'تأكيد',
    cancelText = 'رجوع',
    tone = 'primary',
    icon = '!',
  } = options;
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-backdrop confirm-backdrop">
      <div class="modal small confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <button class="modal-x" type="button" data-cancel aria-label="إغلاق">×</button>
        <div class="confirm-icon ${escapeHtml(tone)}">${escapeHtml(icon)}</div>
        <h3 id="confirm-title">${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" data-cancel>${escapeHtml(cancelText)}</button>
          <button class="btn ${tone === 'danger' ? 'danger' : tone === 'gold' ? 'gold' : 'primary'}" type="button" data-confirm>${escapeHtml(confirmText)}</button>
        </div>
      </div>
    </div>`;
    const done = value => {
      document.removeEventListener('keydown', onKeydown);
      root.innerHTML = '';
      resolve(value);
    };
    const onKeydown = event => {
      if (event.key === 'Escape') done(false);
      if (event.key === 'Enter') done(true);
    };
    document.addEventListener('keydown', onKeydown);
    root.querySelectorAll('[data-cancel]').forEach(button => button.onclick = () => done(false));
    root.querySelector('[data-confirm]').onclick = () => done(true);
    root.querySelector('[data-confirm]').focus();
  });
}
