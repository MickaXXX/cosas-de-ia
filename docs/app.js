/* Market Intelligence AI — app móvil (vanilla JS, sin dependencias)
 * Datos: docs/data/latest.json + history.json (generados por scripts/update_data.py).
 * Estado local: localStorage (cartera, favoritos, bitácora). Sin servidores.
 */
'use strict';

const APP_VERSION = '1.0.0';
const DATA_URL = './data/latest.json';
const HIST_URL = './data/history.json';
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

// ----------------------------------------------------------------------------
// Estado
// ----------------------------------------------------------------------------
const S = {
  data: null, history: {}, tab: 'cartera', detail: null,
  radar: { horizon: 'score', signal: 'all', type: 'all', q: '', fav: false },
  pf: loadJSON(LS.portfolio, { tx: [], fav: [], log: [], cash: 0 }),
  settings: loadJSON(LS.settings, { showClp: true }),
};

function loadJSON(k, d) { try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('No se pudo guardar (almacenamiento lleno)'); } }
function savePf() { pruneLocal(); saveJSON(LS.portfolio, S.pf); }

/** Auto-gestión de almacenamiento local: límites suaves para no saturar el teléfono. */
function pruneLocal() {
  if (S.pf.log.length > 200) S.pf.log = S.pf.log.slice(-200);
  if (S.pf.tx.length > 2000) S.pf.tx = S.pf.tx.slice(-2000);
}

// ----------------------------------------------------------------------------
// Utilidades
// ----------------------------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtUSD = (v, d = 2) => v == null ? '—' : (v < 0 ? '−' : '') + new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'USD', maximumFractionDigits: d, minimumFractionDigits: d }).format(Math.abs(v));
const fmtCLP = (v) => v == null ? '—' : (v < 0 ? '−' : '') + new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(Math.abs(v));
const fmtN = (v, d = 1) => v == null ? '—' : new Intl.NumberFormat('es-CL', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);
const pct = (v, d = 1, sign = true) => v == null ? '—' : `${sign && v > 0 ? '+' : ''}${fmtN(v, d)}%`;
const cls = (v) => v == null ? '' : v >= 0 ? 'up' : 'down';
const big = (v) => v == null ? '—' : v >= 1e12 ? `${fmtN(v / 1e12, 2)} T` : v >= 1e9 ? `${fmtN(v / 1e9, 1)} B` : v >= 1e6 ? `${fmtN(v / 1e6, 0)} M` : fmtN(v, 0);
const today = () => new Date().toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sigClass = (sig) => SIG_CLASS[sig] || 'h';
const scoreSig = (s) => s == null ? 'hold' : s >= 78 ? 'strong_buy' : s >= 62 ? 'buy' : s >= 42 ? 'hold' : s >= 28 ? 'sell' : 'strong_sell';
const tk = (sym) => S.data?.tickers.find((t) => t.sym === sym);
const usdclp = () => S.data?.market?.['CLP=X']?.price || null;

function chip(sig, extra = '') { return `<span class="chip ${esc(sig)} ${extra}">${SIG_ICON[sig] || ''} ${esc(SIG_LABEL[sig] || sig)}</span>`; }
function scoreBar(v, label, sig) {
  const c = sigClass(sig || scoreSig(v));
  return `<span class="lbl">${esc(label)}</span><div class="bar"><i class="c-${c}" style="width:${v ?? 0}%"></i></div><span class="val t-${c}">${v ?? '—'}</span>`;
}
function relTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.round(ms / 36e5);
  if (h < 1) return 'hace minutos';
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
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
  // parts: [{label, value, color}] — máximo 7 + "Otros"
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const R = 50, r = 32, cx = 60, cy = 60;
  let a0 = -Math.PI / 2, paths = '';
  for (const p of parts) {
    const a1 = a0 + (p.value / total) * Math.PI * 2;
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
// Carga de datos
// ----------------------------------------------------------------------------
async function loadData(force = false) {
  const btn = $('#btnRefresh'); btn.classList.add('spin');
  try {
    const bust = force ? `?t=${Date.now()}` : '';
    const [d, h] = await Promise.all([
      fetch(DATA_URL + bust, { cache: force ? 'reload' : 'default' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch(HIST_URL + bust, { cache: force ? 'reload' : 'default' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    S.data = d; S.history = h || {};
    try { localStorage.setItem(LS.cache, JSON.stringify({ d, h })); } catch { /* cache opcional */ }
  } catch (e) {
    const c = loadJSON(LS.cache, null);
    if (c && c.d) { S.data = c.d; S.history = c.h || {}; toast('Sin conexión: mostrando datos guardados'); }
  } finally { btn.classList.remove('spin'); }
  renderStatus(); render();
}

function renderStatus() {
  const st = $('#dataStatus'), b = $('#banner');
  if (!S.data) { st.textContent = 'Sin datos. Ejecuta el workflow "Actualizar datos".'; b.hidden = false; b.className = 'banner error'; b.textContent = 'No se encontraron datos (docs/data/latest.json). Ejecuta el workflow de GitHub Actions o el script update_data.py.'; return; }
  const age = Math.round((Date.now() - new Date(S.data.generated_at).getTime()) / 36e5);
  st.textContent = `Datos: ${S.data.date} (${relTime(S.data.generated_at)}) · ${S.data.stats?.ok ?? S.data.tickers.length} activos`;
  if (S.data.demo) { b.hidden = false; b.className = 'banner'; b.innerHTML = '⚠️ <b>Datos de demostración (sintéticos)</b>. Activa el workflow de GitHub Actions para cargar datos reales de Yahoo Finance. Ver Ajustes.'; }
  else if (age > 60) { b.hidden = false; b.className = 'banner info'; b.textContent = `Los datos tienen ${Math.round(age / 24)} días. Revisa que el workflow diario esté activo.`; }
  else b.hidden = true;
}

// ----------------------------------------------------------------------------
// Cartera: cálculo de posiciones a partir de transacciones
// ----------------------------------------------------------------------------
function positions() {
  const pos = {};
  const txs = [...S.pf.tx].sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
  for (const t of txs) {
    const p = pos[t.sym] || (pos[t.sym] = { sym: t.sym, qty: 0, cost: 0, realized: 0, txs: [] });
    p.txs.push(t);
    if (t.type === 'buy') { p.cost += t.qty * t.price; p.qty += t.qty; }
    else { const avg = p.qty > 0 ? p.cost / p.qty : t.price; const q = Math.min(t.qty, p.qty); p.realized += q * (t.price - avg); p.cost -= q * avg; p.qty -= q; }
  }
  const list = Object.values(pos).map((p) => {
    const d = tk(p.sym);
    const price = d?.price ?? null;
    p.avg = p.qty > 0 ? p.cost / p.qty : 0;
    p.value = price != null ? p.qty * price : null;
    p.pnl = p.value != null ? p.value - p.cost : null;
    p.pnlPct = p.pnl != null && p.cost > 0 ? (p.pnl / p.cost) * 100 : null;
    p.data = d;
    return p;
  });
  return { open: list.filter((p) => p.qty > 1e-9), closed: list.filter((p) => p.qty <= 1e-9) };
}

// ----------------------------------------------------------------------------
// Render principal
// ----------------------------------------------------------------------------
function render() {
  const v = $('#view');
  if (!S.data) { v.innerHTML = `<div class="empty"><div class="big">📡</div>Aún no hay datos.<br>Ejecuta <b>Actions → Actualizar datos de mercado → Run workflow</b> en GitHub.</div>`; return; }
  const views = { cartera: viewCartera, radar: viewRadar, hoy: viewHoy, ia: viewIA, ajustes: viewAjustes };
  v.innerHTML = views[S.tab]();
  window.scrollTo({ top: 0 });
}

// ---- CARTERA ----------------------------------------------------------------
function viewCartera() {
  const { open, closed } = positions();
  const clp = usdclp();
  const total = open.reduce((a, p) => a + (p.value || 0), 0);
  const cost = open.reduce((a, p) => a + p.cost, 0);
  const pnl = total - cost;
  const realized = [...open, ...closed].reduce((a, p) => a + p.realized, 0);
  const dayChg = open.reduce((a, p) => a + (p.value != null && p.data?.chg1d != null ? p.value * (p.data.chg1d / 100) / (1 + p.data.chg1d / 100) : 0), 0);
  const wScore = total > 0 ? open.reduce((a, p) => a + (p.value || 0) * (p.data?.score ?? 50), 0) / total : null;
  const pfSig = wScore == null ? null : scoreSig(wScore);

  let html = '';
  if (!open.length) {
    html += `<div class="empty"><div class="big">💼</div>Tu cartera está vacía.<br>Agrega las posiciones que tienes en Racional (ticker, cantidad y precio promedio) y la app las vigilará cada día.</div>
      <button class="btn" data-action="addTx">＋ Agregar posición</button>`;
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

    // Alertas
    const alerts = portfolioAlerts(open);
    if (alerts.length) {
      html += `<h2>🚨 Alertas <small>${alerts.length}</small></h2>`;
      for (const a of alerts) html += `<div class="card tap alert ${a.good ? 'good' : ''}" data-action="detail" data-sym="${a.sym}"><div class="between"><b>${a.sym}</b>${a.chip || ''}</div><div class="small" style="margin-top:4px">${a.text}</div></div>`;
    }

    // Posiciones
    html += `<h2>Posiciones <small>${open.length}</small></h2><div class="card list">`;
    for (const p of open.sort((a, b) => (b.value || 0) - (a.value || 0))) {
      const d = p.data;
      html += `<div class="item" data-action="detail" data-sym="${p.sym}">
        <div class="grow"><div class="row"><span class="sym">${p.sym}</span>${d ? chip(d.signal, 'sm') : '<span class="tag">sin datos</span>'}</div>
          <div class="name mono">${fmtN(p.qty, 4).replace(/,?0+$/, '')} × ${fmtUSD(p.avg)} · ${total ? fmtN((p.value || 0) / total * 100, 0) : 0}%</div>
          ${d ? `<div class="mini-scores"><b>C ${d.h.short.s ?? '—'}</b><b>M ${d.h.medium.s ?? '—'}</b><b>L ${d.h.long.s ?? '—'}</b><b>${d.risk.label}</b></div>` : ''}</div>
        <div><div class="price mono">${fmtUSD(p.value)}</div><div class="small mono ${cls(p.pnl)}" style="text-align:right">${pct(p.pnlPct)} · ${fmtUSD(p.pnl, 0)}</div>
          <div class="tiny muted mono" style="text-align:right">${d ? fmtUSD(d.price) + ' ' + pct(d.chg1d) : ''}</div></div>
      </div>`;
    }
    html += `</div><div class="btn-row"><button class="btn green" data-action="addTx" data-type="buy">＋ Compra</button><button class="btn danger" data-action="addTx" data-type="sell">－ Venta</button></div>`;

    // Distribución
    const bySym = open.map((p, i) => ({ label: p.sym, value: p.value || 0 }));
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

  // Evaluación de decisiones
  const evald = S.pf.tx.filter((t) => tk(t.sym)).slice(-8).reverse();
  if (evald.length) {
    html += `<h2>Mis decisiones vs. el modelo</h2><div class="card list">`;
    for (const t of evald) {
      const d = tk(t.sym); const chg = d?.price != null ? (d.price / t.price - 1) * 100 : null;
      html += `<div class="item" data-action="editTx" data-id="${t.id}"><div class="grow"><b>${t.type === 'buy' ? '🟢 Compra' : '🔴 Venta'} ${t.sym}</b> <span class="muted small">${t.date}</span>
        <div class="small muted">${fmtN(t.qty, 4).replace(/,?0+$/, '')} × ${fmtUSD(t.price)}${t.sig ? ` · modelo decía: ${SIG_LABEL[t.sig]} (${t.score})` : ''}${t.note ? `<br>📝 ${esc(t.note)}` : ''}</div></div>
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
  }
  return out.slice(0, 8);
}

// ---- RADAR ------------------------------------------------------------------
function viewRadar() {
  const R = S.radar;
  let list = S.data.tickers.slice();
  if (R.type !== 'all') list = list.filter((t) => (R.type === 'etf') === !!t.etf);
  if (R.signal !== 'all') list = list.filter((t) => (R.horizon === 'score' ? t.signal : t.h[R.horizon].sig) === R.signal);
  if (R.fav) list = list.filter((t) => S.pf.fav.includes(t.sym));
  if (R.q) { const q = R.q.toUpperCase(); list = list.filter((t) => t.sym.includes(q) || (t.name || '').toUpperCase().includes(q)); }
  const key = (t) => (R.horizon === 'score' ? t.score : t.h[R.horizon].s) ?? -1;
  list.sort((a, b) => key(b) - key(a));

  const counts = {};
  for (const t of S.data.tickers) { const s = R.horizon === 'score' ? t.signal : t.h[R.horizon].sig; counts[s] = (counts[s] || 0) + 1; }

  let html = `<input class="search" id="radarQ" placeholder="Buscar ticker o empresa…" value="${esc(R.q)}" autocomplete="off">
    <div class="seg" data-seg="horizon">${[['score', 'Global'], ['short', 'Corto'], ['medium', 'Mediano'], ['long', 'Largo']].map(([k, l]) => `<button data-v="${k}" class="${R.horizon === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="chips" data-seg="signal"><span class="chip ${R.signal === 'all' ? 'on' : ''}" data-v="all">Todas ${S.data.tickers.length}</span>${SIG_ORDER.slice().reverse().map((s) => `<span class="chip ${R.signal === s ? 'on' : ''}" data-v="${s}">${SIG_ICON[s]} ${SIG_LABEL[s]} ${counts[s] || 0}</span>`).join('')}</div>
    <div class="chips" data-seg="type"><span class="chip ${R.type === 'all' ? 'on' : ''}" data-v="all">Todo</span><span class="chip ${R.type === 'stock' ? 'on' : ''}" data-v="stock">Acciones</span><span class="chip ${R.type === 'etf' ? 'on' : ''}" data-v="etf">ETFs</span><span class="chip ${R.fav ? 'on' : ''}" data-v="fav">★ Favoritos</span></div>`;

  if (R.signal === 'all' && !R.q && !R.fav) {
    html += `<h2>🔥 Top oportunidades <small>${R.horizon === 'score' ? 'global' : HZ[R.horizon]}</small></h2><div class="grid3">`;
    for (const t of list.filter((t) => t.conf !== 'baja' && key(t) >= 62).slice(0, 3)) {
      html += `<div class="card tap" style="margin:0;padding:10px" data-action="detail" data-sym="${t.sym}"><div class="sym">${t.sym}</div><div class="hero mono t-${sigClass(scoreSig(key(t)))}" style="font-size:24px">${key(t)}</div>
        <div class="tiny muted ellipsis">${esc(t.name)}</div>${t.analysts?.upside != null ? `<div class="tiny ${cls(t.analysts.upside)}">obj. ${pct(t.analysts.upside, 0)}</div>` : ''}</div>`;
    }
    html += `</div>`;
  }

  html += `<h2>${list.length} activos <small>ordenados por ${R.horizon === 'score' ? 'score global' : HZ[R.horizon]}</small></h2><div class="card list">`;
  if (!list.length) html += `<div class="empty">Nada que mostrar con estos filtros.</div>`;
  for (const t of list) {
    const sig = R.horizon === 'score' ? t.signal : t.h[R.horizon].sig;
    html += `<div class="item" data-action="detail" data-sym="${t.sym}">
      <div style="width:44px;text-align:center"><div class="hero mono t-${sigClass(sig)}" style="font-size:20px">${key(t) ?? '—'}</div><div class="tiny muted">${t.conf === 'baja' ? 'conf. baja' : t.risk.label}</div></div>
      <div class="grow"><div class="row"><span class="sym">${t.sym}</span>${S.pf.fav.includes(t.sym) ? '<span class="t-s">★</span>' : ''}${chip(sig, 'sm')}</div>
        <div class="name ellipsis">${esc(t.name)}${t.sector ? ` · ${esc(t.sector)}` : ''}</div>
        <div class="mini-scores"><b>C ${t.h.short.s ?? '—'}</b><b>M ${t.h.medium.s ?? '—'}</b><b>L ${t.h.long.s ?? '—'}</b>${t.analysts?.upside != null ? `<b class="${cls(t.analysts.upside)}">obj ${pct(t.analysts.upside, 0)}</b>` : ''}</div></div>
      <div style="width:64px">${spark(t.tech.spark?.slice(-30))}<div class="price mono small">${fmtUSD(t.price)}</div><div class="tiny mono ${cls(t.chg1d)}" style="text-align:right">${pct(t.chg1d)}</div></div>
    </div>`;
  }
  return html + `</div>`;
}

// ---- HOY --------------------------------------------------------------------
function viewHoy() {
  const d = S.data, reg = d.regime || {};
  const regCls = { 'Risk-on': 'sb', Neutral: 'h', 'Risk-off': 'ss' }[reg.label] || 'h';
  let html = `<div class="card"><div class="between"><h2 style="margin:0">Mercado hoy</h2><span class="chip ${regCls === 'sb' ? 'strong_buy' : regCls === 'ss' ? 'strong_sell' : 'hold'}">${esc(reg.label || '')}</span></div>
    <p class="small">${esc(reg.desc || '')}</p>${(reg.notes || []).map((n) => `<div class="tiny muted">• ${esc(n)}</div>`).join('')}</div>`;

  html += `<div class="grid2">`;
  for (const [sym, m] of Object.entries(d.market || {})) {
    html += `<div class="card" style="margin:0;padding:10px"><div class="between"><span class="small" style="font-weight:600">${esc(m.name)}</span><span class="tiny mono ${cls(m.chg1d)}">${pct(m.chg1d)}</span></div>
      <div class="mono" style="font-weight:800;font-size:17px">${sym === 'CLP=X' ? fmtN(m.price, 0) : sym === '^TNX' ? fmtN(m.price, 2) + '%' : fmtN(m.price, m.price < 100 ? 2 : 0)}</div>${spark(m.spark)}
      <div class="tiny muted mono">1S ${pct(m.ret_1w)} · 1M ${pct(m.ret_1m)}</div></div>`;
  }
  html += `</div>`;

  // Cambios de señal
  const ch = d.changes || [];
  if (ch.length) {
    html += `<h2>🔔 Cambios de señal <small>${ch.length}</small></h2><div class="card list">`;
    for (const c of ch.slice(0, 12)) html += `<div class="item" data-action="detail" data-sym="${c.sym}"><span style="font-size:18px">${c.dir === 'up' ? '⬆️' : '⬇️'}</span><div class="grow"><b>${c.sym}</b> <span class="tiny muted">${c.since === '1d' ? 'hoy' : '7 días'}</span><div class="small">${chip(c.from, 'sm')} → ${chip(c.to, 'sm')}</div></div><div class="mono small muted">${c.score_from} → <b>${c.score_to}</b></div></div>`;
    html += `</div>`;
  }

  // Top por horizonte
  html += `<h2>🔥 Top oportunidades hoy</h2>`;
  for (const hz of ['short', 'medium', 'long']) {
    const top = d.tickers.filter((t) => t.conf !== 'baja' && !t.etf).sort((a, b) => (b.h[hz].s ?? 0) - (a.h[hz].s ?? 0)).slice(0, 3);
    html += `<h3>${HZ[hz]}</h3><div class="card list" style="margin-top:0">${top.map((t, i) => `<div class="item" data-action="detail" data-sym="${t.sym}"><span class="muted">${i + 1}.</span><div class="grow"><b>${t.sym}</b> <span class="tiny muted">${esc(t.name)}</span></div>${chip(t.h[hz].sig, 'sm')}<b class="mono t-${sigClass(t.h[hz].sig)}">${t.h[hz].s}</b></div>`).join('')}</div>`;
  }

  // Movers del universo
  const movers = d.tickers.filter((t) => t.chg1d != null).sort((a, b) => Math.abs(b.chg1d) - Math.abs(a.chg1d)).slice(0, 6);
  html += `<h2>Mayores movimientos</h2><div class="card"><div class="chips">${movers.map((t) => `<span class="chip ${t.chg1d >= 0 ? 'buy' : 'sell'}" data-action="detail" data-sym="${t.sym}">${t.sym} ${pct(t.chg1d)}</span>`).join('')}</div></div>`;

  // Earnings próximos
  const { open } = positions();
  const mine = new Set(open.map((p) => p.sym));
  const earn = d.tickers.filter((t) => t.earnings_date).map((t) => ({ t, days: Math.round((new Date(t.earnings_date) - Date.now()) / 864e5) })).filter((e) => e.days >= 0 && e.days <= 21).sort((a, b) => a.days - b.days);
  if (earn.length) html += `<h2>📅 Próximos resultados <small>21 días</small></h2><div class="card"><div class="chips wrap">${earn.slice(0, 16).map((e) => `<span class="chip ${mine.has(e.t.sym) ? 'accent' : 'gray'}" data-action="detail" data-sym="${e.t.sym}">${e.t.sym} · ${e.days === 0 ? 'hoy' : e.days + 'd'}</span>`).join('')}</div></div>`;

  // Noticias: primero de mi cartera, luego mercado
  const news = [];
  const seen = new Set();
  for (const p of open) for (const n of p.data?.news || []) if (!seen.has(n.t)) { seen.add(n.t); news.push({ ...n, sym: p.sym, mine: true }); }
  for (const n of d.market_news || []) if (!seen.has(n.t)) { seen.add(n.t); news.push(n); }
  news.sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || (b.d || '').localeCompare(a.d || ''));
  html += `<h2>📰 Noticias del día <small>se conservan ${d.weights?.retention?.news_max_age_days ?? 7} días</small></h2><div class="card news">`;
  if (!news.length) html += `<div class="empty">Sin noticias recientes.</div>`;
  for (const n of news.slice(0, 20)) html += `<div class="n"><a href="${esc(n.u || '#')}" target="_blank" rel="noopener">${n.mine ? '💼 ' : ''}${esc(n.t)}</a><div class="meta">${esc(n.sym || '')} · ${esc(n.p || '')} · ${relTime(n.d)}</div></div>`;
  return html + `</div>`;
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
    pos ? `MI POSICIÓN: ${fmtN(pos.qty, 4)} acciones a precio promedio ${fmtUSD(pos.avg)} (valor ${fmtUSD(pos.value)}, resultado ${pct(pos.pnlPct)})` : 'MI POSICIÓN: no tengo esta acción',
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
  const lines = open.map((p) => `- ${p.sym} (${p.data?.name || ''}, ${p.data?.sector || '—'}): ${fmtN(p.qty, 4)} acc. a ${fmtUSD(p.avg)} promedio, valor ${fmtUSD(p.value)} (${fmtN((p.value || 0) / total * 100, 1)}%), resultado ${pct(p.pnlPct)}, señal modelo ${SIG_LABEL[p.data?.signal] || '—'} ${p.data?.score ?? ''}/100, beta ${p.data?.fund?.beta ?? '—'}, riesgo ${p.data?.risk?.label || '—'}`);
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
  { n: 3, t: 'Análisis de riesgo · inspirado en Bridgewater', s: 'Correlación, concentración, estrés de recesión, liquidez, colas, coberturas y rebalanceo.', b: (sym, pf) => buildPortfolioPrompt() },
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
  return open.map((p) => `- ${p.sym}: ${fmtN(p.qty, 4)} acc. a ${fmtUSD(p.avg)} promedio · valor ${fmtUSD(p.value)} (${fmtN((p.value || 0) / total * 100, 1)}%) · resultado ${pct(p.pnlPct)} · señal modelo ${SIG_LABEL[p.data?.signal] || '—'} ${p.data?.score ?? ''}/100`).join('\n') + `\nTOTAL: ${fmtUSD(total)}`;
}

// ---- AJUSTES ----------------------------------------------------------------
function viewAjustes() {
  const used = (() => { try { let n = 0; for (const k in localStorage) if (Object.prototype.hasOwnProperty.call(localStorage, k)) n += (localStorage.getItem(k) || '').length * 2; return n; } catch { return 0; } })();
  const d = S.data;
  return `<div class="card"><h2 style="margin-top:0">📡 Datos</h2>
    <div class="kv"><div><span>Generados</span><b>${esc(d.generated_at?.replace('T', ' ').slice(0, 16))}</b></div><div><span>Modo</span><b>${d.demo ? 'DEMO (sintético)' : 'Real (Yahoo Finance)'}</b></div>
    <div><span>Activos OK / fallidos</span><b>${d.stats?.ok} / ${d.stats?.failed}</b></div><div><span>Historial guardado</span><b>${d.weights?.retention?.history_days} días</b></div>
    <div><span>Noticias por activo</span><b>${d.weights?.retention?.news_per_ticker} (máx ${d.weights?.retention?.news_max_age_days} días)</b></div><div><span>App</span><b>v${APP_VERSION}</b></div></div>
    ${d.failed?.length ? `<details><summary class="small">Fallidos (${d.failed.length})</summary><div class="tiny muted">${d.failed.map((f) => `${f.sym}: ${esc(f.error)}`).join('<br>')}</div></details>` : ''}
    <p class="small muted">Los datos se regeneran cada día con GitHub Actions (<b>Actions → Actualizar datos de mercado</b>). Solo se guarda el último snapshot: el almacenamiento no crece.</p>
    <button class="btn secondary" data-action="reload">⟳ Recargar datos</button></div>

    <div class="card"><h2 style="margin-top:0">💾 Mi información</h2>
    <div class="kv"><div><span>Transacciones</span><b>${S.pf.tx.length}</b></div><div><span>Favoritos</span><b>${S.pf.fav.length}</b></div><div><span>Bitácora</span><b>${S.pf.log.length}</b></div><div><span>Uso local</span><b>${fmtN(used / 1024, 0)} KB</b></div></div>
    <p class="small muted">Tu cartera vive solo en este teléfono (localStorage). Haz un respaldo periódico: el archivo sirve para restaurar en otro dispositivo.</p>
    <div class="btn-row"><button class="btn secondary" data-action="export">⬇️ Exportar respaldo</button><button class="btn secondary" data-action="import">⬆️ Importar</button></div>
    <label class="field row" style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="showClp" ${S.settings.showClp ? 'checked' : ''} style="width:auto;margin:0"> Mostrar equivalente en pesos chilenos (USD/CLP)</label>
    <button class="btn danger" data-action="reset">🗑 Borrar toda mi información local</button></div>

    <div class="card"><h2 style="margin-top:0">🔁 Bitácora de mejora continua</h2>
    <p class="small muted">Anota aquí lo que quieres cambiar de la app o del modelo (pesos, nuevos tickers, ideas). Luego exporta y pégamelo en el chat: cada iteración aprende de tu feedback.</p>
    <label class="field">Nueva nota<textarea id="logText" placeholder="Ej: el score de largo plazo castiga demasiado a las empresas con deuda…"></textarea></label>
    <button class="btn secondary" data-action="addLog">＋ Guardar nota</button>
    ${S.pf.log.slice().reverse().slice(0, 10).map((l) => `<div class="small" style="padding:6px 0;border-top:1px solid var(--border)"><span class="muted tiny">${l.d}</span><br>${esc(l.t)}</div>`).join('')}
    ${S.pf.log.length ? `<button class="btn secondary sm" data-action="copyLog" style="margin-top:8px">📋 Copiar bitácora</button>` : ''}</div>

    <div class="card"><h2 style="margin-top:0">📐 Cómo se calcula la señal</h2>
    <p class="small">Tres modelos independientes (no una sola nota):</p>
    <ul class="reasons"><li><b>Corto plazo</b>: tendencia (SMA20/50), RSI y momentum 1M, MACD, volumen, Bandas de Bollinger.</li>
    <li><b>Mediano plazo</b>: consenso de analistas, potencial al precio objetivo, revisiones de EPS, crecimiento, momentum 3–6M y P/E forward.</li>
    <li><b>Largo plazo</b>: crecimiento de ingresos, márgenes y ROE, deuda, FCF yield, PEG/P/E, visión de analistas y tendencia anual.</li>
    <li><b>Global</b> = ${d.weights?.horizons?.short * 100}% corto + ${d.weights?.horizons?.medium * 100}% mediano + ${d.weights?.horizons?.long * 100}% largo. <b>Compra fuerte</b> exige ≥ ${d.weights?.signal?.strong_buy} y confluencia (mediano y largo ≥ ${d.weights?.signal?.strong_buy_min_horizon}). Con confianza baja (p. ej. ETFs sin fundamentales) no se emiten señales fuertes.</li>
    <li><b>Riesgo</b>: beta, volatilidad 30d, drawdown 1A, capitalización y liquidez.</li></ul>
    <p class="tiny muted">Los pesos se editan en <code>config/weights.json</code>. Señal cuantitativa ≠ predicción segura: exige confluencia y gestiona el tamaño de posición. No es asesoría financiera.</p></div>`;
}

// ---- DETALLE DE ACTIVO --------------------------------------------------------
function openDetail(sym) {
  const t = tk(sym);
  const page = $('#page'), c = $('#pageContent');
  if (!t) { c.innerHTML = `<div class="page-head"><button class="icon-btn" data-action="closePage">←</button><b>${esc(sym)}</b></div><div class="inner"><div class="empty">Este ticker no está en el radar todavía.<br>Agrégalo a <code>config/universe.json</code> en GitHub y aparecerá en la próxima actualización.</div></div>`; page.hidden = false; document.body.classList.add('locked'); return; }
  S.detail = sym;
  const a = t.analysts, hist = S.history[sym] || [];
  const { open } = positions(); const pos = open.find((p) => p.sym === sym);
  const fav = S.pf.fav.includes(sym);
  const cov = t.tech.rating;
  let html = `<div class="page-head"><button class="icon-btn" data-action="closePage" aria-label="Volver">←</button>
    <div class="grow"><div class="row"><span class="sym" style="font-size:18px">${t.sym}</span>${t.etf ? '<span class="tag">ETF</span>' : ''}</div><div class="name ellipsis">${esc(t.name)}${t.sector ? ` · ${esc(t.sector)}` : ''}</div></div>
    <button class="icon-btn" data-action="fav" data-sym="${sym}" aria-label="Favorito" style="color:${fav ? 'var(--s)' : 'var(--muted)'}">${fav ? '★' : '☆'}</button></div><div class="inner">`;

  html += `<div class="card"><div class="between"><div><div class="hero mono">${fmtUSD(t.price)}</div><div class="mono ${cls(t.chg1d)}">${pct(t.chg1d)} hoy</div></div>
    <div class="center">${chip(t.signal)}<div class="hero mono t-${sigClass(t.signal)}" style="font-size:34px">${t.score ?? '—'}</div><div class="tiny muted">/100 · confianza ${t.conf}</div></div></div>
    ${spark(t.tech.spark, { big: true })}<div class="between tiny muted mono"><span>6 meses</span><span>1S ${pct(t.tech.ret?.['1w'])} · 1M ${pct(t.tech.ret?.['1m'])} · 3M ${pct(t.tech.ret?.['3m'])} · 1A ${pct(t.tech.ret?.['1y'])}</span></div></div>`;

  if (pos) html += `<div class="card" style="border-color:var(--accent)"><div class="between"><b>💼 Mi posición</b><span class="mono ${cls(p_(pos))}">${pct(pos.pnlPct)} · ${fmtUSD(pos.pnl)}</span></div>
    <div class="small muted mono">${fmtN(pos.qty, 4).replace(/,?0+$/, '')} acciones · promedio ${fmtUSD(pos.avg)} · valor ${fmtUSD(pos.value)}</div>${positionAdvice(t, pos)}</div>`;

  html += `<div class="btn-row"><button class="btn green" data-action="addTx" data-type="buy" data-sym="${sym}">＋ Compré</button><button class="btn danger" data-action="addTx" data-type="sell" data-sym="${sym}" ${pos ? '' : 'disabled'}>－ Vendí</button></div>`;

  // Horizontes
  html += `<div class="card"><h2 style="margin-top:0">Señal por horizonte</h2><div class="hbars">${['short', 'medium', 'long'].map((h) => scoreBar(t.h[h].s, HZ[h], t.h[h].sig)).join('')}</div>
    <div class="between" style="margin-top:10px"><span class="small muted">Riesgo</span><span class="chip ${t.risk.label === 'Alto' ? 'strong_sell' : t.risk.label === 'Medio' ? 'hold' : 'strong_buy'} sm">${t.risk.label} ${t.risk.s ?? ''}</span></div>
    ${['short', 'medium', 'long'].map((h) => { const parts = Object.entries(t.h[h].parts || {}).filter(([, v]) => v != null); return parts.length ? `<details><summary class="small">Desglose ${HZ[h].toLowerCase()}</summary><div class="hbars" style="margin:6px 0">${parts.map(([k, v]) => scoreBar(v, PART_LABEL[k] || k)).join('')}</div></details>` : ''; }).join('')}
    ${t.reasons.length ? `<h3>Por qué</h3><ul class="reasons">${t.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</div>`;

  // Analistas
  if (a && (a.count || a.target?.mean)) {
    const d = a.dist, tot = d ? d.sb + d.b + d.h + d.s + d.ss : 0;
    html += `<div class="card"><div class="between"><h2 style="margin:0">Wall Street</h2>${a.key ? chip(a.key) : ''}</div><div class="small muted">${a.count} analistas · media ${a.mean ?? '—'} (1 = compra fuerte, 5 = venta fuerte)</div>
      ${tot ? `<div class="stack" style="margin-top:8px">${[['sb', 'sb'], ['b', 'b'], ['h', 'h'], ['s', 's'], ['ss', 'ss']].map(([k, c]) => d[k] ? `<i class="c-${c}" style="width:${(d[k] / tot) * 100}%"></i>` : '').join('')}</div>
      <div class="legend"><span><i class="c-sb"></i>Compra fuerte ${d.sb}</span><span><i class="c-b"></i>Compra ${d.b}</span><span><i class="c-h"></i>Mantener ${d.h}</span><span><i class="c-s"></i>Venta ${d.s}</span><span><i class="c-ss"></i>Venta fuerte ${d.ss}</span></div>` : ''}
      ${a.target?.mean ? targetRange(t.price, a.target) : ''}
      ${a.revisions ? `<div class="small" style="margin-top:6px">Revisiones EPS (30 días): <b class="up">${a.revisions.up} ↑</b> · <b class="down">${a.revisions.down} ↓</b></div>` : ''}</div>`;
  }

  // Técnico
  html += `<div class="card"><div class="between"><h2 style="margin:0">Técnico</h2>${cov ? chip(cov.label) : ''}</div>
    ${cov ? `<div class="small muted">${cov.buy} indicadores compran · ${cov.neutral} neutrales · ${cov.sell} venden (estilo TradingView)</div>` : ''}
    <div class="kv" style="margin-top:8px"><div><span>RSI 14</span><b class="${t.tech.rsi > 70 ? 'down' : t.tech.rsi < 30 ? 'up' : ''}">${t.tech.rsi ?? '—'}</b></div><div><span>MACD hist.</span><b class="${cls(t.tech.macd_hist)}">${t.tech.macd_hist ?? '—'}</b></div>
    <div><span>SMA 20</span><b class="${cls(t.price - t.tech.sma20)}">${fmtN(t.tech.sma20, 2)}</b></div><div><span>SMA 50</span><b class="${cls(t.price - t.tech.sma50)}">${fmtN(t.tech.sma50, 2)}</b></div>
    <div><span>SMA 200</span><b class="${cls(t.price - t.tech.sma200)}">${fmtN(t.tech.sma200, 2)}</b></div><div><span>Bollinger %B</span><b>${t.tech.bb_pct ?? '—'}</b></div>
    <div><span>Máx / mín 52s</span><b>${fmtN(t.tech.hi52, 0)} / ${fmtN(t.tech.lo52, 0)}</b></div><div><span>Volumen vs 50d</span><b>${t.tech.vol_ratio ?? '—'}x</b></div>
    <div><span>Volatilidad 30d</span><b>${t.tech.vol30 ?? '—'}%</b></div><div><span>Drawdown 1A</span><b class="down">${t.tech.max_dd ?? '—'}%</b></div></div></div>`;

  // Fundamentales
  const f = t.fund;
  if (!t.etf) html += `<div class="card"><h2 style="margin-top:0">Fundamentales</h2><div class="kv">
    <div><span>Capitalización</span><b>${big(f.market_cap)}</b></div><div><span>Beta</span><b>${f.beta ?? '—'}</b></div>
    <div><span>P/E</span><b>${f.trailing_pe ?? '—'}</b></div><div><span>P/E forward</span><b>${f.forward_pe ?? '—'}</b></div>
    <div><span>PEG</span><b>${f.peg ?? '—'}</b></div><div><span>Crec. ingresos</span><b class="${cls(f.revenue_growth)}">${pct(f.revenue_growth)}</b></div>
    <div><span>Crec. utilidades</span><b class="${cls(f.earnings_growth)}">${pct(f.earnings_growth)}</b></div><div><span>Margen neto</span><b class="${cls(f.profit_margin)}">${pct(f.profit_margin, 1, false)}</b></div>
    <div><span>ROE</span><b>${pct(f.roe, 1, false)}</b></div><div><span>Deuda / patrimonio</span><b>${f.debt_to_equity ?? '—'}</b></div>
    <div><span>FCF yield</span><b>${pct(f.fcf_yield, 1, false)}</b></div><div><span>Dividendo</span><b>${pct(f.dividend_yield, 2, false)}</b></div></div>
    ${t.earnings_date ? `<p class="small">📅 Próximos resultados: <b>${t.earnings_date}</b></p>` : ''}</div>`;

  // Historial del score
  if (hist.length >= 2) html += `<div class="card"><h2 style="margin-top:0">Evolución del score <small>${hist.length} días</small></h2>${spark(hist.map((h) => h.s ?? 50), { big: true, color: 'var(--accent)' })}
    <div class="between tiny muted mono"><span>${hist[0].d}: ${hist[0].s} (${SIG_LABEL[hist[0].sig]})</span><span>${hist[hist.length - 1].d}: ${hist[hist.length - 1].s}</span></div></div>`;

  // Noticias
  if (t.news?.length) html += `<div class="card news"><h2 style="margin-top:0">Noticias</h2>${t.news.map((n) => `<div class="n"><a href="${esc(n.u || '#')}" target="_blank" rel="noopener">${esc(n.t)}</a><div class="meta">${esc(n.p)} · ${relTime(n.d)}</div>${n.s ? `<div class="tiny muted">${esc(n.s)}</div>` : ''}</div>`).join('')}</div>`;

  html += `<button class="btn secondary" data-action="copyPrompt" data-kind="super" data-sym="${sym}">🤖 Copiar superprompt IA de ${sym}</button>
    <p class="tiny muted center">Señal cuantitativa, no asesoría financiera. Datos: Yahoo Finance · ${S.data.date}</p></div>`;
  c.innerHTML = html; page.hidden = false; page.scrollTop = 0; document.body.classList.add('locked');
}
const p_ = (pos) => pos.pnl;

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
  else if (s === 'sell') msg = pos.pnlPct > 0 ? 'Considera tomar ganancias parciales (p. ej. 30–50%) y subir el stop.' : 'Revisa la tesis; considera reducir para limitar la pérdida.';
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
    <div class="grid2"><label class="field">Cantidad${pos ? ` <span class="muted">(tienes ${fmtN(pos.qty, 4).replace(/,?0+$/, '')})</span>` : ''}<input id="txQty" type="number" inputmode="decimal" step="any" min="0" value="${t ? t.qty : ''}" placeholder="10"></label>
    <label class="field">Precio USD<input id="txPrice" type="number" inputmode="decimal" step="any" min="0" value="${t ? t.price : d?.price ?? ''}" placeholder="180.50"></label></div>
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
  const type = $('#txType .on')?.dataset.v, sym = $('#txSym').value.trim().toUpperCase();
  const qty = +$('#txQty').value, price = +$('#txPrice').value; const d = tk(sym);
  let s = '';
  if (sym && !d) s += `⚠️ ${sym} no está en el radar: se guardará pero sin precio actual hasta agregarlo a universe.json. `;
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
  const rec = { id: id || uid(), sym, type, qty, price, date, note, sig: d?.signal || null, score: d?.score ?? null };
  if (id) { const i = S.pf.tx.findIndex((x) => x.id === id); const old = S.pf.tx[i]; S.pf.tx[i] = { ...old, qty, price, date, note, type }; }
  else S.pf.tx.push(rec);
  savePf(); closeSheet(); toast(type === 'buy' ? 'Compra registrada' : 'Venta registrada');
  if (!$('#page').hidden && S.detail) openDetail(S.detail); render();
}

// ----------------------------------------------------------------------------
// Sheet / page helpers
// ----------------------------------------------------------------------------
function openSheet(html) { $('#sheetContent').innerHTML = html; $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; }
function closePage() { $('#page').hidden = true; document.body.classList.remove('locked'); S.detail = null; render(); }

function exportBackup() {
  const payload = { app: 'market-intelligence-ai', version: APP_VERSION, exported: new Date().toISOString(), portfolio: S.pf, settings: S.settings };
  const text = JSON.stringify(payload, null, 1);
  openSheet(`<h2 style="margin-top:4px">Respaldo</h2><p class="small muted">Copia este texto y guárdalo (Notas, correo, Drive). Para restaurar: Ajustes → Importar → pegar.</p>
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
    if (j.settings) S.settings = { ...S.settings, ...j.settings };
    savePf(); saveJSON(LS.settings, S.settings); closeSheet(); render(); toast(`Importados ${n} movimientos`);
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
    if (k === 'type' && v === 'fav') S.radar.fav = !S.radar.fav; else if (k === 'type') { S.radar.type = v; S.radar.fav = false; } else S.radar[k] = v;
    render(); return;
  }
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action, sym = el.dataset.sym;
  switch (a) {
    case 'detail': openDetail(sym); break;
    case 'closePage': closePage(); break;
    case 'closeSheet': closeSheet(); break;
    case 'addTx': openTxSheet({ type: el.dataset.type || 'buy', sym: sym || '' }); break;
    case 'editTx': openTxSheet({ id: el.dataset.id }); break;
    case 'saveTx': saveTx(el.dataset.id || null); break;
    case 'deleteTx': if (confirm('¿Eliminar este movimiento?')) { S.pf.tx = S.pf.tx.filter((t) => t.id !== el.dataset.id); savePf(); closeSheet(); render(); if (S.detail) openDetail(S.detail); } break;
    case 'fav': { const i = S.pf.fav.indexOf(sym); if (i >= 0) S.pf.fav.splice(i, 1); else S.pf.fav.push(sym); savePf(); openDetail(sym); break; }
    case 'reload': loadData(true); break;
    case 'export': exportBackup(); break;
    case 'import': importBackup(); break;
    case 'doImport': doImport(); break;
    case 'copyText': copy($('#' + el.dataset.target).value); break;
    case 'shareBk': try { await navigator.share({ title: 'Respaldo Market IA', text: $('#bk').value }); } catch { /* cancelado */ } break;
    case 'reset': if (confirm('Se borrará tu cartera, favoritos y bitácora de este dispositivo. ¿Continuar?')) { localStorage.removeItem(LS.portfolio); S.pf = { tx: [], fav: [], log: [], cash: 0 }; render(); toast('Información borrada'); } break;
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
  if (e.target.id === 'radarQ') { S.radar.q = e.target.value; const list = $('#view'); const pos = e.target.selectionStart; render(); const q = $('#radarQ'); q.focus(); q.setSelectionRange(pos, pos); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'iaSym') { S.iaSym = e.target.value; render(); }
  if (e.target.id === 'showClp') { S.settings.showClp = e.target.checked; saveJSON(LS.settings, S.settings); }
});
$('#btnRefresh').addEventListener('click', () => loadData(true));
window.addEventListener('popstate', () => { if (!$('#page').hidden) closePage(); else if (!$('#sheet').hidden) closeSheet(); });

// Service worker (PWA offline)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

loadData();
