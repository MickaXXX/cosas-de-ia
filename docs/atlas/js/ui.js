/* Piezas de interfaz compartidas: tooltip, modal, toast, "¿De dónde sale este número?",
 * delegación de clics por data-action y apertura de issues de GitHub ya rellenados. */
import { esc } from './format.js';
import { REPO, actions } from './core.js';

const $ = (sel, root = document) => root.querySelector(sel);
export { $ };
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ tooltip
const tip = () => $('#tooltip');
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  const t = tip();
  t.textContent = el.getAttribute('data-tip');
  t.hidden = false;
});
document.addEventListener('mousemove', (e) => {
  const t = tip();
  if (t.hidden) return;
  if (!e.target.closest('[data-tip]')) { t.hidden = true; return; }
  const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + w > innerWidth - 8) x = e.clientX - w - pad;
  if (y + h > innerHeight - 8) y = e.clientY - h - pad;
  t.style.left = `${x}px`; t.style.top = `${y}px`;
});
document.addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]') && !e.relatedTarget?.closest?.('[data-tip]')) tip().hidden = true; });
document.addEventListener('focusin', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  const t = tip(), r = el.getBoundingClientRect();
  t.textContent = el.getAttribute('data-tip'); t.hidden = false;
  t.style.left = `${Math.min(r.left, innerWidth - 330)}px`; t.style.top = `${r.bottom + 6}px`;
});
document.addEventListener('focusout', () => { tip().hidden = true; });

// ------------------------------------------------------------------ toast
let toastTimer = null;
export function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------------ modal
export function openModal(html, { onClose } = {}) {
  const m = $('#modal'), b = $('#modalBack');
  m.innerHTML = `<button class="btn ghost sm close" data-action="modal-close" aria-label="Cerrar">✕</button>${html}`;
  m.hidden = false; b.hidden = false;
  m._onClose = onClose;
  setTimeout(() => (m.querySelector('input,select,textarea,button:not(.close)') || m).focus(), 20);
  return m;
}
export function closeModal() {
  const m = $('#modal');
  if (m.hidden) return;
  m.hidden = true; $('#modalBack').hidden = true;
  m._onClose?.();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); actions.onEscape?.(); } });

// ------------------------------------------------------------------ ¿De dónde sale este número?
/** Registro de explicaciones: cada número relevante guarda fuente, fecha, fórmula y confianza. */
const WHY = new Map();
let whySeq = 0;
export function why(info) {
  const id = `w${++whySeq}`;
  WHY.set(id, info);
  if (WHY.size > 4000) WHY.delete(WHY.keys().next().value);
  return `<button class="why" data-action="why" data-why="${id}" title="¿De dónde sale este número?" aria-label="¿De dónde sale este número?">?</button>`;
}
export function showWhy(id) {
  const w = WHY.get(id);
  if (!w) return;
  const conf = w.confidence ? `<span class="chip ${({ alta: 'good', media: 'warn', baja: 'serious', nula: 'crit', usuario: 'info', supuesto: 'serious' })[w.confidence] || ''}">Confianza: ${esc(w.confidence)}</span>` : '';
  openModal(`<h3>¿De dónde sale este número?</h3>
    <p><b>${esc(w.title || '')}</b>${w.value ? ` = ${esc(w.value)}` : ''}</p>
    ${w.formula ? `<div class="formula">${esc(w.formula)}</div>` : ''}
    <div class="stack" style="margin-top:10px">
      ${w.source ? `<div><b>Fuente:</b> ${w.url ? `<a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.source)}</a>` : esc(w.source)}</div>` : ''}
      ${w.date ? `<div><b>Fecha del dato:</b> ${esc(w.date)}</div>` : ''}
      ${w.notes ? `<div class="note ${w.warn ? 'warn' : ''}">${esc(w.notes)}</div>` : ''}
      <div>${conf}</div>
    </div>`);
}

// ------------------------------------------------------------------ delegación de acciones
const handlers = {};
export function handle(name, fn) { handlers[name] = fn; }
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = handlers[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  handlers[el.dataset.change]?.(el, e);
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (!el) return;
  handlers[el.dataset.input]?.(el, e);
});
handle('modal-close', closeModal);
handle('why', (el) => showWhy(el.dataset.why));
document.addEventListener('click', (e) => { if (e.target.id === 'modalBack') closeModal(); });

// ------------------------------------------------------------------ GitHub
/** Abre un issue de GitHub ya rellenado (mismo patrón que la app de mercado del repo):
 *  sin credenciales en el navegador; el workflow verifica que el autor sea el dueño. */
export function openIssue(title, body) {
  const base = `https://github.com/${REPO.owner}/${REPO.name}/issues/new`;
  const url = `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  if (url.length > 7800) {
    copyText(body);
    window.open(`${base}?title=${encodeURIComponent(title)}`, '_blank', 'noopener');
    toast('El contenido es largo: quedó copiado. Pégalo en el cuerpo del issue y pulsa “Submit new issue”.', 6000);
    return;
  }
  window.open(url, '_blank', 'noopener');
  toast('Revisa y pulsa “Submit new issue”: el repositorio aplica el cambio y comenta el resultado.', 5000);
}

export function copyText(text) {
  try { navigator.clipboard.writeText(text); } catch { /* sin portapapeles */ }
}

export function download(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\n');
}

/** Excel abre bien una tabla HTML con extensión .xls (sin dependencias). */
export function toExcelHTML(sheets) {
  const tables = sheets.map(({ name, rows }) => {
    if (!rows.length) return `<h3>${esc(name)}</h3><p>Sin datos</p>`;
    const cols = Object.keys(rows[0]);
    return `<h3>${esc(name)}</h3><table border="1"><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}</table>`;
  }).join('<br>');
  return `<html><head><meta charset="utf-8"></head><body>${tables}</body></html>`;
}
