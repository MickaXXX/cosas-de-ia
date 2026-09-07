/* Market Intelligence AI — app móvil (vanilla JS, sin dependencias)
 * Datos: docs/data/latest.json (diario) + history.json + quotes.json (intradía, cada hora).
 * Estado local: localStorage (cartera, favoritos, bitácora, claves opcionales). Sin servidores.
 */
'use strict';

const APP_VERSION = '1.3.0';
const REPO = { owner: 'MickaXXX', name: 'cosas-de-ia', workflow: 'update-data.yml', quotesWorkflow: 'quotes.yml', branch: 'main' };
const DATA_URL = './data/latest.json';
const HIST_URL = './data/history.json';
const QUOTES_URL = './data/quotes.json';
const LS = { portfolio: 'mia.portfolio.v1', cache: 'mia.cache.v1', settings: 'mia.settings.v1' };
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
  pf: loadJSON(LS.portfolio, { tx: [], fav: [], log: [], pending: [] }),
  settings: loadJSON(LS.settings, { showClp: true, finnhubKey: '', ghToken: '' }),
  ocr: null,
};

function loadJSON(k, d) { try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('No se pudo guardar (almacenamiento lleno)'); } }
function savePf() { pruneLocal(); saveJSON(LS.portfolio, S.pf); }
function saveSettings() { saveJSON(LS.settings, S.settings); }

/** Auto-gestión de almacenamiento local: límites suaves para no saturar el teléfono. */
function pruneLocal() {
  if (S.pf.log.length > 200) S.pf.log = S.pf.log.slice(-200);
  if (S.pf.tx.length > 2000) S.pf.tx = S.pf.tx.slice(-2000);
  if (!Array.isArray(S.pf.pending)) S.pf.pending = [];
  if (S.pf.pending.length > 100) S.pf.pending = S.pf.pending.slice(-100);
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
    const [d, h, q] = await Promise.all([
      fetchJSON(DATA_URL, force),
      fetchJSON(HIST_URL, force).catch(() => ({})),
      fetchJSON(QUOTES_URL, force).catch(() => null),
    ]);
    S.data = d; S.history = h || {}; S.quotes = q;
    applyQuotes();
    try { localStorage.setItem(LS.cache, JSON.stringify({ d, h, q })); } catch { /* caché opcional (puede no caber) */ }
  } catch (e) {
    const c = loadJSON(LS.cache, null);
    if (c && c.d) { S.data = c.d; S.history = c.h || {}; S.quotes = c.q || null; applyQuotes(); toast('Sin conexión: mostrando datos guardados'); }
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

/** Botón "Actualizar mercado": recarga, y con token pide precios + análisis rápido y espera el resultado. */
async function updateMarket(mode) {
  toast('Actualizando…');
  await loadData(true);
  const token = (S.settings.ghToken || '').trim();
  if (!token) { toast('Datos recargados. Agrega un token de GitHub en Ajustes para actualizar el mercado al instante.'); return; }
  const stampBefore = S.quotes?.generated_at || '';
  const okQ = await dispatchWorkflow(token, REPO.quotesWorkflow);
  const okA = await dispatchWorkflow(token, REPO.workflow, { mode: mode || 'fast', discover: 'false' });
  if (!okQ && !okA) { toast('No se pudo lanzar la actualización (revisa el token)'); return; }
  toast(mode === 'full' ? 'Análisis completo lanzado (~20 min)' : 'Actualizando precios y señales (~2 min)…');
  waitForFresh(stampBefore);
}

/** Espera a que GitHub publique el nuevo quotes.json y recarga solo. */
let waitTimer = null;
function waitForFresh(stampBefore, tries = 0) {
  clearTimeout(waitTimer);
  if (tries > 12) return;
  waitTimer = setTimeout(async () => {
    try {
      const q = await fetchJSON(QUOTES_URL, true);
      if (q && q.generated_at !== stampBefore) {
        await loadData(true);
        toast('Mercado actualizado');
        return;
      }
    } catch { /* aún no publica */ }
    waitForFresh(stampBefore, tries + 1);
  }, 20000);
}
async function dispatchWorkflow(token, file, inputs = {}) {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.name}/actions/workflows/${file}/dispatches`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: REPO.branch, inputs }),
    });
    return r.status === 204;
  } catch { return false; }
}
/** Agrega tickers a config/universe.json en GitHub (requiere token con permiso de contenido). */
async function addToUniverse(token, syms) {
  const H = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const base = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/config/universe.json`;
  const r = await fetch(`${base}?ref=${REPO.branch}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${r.status}`);
  const j = await r.json();
  const text = decodeURIComponent(escape(atob(j.content.replace(/\n/g, ''))));
  const cfg = JSON.parse(text);
  const have = new Set([...(cfg.stocks || []), ...(cfg.etfs || [])]);
  const add = syms.filter((s) => !have.has(s));
  if (!add.length) return 0;
  cfg.stocks = [...(cfg.stocks || []), ...add];
  const body = { message: `config: agrega ${add.join(', ')} al radar`, sha: j.sha, branch: REPO.branch,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(cfg, null, 1)))) };
  const put = await fetch(base, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!put.ok) throw new Error(`PUT ${put.status}`);
  return add.length;
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
function positions() {
  const pos = {};
  const txs = [...S.pf.tx].sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
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

  if (!open.length) {
    html += `<div class="empty"><div class="big">💼</div>Tu cartera está vacía.<br>Sube capturas de la pantalla "Inicio" de Racional y la app lee tus posiciones sola, o agrégalas a mano.</div>
      <button class="btn" data-action="ocr">📷 Cargar capturas de Racional</button>
      <button class="btn secondary" style="margin-top:8px" data-action="addTx">＋ Agregar posición a mano</button>`;
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

  const evald = S.pf.tx.filter((t) => tk(t.sym) && t.price > 0 && t.src !== 'ocr').slice(-8).reverse();
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

// ---- RADAR ------------------------------------------------------------------
function viewRadar() {
  const R = S.radar;
  let list = S.data.tickers.slice();
  if (R.type !== 'all') list = list.filter((t) => (R.type === 'etf') === !!t.etf);
  if (R.signal !== 'all') list = list.filter((t) => (R.horizon === 'score' ? t.signal : t.h[R.horizon].sig) === R.signal);
  if (R.fav) { const mine = held(); list = list.filter((t) => S.pf.fav.includes(t.sym) || mine.has(t.sym)); }
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

  const shown = list.slice(0, R.limit);
  html += `<h2>${list.length} activos <small>ordenados por ${R.horizon === 'score' ? 'score global' : HZ[R.horizon]}</small></h2><div class="card list">`;
  if (!list.length) html += `<div class="empty">Nada que mostrar con estos filtros.${R.q ? `<br><br>¿No está <b>${esc(R.q.toUpperCase())}</b>? <button class="btn secondary sm" data-action="requestTicker" data-sym="${esc(R.q.toUpperCase())}">Pedir que se agregue al radar</button>` : ''}</div>`;
  for (const t of shown) {
    const sig = R.horizon === 'score' ? t.signal : t.h[R.horizon].sig;
    html += `<div class="item" data-action="detail" data-sym="${t.sym}">
      <div style="width:44px;text-align:center"><div class="hero mono t-${sigClass(sig)}" style="font-size:20px">${key(t) ?? '—'}</div><div class="tiny muted">${t.conf === 'baja' ? 'conf. baja' : t.risk.label}</div></div>
      <div class="grow"><div class="row"><span class="sym">${t.sym}</span>${S.pf.fav.includes(t.sym) ? '<span class="t-s">★</span>' : ''}${chip(sig, 'sm')}</div>
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
  const mine = new Set(open.map((p) => p.sym)), favs = new Set(S.pf.fav), changed = new Set((S.data.changes || []).filter((c) => c.since === '1d').map((c) => c.sym));
  const seen = new Set(), out = [];
  const push = (n, sym) => { if (!n.t || seen.has(n.t)) return; seen.add(n.t); const r = newsRank({ ...n, sym }, mine, favs, changed); out.push({ ...n, sym, rank: r, lvl: newsLevel(r), mine: mine.has(sym) }); };
  for (const p of open) for (const n of p.data?.news || []) push(n, p.sym);
  for (const f of S.pf.fav) for (const n of tk(f)?.news || []) push(n, f);
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

// ---- IA ---------------------------------------------------------------------
function viewIA() {
  const { open } = positions();
  const syms = S.data.tickers.map((t) => t.sym);
  const sel = S.iaSym || open[0]?.sym || syms[0];
  let html = `<div class="card"><h2 style="margin-top:0">🤖 Superprompt de análisis</h2>
    <p class="small muted">Genera un prompt con TODOS los datos del activo (técnico, fundamental, analistas, riesgo, tu posición) para pegarlo en ChatGPT, Claude o Gemini y obtener un informe tipo Goldman / Morgan Stanley / Citadel con veredicto final.</p>
    <label class="field">Activo<select id="iaSym">${syms.map((s) => `<option ${s === sel ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <button class="btn" data-action="copyPrompt" data-kind="super">📋 Copiar superprompt de ${sel}</button>
    <details style="margin-top:8px"><summary class="small">Ver prompt</summary><pre class="prompt">${esc(buildSuperPrompt(sel))}</pre></details></div>`;
  html += `<div class="card"><h2 style="margin-top:0">🧠 Análisis de mi cartera</h2><p class="small muted">Prompt estilo Bridgewater/BlackRock con tus posiciones reales: correlación, concentración, estrés, rebalanceo.</p>
    <button class="btn secondary" data-action="copyPrompt" data-kind="portfolio" ${open.length ? '' : 'disabled'}>📋 Copiar prompt de cartera</button></div>`;
  html += `<h2>Biblioteca de prompts institucionales</h2><p class="small muted">Se rellenan automáticamente con el activo seleccionado y tu cartera.</p>`;
  for (const p of PROMPTS) html += `<div class="card"><div class="between"><b>${p.n}. ${esc(p.t)}</b><button class="btn secondary sm" data-action="copyPrompt" data-kind="lib" data-n="${p.n}">Copiar</button></div><div class="tiny muted">${esc(p.s)}</div></div>`;
  return html;
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
  const pending = (S.pf.pending || []).filter((s) => !tk(s));
  const hasToken = !!(S.settings.ghToken || '').trim();
  return `<div class="card"><h2 style="margin-top:0">📡 Datos</h2>
    <div class="kv"><div><span>Análisis diario</span><b>${esc(fmtStamp(d.generated_at))}</b></div><div><span>Precios intradía</span><b>${S.quotes ? esc(fmtStamp(S.quotes.generated_at)) : '—'}</b></div>
    <div><span>Modo</span><b>${d.demo ? 'DEMO (sintético)' : 'Real (Yahoo Finance)'}</b></div><div><span>Activos OK / fallidos</span><b>${d.stats?.ok} / ${d.stats?.failed}</b></div>
    <div><span>Noticias con IA</span><b>${d.news_stats?.ai ? `${d.news_stats.ai} de ${d.news_stats.unique}` : 'no (solo heurística)'}</b></div><div><span>App</span><b>v${APP_VERSION}</b></div>
    <div><span>Último modo</span><b>${esc(d.mode || '—')}</b></div><div><span>Duró</span><b>${d.elapsed_s ? Math.round(d.elapsed_s / 60) + ' min' : '—'}</b></div>
    <div><span>Metadatos frescos</span><b>${d.stats?.meta_refreshed ?? '—'}</b></div><div><span>Gurús seguidos</span><b>${Object.keys(d.investors || {}).length}</b></div></div>
    ${d.failed?.length ? `<details><summary class="small">Fallidos (${d.failed.length})</summary><div class="tiny muted">${d.failed.map((f) => `${f.sym}: ${esc(f.error)}`).join('<br>')}</div></details>` : ''}
    <p class="small muted">El análisis completo se regenera cada día hábil al cierre; las cotizaciones cada hora en horario de mercado. Solo se guarda el último snapshot: el almacenamiento no crece.</p>
    <div class="btn-row"><button class="btn secondary" data-action="updateMarket">⟳ Precios y señales (~2 min)</button>${hasToken ? `<button class="btn secondary" data-action="runFull">▶ Análisis completo (~20 min)</button>` : ''}</div>
    <p class="tiny muted">Rápido = precios de todo el universo + recálculo del técnico. Completo = además refresca fundamentales, analistas y noticias de los ${d.tickers.length} activos.</p></div>

    <div class="card"><h2 style="margin-top:0">📈 Precios en vivo <small>opcional</small></h2>
    <p class="small muted">Con una clave gratuita de <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io</a> la app actualiza cada minuto el precio de tus posiciones y del activo que estés mirando (mientras la app esté abierta).</p>
    <label class="field">Clave Finnhub<input id="finnhubKey" type="text" autocomplete="off" autocapitalize="off" placeholder="pega aquí tu API key" value="${esc(S.settings.finnhubKey || '')}"></label>
    <div class="btn-row"><button class="btn secondary sm" data-action="saveKeys">Guardar</button><button class="btn secondary sm" data-action="testLive">Probar</button></div></div>

    <div class="card"><h2 style="margin-top:0">🔑 Conexión con GitHub <small>opcional</small></h2>
    <p class="small muted">Con un token de GitHub la app puede <b>pedir cotizaciones al instante</b>, lanzar el <b>análisis completo</b> y <b>agregar tickers al radar</b> sin que edites archivos. Crea uno en GitHub → Settings → Developer settings → Fine-grained tokens, solo para este repo, con permisos <i>Actions: Read and write</i> y <i>Contents: Read and write</i>.</p>
    <label class="field">Token de GitHub<input id="ghToken" type="password" autocomplete="off" placeholder="github_pat_…" value="${esc(S.settings.ghToken || '')}"></label>
    <button class="btn secondary sm" data-action="saveKeys">Guardar</button>
    ${pending.length ? `<h3>Tickers pendientes de agregar al radar</h3><div class="chips wrap">${pending.map((s) => `<span class="chip gray">${esc(s)}</span>`).join('')}</div>
      <div class="btn-row"><button class="btn sm" data-action="addPending" ${hasToken ? '' : 'disabled'}>Agregar al radar (con token)</button><button class="btn secondary sm" data-action="copyPending">Copiar lista</button><button class="btn secondary sm" data-action="clearPending">Limpiar</button></div>
      <p class="tiny muted">Sin token: copia la lista y pégala en <code>config/universe.json</code> en GitHub.</p>` : ''}</div>

    <div class="card"><h2 style="margin-top:0">🤖 Noticias con IA <small>opcional</small></h2>
    <p class="small muted">Para que las noticias lleguen <b>traducidas, resumidas y priorizadas por Claude</b>, agrega en GitHub → Settings → Secrets and variables → Actions un secreto llamado <code>ANTHROPIC_API_KEY</code>. El run diario clasifica hasta 250 titulares (costo aproximado US$0,5/día con claude-opus-5; la variable <code>NEWS_MODEL</code> permite elegir otro modelo).</p></div>

    <div class="card"><h2 style="margin-top:0">💾 Mi información</h2>
    <div class="kv"><div><span>Transacciones</span><b>${S.pf.tx.length}</b></div><div><span>Favoritos</span><b>${S.pf.fav.length}</b></div><div><span>Bitácora</span><b>${S.pf.log.length}</b></div><div><span>Uso local</span><b>${fmtN(used / 1024, 0)} KB</b></div></div>
    <p class="small muted">Tu cartera vive solo en este teléfono (localStorage). Haz un respaldo periódico: el archivo sirve para restaurar en otro dispositivo.</p>
    <div class="btn-row"><button class="btn secondary" data-action="export">⬇️ Exportar respaldo</button><button class="btn secondary" data-action="import">⬆️ Importar</button></div>
    <label class="field row" style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="showClp" ${S.settings.showClp ? 'checked' : ''} style="width:auto;margin:0"> Mostrar equivalente en pesos chilenos (USD/CLP)</label>
    <button class="btn danger" data-action="reset">🗑 Borrar toda mi información local</button></div>

    <div class="card"><h2 style="margin-top:0">🔁 Bitácora de mejora continua</h2>
    <p class="small muted">Anota aquí lo que quieres cambiar de la app o del modelo. Luego cópiala y pégamela en el chat: cada versión aprende de tu feedback.</p>
    <label class="field">Nueva nota<textarea id="logText" placeholder="Ej: el score de largo plazo castiga demasiado a las empresas con deuda…"></textarea></label>
    <button class="btn secondary" data-action="addLog">＋ Guardar nota</button>
    ${S.pf.log.slice().reverse().slice(0, 10).map((l) => `<div class="small" style="padding:6px 0;border-top:1px solid var(--border)"><span class="muted tiny">${l.d}</span><br>${esc(l.t)}</div>`).join('')}
    ${S.pf.log.length ? `<button class="btn secondary sm" data-action="copyLog" style="margin-top:8px">📋 Copiar bitácora</button>` : ''}</div>

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
  const fav = S.pf.fav.includes(sym);
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

  if (a && (a.count || a.target?.mean)) {
    const d = a.dist, tot = d ? d.sb + d.b + d.h + d.s + d.ss : 0;
    html += `<div class="card"><div class="between"><h2 style="margin:0">Wall Street</h2>${a.key ? chip(a.key) : ''}</div><div class="small muted">${a.count} analistas · media ${a.mean ?? '—'} (1 = compra fuerte, 5 = venta fuerte)</div>
      ${tot ? `<div class="stack" style="margin-top:8px">${[['sb', 'sb'], ['b', 'b'], ['h', 'h'], ['s', 's'], ['ss', 'ss']].map(([k, c2]) => d[k] ? `<i class="c-${c2}" style="width:${(d[k] / tot) * 100}%"></i>` : '').join('')}</div>
      <div class="legend"><span><i class="c-sb"></i>Compra fuerte ${d.sb}</span><span><i class="c-b"></i>Compra ${d.b}</span><span><i class="c-h"></i>Mantener ${d.h}</span><span><i class="c-s"></i>Venta ${d.s}</span><span><i class="c-ss"></i>Venta fuerte ${d.ss}</span></div>` : ''}
      ${a.target?.mean ? targetRange(t.price, a.target) : ''}
      ${a.revisions ? `<div class="small" style="margin-top:6px">Revisiones EPS (30 días): <b class="up">${a.revisions.up} ↑</b> · <b class="down">${a.revisions.down} ↓</b></div>` : ''}</div>`;
  }

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
    const mine = held(), favs = new Set(S.pf.fav);
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
  const t = id ? S.pf.tx.find((x) => x.id === id) : null;
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
  if (id) { const i = S.pf.tx.findIndex((x) => x.id === id); const old = S.pf.tx[i]; S.pf.tx[i] = { ...old, qty, price, date, note, type, amount: undefined, snapValue: undefined }; }
  else S.pf.tx.push(rec);
  savePf(); closeSheet(); toast(type === 'buy' ? 'Compra registrada' : 'Venta registrada');
  if (!$('#page').hidden && S.detail) openDetail(S.detail); render();
}
function addPending(sym) { if (!S.pf.pending) S.pf.pending = []; if (!S.pf.pending.includes(sym)) { S.pf.pending.push(sym); savePf(); } }

// ----------------------------------------------------------------------------
// OCR: importar posiciones desde capturas de Racional
// ----------------------------------------------------------------------------
function openOcrSheet() {
  openSheet(`<h2 style="margin-top:4px">📷 Cargar capturas de Racional</h2>
    <p class="small muted">Toma capturas de la pantalla <b>Inicio</b> de Racional con la lista de acciones (modo <b>Ganancia Total</b>) y súbelas todas. La app lee ticker, inversión y ganancia, y calcula tu posición con el precio actual. Todo ocurre en tu teléfono; las fotos no se envían a ningún lado.</p>
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

/** Extrae posiciones de las líneas OCR (ordenadas de arriba a abajo) de una captura de Racional. */
function parseRacionalLines(lines) {
  const known = new Set(S.data.tickers.map((t) => t.sym));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].text.match(/USD\s*([\d.,]+)\s*invers/i);
    if (!m) continue;
    const cost = parseAmount(m[1]); if (cost == null) continue;
    let gain = null, ticker = null;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const txt = lines[j].text;
      if (/invers/i.test(txt)) break; // llegamos a la tarjeta anterior
      if (gain == null) { const g = txt.match(/(-|−)?\s*USD\s*([\d.,]+)/i); if (g) { const v = parseAmount(g[2]); if (v != null) gain = g[1] ? -v : v; } }
      if (ticker == null && !/USD/i.test(txt)) { // la línea de ganancia nunca contiene el ticker
        const toks = (txt.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) || []).filter((x) => !['USD', 'CLP', 'YTD'].includes(x));
        const pick = toks.find((x) => known.has(x)) || toks.sort((a, b) => b.length - a.length)[0];
        if (pick) ticker = pick;
      }
    }
    // Sin ticker legible (logo encima, letra sola): fila vacía para que el usuario lo escriba.
    out.push({ sym: ticker || '', cost, gain: gain ?? 0, known: !!ticker && known.has(ticker) });
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
  // Consolidar duplicados (una acción puede aparecer cortada en dos capturas): conservar la de mayor inversión.
  const bySym = {}, noSym = [];
  for (const f of found) { if (!f.sym) { noSym.push(f); continue; } if (!bySym[f.sym] || f.cost > bySym[f.sym].cost) bySym[f.sym] = f; }
  const rows = [...Object.values(bySym), ...noSym].sort((a, b) => b.cost - a.cost);
  S.ocr = rows.map((r) => ocrRow(r));
  st.textContent = rows.length ? `Detectadas ${rows.length} posiciones. Revisa y corrige si algo no calza${noSym.length ? ` (${noSym.length} sin ticker legible: escríbelo)` : ''}:` : 'No se detectaron posiciones. Asegúrate de capturar la lista de acciones (ticker + "USD … inversión").';
  res.innerHTML = renderOcrTable();
}
function ocrRow(r) {
  const d = tk(r.sym); const value = r.cost + r.gain; const qty = d?.price ? value / d.price : null;
  return { ...r, known: !!d, value, price: d?.price ?? null, qty, avg: qty ? r.cost / qty : null, on: r.on ?? true };
}
function renderOcrTable() {
  if (!S.ocr?.length) return '';
  const total = S.ocr.filter((r) => r.on).reduce((a, r) => a + r.value, 0);
  return `<table class="ocr"><thead><tr><th></th><th>Ticker</th><th>Inversión</th><th>Ganancia</th><th>Cant. calc.</th></tr></thead><tbody>
    ${S.ocr.map((r, i) => `<tr class="${r.on ? '' : 'off'}"><td><input type="checkbox" data-ocr="on" data-i="${i}" ${r.on ? 'checked' : ''}></td>
      <td><input data-ocr="sym" data-i="${i}" value="${esc(r.sym)}" placeholder="?" style="width:64px;${r.sym ? '' : 'border-color:var(--ss)'}" autocapitalize="characters">${r.known ? '' : `<div class="tiny" style="color:var(--s)">${r.sym ? 'fuera del radar' : 'escribe el ticker'}</div>`}</td>
      <td><input data-ocr="cost" data-i="${i}" inputmode="decimal" value="${r.cost}" style="width:74px"></td>
      <td><input data-ocr="gain" data-i="${i}" inputmode="decimal" value="${r.gain}" style="width:64px"></td>
      <td class="tiny mono">${r.qty ? `${fmtQ(r.qty)}<br>@ ${fmtUSD(r.avg)}` : '<span class="muted">sin precio</span>'}</td></tr>`).join('')}</tbody></table>
    <p class="small">Valor detectado: <b>${fmtUSD(total)}</b>. Los tickers fuera del radar se guardan por monto y quedan pendientes de agregar (Ajustes).</p>
    <p class="tiny muted">Importar <b>reemplaza</b> la posición de cada ticker detectado con lo que dice Racional (los demás no se tocan). El historial manual de esos tickers se sustituye por una sola línea "importado".</p>
    <button class="btn" data-action="ocrImport">Importar ${S.ocr.filter((r) => r.on).length} posiciones</button>`;
}
function ocrImport() {
  const rows = (S.ocr || []).filter((r) => r.on && r.sym && r.cost > 0);
  if (!rows.length) return toast('Nada que importar');
  const d0 = today();
  for (const r of rows) {
    const sym = r.sym.toUpperCase();
    S.pf.tx = S.pf.tx.filter((t) => t.sym !== sym);
    const d = tk(sym);
    const value = r.cost + r.gain;
    const qty = d?.price ? value / d.price : null;
    S.pf.tx.push({ id: uid(), sym, type: 'buy', qty: qty ? +qty.toFixed(6) : null, price: qty ? +(r.cost / qty).toFixed(4) : null, amount: r.cost, snapValue: value,
      date: d0, note: 'Importado desde captura de Racional', src: 'ocr', sig: d?.signal || null, score: d?.score ?? null });
    if (!d) addPending(sym);
  }
  savePf(); closeSheet(); S.ocr = null; render(); toast(`Importadas ${rows.length} posiciones`);
}

// ----------------------------------------------------------------------------
// Sheet / page helpers
// ----------------------------------------------------------------------------
function openSheet(html) { $('#sheetContent').innerHTML = html; $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; }
function closePage() { $('#page').hidden = true; document.body.classList.remove('locked'); S.detail = null; render(); }

function exportBackup() {
  const payload = { app: 'market-intelligence-ai', version: APP_VERSION, exported: new Date().toISOString(), portfolio: S.pf, settings: { showClp: S.settings.showClp } };
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
    const j = JSON.parse($('#bkIn').value); const pf = j.portfolio || j;
    if (!Array.isArray(pf.tx)) throw new Error('formato');
    const ids = new Set(S.pf.tx.map((t) => t.id));
    let n = 0; for (const t of pf.tx) if (t && t.sym && !ids.has(t.id)) { S.pf.tx.push({ ...t, id: t.id || uid() }); n++; }
    S.pf.fav = [...new Set([...(S.pf.fav || []), ...(pf.fav || [])])];
    S.pf.log = [...(S.pf.log || []), ...(pf.log || []).filter((l) => !S.pf.log.some((x) => x.d === l.d && x.t === l.t))];
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
    case 'closePage': closePage(); break;
    case 'closeSheet': closeSheet(); break;
    case 'addTx': openTxSheet({ type: el.dataset.type || 'buy', sym: sym || '' }); break;
    case 'editTx': openTxSheet({ id: el.dataset.id }); break;
    case 'saveTx': saveTx(el.dataset.id || null); break;
    case 'deleteTx': if (confirm('¿Eliminar este movimiento?')) { S.pf.tx = S.pf.tx.filter((t) => t.id !== el.dataset.id); savePf(); closeSheet(); render(); if (S.detail) openDetail(S.detail); } break;
    case 'fav': { const i = S.pf.fav.indexOf(sym); if (i >= 0) S.pf.fav.splice(i, 1); else S.pf.fav.push(sym); savePf(); openDetail(sym, true); break; }
    case 'reload': loadData(true); break;
    case 'updateMarket': updateMarket(); break;
    case 'runFull': { const ok = await dispatchWorkflow(S.settings.ghToken.trim(), REPO.workflow, { mode: 'full' }); toast(ok ? 'Análisis completo lanzado (~20 min)' : 'No se pudo lanzar (revisa el token)'); break; }
    case 'ocr': openOcrSheet(); break;
    case 'ocrImport': ocrImport(); break;
    case 'moreRadar': S.radar.limit += RADAR_PAGE; render({ keepScroll: true }); break;
    case 'requestTicker': if (sym) { addPending(sym); toast(`${sym} quedó pendiente de agregar al radar (Ajustes)`); } break;
    case 'saveKeys': S.settings.finnhubKey = ($('#finnhubKey')?.value ?? S.settings.finnhubKey ?? '').trim(); S.settings.ghToken = ($('#ghToken')?.value ?? S.settings.ghToken ?? '').trim(); saveSettings(); toast('Guardado'); render({ keepScroll: true }); break;
    case 'testLive': { S.settings.finnhubKey = ($('#finnhubKey')?.value || '').trim(); saveSettings(); await refreshLive(['AAPL']); toast(S.live.AAPL ? `OK: AAPL ${fmtUSD(S.live.AAPL.p)}` : 'Sin respuesta: revisa la clave'); break; }
    case 'addPending': {
      const syms = (S.pf.pending || []).filter((s) => !tk(s)); if (!syms.length) break;
      try { const n = await addToUniverse(S.settings.ghToken.trim(), syms); S.pf.pending = []; savePf(); const ok = await dispatchWorkflow(S.settings.ghToken.trim(), REPO.workflow, { only: syms.join(','), mode: 'full', discover: 'false' }); toast(`${n} ticker(s) agregados${ok ? '; análisis lanzado (~3 min)' : ''}`); render({ keepScroll: true }); }
      catch (err) { toast('Error: ' + err.message); }
      break;
    }
    case 'copyPending': copy((S.pf.pending || []).join(', ')); break;
    case 'clearPending': S.pf.pending = []; savePf(); render({ keepScroll: true }); break;
    case 'export': exportBackup(); break;
    case 'import': importBackup(); break;
    case 'doImport': doImport(); break;
    case 'copyText': copy($('#' + el.dataset.target).value); break;
    case 'shareBk': try { await navigator.share({ title: 'Respaldo Market IA', text: $('#bk').value }); } catch { /* cancelado */ } break;
    case 'reset': if (confirm('Se borrará tu cartera, favoritos y bitácora de este dispositivo. ¿Continuar?')) { localStorage.removeItem(LS.portfolio); S.pf = { tx: [], fav: [], log: [], pending: [] }; render(); toast('Información borrada'); } break;
    case 'addLog': { const t = $('#logText').value.trim(); if (!t) return; S.pf.log.push({ d: today(), t }); savePf(); render(); toast('Nota guardada'); break; }
    case 'copyLog': copy(S.pf.log.map((l) => `[${l.d}] ${l.t}`).join('\n')); break;
    case 'copyPrompt': {
      const kind = el.dataset.kind; const s = sym || $('#iaSym')?.value || S.iaSym;
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
    if (k === 'on') r.on = e.target.checked; else if (k === 'sym') r.sym = e.target.value.toUpperCase().trim(); else r[k] = parseAmount(e.target.value) ?? 0;
    S.ocr[i] = ocrRow(r);
    const btn = $('#ocrResult .btn'); if (btn) btn.textContent = `Importar ${S.ocr.filter((x) => x.on).length} posiciones`;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'iaSym') { S.iaSym = e.target.value; render(); }
  if (e.target.id === 'showClp') { S.settings.showClp = e.target.checked; saveSettings(); }
  if (e.target.dataset.ocr && S.ocr) $('#ocrResult').innerHTML = renderOcrTable(); // recalcula cantidades al terminar de editar
});
$('#btnRefresh').addEventListener('click', () => updateMarket());
window.addEventListener('popstate', () => { if (!$('#page').hidden) closePage(); else if (!$('#sheet').hidden) closeSheet(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

loadData.at = 0;
loadData();
