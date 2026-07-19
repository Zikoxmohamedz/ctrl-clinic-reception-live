const saved = localStorage.getItem('ctrl_theme');
const preferred = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
function apply(theme){ document.documentElement.dataset.theme = theme; document.querySelectorAll('#theme-toggle').forEach(b => b.textContent = theme === 'dark' ? '☀' : '☾'); }
apply(saved || preferred);
document.addEventListener('click', e => { if (e.target.closest('#theme-toggle')) { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('ctrl_theme', next); apply(next); } });
