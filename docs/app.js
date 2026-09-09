/* Market Intelligence AI — app móvil (vanilla JS, sin dependencias)
 * Datos: docs/data/latest.json (diario) + history.json + quotes.json (intradía, cada hora).
 * Estado local: localStorage (cartera, favoritos, bitácora, claves opcionales). Sin servidores.
 */
'use strict';

const APP_VERSION = '1.5.1';
const REPO = { owner: 'MickaXXX', name: 'cosas-de-ia', workflow: 'update-data.yml', quotesWorkflow: 'quotes.yml', branch: 'main' };
const DATA_URL = './data/latest.json';
const HIST_URL = './data/history.json';
const QUOTES_URL = './data/quotes.json';
const PUB_URL = './data/portfolios.json';
const DESKS_URL = './data/desks.json';

const LS = { book: 'mia.book.v1', portfolio: 'mia.portfolio.v1', cache: 'mia.cache.v1', settings: 'mia.settings.v1' };
const SIG_ORDER = ['strong_sell', 'sell', 'hold', 'buy', 'strong_buy'];
const SIG_LABEL = { strong_buy: 'Compra fuerte', buy: 'Compra', hold: 'Mantener', sell: 'Venta', strong_sell: 'Venta fuerte', neutral: 'Neutral' };
const SIG_ICON = { strong_buy: '🟢', buy: '🟢', hold: '⚪', sell: '🔴', strong_sell: '🔴', neutral: '⚪' };
const SIG_CLASS = { strong_buy: 'sb', buy: 'b', hold: 'h', sell: 's', strong_sell: 'ss', neutral: 'h' };
const HZ = { short: 'Corto (1d–1m)', medium: 'Mediano (1–12m)', long: 'Largo (1–5a)' };
const PART_LABEL = {
  trend: 'Tendencia', momentum: 'Momentum', macd: 'MACD', volume: 'Volumen', bollinger: 'Bollinger',
  analysts: 'Analistas', upside: 'Potencial objetivo', revisions: 'Revisiones EPS', growth: 'Crecimiento', valuation: 'Valoración',
  profitability: 'Rentabilidad', balance: 'Deuda', cashflow: 'Flujo de caja',
};
const RADAR_PAGE = 120;

// ----------------------------------------------------------------------------
// Estado
// ----------------------------------------------------------------------------
const S = {
  data: null, history: {}, quotes: null, live: {}, liveAt: null, tab: 'cartera', detail: null,
  radar: { horizon: 'score', signal: 'all', type: 'all', q: '', fav: false, guru: false, limit: RADAR_PAGE },
  book: loadBook(),
  settings: loadJSON(LS.settings, { showClp: true, finnhubKey: '', aiKey: '', aiModel: 'claude-opus-5' }),
  pub: [], pubAt: null, desks: null, ocr: null, chat: loadChat(), chatBusy: false, carteraView: 'posiciones', radarView: 'lista',
};

/** Carteras: una activa, varias guardadas. Las ajenas llegan por enlace y son de solo lectura. */
function loadBook() {
  const b = loadJSON(LS.book, null);
  if (b && Array.isArray(b.list) && b.list.length) return b;
  const old = loadJSON(LS.portfolio, null);           // migración desde la versión anterior
  const first = { id: old ? 'mia' : 'd' + Math.random().toString(36).slice(2, 8), name: 'Mi cartera', ro: false, tx: old?.tx || [], fav: old?.fav || [] };
  return { active: first.id, list: [first], log: old?.log || [], pending: old?.pending || [] };
}
/** Carteras visibles: las de este dispositivo, más las publicadas que no tengan
 *  ya una copia local (si la tienes, la local manda y se marca como publicada). */
function allPortfolios() {
  const conDatos = new Set(S.book.list.filter((p) => p.tx.length).map((p) => p.id));
  const ajenas = S.pub.filter((p) => !conDatos.has(p.baseId)).map((p) => ({ ...p, pub: true, ro: true }));
  return [...S.book.list, ...ajenas];
}
const PF = () => allPortfolios().find((p) => p.id === S.book.active) || S.book.list[0];
const isRO = () => !!PF().ro;
const pubOf = (id) => S.pub.find((p) => p.baseId === id || p.id === id);
const isPub = (id) => !!pubOf(id ?? S.book.active);

function loadJSON(k, d) { try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('No se pudo guardar (almacenamiento lleno)'); } }
function savePf() { pruneLocal(); saveJSON(LS.book, S.book); }
function saveSettings() { saveJSON(LS.settings, S.settings); }
/** v1.4.2: la app ya no usa token de GitHub. Se borra el que hubiera guardado. */
(function limpiarCredencialesViejas() {
  if (S.settings.ghToken === undefined) return;
  delete S.settings.ghToken;
  saveSettings();
})();

/** Auto-gestión de almacenamiento local: límites suaves para no saturar el teléfono. */
function pruneLocal() {
  if (!Array.isArray(S.book.log)) S.book.log = [];
  if (!Array.isArray(S.book.pending)) S.book.pending = [];
  if (S.book.log.length > 200) S.book.log = S.book.log.slice(-200);
  if (S.book.pending.length > 100) S.book.pending = S.book.pending.slice(-100);
  for (const p of S.book.list) {
    if (!Array.isArray(p.tx)) p.tx = [];
    if (!Array.isArray(p.fav)) p.fav = [];
    if (p.tx.length > 2000) p.tx = p.tx.slice(-2000);
  }
  if (S.book.list.length > 12) S.book.list = S.book.list.slice(0, 12);
}

// ----------------------------------------------------------------------------
// Utilidades
// ----------------------------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtUSD = (v, d = 2) => v == null || isNaN(v) ? '—' : (v < 0 ? '−' : '') + new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'USD', maximumFractionDigits: d, minimumFractionDigits: d }).format(Math.abs(v));
const fmtCLP = (v) => v == null || isNaN(v) ? '—' : (v < 0 ? '−' : '') + new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(Math.abs(v));
const fmtN = (v, d = 1) => v == null || isNaN(v) ? '—' : new Intl.NumberFormat('es-CL', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);
const fmtQ = (v) => v == null ? '—' : fmtN(v, 4).replace(/([,.]\d*?)0+$/, '$1').replace(/[,.]$/, '');
const pct = (v, d = 1, sign = true) => v == null || isNaN(v) ? '—' : `${sign && v > 0 ? '+' : ''}${fmtN(v, d)}%`;
const cls = (v) => v == null || isNaN(v) ? '' : v >= 0 ? 'up' : 'down';
const big = (v) => v == null ? '—' : v >= 1e12 ? `${fmtN(v / 1e12, 2)} T` : v >= 1e9 ? `${fmtN(v / 1e9, 1)} B` : v >= 1e6 ? `${fmtN(v / 1e6, 0)} M` : fmtN(v, 0);
const today = () => new Date().toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sigClass = (sig) => SIG_CLASS[sig] || 'h';
const scoreSig = (s) => s == null ? 'hold' : s >= 78 ? 'strong_buy' : s >= 62 ? 'buy' : s >= 42 ? 'hold' : s >= 28 ? 'sell' : 'strong_sell';
const tk = (sym) => S.data?.tickers.find((t) => t.sym === sym);
const usdclp = () => S.data?.market?.['CLP=X']?.price || null;
const held = () => new Set(positions().open.map((p) => p.sym));

function chip(sig, extra = '') { return `<span class="chip ${esc(sig)} ${extra}">${SIG_ICON[sig] || ''} ${esc(SIG_LABEL[sig] || sig)}</span>`; }
function scoreBar(v, label, sig) {
  const c = sigClass(sig || scoreSig(v));
  return `<span class="lbl">${esc(label)}</span><div class="bar"><i class="c-${c}" style="width:${v ?? 0}%"></i></div><span class="val t-${c}">${v ?? '—'}</span>`;
}
function relTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 6e4);
  if (m < 2) return 'hace un momento';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}
function fmtStamp(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2400);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado al portapapeles'); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copiado'); }
}

// ----------------------------------------------------------------------------
// Gráficos SVG (sin librerías)
// ----------------------------------------------------------------------------
function spark(values, { big: isBig = false, color } = {}) {
  if (!values || values.length < 2) return '';
  const w = 200, h = isBig ? 120 : 36, pad = 2;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (w - 2 * pad), pad + (1 - (v - min) / span) * (h - 2 * pad)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const col = color || (values[values.length - 1] >= values[0] ? 'var(--up)' : 'var(--down)');
  const last = pts[pts.length - 1];
  return `<svg class="spark ${isBig ? 'big' : ''}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d} L${last[0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z" fill="${col}" opacity=".12"/>
    <path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
function donut(parts) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const R = 50, r = 32, cx = 60, cy = 60;
  let a0 = -Math.PI / 2, paths = '';
  for (const p of parts) {
    const a1 = a0 + (p.value / total) * Math.PI * 2 - 1e-6;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0), x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
    const xi0 = cx + r * Math.cos(a1), yi0 = cy + r * Math.sin(a1), xi1 = cx + r * Math.cos(a0), yi1 = cy + r * Math.sin(a0);
    paths += `<path d="M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${xi0},${yi0} A${r},${r} 0 ${large} 0 ${xi1},${yi1} Z" fill="${p.color}" stroke="var(--surface)" stroke-width="2"/>`;
    a0 = a1;
  }
  return `<svg viewBox="0 0 120 120" aria-hidden="true">${paths}</svg>`;
}
const CAT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#7c8392'];

// ----------------------------------------------------------------------------
// Carga de datos (diario + intradía + en vivo)
// ----------------------------------------------------------------------------
async function fetchJSON(url, force) {
  const r = await fetch(url + (force ? `?t=${Date.now()}` : ''), { cache: force ? 'reload' : 'default' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function loadData(force = false) {
  const btn = $('#btnRefresh'); btn.classList.add('spin');
  try {
    const [d, h, q, pub, desks] = await Promise.all([
      fetchJSON(DATA_URL, force),
      fetchJSON(HIST_URL, force).catch(() => ({})),
      fetchJSON(QUOTES_URL, force).catch(() => null),
      fetchJSON(PUB_URL, true).catch(() => null),
      fetchJSON(DESKS_URL, force).catch(() => null),
    ]);
    S.data = d; S.history = h || {}; S.quotes = q; S.desks = desks;
    S.pub = (pub?.list || []).map((p) => ({
      ...p, baseId: p.id, id: 'pub:' + p.id, fav: p.fav || [],
      tx: (p.tx || []).map((t, i) => ({ ...t, id: t.id || `${p.id}-${i}`, type: t.type || 'buy', date: t.date || today() })),
    }));
    S.pubAt = pub?.updated || null;
    if (S.book.active && !allPortfolios().some((p) => p.id === S.book.active)) S.book.active = S.book.list[0].id;
    // Si en este dispositivo no hay nada cargado, se abre directamente la cartera publicada.
    if (!PF().tx.length && !PF().pub) { const pub = allPortfolios().find((p) => p.pub && p.tx.length); if (pub) S.book.active = pub.id; }
    syncHeader();
    applyQuotes();
    try { localStorage.setItem(LS.cache, JSON.stringify({ d, h, q, desks })); } catch { /* caché opcional (puede no caber) */ }
  } catch (e) {
    const c = loadJSON(LS.cache, null);
    if (c && c.d) { S.data = c.d; S.history = c.h || {}; S.quotes = c.q || null; S.desks = c.desks || null; applyQuotes(); toast('Sin conexión: mostrando datos guardados'); }
  } finally { btn.classList.remove('spin'); }
  renderStatus(); render();
  refreshLive();
}

/** Fusiona cotizaciones intradía (quotes.json) sobre el snapshot diario. */
function applyQuotes() {
  if (!S.data || !S.quotes?.q) return;
  const qAt = new Date(S.quotes.generated_at).getTime(), dAt = new Date(S.data.generated_at).getTime();
  if (!(qAt > dAt)) return; // el snapshot diario es más nuevo
  for (const t of S.data.tickers) {
    const q = S.quotes.q[t.sym];
    if (q && q.p) { t.price = q.p; if (q.c != null) t.chg1d = q.c; t.src = 'intradia'; }
  }
  for (const [sym, m] of Object.entries(S.data.market || {})) {
    const q = S.quotes.q[sym];
    if (q && q.p) { m.price = q.p; if (q.c != null) m.chg1d = q.c; }
  }
}

/** Precios en vivo (opcional) vía Finnhub para posiciones + activo abierto. */
async function refreshLive(symbols) {
  const key = (S.settings.finnhubKey || '').trim();
  if (!key || !S.data) return;
  const syms = symbols || [...new Set([...positions().open.map((p) => p.sym), S.detail].filter(Boolean))].slice(0, 40);
  if (!syms.length) return;
  let changed = 0;
  await Promise.all(syms.map(async (sym) => {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`);
      if (!r.ok) return;
      const j = await r.json();
      if (!j || !j.c) return;
      const t = tk(sym);
      if (t) { t.price = j.c; t.chg1d = j.dp ?? t.chg1d; t.src = 'vivo'; changed++; }
      S.live[sym] = { p: j.c, dp: j.dp, t: j.t };
    } catch { /* red */ }
  }));
  if (changed) { S.liveAt = new Date().toISOString(); render({ keepScroll: true }); if (S.detail && !$('#page').hidden) openDetail(S.detail, true); }
}
setInterval(() => { if (document.visibilityState === 'visible') refreshLive(); }, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.data && Date.now() - loadData.at > 10 * 60e3) loadData(true); });

/** Botón "Actualizar mercado": recarga lo último publicado. Las actualizaciones
 *  corren solas en GitHub: precios cada hora en sesión, noticias cada 3 h y el
 *  análisis completo al cierre. */
async function updateMarket() {
  toast('Recargando…');
  const before = (S.quotes?.generated_at || '') + (S.data?.generated_at || '');
  await loadData(true);
  const after = (S.quotes?.generated_at || '') + (S.data?.generated_at || '');
  toast(after !== before ? 'Datos nuevos cargados' : `Ya tienes lo último. ${nextRefreshText()}`);
}
/** Cuándo llega la próxima actualización automática (hora de Chile aproximada). */
function nextRefreshText() {
  const now = new Date();
  const utcH = now.getUTCHours(), dow = now.getUTCDay();
  const weekday = dow >= 1 && dow <= 5;
  if (weekday && utcH >= 13 && utcH < 21) return 'Próximos precios en menos de 1 hora.';
  if (weekday && utcH < 13) return 'Los precios se mueven desde la apertura (10:30 Chile).';
  return 'Próximo análisis completo al cierre de Wall Street de mañana.';
}

function renderStatus() {
  const st = $('#dataStatus'), b = $('#banner');
  loadData.at = Date.now();
  if (!S.data) { st.textContent = 'Sin datos. Ejecuta el workflow "Actualizar datos".'; b.hidden = false; b.className = 'banner error'; b.textContent = 'No se encontraron datos (docs/data/latest.json). Ejecuta el workflow de GitHub Actions o el script update_data.py.'; return; }
  const age = Math.round((Date.now() - new Date(S.data.generated_at).getTime()) / 36e5);
  st.textContent = `Análisis ${S.data.date} · ${S.data.stats?.ok ?? S.data.tickers.length} activos · v${APP_VERSION}`;
  if (S.data.demo) { b.hidden = false; b.className = 'banner'; b.innerHTML = '⚠️ <b>Datos de demostración (sintéticos)</b>. Activa el workflow de GitHub Actions para cargar datos reales de Yahoo Finance. Ver Ajustes.'; }
  else if (age > 96) { b.hidden = false; b.className = 'banner info'; b.textContent = `El análisis tiene ${Math.round(age / 24)} días. Revisa que el workflow diario esté activo.`; }
  else b.hidden = true;
}

function updateStamp() {
  const parts = [`Análisis: ${fmtStamp(S.data.generated_at)}`];
  if (S.quotes?.generated_at && new Date(S.quotes.generated_at) > new Date(S.data.generated_at)) parts.push(`Precios: ${fmtStamp(S.quotes.generated_at)} (${relTime(S.quotes.generated_at)})`);
  if (S.liveAt) parts.push(`En vivo: ${relTime(S.liveAt)}`);
  return parts.join(' · ');
}

// ----------------------------------------------------------------------------
// Cartera: posiciones a partir de transacciones
// ----------------------------------------------------------------------------
const positions = () => positionsOf(PF());

function positionsOf(pf) {
  const pos = {};
  const txs = [...(pf.tx || [])].sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
  for (const t of txs) {
    const p = pos[t.sym] || (pos[t.sym] = { sym: t.sym, qty: 0, cost: 0, realized: 0, txs: [], fixedValue: null });
    p.txs.push(t);
    if (t.type === 'buy') {
      if (t.qty > 0 && t.price > 0) { p.cost += t.qty * t.price; p.qty += t.qty; }
      else if (t.amount > 0) { p.cost += t.amount; p.fixedValue = (p.fixedValue || 0) + (t.snapValue ?? t.amount); } // importado sin precio conocido
    } else {
      const avg = p.qty > 0 ? p.cost / p.qty : t.price; const q = Math.min(t.qty, p.qty);
      p.realized += q * (t.price - avg); p.cost -= q * avg; p.qty -= q;
    }
  }
  const list = Object.values(pos).map((p) => {
    const d = tk(p.sym);
    const price = d?.price ?? null;
    p.avg = p.qty > 0 ? p.cost / p.qty : 0;
    p.value = p.qty > 0 && price != null ? p.qty * price : (p.fixedValue != null ? p.fixedValue : null);
    p.pnl = p.value != null ? p.value - p.cost : null;
    p.pnlPct = p.pnl != null && p.cost > 0 ? (p.pnl / p.cost) * 100 : null;
    p.data = d;
    p.open = p.qty > 1e-9 || (p.fixedValue != null && p.cost > 0);
    return p;
  });
  return { open: list.filter((p) => p.open), closed: list.filter((p) => !p.open) };
}

// ----------------------------------------------------------------------------
// Render principal
// ----------------------------------------------------------------------------
function render(opts = {}) {
  const v = $('#view');
  if (!S.data) { v.innerHTML = `<div class="empty"><div class="big">📡</div>Aún no hay datos.<br>Ejecuta <b>Actions → Actualizar datos de mercado → Run workflow</b> en GitHub.</div>`; return; }
  const y = window.scrollY;
  const views = { cartera: viewCartera, radar: viewRadar, hoy: viewHoy, ia: viewIA, ajustes: viewAjustes };
  v.innerHTML = views[S.tab]();
  if (opts.keepScroll) window.scrollTo({ top: y }); else window.scrollTo({ top: 0 });
}

// ---- CARTERA ----------------------------------------------------------------
function viewCartera() {
  const { open, closed } = positions();
  const clp = usdclp();
  const total = open.reduce((a, p) => a + (p.value || 0), 0);
  const cost = open.reduce((a, p) => a + p.cost, 0);
  const pnl = total - cost;
  const realized = [...open, ...closed].reduce((a, p) => a + p.realized, 0);
  const dayChg = open.reduce((a, p) => a + (p.value != null && p.data?.chg1d != null && p.qty > 0 ? p.value * (p.data.chg1d / 100) / (1 + p.data.chg1d / 100) : 0), 0);
  const wScore = total > 0 ? open.reduce((a, p) => a + (p.value || 0) * (p.data?.score ?? 50), 0) / total : null;
  const pfSig = wScore == null ? null : scoreSig(wScore);
  const liveOn = !!(S.settings.finnhubKey || '').trim();

  let html = `<div class="card stamp"><div class="between"><div class="small"><b>Actualizado</b><div class="tiny muted">${esc(updateStamp())}</div>
      <div class="tiny muted">${liveOn ? '🟢 precios en vivo activos' : 'Precios: cierre diario + intradía cada hora'}</div></div>
      <button class="btn sm" data-action="updateMarket">⟳ Actualizar mercado</button></div></div>`;

  if (isRO()) html += `<div class="ro-banner">👁️ Estás viendo <b>${esc(PF().name)}</b> en solo lectura${PF().pub ? ', publicada en este enlace' : ', compartida contigo'}.
    ${PF().pub ? 'Se actualiza sola desde el enlace. Si editas algo, se copia a este dispositivo automáticamente.' : ''}
    <button class="btn secondary sm" style="margin-top:6px" data-action="pfDuplicate">Duplicar como mía</button></div>`;

  // Compras que el radar todavía no analiza: se agregan al radar con un toque.
  const faltan = missingFromRadar();
  if (faltan.length && !isRO()) html += `<div class="card" style="border-color:var(--s)">
      <div class="between"><b>🎯 ${faltan.length === 1 ? 'Una acción tuya no está' : `${faltan.length} acciones tuyas no están`} en el radar</b></div>
      <div class="chips wrap" style="margin:6px 0">${faltan.map((x) => `<span class="chip gray">${esc(x)}</span>`).join('')}</div>
      <p class="small muted">Sin ficha en el radar no tienen señal, ni objetivo de analistas, ni aparecen en las mesas. Agrégalas y el propio sitio las analiza en unos minutos.</p>
      <button class="btn" data-action="syncRadar">➕ Agregar al radar</button>
      <p class="tiny muted">Se abre GitHub con tu cartera ya escrita: pulsa "Submit new issue" y listo. Además queda publicada, así la ves igual en el teléfono y en el computador.</p></div>`;

  html += `<div class="seg" data-seg2="carteraView">${[['posiciones', 'Posiciones'], ['rendimiento', 'Rendimiento'], ['objetivos', 'Objetivos']]
    .map(([k, l]) => `<button data-action="carteraView" data-v="${k}" class="${S.carteraView === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  if (open.length && S.carteraView === 'rendimiento') return html + viewRendimiento();
  if (open.length && S.carteraView === 'objetivos') return html + viewObjetivos();

  if (!open.length) {
    html += `<div class="empty"><div class="big">💼</div><b>${esc(PF().name)}</b> está vacía en este dispositivo.<br>
      <span class="small">Tus posiciones se guardan en el navegador donde las cargaste. Publica una cartera para verla igual en el teléfono y en el computador.</span></div>`;
    const ajenas = S.pub.filter((p) => !S.book.list.some((l) => l.id === p.baseId && l.tx.length));
    if (ajenas.length) html += `<div class="card"><h3 style="margin-top:0">🔗 Publicadas en este enlace</h3>
      ${ajenas.map((p) => { const { open: o } = positionsOf(p); return `<div class="pf-row" data-action="pfSwitch" data-id="${p.id}"><span class="dot"></span>
        <div class="grow"><b>${esc(p.name)}</b><div class="tiny muted">${o.length} posiciones · ${fmtUSD(o.reduce((a, x) => a + (x.value || 0), 0))}</div></div>
        <span class="chip gray sm">Ver</span></div>`; }).join('')}</div>`;
    html += `<button class="btn" data-action="ocr">📷 Cargar capturas de Racional</button>
      <button class="btn secondary" style="margin-top:8px" data-action="addTx">＋ Agregar posición a mano</button>
      <button class="btn secondary" style="margin-top:8px" data-action="book">📂 Ver mis carteras</button>`;
  } else {
    html += `<div class="card">
      <div class="between"><div><div class="muted small">Valor de la cartera</div><div class="hero mono">${fmtUSD(total)}</div>
        ${clp && S.settings.showClp ? `<div class="muted small mono">≈ ${fmtCLP(total * clp)} · USD/CLP ${fmtN(clp, 0)}</div>` : ''}</div>
        <div class="center">${pfSig ? chip(pfSig) : ''}<div class="tiny muted" style="margin-top:4px">Señal ponderada ${wScore != null ? Math.round(wScore) : '—'}/100</div></div></div>
      <div class="grid3" style="margin-top:10px">
        <div class="stat"><div class="k">Ganancia abierta</div><div class="v mono ${cls(pnl)}">${pct(cost ? (pnl / cost) * 100 : null)}</div><div class="tiny muted mono">${fmtUSD(pnl)}</div></div>
        <div class="stat"><div class="k">Hoy</div><div class="v mono ${cls(dayChg)}">${fmtUSD(dayChg)}</div><div class="tiny muted mono">${pct(total ? (dayChg / (total - dayChg)) * 100 : null)}</div></div>
        <div class="stat"><div class="k">Realizada</div><div class="v mono ${cls(realized)}">${fmtUSD(realized)}</div><div class="tiny muted">ventas cerradas</div></div>
      </div>
    </div>`;

    const alerts = portfolioAlerts(open);
    if (alerts.length) {
      html += `<h2>🚨 Alertas <small>${alerts.length}</small></h2>`;
      for (const a of alerts) html += `<div class="card tap alert ${a.good ? 'good' : ''}" data-action="detail" data-sym="${a.sym}"><div class="between"><b>${a.sym}</b>${a.chip || ''}</div><div class="small" style="margin-top:4px">${a.text}</div></div>`;
    }

    html += `<h2>Posiciones <small>${open.length}</small></h2><div class="card list">`;
    for (const p of open.sort((a, b) => (b.value || 0) - (a.value || 0))) {
      const d = p.data;
      html += `<div class="item" data-action="detail" data-sym="${p.sym}">
        <div class="grow"><div class="row"><span class="sym">${p.sym}</span>${d ? chip(d.signal, 'sm') : '<span class="tag">fuera del radar</span>'}${d?.src === 'vivo' ? '<span class="tag live">vivo</span>' : ''}</div>
          <div class="name mono">${p.qty > 0 ? `${fmtQ(p.qty)} × ${fmtUSD(p.avg)}` : `inversión ${fmtUSD(p.cost)}`} · ${total ? fmtN((p.value || 0) / total * 100, 0) : 0}%</div>
          ${d ? `<div class="mini-scores"><b>C ${d.h.short.s ?? '—'}</b><b>M ${d.h.medium.s ?? '—'}</b><b>L ${d.h.long.s ?? '—'}</b><b>${d.risk.label}</b></div>` : ''}</div>
        <div><div class="price mono">${fmtUSD(p.value)}</div><div class="small mono ${cls(p.pnl)}" style="text-align:right">${pct(p.pnlPct)} · ${fmtUSD(p.pnl, 0)}</div>
          <div class="tiny muted mono" style="text-align:right">${d ? fmtUSD(d.price) + ' ' + pct(d.chg1d) : ''}</div></div>
      </div>`;
    }
    html += `</div><div class="btn-row"><button class="btn green" data-action="addTx" data-type="buy">＋ Compra</button><button class="btn danger" data-action="addTx" data-type="sell">－ Venta</button></div>
      <button class="btn secondary" data-action="ocr">📷 Actualizar desde capturas de Racional</button>`;

    const bySym = open.map((p) => ({ label: p.sym, value: p.value || 0 }));
    const parts = foldOthers(bySym);
    const bySec = {};
    for (const p of open) { const s = p.data?.sector || 'Otro'; bySec[s] = (bySec[s] || 0) + (p.value || 0); }
    const secParts = foldOthers(Object.entries(bySec).map(([label, value]) => ({ label, value })));
    const sigCount = {};
    for (const p of open) { const s = p.data?.signal || 'hold'; sigCount[s] = (sigCount[s] || 0) + (p.value || 0); }
    html += `<h2>Distribución</h2><div class="card"><div class="donut-wrap">${donut(parts)}<div class="legend" style="flex-direction:column;gap:4px">${parts.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)} <b>${fmtN(p.value / total * 100, 0)}%</b></span>`).join('')}</div></div>
      <h3>Por sector</h3>${stackBar(secParts, total)}
      <h3>Por señal del modelo</h3>${stackBar(SIG_ORDER.slice().reverse().filter((s) => sigCount[s]).map((s) => ({ label: SIG_LABEL[s], value: sigCount[s], color: `var(--${SIG_CLASS[s]})` })), total)}
      ${concentrationNote(parts, total)}</div>`;
  }

  const evald = PF().tx.filter((t) => tk(t.sym) && t.price > 0 && t.src !== 'ocr').slice(-8).reverse();
  if (evald.length) {
    html += `<h2>Mis decisiones vs. el modelo</h2><div class="card list">`;
    for (const t of evald) {
      const d = tk(t.sym); const chg = d?.price != null ? (d.price / t.price - 1) * 100 : null;
      html += `<div class="item" data-action="editTx" data-id="${t.id}"><div class="grow"><b>${t.type === 'buy' ? '🟢 Compra' : '🔴 Venta'} ${t.sym}</b> <span class="muted small">${t.date}</span>
        <div class="small muted">${fmtQ(t.qty)} × ${fmtUSD(t.price)}${t.sig ? ` · modelo decía: ${SIG_LABEL[t.sig]} (${t.score})` : ''}${t.note ? `<br>📝 ${esc(t.note)}` : ''}</div></div>
        <div class="price mono ${cls(t.type === 'buy' ? chg : -chg)}">${pct(chg)}<div class="tiny muted">desde entonces</div></div></div>`;
    }
    html += `</div>`;
  }
  if (closed.length) html += `<p class="small muted center">${closed.length} posición(es) cerrada(s) · ganancia realizada ${fmtUSD(realized)}</p>`;
  return html;
}

function foldOthers(items, max = 7) {
  const sorted = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, max), tail = sorted.slice(max);
  if (tail.length) head.push({ label: 'Otros', value: tail.reduce((a, i) => a + i.value, 0) });
  return head.map((p, i) => ({ ...p, color: p.color || CAT[Math.min(i, CAT.length - 1)] }));
}
function stackBar(parts, total) {
  if (!total) return '';
  return `<div class="stack">${parts.map((p) => `<i style="width:${(p.value / total) * 100}%;background:${p.color}"></i>`).join('')}</div>
    <div class="legend">${parts.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)} ${fmtN((p.value / total) * 100, 0)}%</span>`).join('')}</div>`;
}
function concentrationNote(parts, total) {
  const top = parts[0]; if (!top || !total) return '';
  const w = (top.value / total) * 100;
  if (w >= 40) return `<p class="small" style="color:var(--s)">⚠️ Concentración alta: ${esc(top.label)} pesa ${fmtN(w, 0)}% de la cartera.</p>`;
  return '';
}

function portfolioAlerts(open) {
  const out = [];
  const changes = S.data.changes || [];
  for (const p of open) {
    const d = p.data; if (!d) continue;
    const ch = changes.find((c) => c.sym === p.sym);
    if (ch) out.push({ sym: p.sym, good: ch.dir === 'up', chip: chip(ch.to, 'sm'), text: `Cambio de señal (${ch.since === '1d' ? 'hoy' : 'esta semana'}): ${SIG_LABEL[ch.from]} ${ch.score_from} → <b>${SIG_LABEL[ch.to]} ${ch.score_to}</b>` });
    else if (d.signal === 'sell' || d.signal === 'strong_sell') out.push({ sym: p.sym, chip: chip(d.signal, 'sm'), text: `El modelo indica ${SIG_LABEL[d.signal]} (${d.score}/100). Motivos: ${d.reasons.slice(0, 2).join('; ') || 'ver detalle'}.` });
    if (d.earnings_date) { const days = Math.round((new Date(d.earnings_date) - Date.now()) / 864e5); if (days >= 0 && days <= 10) out.push({ sym: p.sym, good: true, chip: '<span class="tag">resultados</span>', text: `Reporta resultados ${days === 0 ? 'hoy' : `en ${days} días`} (${d.earnings_date}). Espera volatilidad.` }); }
    if (d.tech?.rsi >= 78) out.push({ sym: p.sym, chip: '<span class="tag">RSI</span>', text: `RSI ${d.tech.rsi}: sobrecomprado. Considera tomar ganancias parciales o no aumentar.` });
    if (p.pnlPct != null && p.pnlPct <= -15) out.push({ sym: p.sym, chip: '<span class="tag">−15%</span>', text: `Pérdida de ${pct(p.pnlPct)}. Revisa si la tesis sigue vigente (largo plazo ${d.h.long.s}/100).` });
    const hot = (d.news || []).find((n) => n.nivel === 'alta');
    if (hot) out.push({ sym: p.sym, good: hot.accion === 'oportunidad', chip: `<span class="tag">${esc(hot.tag || 'noticia')}</span>`, text: `📰 ${esc(hot.t_es || hot.t)}${hot.r_es ? `<br><span class="muted">${esc(hot.r_es)}</span>` : ''}` });
  }
  return out.slice(0, 10);
}

// ---- ANALISTAS (estilo Google Finance) ---------------------------------------
/** Anillo de recomendaciones + previsión de 12 meses, como en Google Finance. */
function analystBlock(t, opts = {}) {
  const a = t.analysts;
  if (!a || !(a.count || a.target?.mean)) return '';
  const d = a.dist;
  const buy = d ? d.sb + d.b : null, hold = d ? d.h : null, sell = d ? d.s + d.ss : null;
  const tot = d ? buy + hold + sell : (a.count || 0);
  const parts = d ? [
    { label: 'Compra', value: buy, color: 'var(--sb)' },
    { label: 'Mantenimiento', value: hold, color: 'var(--h)' },
    { label: 'Venta', value: sell, color: 'var(--ss)' },
  ].filter((p) => p.value > 0) : [];
  const veredicto = a.key ? SIG_LABEL[a.key] || a.key : (a.mean != null ? SIG_LABEL[scoreSig(scale5(a.mean))] : '—');
  const ring = parts.length ? `<div class="an-ring">${donut(parts)}<div class="an-legend">
      ${parts.map((p) => `<div><i style="background:${p.color}"></i>${p.label}<b>${p.value}</b></div>`).join('')}
      <div class="an-verdict t-${sigClass(a.key || 'hold')}">${esc(veredicto)}</div></div></div>` : '';
  const tg = a.target || {};
  const bars = tg.mean ? targetBars(t.price, tg) : '';
  const head = opts.head === false ? '' :
    `<div class="between"><h2 style="margin:0">Valoración de analistas</h2>${a.key ? chip(a.key, 'sm') : ''}</div>
     <div class="tiny muted">${a.count || tot} analistas en los últimos 3 meses${a.revisions ? ` · revisiones EPS 30d ${a.revisions.up}↑ ${a.revisions.down}↓` : ''}</div>`;
  return `${head}${ring}${bars}`;
}
const scale5 = (mean) => Math.round(100 - ((mean - 1) / 4) * 100);   // 1 = compra fuerte → 100

/** Barras de precio objetivo a 12 meses con la marca del precio actual. */
function targetBars(price, tg) {
  const vals = [tg.high, tg.mean, tg.low, price].filter((v) => v != null && v > 0);
  if (!vals.length || !price) return '';
  const max = Math.max(...vals) * 1.06;
  const row = (label, v, strong) => v == null ? '' : `<div class="tb-row">
    <span class="tb-l">${label}</span>
    <div class="tb-track"><i class="${strong ? 'strong' : ''}" style="width:${Math.max((v / max) * 100, 14)}%"><b>${fmtUSD(v, v < 100 ? 2 : 0)}</b></i></div>
    <span class="tb-p ${cls(v - price)}">${pct((v / price - 1) * 100, 0)}</span></div>`;
  return `<h3>Previsión de 12 meses</h3><div class="tbars">
    <div class="tb-cur" style="left:calc(76px + (100% - 122px) * ${(price / max).toFixed(4)})"><span>Actual ${fmtUSD(price, price < 100 ? 2 : 0)}</span></div>
    ${row('El más alto', tg.high)}${row('Medio', tg.mean, true)}${row('El más bajo', tg.low)}</div>`;
}

/** Versión compacta para listas: barra de consenso + potencial. */
function analystStrip(t) {
  const a = t.analysts; if (!a || !a.dist) return '';
  const d = a.dist, tot = d.sb + d.b + d.h + d.s + d.ss;
  if (!tot) return '';
  const w = (n) => `${(n / tot) * 100}%`;
  return `<div class="an-strip"><div class="stack" style="height:8px">
      ${d.sb + d.b ? `<i class="c-sb" style="width:${w(d.sb + d.b)}"></i>` : ''}
      ${d.h ? `<i class="c-h" style="width:${w(d.h)}"></i>` : ''}
      ${d.s + d.ss ? `<i class="c-ss" style="width:${w(d.s + d.ss)}"></i>` : ''}</div>
    <div class="tiny muted">${d.sb + d.b} compra · ${d.h} mantener · ${d.s + d.ss} venta${a.upside != null ? ` · objetivo <b class="${cls(a.upside)}">${pct(a.upside, 0)}</b>` : ''}</div></div>`;
}

// ---- RENDIMIENTO DE LA CARTERA ------------------------------------------------
/** Reconstruye el valor diario de la cartera con el historial de precios del radar.
 *  Supone las posiciones actuales constantes: sirve como referencia de comportamiento. */
function equityHistory(pf) {
  const { open } = positionsOf(pf);
  const holds = open.filter((p) => p.qty > 0 && S.history[p.sym]?.length);
  if (!holds.length) return [];
  const maps = holds.map((h) => ({ qty: h.qty, m: new Map((S.history[h.sym] || []).map((r) => [r.d, r.p])) }));
  const dates = [...new Set(holds.flatMap((h) => (S.history[h.sym] || []).map((r) => r.d)))].sort();
  const last = new Array(maps.length).fill(null);
  const out = [];
  for (const d of dates) {
    let val = 0, known = 0;
    maps.forEach((mm, i) => {
      const p = mm.m.get(d); if (p) last[i] = p;
      if (last[i]) { val += mm.qty * last[i]; known++; }
    });
    if (known >= Math.ceil(maps.length * 0.6)) out.push({ d, v: val });
  }
  return out;
}
/** Serie de variación diaria en dólares. */
function dailyPnl(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) out.push({ d: series[i].d, v: series[i].v - series[i - 1].v, pct: series[i - 1].v ? (series[i].v / series[i - 1].v - 1) * 100 : 0 });
  return out;
}
function retOver(series, n) {
  if (series.length < 2) return null;
  const a = series[Math.max(0, series.length - 1 - n)], b = series[series.length - 1];
  return a.v ? (b.v / a.v - 1) * 100 : null;
}

function calendarMonth(pnl, ym) {
  const rows = pnl.filter((x) => x.d.startsWith(ym));
  const byDay = new Map(rows.map((x) => [+x.d.slice(8, 10), x]));
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;                 // semana que empieza en lunes
  const maxAbs = Math.max(1, ...rows.map((x) => Math.abs(x.v)));
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div class="cal-d empty"></div>';
  for (let day = 1; day <= days; day++) {
    const x = byDay.get(day);
    const alpha = x ? Math.min(0.85, 0.18 + Math.abs(x.v) / maxAbs * 0.67) : 0;
    const bg = x ? `background:color-mix(in srgb, var(--${x.v >= 0 ? 'sb' : 'ss'}) ${Math.round(alpha * 100)}%, transparent)` : '';
    cells += `<div class="cal-d ${x ? 'has' : ''}" style="${bg}"><span class="n">${day}</span>${x ? `<span class="v ${cls(x.v)}">${x.v >= 0 ? '+' : '−'}${fmtN(Math.abs(x.v), Math.abs(x.v) < 10 ? 1 : 0)}</span>` : ''}</div>`;
  }
  const mes = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('es-CL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const tot = rows.reduce((a, x) => a + x.v, 0);
  const ganadores = rows.filter((x) => x.v > 0).length;
  return `<div class="between"><b style="text-transform:capitalize">${mes}</b><span class="mono ${cls(tot)}">${fmtUSD(tot)}</span></div>
    <div class="cal-head">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="cal">${cells}</div>
    <div class="tiny muted">${rows.length} días con datos · ${ganadores} al alza · ${rows.length - ganadores} a la baja</div>`;
}

function viewRendimiento() {
  const pf = PF();
  const series = equityHistory(pf);
  if (series.length < 3) {
    return `<div class="empty"><div class="big">📈</div>Aún no hay historial suficiente.<br>El rendimiento se reconstruye con el historial de precios del radar, que crece cada día.<br><br><span class="tiny">Si acabas de importar tu cartera, vuelve mañana.</span></div>`;
  }
  const pnl = dailyPnl(series);
  const best = pnl.reduce((a, b) => (b.v > (a?.v ?? -Infinity) ? b : a), null);
  const worst = pnl.reduce((a, b) => (b.v < (a?.v ?? Infinity) ? b : a), null);
  const pos = pnl.filter((x) => x.v > 0).length;
  const meses = [...new Set(pnl.map((x) => x.d.slice(0, 7)))].sort().reverse();
  const mesSel = S.calMonth && meses.includes(S.calMonth) ? S.calMonth : meses[0];

  // Semanas ISO recientes
  const semanas = {};
  for (const x of pnl) {
    const dt = new Date(x.d + 'T00:00:00Z');
    const monday = new Date(dt); monday.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    const k = monday.toISOString().slice(0, 10);
    semanas[k] = (semanas[k] || 0) + x.v;
  }
  const semList = Object.entries(semanas).sort().slice(-8);
  const maxSem = Math.max(1, ...semList.map(([, v]) => Math.abs(v)));

  const porMes = {};
  for (const x of pnl) porMes[x.d.slice(0, 7)] = (porMes[x.d.slice(0, 7)] || 0) + x.v;

  let html = `<div class="card"><h2 style="margin-top:0">Evolución del valor <small>${series.length} días</small></h2>
    ${spark(series.map((x) => x.v), { big: true, color: 'var(--accent)' })}
    <div class="between tiny muted mono"><span>${series[0].d} · ${fmtUSD(series[0].v)}</span><span>${series[series.length - 1].d} · ${fmtUSD(series[series.length - 1].v)}</span></div>
    <div class="grid3" style="margin-top:10px">
      ${[['1 semana', retOver(series, 5)], ['2 semanas', retOver(series, 10)], ['30 días', retOver(series, 21)]].map(([k, v]) =>
        `<div class="stat"><div class="k">${k}</div><div class="v mono ${cls(v)}">${pct(v)}</div></div>`).join('')}
    </div></div>

    <div class="card"><h2 style="margin-top:0">Mejores y peores días</h2>
    <div class="grid2">
      <div class="stat"><div class="k">🟢 Mejor día</div><div class="v mono up">${fmtUSD(best.v)}</div><div class="tiny muted">${best.d} · ${pct(best.pct)}</div></div>
      <div class="stat"><div class="k">🔴 Peor día</div><div class="v mono down">${fmtUSD(worst.v)}</div><div class="tiny muted">${worst.d} · ${pct(worst.pct)}</div></div>
    </div>
    <div class="tiny muted" style="margin-top:8px">${pos} de ${pnl.length} días al alza (${fmtN((pos / pnl.length) * 100, 0)}% de acierto diario)</div></div>

    <div class="card"><div class="between"><h2 style="margin:0">Calendario</h2>
      <select id="calMonth" style="width:auto;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-size:13px">
        ${meses.map((m) => `<option value="${m}" ${m === mesSel ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
    ${calendarMonth(pnl, mesSel)}</div>

    <div class="card"><h2 style="margin-top:0">Últimas 8 semanas</h2>
    <div class="wbars">${semList.map(([k, v]) => `<div class="wb"><div class="wb-bar ${v >= 0 ? 'up' : 'down'}" style="height:${Math.max(4, Math.abs(v) / maxSem * 60)}px"></div>
      <div class="tiny mono ${cls(v)}">${v >= 0 ? '+' : '−'}${fmtN(Math.abs(v), 0)}</div><div class="tiny muted">${k.slice(5)}</div></div>`).join('')}</div></div>

    <div class="card"><h2 style="margin-top:0">Por mes</h2><div class="kv">
    ${Object.entries(porMes).sort().reverse().map(([m, v]) => `<div><span>${m}</span><b class="mono ${cls(v)}">${fmtUSD(v)}</b></div>`).join('')}</div></div>

    <p class="tiny muted center">El histórico se reconstruye aplicando tus posiciones actuales a los precios pasados. Sirve para ver comportamiento y tendencia, no como estado de cuenta.</p>`;
  return html;
}

// ---- OBJETIVOS DE PRECIO -----------------------------------------------------
function aggregateTargets(open) {
  let value = 0, mean = 0, high = 0, low = 0, covered = 0, n = 0;
  for (const p of open) {
    const a = p.data?.analysts;
    if (!p.qty || !a?.target?.mean) continue;
    value += p.value || 0; covered += p.value || 0; n++;
    mean += p.qty * a.target.mean;
    high += p.qty * (a.target.high || a.target.mean);
    low += p.qty * (a.target.low || a.target.mean);
  }
  return n ? { value, mean, high, low, n, covered } : null;
}

function viewObjetivos() {
  const { open } = positions();
  const agg = aggregateTargets(open);
  const total = open.reduce((a, p) => a + (p.value || 0), 0);
  let html = '';
  if (!agg) {
    html += `<div class="empty">Ninguna de tus posiciones tiene precio objetivo de analistas todavía.</div>`;
  } else {
    html += `<div class="card"><h2 style="margin-top:0">Potencial de mi cartera <small>a 12 meses</small></h2>
      <div class="tiny muted">Suma de los precios objetivo de ${agg.n} posiciones (${fmtN(agg.covered / total * 100, 0)}% del valor)</div>
      ${targetBars(agg.value, { mean: agg.mean, high: agg.high, low: agg.low })}
      <div class="grid3" style="margin-top:12px">
        <div class="stat"><div class="k">Hoy</div><div class="v mono">${fmtUSD(agg.value, 0)}</div></div>
        <div class="stat"><div class="k">Objetivo medio</div><div class="v mono ${cls(agg.mean - agg.value)}">${fmtUSD(agg.mean, 0)}</div><div class="tiny muted">${pct((agg.mean / agg.value - 1) * 100, 0)}</div></div>
        <div class="stat"><div class="k">Escenario alto</div><div class="v mono up">${fmtUSD(agg.high, 0)}</div><div class="tiny muted">${pct((agg.high / agg.value - 1) * 100, 0)}</div></div>
      </div></div>`;

    const rows = open.filter((p) => p.data?.analysts?.upside != null).sort((a, b) => b.data.analysts.upside - a.data.analysts.upside);
    html += `<h2>Posición por posición</h2><div class="card list">`;
    for (const p of rows) {
      const a = p.data.analysts;
      html += `<div class="item" data-action="detail" data-sym="${p.sym}"><div class="grow">
        <div class="row"><b>${p.sym}</b>${chip(p.data.signal, 'sm')}</div>
        <div class="tiny muted mono">${fmtUSD(p.data.price)} → objetivo ${fmtUSD(a.target.mean)}</div>
        ${analystStrip(p.data)}</div>
        <div class="price mono ${cls(a.upside)}">${pct(a.upside, 0)}<div class="tiny muted">${a.count} analistas</div></div></div>`;
    }
    html += `</div>`;
  }
  html += `<p class="tiny muted center">Los precios objetivo son el consenso de Wall Street a 12 meses, no una promesa. Úsalos como referencia de expectativas.</p>`;
  return html;
}

// ---- RADAR ------------------------------------------------------------------
function viewRadar() {
  const R = S.radar;
  let list = S.data.tickers.slice();
  if (R.type !== 'all') list = list.filter((t) => (R.type === 'etf') === !!t.etf);
  if (R.signal !== 'all') list = list.filter((t) => (R.horizon === 'score' ? t.signal : t.h[R.horizon].sig) === R.signal);
  if (R.fav) { const mine = held(); list = list.filter((t) => PF().fav.includes(t.sym) || mine.has(t.sym)); }
  if (R.guru) list = list.filter((t) => t.gurus && t.gurus.length);
  if (R.q) { const q = R.q.toUpperCase(); list = list.filter((t) => t.sym.includes(q) || (t.name || '').toUpperCase().includes(q)); }
  const key = (t) => (R.horizon === 'score' ? t.score : t.h[R.horizon].s) ?? -1;
  list.sort((a, b) => key(b) - key(a));

  const counts = {};
  for (const t of S.data.tickers) { const s = R.horizon === 'score' ? t.signal : t.h[R.horizon].sig; counts[s] = (counts[s] || 0) + 1; }

  let html = `<input class="search" id="radarQ" placeholder="Buscar entre ${S.data.tickers.length} activos…" value="${esc(R.q)}" autocomplete="off">
    <div class="seg" data-seg="horizon">${[['score', 'Global'], ['short', 'Corto'], ['medium', 'Mediano'], ['long', 'Largo']].map(([k, l]) => `<button data-v="${k}" class="${R.horizon === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="chips" data-seg="signal"><span class="chip ${R.signal === 'all' ? 'on' : ''}" data-v="all">Todas</span>${SIG_ORDER.slice().reverse().map((s) => `<span class="chip ${R.signal === s ? 'on' : ''}" data-v="${s}">${SIG_ICON[s]} ${SIG_LABEL[s]} ${counts[s] || 0}</span>`).join('')}</div>
    <div class="chips" data-seg="type"><span class="chip ${R.type === 'all' ? 'on' : ''}" data-v="all">Todo</span><span class="chip ${R.type === 'stock' ? 'on' : ''}" data-v="stock">Acciones</span><span class="chip ${R.type === 'etf' ? 'on' : ''}" data-v="etf">ETFs</span><span class="chip ${R.fav ? 'on' : ''}" data-v="fav">★ Míos y favoritos</span><span class="chip ${R.guru ? 'on' : ''}" data-v="guru">🏆 Gurús</span></div>`;

  if (R.signal === 'all' && !R.q && !R.fav) {
    html += `<h2>🔥 Top oportunidades <small>${R.horizon === 'score' ? 'global' : HZ[R.horizon]}</small></h2><div class="grid3">`;
    for (const t of list.filter((t) => t.conf !== 'baja' && key(t) >= 62).slice(0, 3)) {
      html += `<div class="card tap" style="margin:0;padding:10px" data-action="detail" data-sym="${t.sym}"><div class="sym">${t.sym}</div><div class="hero mono t-${sigClass(scoreSig(key(t)))}" style="font-size:24px">${key(t)}</div>
        <div class="tiny muted ellipsis">${esc(t.name)}</div>${t.analysts?.upside != null ? `<div class="tiny ${cls(t.analysts.upside)}">obj. ${pct(t.analysts.upside, 0)}</div>` : ''}</div>`;
    }
    html += `</div>`;
  }

  html += `<div class="seg" style="margin-top:6px">${[['lista', '📋 Lista'], ['analistas', '🎯 Analistas']]
    .map(([k, l]) => `<button data-action="radarView" data-v="${k}" class="${S.radarView === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;

  if (S.radarView === 'analistas') {
    const top = list.filter((t) => t.analysts?.count).slice(0, 20);
    html += `<h2>Top ${top.length} por valoración de analistas</h2>
      <p class="tiny muted">Consenso de Wall Street y previsión de 12 meses de las mejores señales del filtro actual.</p>`;
    for (const t of top) {
      html += `<div class="card"><div class="between tap" data-action="detail" data-sym="${t.sym}">
        <div><div class="row"><span class="sym">${t.sym}</span>${chip(t.signal, 'sm')}</div>
          <div class="name ellipsis">${esc(t.name)}</div></div>
        <div style="text-align:right"><div class="mono" style="font-weight:700">${fmtUSD(t.price)}</div>
          <div class="tiny mono ${cls(t.chg1d)}">${pct(t.chg1d)}</div></div></div>
        ${analystBlock(t, { head: false })}</div>`;
    }
    if (!top.length) html += `<div class="empty">Ningún activo del filtro tiene cobertura de analistas.</div>`;
    return html;
  }

  const shown = list.slice(0, R.limit);
  html += `<h2>${list.length} activos <small>ordenados por ${R.horizon === 'score' ? 'score global' : HZ[R.horizon]}</small></h2><div class="card list">`;
  if (!list.length) html += `<div class="empty">Nada que mostrar con estos filtros.${R.q ? `<br><br>¿No está <b>${esc(R.q.toUpperCase())}</b>? <button class="btn secondary sm" data-action="requestTicker" data-sym="${esc(R.q.toUpperCase())}">Pedir que se agregue al radar</button>` : ''}</div>`;
  for (const t of shown) {
    const sig = R.horizon === 'score' ? t.signal : t.h[R.horizon].sig;
    html += `<div class="item" data-action="detail" data-sym="${t.sym}">
      <div style="width:44px;text-align:center"><div class="hero mono t-${sigClass(sig)}" style="font-size:20px">${key(t) ?? '—'}</div><div class="tiny muted">${t.conf === 'baja' ? 'conf. baja' : t.risk.label}</div></div>
      <div class="grow"><div class="row"><span class="sym">${t.sym}</span>${PF().fav.includes(t.sym) ? '<span class="t-s">★</span>' : ''}${chip(sig, 'sm')}</div>
        <div class="name ellipsis">${esc(t.name)}${t.sector ? ` · ${esc(t.sector)}` : ''}</div>
        <div class="mini-scores"><b>C ${t.h.short.s ?? '—'}</b><b>M ${t.h.medium.s ?? '—'}</b><b>L ${t.h.long.s ?? '—'}</b>${t.analysts?.upside != null ? `<b class="${cls(t.analysts.upside)}">obj ${pct(t.analysts.upside, 0)}</b>` : ''}${t.gurus ? `<b class="guru">🏆 ${t.gurus.length}</b>` : ''}</div></div>
      <div style="width:64px">${spark(t.tech.spark?.slice(-20))}<div class="price mono small">${fmtUSD(t.price)}</div><div class="tiny mono ${cls(t.chg1d)}" style="text-align:right">${pct(t.chg1d)}</div></div>
    </div>`;
  }
  html += `</div>`;
  if (list.length > shown.length) html += `<button class="btn secondary" data-action="moreRadar">Mostrar más (${list.length - shown.length} restantes)</button>`;
  return html;
}

// ---- HOY --------------------------------------------------------------------
/** Prioridad final de una noticia = prioridad del modelo + contexto personal (cartera, favoritos, señales). */
function newsRank(n, mine, favs, changed) {
  let p = n.prio ?? 30;
  if (n.sym && mine.has(n.sym)) p += 25;
  if (n.sym && favs.has(n.sym)) p += 10;
  if (n.sym && changed.has(n.sym)) p += 8;
  return p;
}
function newsLevel(p) { return p >= 60 ? 'alta' : p >= 38 ? 'media' : 'baja'; }
function collectNews() {
  const { open } = positions();
  const mine = new Set(open.map((p) => p.sym)), favs = new Set(PF().fav), changed = new Set((S.data.changes || []).filter((c) => c.since === '1d').map((c) => c.sym));
  const seen = new Set(), out = [];
  const push = (n, sym) => { if (!n.t || seen.has(n.t)) return; seen.add(n.t); const r = newsRank({ ...n, sym }, mine, favs, changed); out.push({ ...n, sym, rank: r, lvl: newsLevel(r), mine: mine.has(sym) }); };
  for (const p of open) for (const n of p.data?.news || []) push(n, p.sym);
  for (const f of PF().fav) for (const n of tk(f)?.news || []) push(n, f);
  for (const n of S.data.market_news || []) push(n, n.sym);
  out.sort((a, b) => b.rank - a.rank || (b.d || '').localeCompare(a.d || ''));
  return out;
}
function newsItem(n) {
  const lvlCls = { alta: 'strong_buy', media: 'hold', baja: 'gray' }[n.lvl];
  const act = { oportunidad: '🟢 Oportunidad', vender: '🔴 Revisar venta', anticipar: '🔭 Anticipar', informativo: '' }[n.accion] || '';
  return `<div class="n"><div class="row wrap" style="gap:4px;margin-bottom:2px"><span class="chip ${lvlCls} sm">${n.lvl === 'alta' ? 'Importante' : n.lvl === 'media' ? 'Media' : 'Baja'}</span>${n.tag ? `<span class="tag">${esc(n.tag)}</span>` : ''}${act ? `<span class="tiny">${act}</span>` : ''}${n.mine ? '<span class="tag">💼 mi cartera</span>' : ''}</div>
    <a href="${esc(n.u || '#')}" target="_blank" rel="noopener">${esc(n.t_es || n.t)}</a>
    ${n.r_es ? `<div class="small" style="margin-top:2px">${esc(n.r_es)}</div>` : (n.s && !n.t_es ? `<div class="tiny muted">${esc(n.s)}</div>` : '')}
    <div class="meta"><span class="tap-sym" data-action="detail" data-sym="${esc(n.sym || '')}"><b>${esc(n.sym || '')}</b></span> · ${esc(n.p || '')} · ${relTime(n.d)}${n.t_es ? '' : ' · <i>sin traducir</i>'}</div></div>`;
}

function viewHoy() {
  const d = S.data, reg = d.regime || {};
  const regCls = { 'Risk-on': 'strong_buy', Neutral: 'hold', 'Risk-off': 'strong_sell' }[reg.label] || 'hold';
  let html = `<div class="card"><div class="between"><h2 style="margin:0">Mercado hoy</h2><span class="chip ${regCls}">${esc(reg.label || '')}</span></div>
    <p class="small">${esc(reg.desc || '')}</p>${(reg.notes || []).map((n) => `<div class="tiny muted">• ${esc(n)}</div>`).join('')}<div class="tiny muted" style="margin-top:6px">${esc(updateStamp())}</div></div>`;

  html += `<div class="grid2">`;
  for (const [sym, m] of Object.entries(d.market || {})) {
    html += `<div class="card" style="margin:0;padding:10px"><div class="between"><span class="small" style="font-weight:600">${esc(m.name)}</span><span class="tiny mono ${cls(m.chg1d)}">${pct(m.chg1d)}</span></div>
      <div class="mono" style="font-weight:800;font-size:17px">${sym === 'CLP=X' ? fmtN(m.price, 0) : sym === '^TNX' ? fmtN(m.price, 2) + '%' : fmtN(m.price, m.price < 100 ? 2 : 0)}</div>${spark(m.spark)}
      <div class="tiny muted mono">1S ${pct(m.ret_1w)} · 1M ${pct(m.ret_1m)}</div></div>`;
  }
  html += `</div>`;

  // Noticias priorizadas
  const news = collectNews();
  const alta = news.filter((n) => n.lvl === 'alta'), media = news.filter((n) => n.lvl === 'media'), baja = news.filter((n) => n.lvl === 'baja');
  const aiOn = news.some((n) => n.ai);
  html += `<h2>📰 Noticias priorizadas <small>${news.length}</small></h2>
    <p class="tiny muted">${aiOn ? 'Traducidas y resumidas por IA; ' : 'Clasificación automática por palabras clave (activa la IA en Ajustes para traducción y resumen); '}las de tu cartera suben de prioridad.</p>`;
  html += `<h3>🚨 Importantes <small class="muted">oportunidad o decidir vender · ${alta.length}</small></h3><div class="card news">${alta.length ? alta.slice(0, 15).map(newsItem).join('') : '<div class="empty small">Nada importante por ahora.</div>'}</div>`;
  html += `<h3>🔭 Medias <small class="muted">para anticiparse · ${media.length}</small></h3><div class="card news">${media.length ? media.slice(0, 15).map(newsItem).join('') : '<div class="empty small">Sin noticias medias.</div>'}</div>`;
  html += `<details><summary class="small muted">Bajas (${baja.length}) — sin impacto directo</summary><div class="card news">${baja.slice(0, 20).map(newsItem).join('')}</div></details>`;

  const ch = d.changes || [];
  if (ch.length) {
    html += `<h2>🔔 Cambios de señal <small>${ch.length}</small></h2><div class="card list">`;
    for (const c of ch.slice(0, 12)) html += `<div class="item" data-action="detail" data-sym="${c.sym}"><span style="font-size:18px">${c.dir === 'up' ? '⬆️' : '⬇️'}</span><div class="grow"><b>${c.sym}</b> <span class="tiny muted">${c.since === '1d' ? 'hoy' : '7 días'}</span><div class="small">${chip(c.from, 'sm')} → ${chip(c.to, 'sm')}</div></div><div class="mono small muted">${c.score_from} → <b>${c.score_to}</b></div></div>`;
    html += `</div>`;
  }

  html += `<h2>🔥 Top oportunidades hoy</h2>`;
  for (const hz of ['short', 'medium', 'long']) {
    const top = d.tickers.filter((t) => t.conf !== 'baja' && !t.etf).sort((a, b) => (b.h[hz].s ?? 0) - (a.h[hz].s ?? 0)).slice(0, 3);
    html += `<h3>${HZ[hz]}</h3><div class="card list" style="margin-top:0">${top.map((t, i) => `<div class="item" data-action="detail" data-sym="${t.sym}"><span class="muted">${i + 1}.</span><div class="grow"><b>${t.sym}</b> <span class="tiny muted">${esc(t.name)}</span></div>${chip(t.h[hz].sig, 'sm')}<b class="mono t-${sigClass(t.h[hz].sig)}">${t.h[hz].s}</b></div>`).join('')}</div>`;
  }

  const movers = d.tickers.filter((t) => t.chg1d != null).sort((a, b) => Math.abs(b.chg1d) - Math.abs(a.chg1d)).slice(0, 8);
  html += `<h2>Mayores movimientos</h2><div class="card"><div class="chips">${movers.map((t) => `<span class="chip ${t.chg1d >= 0 ? 'buy' : 'sell'}" data-action="detail" data-sym="${t.sym}">${t.sym} ${pct(t.chg1d)}</span>`).join('')}</div></div>`;

  const mine = held();
  const earn = d.tickers.filter((t) => t.earnings_date).map((t) => ({ t, days: Math.round((new Date(t.earnings_date) - Date.now()) / 864e5) })).filter((e) => e.days >= 0 && e.days <= 21).sort((a, b) => (mine.has(b.t.sym) - mine.has(a.t.sym)) || a.days - b.days);
  if (earn.length) html += `<h2>📅 Próximos resultados <small>21 días</small></h2><div class="card"><div class="chips wrap">${earn.slice(0, 24).map((e) => `<span class="chip ${mine.has(e.t.sym) ? 'accent' : 'gray'}" data-action="detail" data-sym="${e.t.sym}">${e.t.sym} · ${e.days === 0 ? 'hoy' : e.days + 'd'}</span>`).join('')}</div></div>`;
  return html;
}

// ---- IA (chat con Claude) -----------------------------------------------------
const AI_URL = 'https://api.anthropic.com/v1/messages';

function loadChat() {
  const c = loadJSON('mia.chat.v1', null);
  return (c && c.d === today() && Array.isArray(c.m)) ? c.m : [];   // se limpia cada día
}
function saveChat() { saveJSON('mia.chat.v1', { d: today(), m: S.chat.slice(-24) }); }

/** Contexto que acompaña a cada pregunta: cartera, régimen y mejores señales del día. */
function aiSystemPrompt() {
  const d = S.data;
  const { open } = positions();
  const top = d.tickers.filter((t) => !t.etf && t.conf !== 'baja').slice(0, 12)
    .map((t) => `${t.sym} ${SIG_LABEL[t.signal]} ${t.score}/100 (C${t.h.short.s} M${t.h.medium.s} L${t.h.long.s}, riesgo ${t.risk.label}${t.analysts?.upside != null ? `, objetivo ${pct(t.analysts.upside, 0)}` : ''})`).join('; ');
  const cambios = (d.changes || []).slice(0, 6).map((c) => `${c.sym} ${SIG_LABEL[c.from]}→${SIG_LABEL[c.to]}`).join('; ');
  const noticias = collectNews().filter((n) => n.lvl === 'alta').slice(0, 8).map((n) => `[${n.sym}] ${n.t_es || n.t}`).join(' | ');
  return `Eres el analista cuantitativo de cabecera de un inversionista minorista chileno que invierte en acciones y ETFs de EE.UU. a través de Racional. Respondes en español de Chile, directo, sin relleno y sin prometer rentabilidades. Latency-sensitive; begin your visible answer immediately.

Trabajas sobre los datos de su app "Market Intelligence AI" (fuente: Yahoo Finance, ${d.date}):

RÉGIMEN: ${d.regime?.label} — ${d.regime?.desc} ${(d.regime?.notes || []).join('. ')}

SU CARTERA (${PF().name}${isRO() ? ', compartida' : ''}):
${portfolioText()}

MEJORES SEÑALES DEL MODELO HOY: ${top}
CAMBIOS DE SEÑAL: ${cambios || 'ninguno'}
TITULARES IMPORTANTES: ${noticias || 'sin titulares relevantes'}

El modelo puntúa 0-100 en tres horizontes (corto 1d-1m, mediano 1-12m, largo 1-5a) y emite Compra fuerte / Compra / Mantener / Venta / Venta fuerte. Cuando te pregunten por un activo que no esté arriba, dilo y responde con lo que sepas, aclarando que no tienes su ficha delante. Cierra siempre recordando que son señales cuantitativas, no asesoría financiera personalizada.`;
}

async function aiSend(text) {
  const key = (S.settings.aiKey || '').trim();
  if (S.chatBusy || !text.trim()) return;
  S.chat.push({ role: 'user', content: text.trim() });
  if (!key) {                                   // sin clave: responde con los datos del día
    S.chat.push({ role: 'assistant', content: localAnswer(text) });
    saveChat(); render(); scrollChat();
    return;
  }
  S.chatBusy = true; saveChat(); render(); scrollChat();
  try {
    const r = await fetch(AI_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: S.settings.aiModel || 'claude-opus-5',
        max_tokens: 4000,
        fallbacks: 'default',
        system: aiSystemPrompt(),
        output_config: { effort: 'low' },
        messages: S.chat.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${r.status}`);
    }
    const j = await r.json();
    if (j.stop_reason === 'refusal') {
      S.chat.push({ role: 'assistant', content: 'No puedo responder esa consulta. Reformúlala o pregunta por otro activo.' });
    } else {
      const txt = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      S.chat.push({ role: 'assistant', content: txt || '(respuesta vacía)' });
    }
  } catch (e) {
    S.chat.push({ role: 'assistant', content: `⚠️ No se pudo consultar a Claude: ${e.message}` });
  } finally {
    S.chatBusy = false; saveChat(); render(); scrollChat();
  }
}
function scrollChat() { setTimeout(() => { const el = $('#chatEnd'); if (el) el.scrollIntoView({ block: 'end' }); }, 60); }

/** Markdown mínimo: negritas, viñetas y saltos. */
function mdLite(t) {
  return esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^### (.+)$/gm, '<b>$1</b>')
    .replace(/^[-•*] (.+)$/gm, '• $1')
    .replace(/\n/g, '<br>');
}

function briefCard() {
  const b = S.data.brief;
  if (!b?.text) return '';
  return `<div class="card"><div class="between"><h2 style="margin:0">🗞️ Resumen del día</h2>
      <span class="tag">${b.ai ? 'IA · ' : ''}${S.data.date}</span></div>
    <p class="small">${esc(b.text)}</p>
    ${(b.bullets || []).length ? `<h3>Qué vigilar</h3><ul class="reasons">${b.bullets.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${b.riesgo ? `<p class="small" style="color:var(--s)">⚠️ ${esc(b.riesgo)}</p>` : ''}</div>`;
}

function viewIA() {
  const dk = S.desks;
  let html = briefCard();

  if (!dk?.desks?.length) {
    html += `<div class="card"><h2 style="margin-top:0">🏛️ Mesas de análisis</h2>
      <p class="small muted">Las mesas se generan en el análisis diario. Todavía no hay ninguna publicada; vuelve después del próximo cierre de mercado.</p></div>`;
  } else {
    html += `<div class="card"><div class="between"><h2 style="margin:0">🏛️ Mesas de análisis</h2>
        <span class="tag">${dk.ai ? 'IA · ' : ''}${esc(dk.date || '')}</span></div>
      <p class="small muted">Diez mesas institucionales revisan tu cartera todos los días. Están listas al abrir: no hay que activar nada.</p>
      <div class="desks">${dk.desks.map((d) => `<button class="desk" data-action="desk" data-id="${esc(d.id)}">
        <span class="ic">${d.icon}</span>
        <span class="grow"><b>${esc(d.firm)}</b><span class="tiny muted">${esc(d.title)}</span>
          <span class="verdict">${esc(d.veredicto || '')}</span></span>
        <span class="caret">›</span></button>`).join('')}</div></div>`;
  }

  html += askCard();

  const { open } = positions();
  const ref = S.detail || open[0]?.sym || S.data.tickers[0]?.sym;
  html += `<div class="card"><h2 style="margin-top:0">📚 Llevar a otra IA</h2>
    <p class="small muted">Los prompts institucionales originales, ya rellenados con tus datos de hoy, para pegarlos en ChatGPT, Gemini o donde quieras.</p>
    <div class="btn-row"><button class="btn secondary sm" data-action="copyPrompt" data-kind="super">📋 Superprompt de ${esc(ref || '')}</button>
      <button class="btn secondary sm" data-action="copyPrompt" data-kind="portfolio" ${open.length ? '' : 'disabled'}>📋 Prompt de cartera</button></div>
    <p class="tiny muted">Cada mesa también trae su prompt original, dentro de su ficha.</p></div>`;
  return html;
}

/** Ficha completa de una mesa, en página aparte. */
function openDesk(id) {
  const d = (S.desks?.desks || []).find((x) => x.id === id);
  if (!d) return;
  S.deskOpen = id;
  const cols = d.cols || [], rows = d.rows || [];
  const tabla = rows.length ? `<div class="scroll-x"><table class="grid">
      <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.mine ? 'mine' : ''}">
        <td><button class="lnk" data-action="detail" data-sym="${esc(r.sym)}">${esc(r.sym)}</button>${r.tag ? `<div class="tiny muted">${esc(r.tag)}</div>` : ''}</td>
        ${(r.cols || []).map((c) => `<td>${esc(String(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<div class="empty small">Sin filas que mostrar hoy.</div>';

  $('#pageContent').innerHTML = `<div class="page-head"><button class="icon-btn" data-action="closePage" aria-label="Volver">←</button>
      <div class="grow"><div class="row"><span style="font-size:18px">${d.icon}</span><b>${esc(d.firm)}</b></div>
      <div class="name ellipsis">${esc(d.title)}</div></div></div><div class="inner">
    <div class="card"><div class="verdict big">${esc(d.veredicto || '')}</div>
      <p class="small">${esc(d.resumen || '')}</p>
      <div class="tiny muted">Datos del ${esc(S.desks.date || '')} · cartera ${esc(S.desks.portfolio?.name || '')} · ${d.ai ? 'redactado por Claude sobre los números calculados' : 'calculado con los datos de la app'}</div></div>
    ${d.acciones?.length ? `<div class="card"><h2 style="margin-top:0">✅ Qué haría esta mesa</h2>
      ${d.acciones.map((a) => `<div class="between" style="padding:8px 0;border-top:1px solid var(--border)">
        <div class="grow"><button class="lnk"><b>${esc(a.sym)}</b></button> <span class="chip sm">${esc(a.accion)}</span>
          <div class="tiny muted">${esc(a.por)}</div></div></div>`).join('')}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">📋 Los números</h2>${tabla}
      <p class="tiny muted">Las filas de tu cartera van resaltadas. Toca un símbolo para abrir su ficha.</p></div>
    <div class="card"><h2 style="margin-top:0">🔍 Lectura de la mesa</h2>
      <ul class="reasons">${(d.puntos || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p class="tiny muted">Análisis cuantitativo con datos de Yahoo Finance. No es asesoría financiera personalizada.</p></div>
    <div class="btn-row"><button class="btn secondary sm" data-action="copyDesk" data-id="${esc(d.id)}">📋 Copiar informe</button>
      <button class="btn secondary sm" data-action="copyPrompt" data-kind="lib" data-n="${d.n}">📋 Copiar el prompt original</button></div>
    </div>`;
  const page = $('#page'); page.hidden = false; page.scrollTop = 0; document.body.classList.add('locked');
}

/** Texto plano de una mesa, para pegarlo donde sea. */
function deskText(d) {
  const filas = (d.rows || []).map((r) => [r.sym, r.tag, ...(r.cols || [])].join(' | ')).join('\n');
  return [`${d.firm} — ${d.title} · ${S.desks.date}`, '', d.veredicto, '', d.resumen, '',
    (d.cols || []).join(' | '), filas, '', ...(d.puntos || []).map((x) => `• ${x}`)].join('\n');
}

// ---- Asistente ---------------------------------------------------------------
/** Con clave de Claude es un chat; sin clave responde con los datos ya calculados. */
function askCard() {
  const hasKey = !!(S.settings.aiKey || '').trim();
  const { open } = positions();
  const sel = open[0]?.sym || S.data.tickers[0]?.sym;
  const starters = ['¿Qué hago hoy con mi cartera?', `¿Cómo viene ${sel}?`, '¿Dónde estoy demasiado concentrado?', '¿Qué reporta pronto?'];
  return `<div class="card chat"><div class="between"><h2 style="margin:0">💬 Pregúntale a tu cartera</h2>
      ${S.chat.length ? '<button class="btn secondary sm" data-action="chatClear">Limpiar</button>' : ''}</div>
    <div class="tiny muted">${hasKey ? 'Chat con Claude: conoce tu cartera y los datos de hoy.' : 'Responde con los datos y las mesas del día, sin conexión ni claves.'}</div>
    <div id="chatBox">${S.chat.length ? S.chat.map((m) => `<div class="msg ${m.role}">${m.role === 'assistant' ? mdLite(m.content) : esc(m.content)}</div>`).join('')
      : '<div class="empty small">Pregunta por una acción, por tu riesgo o por lo que viene esta semana.</div>'}
      ${S.chatBusy ? '<div class="msg assistant pending">Pensando…</div>' : ''}<div id="chatEnd"></div></div>
    <div class="chips">${starters.map((q) => `<span class="chip" data-action="chatAsk" data-q="${esc(q)}">${esc(q)}</span>`).join('')}</div>
    <div class="chat-input"><textarea id="chatText" rows="1" placeholder="Escribe tu pregunta…"></textarea>
      <button class="btn sm" data-action="chatSend" ${S.chatBusy ? 'disabled' : ''}>➤</button></div>
    ${hasKey ? '' : '<p class="tiny muted">Responde solo, con lo que la app ya calculó. Si quieres que conteste Claude en vivo, agrega tu clave en Ajustes.</p>'}</div>`;
}

/** Responde sin conexión, leyendo las mesas y los datos del día. */
function localAnswer(q) {
  const txt = (q || '').toLowerCase();
  const dk = S.desks;
  const d = S.data;
  const { open } = positions();
  const total = open.reduce((a, p) => a + (p.value || 0), 0);
  const norm = (x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const t = txt.split(/[^a-záéíóúñ0-9.]+/i).map(norm).filter(Boolean);
  const has = (...ws) => ws.some((w) => t.includes(norm(w)) || txt.includes(w));
  const desk = (id) => (dk?.desks || []).find((x) => x.id === id);
  const linea = (x) => `**${x.firm}** · ${x.veredicto}\n${(x.puntos || []).slice(0, 2).map((p) => `• ${p}`).join('\n')}`;

  // ¿Habla de un activo concreto? Se compara palabra por palabra: "concentrado"
  // no puede activar el ticker NTR.
  const pal = new Set(t);
  const sym = (d.tickers.find((x) => pal.has(x.sym.toLowerCase()))
    || d.tickers.find((x) => { const n = norm((x.name || '').split(/[ ,.]/)[0].toLowerCase()); return n.length > 4 && pal.has(n); }));
  if (sym && !has('cartera', 'portafolio')) {
    const pos = open.find((p) => p.sym === sym.sym);
    const a = sym.analysts || {};
    const conVeredicto = ['goldman', 'morgan', 'blackrock', 'citadel', 'jpmorgan', 'harvard'];
    const enMesas = (dk?.desks || []).filter((x) => conVeredicto.includes(x.id) && (x.rows || []).some((r) => r.sym === sym.sym))
      .map((x) => { const r = x.rows.find((y) => y.sym === sym.sym); return `**${x.firm}**: ${r.tag || '—'}`; });
    return [`**${sym.sym} · ${sym.name}**`,
      `Señal del modelo: **${SIG_LABEL[sym.signal]} ${sym.score}/100** (corto ${sym.h.short.s} · mediano ${sym.h.medium.s} · largo ${sym.h.long.s}, riesgo ${sym.risk.label}).`,
      `Precio ${fmtUSD(sym.price)} (${pct(sym.chg1d)} hoy). ${a.target?.mean ? `Objetivo de analistas ${fmtUSD(a.target.mean)} (${pct(a.upside)}), ${a.count} opiniones.` : ''}`,
      pos ? `Tu posición: ${fmtQ(pos.qty)} acciones, valor ${fmtUSD(pos.value)} (${fmtN(pos.value / total * 100, 1)}% de la cartera), resultado ${pct(pos.pnlPct)}.` : 'No tienes esta acción.',
      enMesas.length ? `\nQué dicen las mesas hoy:\n${enMesas.map((x) => `• ${x}`).join('\n')}` : '',
      sym.reasons?.length ? `\nMotivos del modelo: ${sym.reasons.slice(0, 3).join('; ')}.` : '',
      `\nToca el símbolo en el radar para ver la ficha completa.`].filter(Boolean).join('\n');
  }

  if (has('riesgo', 'concentrado', 'concentracion', 'diversific', 'peligro')) {
    const b = desk('bridgewater'), bl = desk('blackrock');
    return [b ? linea(b) : '', bl ? `\n**${bl.firm}** · ${bl.veredicto}` : '',
      '\nAbre la mesa de Bridgewater para ver el mapa por sector y la prueba de estrés.'].filter(Boolean).join('\n');
  }
  if (has('reporta', 'resultados', 'earnings', 'semana', 'viene', 'proximo', 'próximo')) {
    const j = desk('jpmorgan');
    if (j) return [linea(j), '', ...(j.rows || []).slice(0, 6).map((r) => `• ${r.sym}: ${r.cols[0]} (${r.tag})`)].join('\n');
  }
  if (has('dividendo', 'renta', 'ingreso')) { const h = desk('harvard'); if (h) return linea(h); }
  if (has('caro', 'barato', 'valoracion', 'valoración', 'sobrevalorad', 'infravalorad', 'dcf')) {
    const m = desk('morgan'); if (m) return linea(m);
  }
  if (has('comprar', 'oportunidad', 'idea', 'nuevo', 'agregar')) {
    const g = desk('goldman');
    if (g) return [linea(g), '', ...(g.rows || []).slice(0, 5).map((r) => `• ${r.sym} — ${r.cols[0]} · ${r.tag}`)].join('\n');
  }
  if (has('tecnico', 'técnico', 'grafico', 'gráfico', 'stop', 'soporte', 'resistencia', 'rsi')) {
    const c = desk('citadel'); if (c) return linea(c);
  }
  if (has('macro', 'tasas', 'fed', 'dolar', 'dólar', 'inflacion', 'inflación', 'mercado')) {
    const mk = desk('mckinsey'); if (mk) return linea(mk);
  }

  // Pregunta general: el estado del día en cuatro líneas.
  const cambios = (d.changes || []).slice(0, 3).map((c) => `${c.sym} ${SIG_LABEL[c.from]}→${SIG_LABEL[c.to]}`);
  const alertas = portfolioAlerts(open).slice(0, 3);
  return [`**Tu cartera hoy**: ${fmtUSD(total)} en ${open.length} posiciones.`,
    d.regime ? `Régimen: **${d.regime.label}** — ${d.regime.desc}` : '',
    cambios.length ? `Cambios de señal: ${cambios.join('; ')}.` : 'Sin cambios de señal hoy.',
    alertas.length ? `\nAlertas:\n${alertas.map((x) => `• ${x.sym}: ${x.text}`).join('\n')}` : '',
    dk?.desks?.length ? `\nLas mesas de hoy en una línea:\n${dk.desks.slice(0, 4).map((x) => `• **${x.firm}**: ${x.veredicto}`).join('\n')}` : '',
    '\nPregunta por una acción por su símbolo (por ejemplo "¿cómo viene NVDA?") o por riesgo, dividendos, valoración o resultados.'].filter(Boolean).join('\n');
}

function tickerBrief(t) {
  const a = t.analysts || {};
  const { open } = positions(); const pos = open.find((p) => p.sym === t.sym);
  return [
    `Activo: ${t.sym} (${t.name})${t.sector ? ` · Sector: ${t.sector}` : ''}${t.industry ? ` · ${t.industry}` : ''}`,
    `Precio: ${fmtUSD(t.price)} (${pct(t.chg1d)} hoy) · Fecha datos: ${S.data.date}`,
    `Señal del modelo: ${SIG_LABEL[t.signal]} ${t.score}/100 (confianza ${t.conf}) · Corto ${t.h.short.s} · Mediano ${t.h.medium.s} · Largo ${t.h.long.s} · Riesgo ${t.risk.label} (${t.risk.s})`,
    `Técnico: rating ${SIG_LABEL[t.tech.rating?.label] || '—'} (${t.tech.rating?.buy}↑/${t.tech.rating?.sell}↓), RSI ${t.tech.rsi}, MACD hist ${t.tech.macd_hist}, SMA20 ${t.tech.sma20}, SMA50 ${t.tech.sma50}, SMA200 ${t.tech.sma200}, %B ${t.tech.bb_pct}, ATR ${t.tech.atr_pct}%`,
    `Retornos: 1S ${pct(t.tech.ret?.['1w'])}, 1M ${pct(t.tech.ret?.['1m'])}, 3M ${pct(t.tech.ret?.['3m'])}, 6M ${pct(t.tech.ret?.['6m'])}, 1A ${pct(t.tech.ret?.['1y'])} · Máx 52s ${t.tech.hi52} · Mín 52s ${t.tech.lo52} · Vol 30d ${t.tech.vol30}% · Drawdown 1A ${t.tech.max_dd}% · Volumen ${t.tech.vol_ratio}x`,
    `Fundamentales: cap ${big(t.fund.market_cap)}, P/E ${t.fund.trailing_pe ?? '—'}, P/E fwd ${t.fund.forward_pe ?? '—'}, PEG ${t.fund.peg ?? '—'}, crec. ingresos ${pct(t.fund.revenue_growth)}, crec. utilidades ${pct(t.fund.earnings_growth)}, margen neto ${pct(t.fund.profit_margin, 1, false)}, margen op. ${pct(t.fund.operating_margin, 1, false)}, ROE ${pct(t.fund.roe, 1, false)}, D/E ${t.fund.debt_to_equity ?? '—'}, FCF yield ${pct(t.fund.fcf_yield, 1, false)}, div. yield ${pct(t.fund.dividend_yield, 2, false)}, beta ${t.fund.beta ?? '—'}`,
    t.analysts ? `Analistas: ${SIG_LABEL[a.key] || a.key || '—'} (media ${a.mean}, ${a.count} opiniones) · objetivo medio ${fmtUSD(a.target?.mean)} (${pct(a.upside)}), rango ${fmtUSD(a.target?.low)}–${fmtUSD(a.target?.high)}${a.dist ? ` · distribución SB ${a.dist.sb} / B ${a.dist.b} / H ${a.dist.h} / S ${a.dist.s} / SS ${a.dist.ss}` : ''}${a.revisions ? ` · revisiones EPS 30d: ${a.revisions.up}↑ ${a.revisions.down}↓` : ''}` : 'Analistas: no aplica (ETF)',
    t.earnings_date ? `Próximos resultados: ${t.earnings_date}` : '',
    `Motivos del modelo: ${t.reasons.join('; ') || '—'}`,
    pos ? `MI POSICIÓN: ${pos.qty > 0 ? `${fmtQ(pos.qty)} acciones a precio promedio ${fmtUSD(pos.avg)}` : `inversión ${fmtUSD(pos.cost)}`} (valor ${fmtUSD(pos.value)}, resultado ${pct(pos.pnlPct)})` : 'MI POSICIÓN: no tengo esta acción',
    t.news?.length ? `Titulares recientes: ${t.news.map((n) => n.t).join(' | ')}` : '',
  ].filter(Boolean).join('\n');
}

function buildSuperPrompt(sym) {
  const t = tk(sym); if (!t) return '';
  return `Actúa como un comité de inversión que reúne a un analista sénior de equity research (Goldman Sachs), un banquero de valoración (Morgan Stanley), un gestor de riesgo (Bridgewater), un trader cuantitativo (Citadel), un investigador de patrones (Renaissance) y un estratega macro (McKinsey).

DATOS ACTUALES DEL ACTIVO (calculados por mi app Market Intelligence AI con datos de Yahoo Finance):
${tickerBrief(t)}

CONTEXTO DE MERCADO: régimen ${S.data.regime?.label} — ${S.data.regime?.desc} ${(S.data.regime?.notes || []).join('. ')}

ENTRÉGAME, en español y con tablas claras:
1. Resumen ejecutivo en 5 líneas.
2. Tesis alcista y bajista (3 puntos cada una).
3. Valoración: DCF simplificado (supuestos de crecimiento, margen, WACC, valor terminal) y comparación con múltiplos del sector; veredicto infra/sobre valorada.
4. Análisis técnico: tendencia diaria/semanal, soportes y resistencias con precios, plan de trading (entrada, stop-loss, objetivo, ratio riesgo/beneficio).
5. Próximos resultados: qué vigila Wall Street, escenarios alcista/bajista y movimiento esperado.
6. Riesgo: nivel 1-10 con justificación, escenarios de cola, tamaño de posición sugerido para una cartera de una persona en Chile que invierte en dólares vía Racional.
7. Patrones y anomalías: estacionalidad, insiders, interés en corto, rotación sectorial.
8. Macro: cómo tasas, dólar, inflación y ciclo afectan a este activo en los próximos 6-12 meses.
9. VEREDICTO FINAL por horizonte, usando exactamente estas etiquetas: Compra fuerte / Compra / Mantener / Venta / Venta fuerte.
   - Corto plazo (1 día – 1 mes):
   - Mediano plazo (1 – 12 meses):
   - Largo plazo (1 – 5 años):
   Indica si coincides o discrepas con la señal del modelo (${SIG_LABEL[t.signal]} ${t.score}/100) y por qué.
10. Si tengo posición: ¿mantener, aumentar, reducir o cerrar? Precio concreto de acción.

Sé específico, cuantifica, y aclara que es análisis educativo y no asesoría financiera personalizada.`;
}

function buildPortfolioPrompt() {
  const { open } = positions();
  const total = open.reduce((a, p) => a + (p.value || 0), 0);
  const lines = open.map((p) => `- ${p.sym} (${p.data?.name || ''}, ${p.data?.sector || '—'}): ${p.qty > 0 ? `${fmtQ(p.qty)} acc. a ${fmtUSD(p.avg)} promedio` : `inversión ${fmtUSD(p.cost)}`}, valor ${fmtUSD(p.value)} (${fmtN((p.value || 0) / total * 100, 1)}%), resultado ${pct(p.pnlPct)}, señal modelo ${SIG_LABEL[p.data?.signal] || '—'} ${p.data?.score ?? ''}/100, beta ${p.data?.fund?.beta ?? '—'}, riesgo ${p.data?.risk?.label || '—'}`);
  return `Actúa como un analista sénior de riesgo de Bridgewater Associates y un estratega de portafolio de BlackRock trabajando juntos.

MI CARTERA (valor total ${fmtUSD(total)}, invertida en dólares desde Chile vía Racional; datos al ${S.data.date}):
${lines.join('\n')}

Régimen de mercado actual: ${S.data.regime?.label} — ${S.data.regime?.desc}

EVALÚA Y ENTRÉGAME EN ESPAÑOL:
1. Correlación estimada entre posiciones y riesgo de concentración sectorial (% por sector).
2. Exposición geográfica/cambiaria (USD vs CLP) y sensibilidad a tasas de interés.
3. Prueba de estrés: recesión, shock tecnológico, subida del VIX a 35 — drawdown estimado de la cartera.
4. Riesgo de liquidez y tamaño de posición recomendado para cada activo.
5. Escenarios de cola con probabilidades.
6. Estrategias de cobertura para mis 3 mayores riesgos (ETFs, efectivo, oro, bonos, etc.).
7. Propuesta de rebalanceo con porcentajes objetivo, indicando qué vender/comprar y por qué.
8. Tabla resumen final con acción recomendada por posición: Mantener / Aumentar / Reducir / Cerrar.

Presenta un mapa de calor de riesgo (tabla) y aclara que es análisis educativo, no asesoría financiera personalizada.`;
}

const PROMPTS = [
  { n: 1, t: 'Screener de acciones · nivel Goldman Sachs', s: 'Framework de selección con P/E vs sector, crecimiento, deuda, dividendos, moat, objetivos a 12 meses y stop-loss.', b: (sym, pf) => `Actúa como un analista sénior de renta variable de Goldman Sachs con 20 años de experiencia evaluando acciones para clientes de alto patrimonio.\n\nNecesito un framework completo de selección de acciones alineado con mis objetivos de inversión.\n\nANALIZA Y ENTRÉGAME:\n• Las 10 acciones que mejor cumplan mis criterios con su ticker.\n• Análisis del ratio P/E frente al promedio de su sector.\n• Tendencia de crecimiento de ingresos en los últimos 5 años.\n• Revisión de deuda/patrimonio para cada empresa.\n• Rentabilidad por dividendo y sostenibilidad del payout.\n• Fortaleza de la ventaja competitiva: débil, moderada o fuerte.\n• Precio objetivo a 12 meses en escenarios alcista, base y bajista.\n• Nivel de riesgo del 1 al 10 con justificación clara.\n• Zonas de entrada sugeridas y nivel de stop-loss.\n• Tabla resumen final con conclusiones accionables.\n\nPRESÉNTALO COMO UN INFORME PROFESIONAL DE RESEARCH DE ACCIONES, con resumen ejecutivo y tabla comparativa.\n\nMI PERFIL DE INVERSIÓN:\n[RIESGO TOLERADO · MONTO A INVERTIR · HORIZONTE DE TIEMPO · SECTORES PREFERIDOS]\n\nMI CARTERA ACTUAL:\n${pf}` },
  { n: 2, t: 'Valuación DCF profunda · estilo Morgan Stanley', s: 'Proyección 5 años, márgenes, FCF, WACC, valor terminal, sensibilidad y veredicto.', b: (sym) => `Actúa como un banquero de inversión nivel VP en Morgan Stanley que construye modelos de valoración para operaciones M&A de compañías Fortune 500.\n\nNecesito un análisis completo de flujo de caja descontado (DCF) para una acción específica.\n\nCONSTRUYE:\n• Proyección de ingresos a 5 años con supuestos de crecimiento.\n• Estimación de márgenes operativos basada en tendencias históricas.\n• Cálculo del flujo de caja libre año por año.\n• Estimación del WACC.\n• Valor terminal con múltiplo de salida y crecimiento a perpetuidad.\n• Tabla de sensibilidad con diferentes tasas de descuento.\n• Comparación del valor DCF vs. el precio de mercado actual.\n• Veredicto: infravalorada, justamente valorada o sobrevalorada.\n• Supuestos clave que podrían romper el modelo.\n• Resumen ejecutivo con recomendación de inversión.\n\nPRESÉNTALO COMO UN MEMORANDO DE VALORACIÓN DE BANCA DE INVERSIÓN, con tablas financieras y matemáticas claras.\n\nACCIÓN A VALORAR (datos actuales):\n${sym}` },
  { n: 3, t: 'Análisis de riesgo · inspirado en Bridgewater', s: 'Correlación, concentración, estrés de recesión, liquidez, colas, coberturas y rebalanceo.', b: () => buildPortfolioPrompt() },
  { n: 4, t: 'Previa de resultados · nivel JPMorgan', s: 'Últimos 4 trimestres vs estimaciones, consenso, guía, movimiento implícito y recomendación.', b: (sym) => `Actúa como un analista sénior de equity research en JPMorgan Chase que prepara previas de resultados para inversores institucionales.\n\nNecesito un análisis completo antes de que una empresa publique resultados.\n\nENTRÉGAME:\n• Resultados de los últimos 4 trimestres vs. estimaciones.\n• Consenso de ingresos y EPS para el próximo trimestre.\n• Métricas clave que Wall Street vigila en esta empresa.\n• Desglose de ingresos por segmento y tendencias.\n• Resumen de la guía de la administración en la última llamada.\n• Movimiento implícito del mercado de opciones para el día de resultados.\n• Reacción histórica de la acción tras los últimos 4 reportes.\n• Escenario alcista y estimación de impacto en el precio.\n• Escenario bajista y estimación de riesgo a la baja.\n• Recomendación final: comprar antes, vender antes o esperar.\n\nPRESÉNTALO COMO UN BRIEF PROFESIONAL PREVIO A RESULTADOS, con un resumen de decisión al inicio.\n\nEMPRESA Y DATOS ACTUALES:\n${sym}` },
  { n: 5, t: 'Construcción de portafolio · estilo BlackRock', s: 'Asignación exacta, ETFs núcleo/satélite, retorno esperado, drawdown, rebalanceo y política de inversión.', b: (sym, pf) => `Actúa como un estratega sénior de portafolio en BlackRock que diseña carteras multiactivo para clientes institucionales.\n\nNecesito un portafolio de inversión personalizado, construido desde cero para mi situación (invierto en dólares desde Chile vía Racional; acciones y ETFs de EE.UU.).\n\nCREA:\n• Asignación exacta de activos con porcentajes en acciones, bonos y alternativos.\n• ETFs o fondos específicos recomendados para cada categoría, con ticker.\n• Posiciones núcleo y satélite claramente definidas.\n• Rango de retorno anual esperado basado en datos históricos.\n• Drawdown máximo esperado en un año adverso.\n• Calendario de rebalanceo y reglas de activación.\n• Estrategia de eficiencia fiscal según mi tipo de cuenta.\n• Plan de inversión periódica si aporto mensualmente.\n• Benchmark para medir mi desempeño.\n• Política de inversión resumida en una página.\n\nPRESÉNTALO COMO UN DOCUMENTO PROFESIONAL DE POLÍTICA DE INVERSIÓN.\n\nMIS DATOS:\n[EDAD · INGRESOS · AHORROS · METAS · RIESGO · TIPO DE CUENTA]\n\nMI CARTERA ACTUAL:\n${pf}` },
  { n: 6, t: 'Análisis técnico · nivel Citadel', s: 'Tendencia multi-marco, soportes/resistencias, medias, RSI/MACD/Bollinger, Fibonacci y plan de trading.', b: (sym) => `Actúa como un trader cuantitativo sénior en Citadel que combina análisis técnico con modelos estadísticos para temporizar entradas y salidas.\n\nNecesito un análisis técnico completo de una acción.\n\nANALIZA:\n• Dirección de la tendencia en marcos diario, semanal y mensual.\n• Niveles clave de soporte y resistencia con precios exactos.\n• Medias móviles de 50, 100 y 200 días y señales de cruce.\n• Lecturas de RSI, MACD y Bandas de Bollinger en lenguaje claro.\n• Análisis de volumen y fuerza relativa entre compradores y vendedores.\n• Identificación de patrones gráficos relevantes.\n• Niveles de retroceso de Fibonacci y posibles zonas de rebote.\n• Precio ideal de entrada, stop-loss y objetivo de ganancia.\n• Relación riesgo/beneficio de la operación actual.\n• Calificación de convicción: compra fuerte, compra, neutral, venta o venta fuerte.\n\nPRESÉNTALO COMO UNA FICHA PROFESIONAL DE ANÁLISIS TÉCNICO, con un plan de trading claro y accionable.\n\nACCIÓN Y DATOS ACTUALES:\n${sym}` },
  { n: 7, t: 'Estrategia de dividendos · Harvard Endowment', s: '15–20 acciones de dividendos, seguridad, payout, proyección mensual, DRIP a 10 años.', b: (sym, pf) => `Actúa como un estratega jefe de inversiones especializado en estrategias de renta variable orientadas a generar ingresos.\n\nNecesito un portafolio de dividendos que genere ingresos pasivos confiables (acciones/ETFs de EE.UU. disponibles en Racional).\n\nCONSTRUYE:\n• Selección de 15–20 acciones de dividendos con ticker y rendimiento actual.\n• Puntaje de seguridad del dividendo para cada acción, en escala de 1 a 10.\n• Años consecutivos de crecimiento del dividendo.\n• Análisis del payout ratio para detectar dividendos insostenibles.\n• Proyección de ingreso mensual según mi monto de inversión.\n• Desglose de diversificación sectorial.\n• Estimación de crecimiento del dividendo a 5 años.\n• Proyección de reinversión DRIP y efecto compuesto a 10 años.\n• Implicaciones fiscales para un residente en Chile.\n• Ranking desde las opciones más seguras hasta las más agresivas.\n\nPRESÉNTALO COMO UN BLUEPRINT PROFESIONAL DE PORTAFOLIO DE DIVIDENDOS, con tabla y proyección de ingresos.\n\nMI SITUACIÓN:\n[MONTO TOTAL · META DE INGRESO MENSUAL]\n\nMI CARTERA ACTUAL:\n${pf}` },
  { n: 8, t: 'Ventaja competitiva · estilo Bain & Company', s: 'Top competidores, márgenes, moat, cuota de mercado, I+D, FODA, mejor elección y catalizadores.', b: (sym) => `Actúa como un socio sénior en Bain & Company que realiza un análisis de estrategia competitiva para evaluar una industria.\n\nNecesito un panorama competitivo completo para identificar la mejor acción dentro del sector de la siguiente empresa.\n\nCOMPARA:\n• Top 5–7 competidores del sector con comparación de capitalización bursátil.\n• Comparación de ingresos y márgenes de beneficio en formato de tabla.\n• Análisis del foso competitivo: marca, costos, red y switching.\n• Tendencias de participación de mercado en los últimos 3 años.\n• Calidad de la administración según su historial de asignación de capital.\n• Pipeline de innovación y comparación del gasto en I+D.\n• Principales amenazas del sector: regulación, disrupción y macro.\n• Análisis FODA de las 2 compañías principales.\n• Mi mejor elección de acción, con justificación clara.\n• Catalizadores que podrían mover la acción ganadora en 12 meses.\n\nPRESÉNTALO COMO UN RESUMEN EJECUTIVO DE ESTRATEGIA COMPETITIVA, con tablas comparativas y recomendación final.\n\nEMPRESA DE REFERENCIA (datos actuales):\n${sym}` },
  { n: 9, t: 'Identificador de patrones · Renaissance Technologies', s: 'Estacionalidad, día de la semana, eventos Fed/CPI, insiders, institucionales, short squeeze, opciones.', b: (sym) => `Actúa como un investigador cuantitativo que utiliza métodos basados en datos para encontrar patrones y anomalías estadísticas en el mercado de acciones.\n\nNecesito identificar patrones ocultos y anomalías en el comportamiento de una acción.\n\nINVESTIGA:\n• Patrones estacionales: mejores y peores meses históricamente.\n• Patrones por día de la semana, si existen.\n• Correlación con eventos de mercado importantes: Fed, CPI y otros.\n• Patrones de compra y venta de insiders a partir de reportes recientes.\n• Tendencia de propiedad institucional.\n• Análisis de interés en corto y potencial de short squeeze.\n• Actividad inusual de opciones que merezca seguimiento.\n• Comportamiento del precio alrededor de resultados.\n• Señales de rotación sectorial que afecten esta acción.\n• Resumen del edge estadístico.\n\nPRESÉNTALO COMO UN MEMO PROFESIONAL DE RESEARCH CUANTITATIVO, con tablas de datos y resúmenes de patrones.\n\nACCIÓN Y PERIODO (últimos 12 meses; datos actuales):\n${sym}` },
  { n: 10, t: 'Impacto macro · nivel McKinsey', s: 'Tasas, inflación, PIB, dólar, empleo, Fed, riesgos globales, rotación sectorial y ajustes a mi cartera.', b: (sym, pf) => `Actúa como un socio sénior en estrategia macroeconómica que asesora a inversionistas institucionales sobre cómo las tendencias económicas afectan los mercados.\n\nNecesito un análisis macro que muestre cómo las condiciones actuales impactan mi portafolio.\n\nANALIZA:\n• Entorno actual de tasas de interés y su impacto en growth vs. value.\n• Tendencia de inflación y sectores beneficiados o perjudicados.\n• Pronóstico de crecimiento del PIB y su impacto en utilidades corporativas.\n• Fortaleza del dólar y efecto sobre mis posiciones (invierto en USD desde Chile; también me afecta el USD/CLP).\n• Tendencias de empleo y gasto del consumidor.\n• Perspectiva de la Reserva Federal para los próximos 6–12 meses.\n• Riesgos globales: geopolítica, comercio y cadenas de suministro.\n• Recomendación de rotación sectorial según el ciclo actual.\n• Ajustes específicos que debería considerar en mi portafolio ahora mismo.\n• Línea de tiempo de impacto.\n\nPRESÉNTALO COMO UN BRIEFING EJECUTIVO DE ESTRATEGIA MACRO, con escenarios clave y un plan de acción claro.\n\nMI PORTAFOLIO:\n${pf}\n\nMI MAYOR PREOCUPACIÓN: [ESCRÍBELA AQUÍ]` },
];

function portfolioText() {
  const { open } = positions();
  if (!open.length) return '(cartera vacía)';
  const total = open.reduce((a, p) => a + (p.value || 0), 0);
  return open.map((p) => `- ${p.sym}: ${p.qty > 0 ? `${fmtQ(p.qty)} acc. a ${fmtUSD(p.avg)} promedio` : `inversión ${fmtUSD(p.cost)}`} · valor ${fmtUSD(p.value)} (${fmtN((p.value || 0) / total * 100, 1)}%) · resultado ${pct(p.pnlPct)} · señal modelo ${SIG_LABEL[p.data?.signal] || '—'} ${p.data?.score ?? ''}/100`).join('\n') + `\nTOTAL: ${fmtUSD(total)}`;
}

// ---- AJUSTES ----------------------------------------------------------------
function viewAjustes() {
  const used = (() => { try { let n = 0; for (const k in localStorage) if (Object.prototype.hasOwnProperty.call(localStorage, k)) n += (localStorage.getItem(k) || '').length * 2; return n; } catch { return 0; } })();
  const d = S.data;
  const pending = (S.book.pending || []).filter((s) => !tk(s));
  return `<div class="card"><h2 style="margin-top:0">📡 Datos</h2>
    <div class="kv"><div><span>Análisis diario</span><b>${esc(fmtStamp(d.generated_at))}</b></div><div><span>Precios intradía</span><b>${S.quotes ? esc(fmtStamp(S.quotes.generated_at)) : '—'}</b></div>
    <div><span>Modo</span><b>${d.demo ? 'DEMO (sintético)' : 'Real (Yahoo Finance)'}</b></div><div><span>Activos OK / fallidos</span><b>${d.stats?.ok} / ${d.stats?.failed}</b></div>
    <div><span>Carteras publicadas</span><b>${S.pub.length}${S.pubAt ? ` · ${relTime(S.pubAt)}` : ''}</b></div>
    <div><span>Noticias con IA</span><b>${d.news_stats?.ai ? `${d.news_stats.ai} de ${d.news_stats.unique}` : 'no (solo heurística)'}</b></div><div><span>App</span><b>v${APP_VERSION}</b></div>
    <div><span>Último modo</span><b>${esc(d.mode || '—')}</b></div><div><span>Duró</span><b>${d.elapsed_s ? Math.round(d.elapsed_s / 60) + ' min' : '—'}</b></div>
    <div><span>Metadatos frescos</span><b>${d.stats?.meta_refreshed ?? '—'}</b></div><div><span>Gurús seguidos</span><b>${Object.keys(d.investors || {}).length}</b></div></div>
    ${d.failed?.length ? `<details><summary class="small">Fallidos (${d.failed.length})</summary><div class="tiny muted">${d.failed.map((f) => `${f.sym}: ${esc(f.error)}`).join('<br>')}</div></details>` : ''}
    <p class="small muted">El análisis completo se regenera cada día hábil al cierre; las cotizaciones cada hora en horario de mercado. Solo se guarda el último snapshot: el almacenamiento no crece.</p>
    <div class="btn-row"><button class="btn secondary" data-action="updateMarket">⟳ Buscar datos nuevos</button></div>
    <p class="tiny muted">Todo es automático: no hay nada que configurar. El servidor recalcula precios y señales cada hora de mercado, las noticias cada 3 horas y el análisis completo de los ${d.tickers.length} activos cada día al cierre.</p></div>

    <div class="card"><h2 style="margin-top:0">📈 Precios en vivo <small>opcional</small></h2>
    <p class="small muted">Con una clave gratuita de <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io</a> la app actualiza cada minuto el precio de tus posiciones y del activo que estés mirando (mientras la app esté abierta).</p>
    <label class="field">Clave Finnhub<input id="finnhubKey" type="text" autocomplete="off" autocapitalize="off" placeholder="pega aquí tu API key" value="${esc(S.settings.finnhubKey || '')}"></label>
    <div class="btn-row"><button class="btn secondary sm" data-action="saveKeys">Guardar</button><button class="btn secondary sm" data-action="testLive">Probar</button></div></div>

    ${pending.length ? `<div class="card"><h2 style="margin-top:0">🎯 Tickers pendientes</h2>
    <p class="small muted">Símbolos que pediste desde el buscador y todavía no están en el radar.</p>
    <div class="chips wrap">${pending.map((s) => `<span class="chip gray">${esc(s)}</span>`).join('')}</div>
    <div class="btn-row"><button class="btn sm" data-action="syncRadar">➕ Agregar al radar</button><button class="btn secondary sm" data-action="copyPending">Copiar lista</button><button class="btn secondary sm" data-action="clearPending">Limpiar</button></div>
    <p class="tiny muted">Se abre GitHub con la lista ya escrita: pulsa "Submit new issue" y el sitio los analiza en unos minutos.</p></div>` : ''}

    <div class="card"><h2 style="margin-top:0">💬 Chat con Claude <small>opcional</small></h2>
    <p class="small muted">Las mesas de análisis y el asistente funcionan sin ninguna clave. Si además quieres conversar en vivo con Claude sobre tu cartera, pega una clave de <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>. Se guarda solo en este dispositivo y el cobro corre por tu cuenta.</p>
    <label class="field">Clave de Claude<input id="aiKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(S.settings.aiKey || '')}"></label>
    <div class="btn-row"><button class="btn secondary sm" data-action="saveKeys">Guardar</button>${(S.settings.aiKey || '').trim() ? '<button class="btn danger sm" data-action="clearAiKey">Quitar clave</button>' : ''}</div></div>

    <div class="card"><h2 style="margin-top:0">🤖 Noticias con IA <small>opcional</small></h2>
    <p class="small muted">Para que las noticias lleguen <b>traducidas, resumidas y priorizadas por Claude</b>, agrega en GitHub → Settings → Secrets and variables → Actions un secreto llamado <code>ANTHROPIC_API_KEY</code>. El run diario clasifica hasta 250 titulares (costo aproximado US$0,5/día con claude-opus-5; la variable <code>NEWS_MODEL</code> permite elegir otro modelo).</p></div>

    <div class="card"><h2 style="margin-top:0">💾 Mi información</h2>
    <div class="kv"><div><span>Transacciones</span><b>${PF().tx.length}</b></div><div><span>Favoritos</span><b>${PF().fav.length}</b></div><div><span>Bitácora</span><b>${S.book.log.length}</b></div><div><span>Uso local</span><b>${fmtN(used / 1024, 0)} KB</b></div></div>
    <p class="small muted">Tu cartera vive solo en este teléfono (localStorage). Haz un respaldo periódico: el archivo sirve para restaurar en otro dispositivo.</p>
    <div class="btn-row"><button class="btn secondary" data-action="export">⬇️ Exportar respaldo</button><button class="btn secondary" data-action="import">⬆️ Importar</button></div>
    <label class="field row" style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="showClp" ${S.settings.showClp ? 'checked' : ''} style="width:auto;margin:0"> Mostrar equivalente en pesos chilenos (USD/CLP)</label>
    <button class="btn danger" data-action="reset">🗑 Borrar toda mi información local</button></div>

    <div class="card"><h2 style="margin-top:0">🔁 Bitácora de mejora continua</h2>
    <p class="small muted">Anota aquí lo que quieres cambiar de la app o del modelo. Luego cópiala y pégamela en el chat: cada versión aprende de tu feedback.</p>
    <label class="field">Nueva nota<textarea id="logText" placeholder="Ej: el score de largo plazo castiga demasiado a las empresas con deuda…"></textarea></label>
    <button class="btn secondary" data-action="addLog">＋ Guardar nota</button>
    ${S.book.log.slice().reverse().slice(0, 10).map((l) => `<div class="small" style="padding:6px 0;border-top:1px solid var(--border)"><span class="muted tiny">${l.d}</span><br>${esc(l.t)}</div>`).join('')}
    ${S.book.log.length ? `<button class="btn secondary sm" data-action="copyLog" style="margin-top:8px">📋 Copiar bitácora</button>` : ''}</div>

    <div class="card"><h2 style="margin-top:0">📐 Cómo se calcula la señal</h2>
    <ul class="reasons"><li><b>Corto plazo</b>: tendencia (SMA20/50), RSI y momentum 1M, MACD, volumen, Bandas de Bollinger.</li>
    <li><b>Mediano plazo</b>: consenso de analistas, potencial al precio objetivo, revisiones de EPS, crecimiento, momentum 3–6M y P/E forward.</li>
    <li><b>Largo plazo</b>: crecimiento de ingresos, márgenes y ROE, deuda, FCF yield, PEG/P/E, visión de analistas y tendencia anual.</li>
    <li><b>Global</b> = ${d.weights?.horizons?.short * 100}% corto + ${d.weights?.horizons?.medium * 100}% mediano + ${d.weights?.horizons?.long * 100}% largo. <b>Compra fuerte</b> exige ≥ ${d.weights?.signal?.strong_buy} y confluencia (mediano y largo ≥ ${d.weights?.signal?.strong_buy_min_horizon}). Con confianza baja no se emiten señales fuertes.</li>
    <li><b>Riesgo</b>: beta, volatilidad 30d, drawdown 1A, capitalización y liquidez.</li>
    <li><b>Noticias</b>: prioridad por tipo (resultados, rating, M&A, regulación, movimientos fuertes) + tu cartera; con IA, además traducción y resumen.</li></ul>
    <p class="tiny muted">Señal cuantitativa ≠ predicción segura: exige confluencia y gestiona el tamaño de posición. No es asesoría financiera.</p></div>`;
}

// ---- DETALLE DE ACTIVO --------------------------------------------------------
function openDetail(sym, silent = false) {
  const t = tk(sym);
  const page = $('#page'), c = $('#pageContent');
  const y = silent ? page.scrollTop : 0;
  if (!t) {
    c.innerHTML = `<div class="page-head"><button class="icon-btn" data-action="closePage">←</button><b>${esc(sym)}</b></div><div class="inner"><div class="empty">Este ticker no está en el radar todavía.<br><br><button class="btn secondary sm" data-action="requestTicker" data-sym="${esc(sym)}">Pedir que se agregue al radar</button></div></div>`;
    page.hidden = false; document.body.classList.add('locked'); return;
  }
  S.detail = sym;
  const a = t.analysts, hist = S.history[sym] || [];
  const { open } = positions(); const pos = open.find((p) => p.sym === sym);
  const fav = PF().fav.includes(sym);
  const cov = t.tech.rating;
  let html = `<div class="page-head"><button class="icon-btn" data-action="closePage" aria-label="Volver">←</button>
    <div class="grow"><div class="row"><span class="sym" style="font-size:18px">${t.sym}</span>${t.etf ? '<span class="tag">ETF</span>' : ''}${t.src === 'vivo' ? '<span class="tag live">vivo</span>' : t.src === 'intradia' ? '<span class="tag">intradía</span>' : ''}</div><div class="name ellipsis">${esc(t.name)}${t.sector ? ` · ${esc(t.sector)}` : ''}</div></div>
    <button class="icon-btn" data-action="fav" data-sym="${sym}" aria-label="Favorito" style="color:${fav ? 'var(--s)' : 'var(--muted)'}">${fav ? '★' : '☆'}</button></div><div class="inner">`;

  html += `<div class="card"><div class="between"><div><div class="hero mono">${fmtUSD(t.price)}</div><div class="mono ${cls(t.chg1d)}">${pct(t.chg1d)} hoy</div></div>
    <div class="center">${chip(t.signal)}<div class="hero mono t-${sigClass(t.signal)}" style="font-size:34px">${t.score ?? '—'}</div><div class="tiny muted">/100 · confianza ${t.conf}</div></div></div>
    ${spark(t.tech.spark, { big: true })}<div class="between tiny muted mono"><span>6 meses</span><span>1S ${pct(t.tech.ret?.['1w'])} · 1M ${pct(t.tech.ret?.['1m'])} · 3M ${pct(t.tech.ret?.['3m'])} · 1A ${pct(t.tech.ret?.['1y'])}</span></div></div>`;

  if (pos) html += `<div class="card" style="border-color:var(--accent)"><div class="between"><b>💼 Mi posición</b><span class="mono ${cls(pos.pnl)}">${pct(pos.pnlPct)} · ${fmtUSD(pos.pnl)}</span></div>
    <div class="small muted mono">${pos.qty > 0 ? `${fmtQ(pos.qty)} acciones · promedio ${fmtUSD(pos.avg)}` : `inversión ${fmtUSD(pos.cost)}`} · valor ${fmtUSD(pos.value)}</div>${positionAdvice(t, pos)}</div>`;

  if (t.gurus?.length) html += `<div class="card"><div class="between"><b>🏆 Inversionistas que la tienen</b><span class="tag">${t.gurus.length}</span></div>
    <div class="chips wrap" style="margin-top:6px">${t.gurus.map((g) => `<span class="chip gray" title="${esc(S.data.investors?.[g] || g)}">${esc(g)}</span>`).join('')}</div>
    <div class="tiny muted" style="margin-top:4px">${esc(S.data.investors_note || '')}</div></div>`;

  html += `<div class="btn-row"><button class="btn green" data-action="addTx" data-type="buy" data-sym="${sym}">＋ Compré</button><button class="btn danger" data-action="addTx" data-type="sell" data-sym="${sym}" ${pos && pos.qty > 0 ? '' : 'disabled'}>－ Vendí</button></div>`;

  html += `<div class="card"><h2 style="margin-top:0">Señal por horizonte</h2><div class="hbars">${['short', 'medium', 'long'].map((h) => scoreBar(t.h[h].s, HZ[h], t.h[h].sig)).join('')}</div>
    <div class="between" style="margin-top:10px"><span class="small muted">Riesgo</span><span class="chip ${t.risk.label === 'Alto' ? 'strong_sell' : t.risk.label === 'Medio' ? 'hold' : 'strong_buy'} sm">${t.risk.label} ${t.risk.s ?? ''}</span></div>
    ${['short', 'medium', 'long'].map((h) => { const parts = Object.entries(t.h[h].parts || {}).filter(([, v]) => v != null); return parts.length ? `<details><summary class="small">Desglose ${HZ[h].toLowerCase()}</summary><div class="hbars" style="margin:6px 0">${parts.map(([k, v]) => scoreBar(v, PART_LABEL[k] || k)).join('')}</div></details>` : ''; }).join('')}
    ${t.reasons.length ? `<h3>Por qué</h3><ul class="reasons">${t.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</div>`;

  const an = analystBlock(t);
  if (an) html += `<div class="card">${an}</div>`;

  html += `<div class="card"><div class="between"><h2 style="margin:0">Técnico</h2>${cov ? chip(cov.label) : ''}</div>
    ${cov ? `<div class="small muted">${cov.buy} indicadores compran · ${cov.neutral} neutrales · ${cov.sell} venden (estilo TradingView)</div>` : ''}
    <div class="kv" style="margin-top:8px"><div><span>RSI 14</span><b class="${t.tech.rsi > 70 ? 'down' : t.tech.rsi < 30 ? 'up' : ''}">${t.tech.rsi ?? '—'}</b></div><div><span>MACD hist.</span><b class="${cls(t.tech.macd_hist)}">${t.tech.macd_hist ?? '—'}</b></div>
    <div><span>SMA 20</span><b class="${cls(t.price - t.tech.sma20)}">${fmtN(t.tech.sma20, 2)}</b></div><div><span>SMA 50</span><b class="${cls(t.price - t.tech.sma50)}">${fmtN(t.tech.sma50, 2)}</b></div>
    <div><span>SMA 200</span><b class="${cls(t.price - t.tech.sma200)}">${fmtN(t.tech.sma200, 2)}</b></div><div><span>Bollinger %B</span><b>${t.tech.bb_pct ?? '—'}</b></div>
    <div><span>Máx / mín 52s</span><b>${fmtN(t.tech.hi52, 0)} / ${fmtN(t.tech.lo52, 0)}</b></div><div><span>Volumen vs 50d</span><b>${t.tech.vol_ratio ?? '—'}x</b></div>
    <div><span>Volatilidad 30d</span><b>${t.tech.vol30 ?? '—'}%</b></div><div><span>Drawdown 1A</span><b class="down">${t.tech.max_dd ?? '—'}%</b></div></div></div>`;

  const f = t.fund;
  if (!t.etf) html += `<div class="card"><h2 style="margin-top:0">Fundamentales</h2><div class="kv">
    <div><span>Capitalización</span><b>${big(f.market_cap)}</b></div><div><span>Beta</span><b>${f.beta ?? '—'}</b></div>
    <div><span>P/E</span><b>${f.trailing_pe ?? '—'}</b></div><div><span>P/E forward</span><b>${f.forward_pe ?? '—'}</b></div>
    <div><span>PEG</span><b>${f.peg ?? '—'}</b></div><div><span>Crec. ingresos</span><b class="${cls(f.revenue_growth)}">${pct(f.revenue_growth)}</b></div>
    <div><span>Crec. utilidades</span><b class="${cls(f.earnings_growth)}">${pct(f.earnings_growth)}</b></div><div><span>Margen neto</span><b class="${cls(f.profit_margin)}">${pct(f.profit_margin, 1, false)}</b></div>
    <div><span>ROE</span><b>${pct(f.roe, 1, false)}</b></div><div><span>Deuda / patrimonio</span><b>${f.debt_to_equity ?? '—'}</b></div>
    <div><span>FCF yield</span><b>${pct(f.fcf_yield, 1, false)}</b></div><div><span>Dividendo</span><b>${pct(f.dividend_yield, 2, false)}</b></div></div>
    ${t.earnings_date ? `<p class="small">📅 Próximos resultados: <b>${t.earnings_date}</b></p>` : ''}</div>`;

  if (hist.length >= 2) html += `<div class="card"><h2 style="margin-top:0">Evolución del score <small>${hist.length} días</small></h2>${spark(hist.map((h) => h.s ?? 50), { big: true, color: 'var(--accent)' })}
    <div class="between tiny muted mono"><span>${hist[0].d}: ${hist[0].s} (${SIG_LABEL[hist[0].sig]})</span><span>${hist[hist.length - 1].d}: ${hist[hist.length - 1].s}</span></div></div>`;

  if (t.news?.length) {
    const mine = held(), favs = new Set(PF().fav);
    const items = t.news.map((n) => { const r = newsRank({ ...n, sym }, mine, favs, new Set()); return { ...n, sym, rank: r, lvl: newsLevel(r), mine: mine.has(sym) }; }).sort((x, y2) => y2.rank - x.rank);
    html += `<div class="card news"><h2 style="margin-top:0">Noticias</h2>${items.map(newsItem).join('')}</div>`;
  }

  html += `<button class="btn secondary" data-action="copyPrompt" data-kind="super" data-sym="${sym}">🤖 Copiar superprompt IA de ${sym}</button>
    <p class="tiny muted center">Señal cuantitativa, no asesoría financiera. Datos: Yahoo Finance · ${S.data.date}</p></div>`;
  c.innerHTML = html; page.hidden = false; page.scrollTop = y; document.body.classList.add('locked');
  if (!silent) refreshLive([sym]);
}

function targetRange(price, tg) {
  const lo = Math.min(tg.low ?? price, price) * 0.97, hi = Math.max(tg.high ?? price, price) * 1.03, span = hi - lo || 1;
  const x = (v) => `${((v - lo) / span) * 100}%`;
  return `<h3>Precio objetivo (12 meses)</h3><div class="range"><div class="track"></div>${tg.low && tg.high ? `<div class="seg2" style="left:${x(tg.low)};width:${((tg.high - tg.low) / span) * 100}%"></div>` : ''}
    <div class="dot" style="left:${x(price)};background:var(--text)" title="Precio actual"></div><div class="dot" style="left:${x(tg.mean)};background:var(--accent)" title="Objetivo medio"></div></div>
    <div class="between tiny muted mono"><span>Bajo ${fmtUSD(tg.low, 0)}</span><span>Actual ${fmtUSD(price, 0)}</span><span>Medio <b class="${cls(tg.mean - price)}">${fmtUSD(tg.mean, 0)} (${pct((tg.mean / price - 1) * 100, 0)})</b></span><span>Alto ${fmtUSD(tg.high, 0)}</span></div>`;
}

function positionAdvice(t, pos) {
  const s = t.signal, lg = t.h.long.s ?? 50, sh = t.h.short.s ?? 50;
  let msg;
  if (s === 'strong_buy') msg = 'El modelo respalda la posición. Aumentar solo si el peso en cartera lo permite (evita superar 20–25%).';
  else if (s === 'buy') msg = 'Mantener. Si quieres aumentar, hazlo en compras escalonadas.';
  else if (s === 'hold') msg = sh < 40 && lg >= 60 ? 'Debilidad de corto plazo con tesis de largo plazo intacta: mantener sin aumentar.' : 'Mantener y vigilar. No es momento de agregar.';
  else if (s === 'sell') msg = (pos.pnlPct ?? 0) > 0 ? 'Considera tomar ganancias parciales (p. ej. 30–50%) y subir el stop.' : 'Revisa la tesis; considera reducir para limitar la pérdida.';
  else msg = 'Señal de salida: considera cerrar o reducir fuertemente la posición.';
  return `<p class="small" style="margin-top:6px">🧭 ${msg}</p>`;
}

// ---- TRANSACCIONES ------------------------------------------------------------
function openTxSheet({ type = 'buy', sym = '', id = null } = {}) {
  const t = id ? PF().tx.find((x) => x.id === id) : null;
  if (t) { type = t.type; sym = t.sym; }
  const d = tk(sym);
  const { open } = positions(); const pos = open.find((p) => p.sym === sym);
  const syms = S.data.tickers.map((x) => x.sym);
  const html = `<h2 style="margin-top:4px">${t ? 'Editar movimiento' : type === 'buy' ? '🟢 Registrar compra' : '🔴 Registrar venta'}</h2>
    <p class="tiny muted">Ingresa lo mismo que ves en Racional. La app calcula precio promedio, ganancia y guarda qué decía el modelo ese día.</p>
    <div class="seg" id="txType"><button data-v="buy" class="${type === 'buy' ? 'on' : ''}">Compra</button><button data-v="sell" class="${type === 'sell' ? 'on' : ''}">Venta</button></div>
    <label class="field">Ticker<input id="txSym" list="symList" value="${esc(sym)}" placeholder="NVDA" autocapitalize="characters" autocomplete="off" ${t ? 'readonly' : ''}><datalist id="symList">${syms.map((s) => `<option value="${s}">`).join('')}</datalist></label>
    <div class="grid2"><label class="field">Cantidad${pos && pos.qty > 0 ? ` <span class="muted">(tienes ${fmtQ(pos.qty)})</span>` : ''}<input id="txQty" type="number" inputmode="decimal" step="any" min="0" value="${t ? (t.qty ?? '') : ''}" placeholder="10"></label>
    <label class="field">Precio USD<input id="txPrice" type="number" inputmode="decimal" step="any" min="0" value="${t ? (t.price ?? '') : d?.price ?? ''}" placeholder="180.50"></label></div>
    <label class="field">Fecha<input id="txDate" type="date" value="${t ? t.date : today()}" max="${today()}"></label>
    <label class="field">Nota (por qué) — opcional<textarea id="txNote" placeholder="Ej: compré por ruptura técnica + revisiones EPS positivas">${esc(t?.note || '')}</textarea></label>
    <div class="tiny muted" id="txPreview"></div>
    <div class="btn-row"><button class="btn" data-action="saveTx" data-id="${t?.id || ''}">Guardar</button>${t ? `<button class="btn danger" data-action="deleteTx" data-id="${t.id}">Eliminar</button>` : ''}</div>`;
  openSheet(html);
  $('#txType').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; for (const x of e.currentTarget.children) x.classList.toggle('on', x === b); txPreview(); });
  for (const id2 of ['txSym', 'txQty', 'txPrice']) $('#' + id2).addEventListener('input', txPreview);
  txPreview();
}
function txPreview() {
  const sym = $('#txSym').value.trim().toUpperCase();
  const qty = +$('#txQty').value, price = +$('#txPrice').value; const d = tk(sym);
  let s = '';
  if (sym && !d) s += `⚠️ ${sym} no está en el radar: se guardará y quedará pendiente de agregar (Ajustes). `;
  if (qty > 0 && price > 0) s += `Total: <b>${fmtUSD(qty * price)}</b>${usdclp() ? ` ≈ ${fmtCLP(qty * price * usdclp())}` : ''}. `;
  if (d) s += `Modelo hoy: ${SIG_LABEL[d.signal]} ${d.score}/100.`;
  $('#txPreview').innerHTML = s;
}
function saveTx(id) {
  const type = $('#txType .on')?.dataset.v || 'buy', sym = $('#txSym').value.trim().toUpperCase();
  const qty = +$('#txQty').value, price = +$('#txPrice').value, date = $('#txDate').value || today(), note = $('#txNote').value.trim();
  if (!sym || !/^[A-Z0-9.\-^=]{1,12}$/.test(sym)) return toast('Ticker inválido');
  if (!(qty > 0) || !(price > 0)) return toast('Cantidad y precio deben ser mayores a 0');
  if (type === 'sell' && !id) { const p = positions().open.find((x) => x.sym === sym); if (!p || p.qty + 1e-9 < qty) return toast(`No tienes ${qty} de ${sym} para vender`); }
  const d = tk(sym);
  if (!d) addPending(sym);
  const rec = { id: id || uid(), sym, type, qty, price, date, note, sig: d?.signal || null, score: d?.score ?? null };
  if (id) { const i = PF().tx.findIndex((x) => x.id === id); const old = PF().tx[i]; PF().tx[i] = { ...old, qty, price, date, note, type, amount: undefined, snapValue: undefined }; }
  else PF().tx.push(rec);
  savePf(); closeSheet(); toast(type === 'buy' ? 'Compra registrada' : 'Venta registrada');
  if (!$('#page').hidden && S.detail) openDetail(S.detail); render();
}
/** Posiciones abiertas cuyo símbolo todavía no está en el radar. */
function missingFromRadar() {
  return positions().open.filter((p) => !tk(p.sym)).map((p) => p.sym);
}

/** Abre un issue de GitHub ya rellenado con la cartera. El propio repositorio
 *  la publica, mete los símbolos nuevos al radar y los analiza. Sin credenciales:
 *  basta con la sesión de GitHub del navegador. */
function syncToRadar() {
  const repo = `${REPO.owner}/${REPO.name}`;
  const pf = PF();
  const tx = pf.tx.map((t) => ({ s: t.sym, t: t.type === 'sell' ? 'sell' : undefined, q: +(+t.qty).toFixed(6), p: +(+t.price).toFixed(4), d: t.date }))
    .map((t) => (t.t ? t : { s: t.s, q: t.q, p: t.p, d: t.d }));
  const watch = (S.book.pending || []).filter((x) => !tk(x)).slice(0, 20);
  const payload = { app: 'mia', v: 1, watch, pf: { id: (pf.id || 'mia').replace(/^pub:/, ''), name: pf.name, fav: pf.fav || [], tx } };
  const faltan = missingFromRadar();
  const body = `La app generó esto. Publica \`Submit new issue\` y el repositorio hace el resto.\n\n`
    + `Posiciones: ${positions().open.length}${faltan.length ? ` · nuevas para el radar: ${faltan.join(', ')}` : ''}`
    + `${watch.length ? ` · en observación: ${watch.join(', ')}` : ''}\n\n`
    + '```json\n' + JSON.stringify(payload) + '\n```';
  const url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent('cartera: ' + pf.name)}&body=${encodeURIComponent(body)}`;
  if (url.length > 7500) {                      // URL demasiado larga: se va por el portapapeles
    copy('```json\n' + JSON.stringify(payload) + '\n```');
    window.open(`https://github.com/${repo}/issues/new?title=${encodeURIComponent('cartera: ' + pf.name)}`, '_blank', 'noopener');
    return toast('Cartera copiada: pégala en el cuerpo del issue');
  }
  window.open(url, '_blank', 'noopener');
  toast('Pulsa "Submit new issue" y listo');
}

function addPending(sym) { if (!S.book.pending) S.book.pending = []; if (!S.book.pending.includes(sym)) { S.book.pending.push(sym); savePf(); } }

// ----------------------------------------------------------------------------
// Carteras: cambiar, crear, renombrar, compartir
// ----------------------------------------------------------------------------
function openBookSheet() {
  const row = (p, grupo) => {
    const { open } = positionsOf(p);
    const val = open.reduce((a, x) => a + (x.value || 0), 0);
    return `<div class="pf-row ${p.id === S.book.active ? 'on' : ''}" data-action="pfSwitch" data-id="${p.id}">
      <span class="dot"></span>
      <div class="grow"><b>${esc(p.name)}</b>${grupo === 'pub' || isPub(p.id) ? ' <span class="tag">en el enlace</span>' : ''}${p.ro && grupo !== 'pub' ? ' <span class="tag">solo lectura</span>' : ''}
        <div class="tiny muted">${open.length} posiciones · ${fmtUSD(val)}${p.updated ? ` · ${relTime(p.updated)}` : ''}</div></div>
      ${p.id === S.book.active ? '<span class="chip accent sm">activa</span>' : ''}</div>`;
  };
  const locales = S.book.list.filter((p) => p.tx.length || p.id === S.book.active).map((p) => row(p, 'local')).join('');
  const conDatos = new Set(S.book.list.filter((x) => x.tx.length).map((x) => x.id));
  const pubs = S.pub.filter((p) => !conDatos.has(p.baseId)).map((p) => row({ ...p, ro: true }, 'pub')).join('');

  openSheet(`<h2 style="margin-top:4px">Mis carteras</h2>

    <h3>📱 En este dispositivo</h3>
    <p class="tiny muted">Guardadas solo en este teléfono o computador. No se ven desde otro aparato.</p>
    ${locales || '<div class="empty small">Ninguna en este dispositivo.</div>'}

    <h3>🔗 Publicadas en el enlace</h3>
    <p class="tiny muted">Viven en el propio sitio, así que se ven igual desde cualquier dispositivo y cualquiera que abra el enlace puede mirarlas (sin editarlas).</p>
    ${pubs || (S.pub.length ? '<div class="tiny muted">La tuya ya está publicada; aparece arriba con la etiqueta "en el enlace".</div>' : '<div class="empty small">Ninguna publicada todavía.</div>')}

    <p class="tiny muted" style="margin-top:12px">La cartera publicada se mantiene sola desde el propio sitio: no hay tokens ni claves que configurar. Si quieres cambiar la que está publicada, dímelo en el chat y la actualizo en el enlace.</p>

    <div class="btn-row" style="margin-top:10px"><button class="btn secondary" data-action="pfNew">＋ Nueva</button>
      <button class="btn secondary" data-action="pfShare">📤 Compartir por enlace</button></div>
    <div class="btn-row"><button class="btn secondary sm" data-action="pfRename">Renombrar</button>
      ${S.book.list.length > 1 && !isPub() ? `<button class="btn danger sm" data-action="pfDelete">Eliminar de este dispositivo</button>` : ''}</div>`);
}

function pfSwitch(id) {
  if (!allPortfolios().some((p) => p.id === id)) return;
  S.book.active = id; savePf(); closeSheet(); S.detail = null; render(); syncHeader();
  toast(`Cartera: ${PF().name}`);
}
function pfNew(name, tx = [], ro = false) {
  const p = { id: uid(), name: (name || 'Nueva cartera').slice(0, 40), ro, tx, fav: [] };
  S.book.list.push(p); S.book.active = p.id; savePf(); render(); syncHeader();
  return p;
}
function syncHeader() { const el = $('#pfName'); if (el) el.textContent = PF().name; }

/** Enlace compartible: la cartera viaja comprimida en el # de la URL, sin servidores. */
function encodePortfolio(p) {
  const { open } = positionsOf(p);
  const rows = open.map((x) => [x.sym, +(x.qty || 0).toFixed(6), +(x.avg || 0).toFixed(4)].join(':')).join(';');
  const payload = `${p.name.replace(/[|;]/g, ' ')}|${rows}`;
  return btoa(unescape(encodeURIComponent(payload))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodePortfolio(code) {
  try {
    const json = decodeURIComponent(escape(atob(code.replace(/-/g, '+').replace(/_/g, '/'))));
    const [name, rows] = json.split('|');
    const tx = (rows || '').split(';').filter(Boolean).map((r, i) => {
      const [sym, qty, price] = r.split(':');
      return { id: 'sh' + i, sym, type: 'buy', qty: +qty, price: +price, date: today(), note: 'Cartera compartida' };
    });
    return tx.length ? { name: name || 'Cartera compartida', tx } : null;
  } catch { return null; }
}
function pfShare() {
  const p = PF();
  const url = `${location.origin}${location.pathname}#p=${encodePortfolio(p)}`;
  openSheet(`<h2 style="margin-top:4px">Compartir "${esc(p.name)}"</h2>
    <p class="small muted">Quien abra este enlace verá tu cartera <b>en modo solo lectura</b>: no puede editarla ni afecta la tuya, y podrá crear la suya propia. El enlace lleva los datos dentro; si cambias posiciones, genera uno nuevo.</p>
    <textarea id="shareUrl" style="width:100%;height:110px;font-size:11px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);padding:8px">${esc(url)}</textarea>
    <div class="btn-row"><button class="btn" data-action="copyText" data-target="shareUrl">📋 Copiar enlace</button>
      ${navigator.share ? '<button class="btn secondary" data-action="shareUrlNative">Compartir…</button>' : ''}</div>`);
}
/** Si la URL trae una cartera compartida, se ofrece agregarla. */
function checkSharedLink() {
  const m = location.hash.match(/[#&]p=([A-Za-z0-9\-_]+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  const p = decodePortfolio(m[1]);
  if (!p) return toast('El enlace compartido no se pudo leer');
  if (S.book.list.some((x) => x.ro && x.name === p.name && x.tx.length === p.tx.length)) return;
  openSheet(`<h2 style="margin-top:4px">🔗 Cartera compartida</h2>
    <p class="small">Alguien compartió <b>${esc(p.name)}</b> con ${p.tx.length} posiciones. Se agregará en <b>solo lectura</b>: podrás verla y compararla, pero no editarla. Tu cartera no se toca.</p>
    <div class="btn-row"><button class="btn" data-action="pfAcceptShare">Agregar y ver</button>
      <button class="btn secondary" data-action="closeSheet">Ahora no</button></div>`);
  S.pendingShare = p;
}

// ----------------------------------------------------------------------------
// OCR: importar posiciones desde capturas de Racional
// ----------------------------------------------------------------------------
function openOcrSheet() {
  openSheet(`<h2 style="margin-top:4px">📷 Cargar capturas de Racional</h2>
    <p class="small muted">En la pantalla <b>Inicio</b> de Racional, captura la lista de acciones en las <b>dos vistas</b> del menú de la derecha:</p>
    <ul class="reasons small"><li><b>Último Precio</b> → entrega la cantidad exacta de acciones.</li>
    <li><b>Ganancia Total</b> → entrega tu resultado, para calcular el precio promedio de compra.</li></ul>
    <p class="tiny muted">Súbelas todas juntas. La app calcula el valor con el precio de mercado actual, no con el que muestra Racional. Todo ocurre en tu teléfono: las fotos no se envían a ningún lado.</p>
    <label class="btn" for="ocrFiles">Elegir capturas</label><input id="ocrFiles" type="file" accept="image/*" multiple hidden>
    <div id="ocrStatus" class="small muted" style="margin-top:10px"></div>
    <div id="ocrResult"></div>`);
  $('#ocrFiles').addEventListener('change', (e) => runOcr([...e.target.files]));
}

function parseAmount(s) {
  s = String(s).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}

/** Racional muestra siempre 8 decimales en la cantidad de acciones; el OCR a veces
 *  se come el separador ("298048048" en vez de "2,98048048"). Se reconstruye. */
function parseShares(s) {
  const raw = String(s).replace(/[^\d.,]/g, '');
  if (/[.,]/.test(raw)) return parseAmount(raw);
  const digits = raw.replace(/\D/g, '');
  if (digits.length > 8) return parseFloat(digits.slice(0, digits.length - 8) + '.' + digits.slice(-8));
  return parseFloat(digits) || null;
}

/** Extrae filas de una captura de Racional. Reconoce las dos vistas:
 *  · "Último Precio": ticker / precio de la acción / "N acciones"      → cantidad exacta
 *  · "Ganancia Total": ticker / ganancia / "USD X inversión"           → valor actual y ganancia
 *  Ojo: en Racional "inversión" es el VALOR ACTUAL de la posición, no el costo.
 */
function parseRacionalLines(lines) {
  const known = new Set(S.data.tickers.map((t) => t.sym));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const txt = lines[i].text;
    const mShares = txt.match(/([\d.,]{3,})\s*acc?[il1]on/i);
    const mValue = txt.match(/USD\s*([\d.,]+)\s*[il1]nvers/i);
    if (!mShares && !mValue) continue;
    let ticker = null, badge = null, badgeNeg = false;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const t = lines[j].text;
      if (/[il1]nvers|acc?[il1]on/i.test(t)) break;        // llegamos a la tarjeta anterior
      if (badge == null) {
        const g = t.match(/(-|−)?\s*USD\s*([\d.,]+)/i);
        if (g) { badge = parseAmount(g[2]); badgeNeg = !!g[1] || /[-−]\s*USD/.test(t); }
      }
      if (ticker == null && !/USD/i.test(t)) {
        const toks = (t.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) || []).filter((x) => !['USD', 'CLP'].includes(x));
        const pick = toks.find((x) => known.has(x)) || toks.sort((x, y) => y.length - x.length)[0];
        if (pick) ticker = pick;
      }
    }
    if (mShares) out.push({ sym: ticker || '', qty: parseShares(mShares[1]), rprice: badge });
    else out.push({ sym: ticker || '', value: parseAmount(mValue[1]), gain: badge == null ? null : (badgeNeg ? -badge : badge) });
  }
  return out;
}

async function runOcr(files) {
  if (!files.length) return;
  const st = $('#ocrStatus'), res = $('#ocrResult');
  if (!window.Tesseract) {
    st.textContent = 'Cargando motor de lectura (≈7 MB, solo la primera vez)…';
    await new Promise((ok, err) => { const s = document.createElement('script'); s.src = 'vendor/tess/tesseract.min.js'; s.onload = ok; s.onerror = err; document.head.appendChild(s); }).catch(() => { st.textContent = 'No se pudo cargar el motor OCR.'; });
    if (!window.Tesseract) return;
  }
  const base = new URL('vendor/tess/', location.href).href;
  let worker;
  try {
    worker = await Tesseract.createWorker('eng', 1, { workerPath: base + 'worker.min.js', corePath: base + 'tesseract-core-simd-lstm.wasm.js', langPath: base, gzip: true,
      logger: (m) => { if (m.status && m.progress != null) st.textContent = `${m.status === 'recognizing text' ? 'Leyendo' : 'Preparando'}… ${Math.round(m.progress * 100)}%`; } });
    await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzáéíóúñ0123456789.,-+ ' });
  } catch (e) { st.textContent = 'Error iniciando OCR: ' + e.message; return; }
  const found = [];
  for (let k = 0; k < files.length; k++) {
    st.textContent = `Leyendo captura ${k + 1} de ${files.length}…`;
    try {
      const { data } = await worker.recognize(files[k]);
      const lines = (data.lines || []).map((l) => ({ text: l.text.trim(), y: l.bbox.y0 })).filter((l) => l.text).sort((a, b) => a.y - b.y);
      found.push(...parseRacionalLines(lines));
    } catch (e) { console.warn('OCR', e); }
  }
  await worker.terminate();

  // Fusiona lo leído en todas las capturas: la vista de acciones aporta la cantidad
  // exacta y la de ganancia aporta el valor y el resultado.
  const bySym = {}, noSym = [];
  for (const f of found) {
    if (!f.sym) { noSym.push(f); continue; }
    const cur = bySym[f.sym] || (bySym[f.sym] = { sym: f.sym });
    for (const k of ['qty', 'value', 'gain', 'rprice']) if (f[k] != null) cur[k] = f[k];
  }
  const rows = [...Object.values(bySym), ...noSym].map(ocrRow).sort((a, b) => (b.value || 0) - (a.value || 0));
  S.ocr = rows;
  const conQty = rows.filter((r) => r.qty != null).length, conGain = rows.filter((r) => r.gain != null).length;
  st.innerHTML = rows.length
    ? `Detectadas <b>${rows.length}</b> posiciones · ${conQty} con cantidad de acciones · ${conGain} con ganancia.`
      + (noSym.length ? ` <span style="color:var(--s)">${noSym.length} sin ticker legible: escríbelo.</span>` : '')
    : 'No se detectaron posiciones. Captura la lista de acciones de la pantalla Inicio.';
  res.innerHTML = renderOcrTable();
}

/** Recalcula una fila: la cantidad manda y el valor sale del precio de mercado actual. */
function ocrRow(r) {
  const d = tk(r.sym);
  const price = d?.price ?? r.rprice ?? null;
  let qty = r.qty;
  if (qty == null && r.value != null && price) qty = r.value / price;      // sin cantidad: se deduce
  const value = (qty != null && price) ? qty * price : (r.value ?? null);  // valor a precio de mercado
  // El costo sale del valor calculado, no del número leído: si el OCR pierde la coma
  // ("4913" en vez de "49,13") la cantidad de acciones sigue dando el valor correcto.
  const cost = (value != null && r.gain != null) ? value - r.gain : null;
  const avg = (qty && cost != null) ? cost / qty : null;
  return { ...r, known: !!d, price, qty, value, cost, avg, on: r.on !== false };
}

function renderOcrTable() {
  if (!S.ocr?.length) return '';
  const sel = S.ocr.filter((r) => r.on);
  const total = sel.reduce((a, r) => a + (r.value || 0), 0);
  const totalCost = sel.reduce((a, r) => a + (r.cost ?? r.value ?? 0), 0);
  const faltaCosto = sel.some((r) => r.cost == null);
  return `<table class="ocr"><thead><tr><th></th><th>Ticker</th><th>Acciones</th><th>Valor USD</th><th>Ganancia</th><th>Prom.</th></tr></thead><tbody>
    ${S.ocr.map((r, i) => `<tr class="${r.on ? '' : 'off'}"><td><input type="checkbox" data-ocr="on" data-i="${i}" ${r.on ? 'checked' : ''}></td>
      <td><input data-ocr="sym" data-i="${i}" value="${esc(r.sym)}" placeholder="?" style="width:58px;${r.sym ? '' : 'border-color:var(--ss)'}" autocapitalize="characters">${r.known ? '' : `<div class="tiny" style="color:var(--s)">${r.sym ? 'fuera del radar' : 'escribe el ticker'}</div>`}</td>
      <td><input data-ocr="qty" data-i="${i}" inputmode="decimal" value="${r.qty != null ? +r.qty.toFixed(8) : ''}" placeholder="—" style="width:78px"></td>
      <td class="mono">${fmtUSD(r.value)}<div class="tiny muted">${r.price ? '@ ' + fmtUSD(r.price) : 'sin precio'}</div></td>
      <td><input data-ocr="gain" data-i="${i}" inputmode="decimal" value="${r.gain != null ? r.gain : ''}" placeholder="—" style="width:62px"></td>
      <td class="tiny mono">${r.avg ? fmtUSD(r.avg) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>
    <p class="small">Valor de la cartera detectado: <b>${fmtUSD(total)}</b> · costo <b>${fmtUSD(totalCost)}</b> · resultado <b class="${cls(total - totalCost)}">${fmtUSD(total - totalCost)}</b></p>
    ${faltaCosto ? `<p class="tiny" style="color:var(--s)">A algunas posiciones les falta la ganancia, así que su precio promedio se asume igual al de mercado. Sube también la vista <b>Ganancia Total</b> para que quede exacto.</p>` : ''}
    <p class="tiny muted">Importar <b>reemplaza</b> la posición de cada ticker detectado; los demás no se tocan.</p>
    <button class="btn" data-action="ocrImport">Importar ${sel.length} posiciones</button>`;
}

function ocrImport() {
  const rows = (S.ocr || []).filter((r) => r.on && r.sym && (r.qty > 0 || r.value > 0));
  if (!rows.length) return toast('Nada que importar');
  const d0 = today();
  for (const r of rows) {
    const sym = r.sym.toUpperCase();
    PF().tx = PF().tx.filter((t) => t.sym !== sym);
    const d = tk(sym);
    const avg = r.avg ?? r.price ?? null;
    PF().tx.push({
      id: uid(), sym, type: 'buy',
      qty: r.qty != null ? +r.qty.toFixed(8) : null,
      price: avg != null ? +avg.toFixed(4) : null,
      amount: r.cost ?? r.value ?? null, snapValue: r.value ?? null,
      date: d0, note: 'Importado desde captura de Racional', src: 'ocr',
      sig: d?.signal || null, score: d?.score ?? null,
    });
    if (!d) addPending(sym);
  }
  savePf(); closeSheet(); S.ocr = null; render(); toast(`Importadas ${rows.length} posiciones`);
}

// ----------------------------------------------------------------------------
// Sheet / page helpers
// ----------------------------------------------------------------------------
/** Copia la cartera publicada a este dispositivo para poder editarla. */
function adoptPub() {
  const pub = PF();
  if (!pub.pub) return false;
  const vacia = S.book.list.find((x) => !x.ro && !x.tx.length);
  const destino = vacia || { id: '', name: pub.name, ro: false, tx: [], fav: [] };
  destino.id = pub.baseId; destino.name = pub.name;
  destino.tx = pub.tx.map((t) => ({ ...t })); destino.fav = [...(pub.fav || [])];
  if (!vacia) S.book.list.push(destino);
  S.book.active = destino.id; savePf(); syncHeader();
  return true;
}

/** Las carteras compartidas no se editan: se ofrece copiarlas a una propia.
 *  La publicada sí: se copia sola a este dispositivo y la edición continúa. */
function roGuard() {
  if (!isRO()) return false;
  if (PF().pub && adoptPub()) { toast('Cartera copiada a este dispositivo para editarla'); render(); return false; }
  openSheet(`<h2 style="margin-top:4px">Cartera de solo lectura</h2>
    <p class="small">${PF().pub
      ? `"${esc(PF().name)}" es la cartera publicada en el enlace: se mantiene sola y no se edita desde el navegador. Duplícala para trabajar sobre una copia tuya en este dispositivo.`
      : `"${esc(PF().name)}" llegó por un enlace compartido, así que no se puede editar. Puedes duplicarla para trabajar sobre una copia tuya, o crear una cartera nueva desde cero.`}</p>
    <div class="btn-row"><button class="btn" data-action="pfDuplicate">Duplicar como mía</button>
      <button class="btn secondary" data-action="pfNew">Crear una vacía</button></div>`);
  return true;
}

function openSheet(html) { $('#sheetContent').innerHTML = html; $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; }
function closePage() { $('#page').hidden = true; document.body.classList.remove('locked'); S.detail = null; render(); }

function exportBackup() {
  const payload = { app: 'market-intelligence-ai', version: APP_VERSION, exported: new Date().toISOString(), book: S.book, settings: { showClp: S.settings.showClp } };
  const text = JSON.stringify(payload, null, 1);
  openSheet(`<h2 style="margin-top:4px">Respaldo</h2><p class="small muted">Copia este texto y guárdalo (Notas, correo, Drive). Para restaurar: Ajustes → Importar → pegar. No incluye tus claves.</p>
    <textarea id="bk" style="width:100%;height:220px;font-size:11px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);padding:8px">${esc(text)}</textarea>
    <div class="btn-row"><button class="btn" data-action="copyText" data-target="bk">📋 Copiar</button>${navigator.share ? '<button class="btn secondary" data-action="shareBk">Compartir…</button>' : ''}</div>`);
}
function importBackup() {
  openSheet(`<h2 style="margin-top:4px">Importar respaldo</h2><p class="small muted">Pega el JSON exportado. Se fusiona con lo existente (no duplica movimientos).</p>
    <textarea id="bkIn" style="width:100%;height:200px;font-size:12px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);padding:8px" placeholder='{"app":"market-intelligence-ai", ...}'></textarea>
    <button class="btn" data-action="doImport">Importar</button>`);
}
function doImport() {
  try {
    const j = JSON.parse($('#bkIn').value);
    if (j.book?.list?.length) {                        // respaldo v1.4: reemplaza el libro completo
      S.book = j.book; savePf(); saveSettings(); closeSheet(); render();
      return toast(`Restauradas ${j.book.list.length} cartera(s)`);
    }
    const pf = j.portfolio || j;
    if (!Array.isArray(pf.tx)) throw new Error('formato');
    const ids = new Set(PF().tx.map((t) => t.id));
    let n = 0; for (const t of pf.tx) if (t && t.sym && !ids.has(t.id)) { PF().tx.push({ ...t, id: t.id || uid() }); n++; }
    PF().fav = [...new Set([...(PF().fav || []), ...(pf.fav || [])])];
    S.book.log = [...(S.book.log || []), ...(pf.log || []).filter((l) => !S.book.log.some((x) => x.d === l.d && x.t === l.t))];
    if (j.settings?.showClp != null) S.settings.showClp = j.settings.showClp;
    savePf(); saveSettings(); closeSheet(); render(); toast(`Importados ${n} movimientos`);
  } catch { toast('JSON inválido'); }
}

// ----------------------------------------------------------------------------
// Eventos (delegación)
// ----------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { S.tab = tab.dataset.tab; for (const b of $('#tabbar').children) b.classList.toggle('active', b === tab); render(); return; }
  const seg = e.target.closest('[data-seg] [data-v]');
  if (seg && S.tab === 'radar') {
    const k = seg.closest('[data-seg]').dataset.seg, v = seg.dataset.v;
    if (k === 'type' && v === 'fav') S.radar.fav = !S.radar.fav;
    else if (k === 'type' && v === 'guru') S.radar.guru = !S.radar.guru;
    else if (k === 'type') { S.radar.type = v; S.radar.fav = false; S.radar.guru = false; } else S.radar[k] = v;
    S.radar.limit = RADAR_PAGE; render(); return;
  }
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action, sym = el.dataset.sym;
  switch (a) {
    case 'detail': if (sym) openDetail(sym); break;
    case 'book': openBookSheet(); break;
    case 'pfSwitch': pfSwitch(el.dataset.id); break;
    case 'pfNew': { const n = prompt('Nombre de la nueva cartera', 'Cartera ' + (S.book.list.length + 1)); if (n) { pfNew(n); closeSheet(); toast('Cartera creada'); } break; }
    case 'pfRename': { const n = prompt('Nuevo nombre', PF().name); if (n) { PF().name = n.slice(0, 40); savePf(); closeSheet(); render(); syncHeader(); } break; }
    case 'pfDelete': if (S.book.list.length > 1 && confirm(`¿Eliminar la cartera "${PF().name}"?`)) { S.book.list = S.book.list.filter((x) => x.id !== S.book.active); S.book.active = S.book.list[0].id; savePf(); closeSheet(); render(); syncHeader(); toast('Cartera eliminada'); } break;
    case 'pfShare': pfShare(); break;
    case 'pfDuplicate': { const src = PF(); pfNew(src.name + ' (mi copia)', src.tx.map((t) => ({ ...t, id: uid() })), false); closeSheet(); render(); toast('Cartera duplicada'); break; }
    case 'shareUrlNative': try { await navigator.share({ title: 'Mi cartera', url: $('#shareUrl').value }); } catch { /* cancelado */ } break;
    case 'pfAcceptShare': { const p = S.pendingShare;
      if (p) { let n = p.name; if (S.book.list.some((x) => x.name === n)) n = `${n} (compartida)`; pfNew(n, p.tx, true); S.pendingShare = null; }
      closeSheet(); render(); syncHeader(); break; }
    case 'carteraView': S.carteraView = el.dataset.v; render(); break;
    case 'desk': openDesk(el.dataset.id); break;
    case 'copyDesk': { const d = (S.desks?.desks || []).find((x) => x.id === el.dataset.id); if (d) copy(deskText(d)); break; }
    case 'chatSend': { const el2 = $('#chatText'); const q = el2?.value || ''; if (el2) el2.value = ''; aiSend(q); break; }
    case 'chatAsk': aiSend(el.dataset.q); break;
    case 'chatClear': S.chat = []; saveChat(); render(); break;
    case 'chatPrompt': { const pr = PROMPTS.find((x) => x.n === +el.dataset.n); const sy = $('#iaSym')?.value || S.iaSym; const t = tk(sy);
      S.tab = 'ia'; aiSend(pr.b(t ? tickerBrief(t) : sy, portfolioText())); break; }
    case 'radarView': S.radarView = el.dataset.v; render(); break;
    case 'closePage': closePage(); break;
    case 'closeSheet': closeSheet(); break;
    case 'addTx': if (roGuard()) break; openTxSheet({ type: el.dataset.type || 'buy', sym: sym || '' }); break;
    case 'editTx': if (roGuard()) break; openTxSheet({ id: el.dataset.id }); break;
    case 'saveTx': saveTx(el.dataset.id || null); break;
    case 'deleteTx': if (confirm('¿Eliminar este movimiento?')) { PF().tx = PF().tx.filter((t) => t.id !== el.dataset.id); savePf(); closeSheet(); render(); if (S.detail) openDetail(S.detail); } break;
    case 'fav': { const i = PF().fav.indexOf(sym); if (i >= 0) PF().fav.splice(i, 1); else PF().fav.push(sym); savePf(); openDetail(sym, true); break; }
    case 'reload': loadData(true); break;
    case 'updateMarket': updateMarket(); break;

    case 'ocr': if (roGuard()) break; openOcrSheet(); break;
    case 'ocrImport': ocrImport(); break;
    case 'moreRadar': S.radar.limit += RADAR_PAGE; render({ keepScroll: true }); break;
    case 'syncRadar': syncToRadar(); break;
    case 'requestTicker': if (sym) { addPending(sym); toast(`${sym} anotado. Agrégalo al radar desde Ajustes`); } break;
    case 'saveKeys': S.settings.finnhubKey = ($('#finnhubKey')?.value ?? S.settings.finnhubKey ?? '').trim();
      S.settings.aiKey = ($('#aiKey')?.value ?? S.settings.aiKey ?? '').trim(); saveSettings(); toast('Guardado'); render({ keepScroll: true }); break;
    case 'clearAiKey': S.settings.aiKey = ''; saveSettings(); toast('Clave eliminada'); render({ keepScroll: true }); break;
    case 'testLive': { S.settings.finnhubKey = ($('#finnhubKey')?.value || '').trim(); saveSettings(); await refreshLive(['AAPL']); toast(S.live.AAPL ? `OK: AAPL ${fmtUSD(S.live.AAPL.p)}` : 'Sin respuesta: revisa la clave'); break; }
    case 'copyPending': copy((S.book.pending || []).join(', ')); break;
    case 'clearPending': S.book.pending = []; savePf(); render({ keepScroll: true }); break;
    case 'export': exportBackup(); break;
    case 'import': importBackup(); break;
    case 'doImport': doImport(); break;
    case 'copyText': copy($('#' + el.dataset.target).value); break;
    case 'shareBk': try { await navigator.share({ title: 'Respaldo Market IA', text: $('#bk').value }); } catch { /* cancelado */ } break;
    case 'reset': if (confirm(`Se borrarán los movimientos y favoritos de "${PF().name}". ¿Continuar?`)) { PF().tx = []; PF().fav = []; savePf(); render(); toast('Cartera vaciada'); } break;
    case 'addLog': { const t = $('#logText').value.trim(); if (!t) return; S.book.log.push({ d: today(), t }); savePf(); render(); toast('Nota guardada'); break; }
    case 'copyLog': copy(S.book.log.map((l) => `[${l.d}] ${l.t}`).join('\n')); break;
    case 'copyPrompt': {
      const kind = el.dataset.kind;
      const s = sym || $('#iaSym')?.value || S.iaSym || S.detail || positions().open[0]?.sym || S.data.tickers[0]?.sym;
      if (kind === 'super') copy(buildSuperPrompt(s));
      else if (kind === 'portfolio') copy(buildPortfolioPrompt());
      else { const p = PROMPTS.find((x) => x.n === +el.dataset.n); const t = tk(s); copy(p.b(t ? tickerBrief(t) : s, portfolioText())); }
      break;
    }
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'radarQ') { S.radar.q = e.target.value; S.radar.limit = RADAR_PAGE; const pos = e.target.selectionStart; render(); const q = $('#radarQ'); q.focus(); q.setSelectionRange(pos, pos); }
  if (e.target.dataset.ocr && S.ocr) {
    const i = +e.target.dataset.i, k = e.target.dataset.ocr, r = S.ocr[i]; if (!r) return;
    if (k === 'on') r.on = e.target.checked;
    else if (k === 'sym') r.sym = e.target.value.toUpperCase().trim();
    else if (k === 'qty') r.qty = parseAmount(e.target.value);
    else r[k] = parseAmount(e.target.value);
    S.ocr[i] = ocrRow(r);
    const btn = $('#ocrResult .btn'); if (btn) btn.textContent = `Importar ${S.ocr.filter((x) => x.on).length} posiciones`;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'iaSym') { S.iaSym = e.target.value; render(); }
  if (e.target.id === 'calMonth') { S.calMonth = e.target.value; render({ keepScroll: true }); }
  if (e.target.id === 'showClp') { S.settings.showClp = e.target.checked; saveSettings(); }
  if (e.target.dataset.ocr && S.ocr) $('#ocrResult').innerHTML = renderOcrTable(); // recalcula cantidades al terminar de editar
});
$('#btnRefresh').addEventListener('click', () => updateMarket());
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'chatText' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const q = e.target.value; e.target.value = ''; aiSend(q); }
});
window.addEventListener('popstate', () => { if (!$('#page').hidden) closePage(); else if (!$('#sheet').hidden) closeSheet(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

loadData.at = 0;
syncHeader();
loadData();
checkSharedLink();
