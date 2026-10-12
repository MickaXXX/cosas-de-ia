/* Ranking dinámico y explicable. Puertas de calidad separan "oportunidades con evidencia
 * suficiente" de "calificación provisional / faltan datos". DEMO nunca entra al ranking real. */
import { S, LS, actions, on } from './core.js';
import { $, handle, toast } from './ui.js';
import { analyzeUnit } from './analysis.js';
import { scoreWithProfile, COMPONENTS } from './scoring.js';
import { monteCarlo, riskLabel } from './risk.js';
import { clp, uf, pct, date, esc } from './format.js';
import { setConfigValue } from './admin.js';
import { passes } from './app.js';

const TABS = [
  ['tradicional', 'Mejores para arriendo tradicional'],
  ['airbnb', 'Mejores para Airbnb'],
  ['riesgo', 'Bajo riesgo de flujo negativo'],
  ['neta', 'Mayor rentabilidad neta'],
  ['equilibrio', 'Equilibrio rentabilidad/seguridad/liquidez'],
  ['valorizacion', 'Potencial de valorización 5–10 años'],
  ['presupuesto', 'Con mi presupuesto y pie'],
  ['recientes', 'Recién publicados y rebajas'],
];
const SORTS = [['score', 'Score'], ['price', 'Precio'], ['equity', 'Capital inicial'], ['dividend', 'Dividendo'], ['noi', 'Arriendo neto'], ['cf', 'Flujo mensual'], ['gross', 'Rentabilidad bruta'], ['cap', 'Rentabilidad neta'], ['coc', 'Sobre capital'], ['risk', 'Riesgo'], ['pneg', 'Prob. año negativo'], ['updated', 'Actualización']];

let strCache = new Map(), mcCache = new Map(), prevPos = new Map();
on('recomputed', () => { strCache = new Map(); mcCache = new Map(); });

function state() {
  return S.rank ||= { tab: 'tradicional', allUnits: false, sort: null, weights: null, showDemo: true };
}

function weights() {
  const st = state();
  return st.weights || S.config.ranking.profiles[S.config.ranking.profile].weights;
}

function candidates() {
  const st = state();
  const out = [];
  for (const p of S.projects) {
    if (!passes(p)) continue;
    const an = S.analyses.get(p.id);
    if (!an?.units.length) continue;
    const units = st.allUnits ? an.units : [an.best];
    for (const a of units) out.push(a);
  }
  return out;
}

function strOf(a) {
  const k = `${a.project.id}::${a.unit.id}`;
  if (!strCache.has(k)) strCache.set(k, analyzeUnit(a.project, a.unit, S.ctx, { mode: 'renta_corta' }));
  return strCache.get(k);
}

function mcOf(a) {
  const k = `${a.project.id}::${a.unit.id}::${a.mode}`;
  if (!mcCache.has(k)) {
    mcCache.set(k, a.input.rentUf > 0 || a.mode === 'renta_corta'
      ? monteCarlo(a.input, { ...S.config.risk.monteCarlo, iterations: S.config.risk.monteCarlo.rankingIterations }, { reserveUf: S.config.investor.reserveUf ?? S.config.risk.defaultReserveUf })
      : null);
  }
  return mcCache.get(k);
}

function metricOf(a, key) {
  const m = a.metrics, ufv = S.raw.uf?.value;
  switch (key) {
    case 'score': return a._score;
    case 'price': return a.priceUf;
    case 'equity': return a.structure.equity;
    case 'dividend': return m.dividend;
    case 'noi': return m.monthlyNoi * ufv;
    case 'cf': return m.monthlyCf * ufv;
    case 'gross': return m.grossYield;
    case 'cap': return m.capRate;
    case 'coc': return m.cashOnCash;
    case 'risk': return a.risk.total;
    case 'pneg': return mcOf(a)?.probNegativeFirstYear ?? 1;
    case 'updated': return Date.parse(a.project.observed_at || a.project.first_seen_at || 0) || 0;
    default: return 0;
  }
}
const ASC = new Set(['price', 'equity', 'dividend', 'risk', 'pneg']);

function build(tab) {
  const w = weights();
  let list = candidates().map((a0) => {
    const a = tab === 'airbnb' ? strOf(a0) : a0;
    const ps = scoreWithProfile(a.components, w);
    return Object.assign(Object.create(Object.getPrototypeOf(a)), a, { _score: ps.score, _contrib: ps.contrib });
  });
  const inv = S.config.investor;
  let note = '';
  let sortKey = 'score';
  switch (tab) {
    case 'airbnb':
      note = 'Solo unidades con renta corta PERMITIDA y verificada pueden estar arriba. El resto queda "por revisar". Ingresos de Airbnb = simulación de supuestos (sin proveedor licenciado).';
      break;
    case 'riesgo':
      sortKey = 'pneg';
      note = `Ordenado por probabilidad SIMULADA de flujo anual negativo en el año 1 (${S.config.risk.monteCarlo.rankingIterations} iteraciones por unidad; distribuciones supuestas y editables).`;
      break;
    case 'neta': sortKey = 'cap'; note = 'Rentabilidad neta sin deuda: NOI anual / (precio real + gastos). No depende del crédito.'; break;
    case 'equilibrio':
      for (const a of list) a._score = ['rentabilidad_neta', 'vacancia', 'liquidez', 'seguridad_servicios', 'flujo'].reduce((s, k) => s + a.components[k], 0) / 5;
      note = 'Promedio simple de rentabilidad neta, facilidad de arrendar, liquidez, seguridad/servicios y flujo.';
      break;
    case 'valorizacion':
      for (const a of list) a._score = a.appreciation.score;
      note = 'PROYECCIÓN: obras futuras cercanas ponderadas por etapa, certeza y distancia. Separado del flujo observado; las obras pueden atrasarse o no hacerse.';
      break;
    case 'presupuesto':
      if (inv.pieAvailableUf == null) note = 'Define tu capital disponible y tu tolerancia de flujo en Configuración → Mi perfil. Mientras tanto se muestran todas.';
      else {
        const ufv = S.raw.uf?.value;
        list = list.filter((a) => a.structure.equity <= inv.pieAvailableUf && (inv.maxNegativeFlowClp == null || a.metrics.monthlyCf * ufv >= inv.maxNegativeFlowClp));
        note = `Capital inicial ≤ ${uf(inv.pieAvailableUf, 0)}${inv.maxNegativeFlowClp != null ? ` y flujo ≥ ${clp(inv.maxNegativeFlowClp)}/mes` : ''}.`;
      }
      break;
    case 'recientes': {
      const cutoff = Date.now() - 60 * 86400000;
      list = list.filter((a) => {
        const h = a.project.price_history || [];
        const drop = h.length >= 2 && h.at(-1).min_price_uf < h.at(-2).min_price_uf;
        a._drop = drop ? h.at(-2).min_price_uf - h.at(-1).min_price_uf : 0;
        return drop || Date.parse(a.project.first_seen_at || 0) >= cutoff;
      });
      sortKey = 'updated';
      note = 'Proyectos ingresados en los últimos 60 días o con baja de precio registrada en su historial.';
      break;
    }
    default: note = 'Score del perfil activo sobre flujo, vacancia, rentabilidades, liquidez, entorno y evidencia.';
  }
  const st = state();
  const key = st.sort || sortKey;
  list.sort((x, y) => (ASC.has(key) ? metricOf(x, key) - metricOf(y, key) : metricOf(y, key) - metricOf(x, key)));
  const isTop = (a) => !a.project.demo && a.gates.passed && (tab !== 'airbnb' || a.strStatus === 'permitido_verificado') && (tab !== 'airbnb' || a.metrics.monthlyCf != null);
  return { top: list.filter(isTop), provisional: list.filter((a) => !isTop(a)), note, key };
}

export function renderRanking(root) {
  const st = state();
  const cfg = S.config;
  const w = weights();
  const { top, provisional, note, key } = build(st.tab);
  const all = [...top, ...provisional];
  const pos = new Map(all.map((a, i) => [`${a.project.id}::${a.unit.id}`, i + 1]));
  root.innerHTML = `<div class="wrap">
    <h1 class="page">Ranking de oportunidades</h1>
    <p class="lead">Ranking dinámico y explicable. Una unidad solo es "oportunidad con evidencia suficiente" si tiene precio reciente con fuente, ubicación confiable, arriendo con ${cfg.ranking.gates.minComps}+ comparables, financiamiento posible y entrega verificada. La falta de datos nunca sube el puntaje.</p>
    <div class="rank-tabs">${TABS.map(([k, l]) => `<button class="btn sm ${st.tab === k ? 'on' : ''}" data-action="rank-tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="card"><div class="row between">
      <div class="row"><span class="small"><b>Perfil:</b></span><div class="seg">${Object.entries(cfg.ranking.profiles).map(([k, p]) => `<button class="${cfg.ranking.profile === k && !st.weights ? 'on' : ''}" data-action="rank-profile" data-p="${k}">${esc(p.label)}</button>`).join('')}</div>
        ${st.weights ? '<span class="chip info">pesos personalizados</span>' : ''}</div>
      <div class="row"><label class="check"><input type="checkbox" data-rank-all ${st.allUnits ? 'checked' : ''}>Todas las unidades</label>
        <label class="small">Ordenar por <select data-rank-sort>${SORTS.map(([k, l]) => `<option value="${k}" ${key === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div></div>
      <details style="margin-top:8px"><summary class="small"><b>Ajustar pesos</b> y ver cómo cambian las posiciones</summary>
        <div class="weights" style="margin-top:8px">${Object.keys(COMPONENTS).map((k) => `<label class="field"><span>${esc(COMPONENTS[k].label)}: <b class="num">${w[k] ?? 0}</b></span><input type="range" min="0" max="50" step="1" value="${w[k] ?? 0}" data-rank-w="${k}"></label>`).join('')}</div>
        <div class="row" style="margin-top:6px"><button class="btn sm" data-action="rank-save-w">Guardar como pesos del perfil ${esc(cfg.ranking.profiles[cfg.ranking.profile].label)}</button><button class="btn sm" data-action="rank-reset-w">Descartar</button></div>
      </details>
      <p class="small muted" style="margin:8px 0 0">${esc(note)}</p></div>
    <h3 style="margin:16px 0 8px">Oportunidades con evidencia suficiente (${top.length})</h3>
    ${top.length ? top.map((a, i) => card(a, i + 1, pos)).join('') : `<div class="card empty"><b>Ninguna unidad pasa todas las puertas de calidad todavía</b>Es lo esperable con los datos actuales: ningún proyecto real tiene entrega/stock verificados ni ${cfg.ranking.gates.minComps} comparables de arriendo cargados. Registra verificaciones e importa avisos de arriendo para que aparezcan aquí.</div>`}
    <h3 style="margin:20px 0 8px">Calificación provisional / faltan datos (${provisional.length})</h3>
    <p class="small muted" style="margin-top:-4px">Análisis con la información disponible; cada tarjeta dice qué falta. ${S.demo ? 'Los proyectos DEMO solo aparecen aquí.' : ''}</p>
    ${provisional.slice(0, 80).map((a, i) => card(a, top.length + i + 1, pos)).join('') || '<div class="empty">Sin unidades con los filtros actuales.</div>'}
  </div>`;
  prevPos = pos;
}

function card(a, n, pos) {
  const ufv = S.raw.uf?.value, m = a.metrics, p = a.project;
  const k = `${p.id}::${a.unit.id}`;
  const before = prevPos.get(k), now = pos.get(k);
  const delta = before && now && before !== now ? (before > now ? `<span class="chip good">▲${before - now}</span>` : `<span class="chip crit">▼${now - before}</span>`) : '';
  const ex = a.explanation;
  const mc = state().tab === 'riesgo' || state().sort === 'pneg' ? mcOf(a) : null;
  const inCmp = LS.get('compare', []).includes(k);
  const st = a.status;
  return `<article class="rank-card">
    <div class="pos">#${n}<small class="num">${Math.round(a._score)}</small><span class="lbl">${state().tab === 'valorizacion' ? 'proyectivo' : state().tab === 'equilibrio' ? 'equilibrio' : 'score'}</span>${delta}</div>
    <div><div class="row between"><h3>${esc(p.name)} · ${esc(a.unit.type || `${a.unit.bedrooms}D`)} ${a.unit.useful_m2 ? `${a.unit.useful_m2} m²` : ''}</h3>
      <div class="row">${p.demo ? '<span class="chip demo">DEMO</span>' : ''}<span class="chip" style="background:${st.color}22;color:var(--text)"><span class="dot" style="background:${st.color}"></span>${esc(st.label)}</span>${a.unit.hypothetical ? '<span class="chip serious">unidad hipotética</span>' : ''}</div></div>
      <div class="small muted">${esc(p.commune)} · ${esc(p.developer?.name || 'inmobiliaria s/d')} · actualizado ${date(p.observed_at || p.first_seen_at)}${a._drop ? ` · <b>baja de ${uf(a._drop, 0)}</b>` : ''}</div>
      <div class="small" style="margin-top:4px"><b>Por qué aparece aquí:</b> ${esc(ex.why)}</div>
      <div class="rank-metrics">
        <div>Precio<b>${uf(a.priceUf, 0)}</b></div><div>Capital inicial<b>${uf(a.structure.equity, 0)}</b></div>
        <div>Dividendo<b>${clp(m.dividend * ufv)}</b></div><div>Arriendo neto<b>${clp(m.monthlyNoi * ufv)}</b></div>
        <div>Flujo mensual<b style="color:var(--${m.monthlyCf >= 0 ? 'good' : 'crit'})">${clp(m.monthlyCf * ufv, { sign: true })}</b></div>
        <div>Rent. bruta / neta<b>${pct(m.grossYield)} / ${pct(m.capRate)}</b></div><div>Sobre capital<b>${pct(m.cashOnCash)}</b></div>
        <div>Riesgo<b>${Math.round(a.risk.total)} · ${riskLabel(a.risk.total)}</b></div>
        <div>${mc ? 'Prob. sim. año negativo' : 'Meses negativos (24)'}<b>${mc ? pct(mc.probNegativeFirstYear, 0) : `${m.negativeMonths24}/24`}</b></div>
        ${state().tab === 'airbnb' ? `<div>Ocupación equilibrio<b>${m.breakeven?.occupancy != null ? pct(m.breakeven.occupancy, 0) : 's/d'}</b></div>` : ''}
        ${state().tab === 'valorizacion' ? `<div>Obras que suman<b>${a.appreciation.reasons.map((r) => esc(r.name.split('·')[0])).slice(0, 2).join(', ') || '—'}</b></div>` : ''}
      </div>
      <div class="pc"><div><div class="h" style="color:var(--good)">3 ventajas</div><ul>${ex.pros.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div><div class="h" style="color:var(--crit)">3 riesgos</div><ul>${ex.cons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div><div class="h" style="color:var(--warn)">Datos pendientes</div><ul>${ex.pending.length ? ex.pending.slice(0, 4).map((x) => `<li>${esc(x)}</li>`).join('') : '<li>Ninguno</li>'}</ul></div></div>
      <div class="row" style="margin-top:8px"><button class="btn sm primary" data-action="open-project" data-id="${esc(p.id)}" data-unit="${esc(a.unit.id)}">Ver ficha</button>
        <button class="btn sm ${inCmp ? 'on' : ''}" data-action="rank-cmp" data-id="${esc(p.id)}" data-unit="${esc(a.unit.id)}">${inCmp ? '✓ En comparador' : '+ Comparar'}</button>
        ${p.lat != null ? `<button class="btn sm" data-action="rank-map" data-id="${esc(p.id)}">Ver en mapa</button>` : ''}</div>
    </div></article>`;
}

handle('rank-tab', (el) => { state().tab = el.dataset.tab; state().sort = null; prevPos = new Map(); renderRanking($('#view-ranking')); });
handle('rank-profile', (el) => { state().weights = null; setConfigValue('ranking.profile', el.dataset.p); renderRanking($('#view-ranking')); });
handle('rank-cmp', (el) => { actions.toggleCompare(el.dataset.id, el.dataset.unit); renderRanking($('#view-ranking')); });
handle('rank-map', (el) => { actions.setView('mapa'); actions.selectProject(el.dataset.id, { fly: true, popup: true }); });
handle('rank-save-w', () => {
  const st = state();
  if (!st.weights) return toast('No hay cambios de pesos');
  setConfigValue(`ranking.profiles.${S.config.ranking.profile}.weights`, st.weights);
  st.weights = null;
  renderRanking($('#view-ranking'));
  toast('Pesos guardados (con registro en Configuración → Auditoría)');
});
handle('rank-reset-w', () => { state().weights = null; renderRanking($('#view-ranking')); });
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('[data-rank-all]')) { state().allUnits = el.checked; renderRanking($('#view-ranking')); }
  if (el.matches('[data-rank-sort]')) { state().sort = el.value; renderRanking($('#view-ranking')); }
  if (el.dataset.rankW) {
    const st = state();
    st.weights = { ...weights(), [el.dataset.rankW]: +el.value };
    renderRanking($('#view-ranking'));
  }
});
