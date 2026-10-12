/* Comparador, Simulador, Radar urbano, Alertas, Favoritos y Fuentes y datos. */
import { S, LS, actions, analysisOf, projectById } from './core.js';
import { $, handle, toast, openIssue, download, toCSV, openModal, closeModal } from './ui.js';
import { simulate, runScenarios, withDefaults, sensitivity } from './finance.js';
import { barChart, lineChart, meter } from './charts.js';
import { clp, uf, pct, num, meters, date, esc, MONTHS, monthIndexSantiago } from './format.js';
import { DEV_LABELS, DEV_COLORS } from './map.js';
import { devGeometry } from './analysis.js';
import { distanceToGeometry } from './geo.js';
import { riskLabel } from './risk.js';
import { stageLabel } from './app.js';

const ufv = () => S.raw.uf?.value;

// ================================================================== COMPARADOR
export function renderComparador(root) {
  const keys = LS.get('compare', []);
  const sc = S.cmpScenario || 'base';
  const items = keys.map((k) => { const [pid, uid] = k.split('::'); const a = analysisOf(pid, uid); return a ? { k, a, r: sc === 'base' ? a.base : a.scenarios[sc] } : null; }).filter(Boolean);
  if (items.length < 2) {
    root.innerHTML = `<div class="wrap"><h1 class="page">Comparador</h1><div class="card empty"><b>Agrega entre 2 y 5 unidades</b>Usa “+ Comparar” en el mapa, el ranking o una ficha. Llevas ${items.length}.</div>
      ${items.map(({ a, k }) => `<div class="card row between"><span>${esc(a.project.name)} · ${esc(a.unit.type || '')}</span><button class="btn sm" data-action="cmp-remove" data-k="${esc(k)}">Quitar</button></div>`).join('')}</div>`;
    return;
  }
  const v = ufv();
  const row = (label, f, best) => {
    const vals = items.map((it) => f(it));
    let bi = -1;
    if (best) { const nums = vals.map((x) => (typeof x === 'object' ? x.n : null)); const target = best === 'max' ? Math.max(...nums.filter(Number.isFinite)) : Math.min(...nums.filter(Number.isFinite)); bi = nums.indexOf(target); }
    return `<tr><td>${label}</td>${vals.map((x, i) => `<td class="num" ${i === bi ? 'style="font-weight:800"' : ''}>${typeof x === 'object' ? x.t : x}</td>`).join('')}</tr>`;
  };
  const N = (n, t) => ({ n, t });
  const months = 60;
  const series = items.map(({ a, r }) => {
    let acc = 0;
    return { name: `${a.project.name.replace('DEMO · ', '')} ${a.unit.type || ''}`, values: r.months.slice(0, months + 1).map((m) => (acc += m.cf - m.equity) * v) };
  });
  root.innerHTML = `<div class="wrap"><h1 class="page">Comparador</h1>
    <p class="lead">Mismo escenario y mismos supuestos para todas las unidades. Negrita = mejor valor de la fila.</p>
    <div class="row" style="margin-bottom:10px"><span class="small"><b>Escenario:</b></span><div class="seg">${['conservador', 'base', 'optimista', 'estres'].map((k) => `<button class="${sc === k ? 'on' : ''}" data-action="cmp-sc" data-sc="${k}">${esc(S.config.scenarios[k].label)}</button>`).join('')}</div>
      <button class="btn sm" data-action="cmp-csv">Descargar CSV</button></div>
    <div class="card table-scroll" style="max-height:none"><table class="t"><tr><th></th>${items.map(({ a, k }) => `<th class="num">${esc(a.project.name)}<div class="tiny">${esc(a.unit.type || '')} ${a.unit.useful_m2 ?? ''} m² ${a.project.demo ? '· DEMO' : ''}</div><button class="btn sm" data-action="cmp-remove" data-k="${esc(k)}">Quitar</button></th>`).join('')}</tr>
      ${row('Comuna', ({ a }) => esc(a.project.commune))}
      ${row('Entrega', ({ a }) => `<span class="status-dot" style="background:${a.status.color}"></span> ${esc(a.status.label)}`)}
      ${row('Precio', ({ a }) => N(a.priceUf, uf(a.priceUf, 0)), 'min')}
      ${row('UF/m²', ({ a }) => N(a.pricePerM2Uf, num(a.pricePerM2Uf, 1)), 'min')}
      ${row('Capital inicial', ({ r }) => N(r.structure.equity, uf(r.structure.equity, 0)), 'min')}
      ${row('Tu plan de pago', ({ a }) => (a.plan ? `<span class="chip ${a.plan.tone}">${a.plan.icon} ${esc(a.plan.short)}</span>` : 's/d'))}
      ${row('Cuotas del pie', ({ a }) => (a.plan ? (a.plan.cuotas ? `${a.plan.cuotas} × ${clp(a.plan.cuotaUf * v)}${a.terms.source === 'publicado' ? '' : ' (sup.)'}` : a.plan.minInstallmentsNeeded ? `necesitas ≥ ${a.plan.minInstallmentsNeeded}` : 'al escriturar') : 's/d'))}
      ${row('Peor mes de tu caja', ({ a }) => (a.plan ? N(a.plan.minBalanceUf, clp(a.plan.minBalanceUf * v)) : 's/d'), 'max')}
      ${row('Dividendo', ({ r }) => N(r.metrics.dividend * v, clp(r.metrics.dividend * v)), 'min')}
      ${row('Arriendo usado', ({ r }) => clp(r.input.rentUf * v))}
      ${row('Fuente del arriendo', ({ a }) => esc(a.rentSource))}
      ${row('Gasto común', ({ a }) => `${clp(a.gc.baseClp)} <span class="tiny muted">${esc(a.gc.kind)}</span>`)}
      ${row('Flujo mensual', ({ r }) => N(r.metrics.monthlyCf * v, clp(r.metrics.monthlyCf * v, { sign: true })), 'max')}
      ${row('Meses negativos (24)', ({ r }) => N(r.metrics.negativeMonths24, `${r.metrics.negativeMonths24}`), 'min')}
      ${row('Caja de respaldo', ({ r }) => N(r.metrics.liquidityNeededUf, clp(r.metrics.liquidityNeededUf * v)), 'min')}
      ${row('Rentabilidad bruta', ({ r }) => N(r.metrics.grossYield, pct(r.metrics.grossYield)), 'max')}
      ${row('Rentabilidad neta', ({ r }) => N(r.metrics.capRate, pct(r.metrics.capRate)), 'max')}
      ${row('Sobre capital', ({ r }) => N(r.metrics.cashOnCash, pct(r.metrics.cashOnCash)), 'max')}
      ${row('DSCR', ({ r }) => N(r.metrics.dscr, num(r.metrics.dscr, 2)), 'max')}
      ${row('TIR real 30 años', ({ r }) => N(r.metrics.irrReal, pct(r.metrics.irrReal)), 'max')}
      ${row('Riesgo', ({ a }) => N(a.risk.total, `${Math.round(a.risk.total)} · ${riskLabel(a.risk.total)}`), 'min')}
      ${row('Metro', ({ a }) => (a.metro ? N(a.metro.distance, meters(a.metro.distance)) : 's/d'), 'min')}
      ${row('Evidencia', ({ a }) => N(a.evidence.score, `${a.evidence.score}/100`), 'max')}
      ${row('Score', ({ a }) => N(a.score, Math.round(a.score)), 'max')}
      ${row('Estado', ({ a }) => (a.gates.passed ? '<span class="chip good">verificada</span>' : `<span class="chip warn" data-tip="${esc(a.gates.fails.join('\n'))}">provisional</span>`))}
    </table></div>
    <div class="card"><h3>Caja acumulada del inversionista (5 años, incluye pie y gastos)</h3>
      ${lineChart({ x: Array.from({ length: months + 1 }, (_, i) => (i % 12 === 0 ? `año ${i / 12}` : `mes ${i}`)), series, fmt: (x) => clp(x), zero: true, title: 'Caja acumulada' })}
      <p class="tiny muted">Pesos de hoy. Una curva que baja más es más capital comprometido; la pendiente después de la entrega es el flujo mensual.</p></div></div>`;
}
handle('cmp-remove', (el) => { LS.set('compare', LS.get('compare', []).filter((k) => k !== el.dataset.k)); actions.updateCounts(); renderComparador($('#view-comparador')); });
handle('cmp-sc', (el) => { S.cmpScenario = el.dataset.sc; renderComparador($('#view-comparador')); });
handle('cmp-csv', () => {
  const v = ufv();
  const rows = LS.get('compare', []).map((k) => { const [pid, uid] = k.split('::'); const a = analysisOf(pid, uid); return a && { proyecto: a.project.name, unidad: a.unit.id, demo: !!a.project.demo, precio_uf: a.priceUf, capital_uf: a.structure.equity.toFixed(1), dividendo_clp: Math.round(a.metrics.dividend * v), arriendo_clp: Math.round(a.input.rentUf * v), flujo_clp: Math.round(a.metrics.monthlyCf * v), rent_bruta: a.metrics.grossYield.toFixed(4), cap_rate: a.metrics.capRate.toFixed(4), coc: a.metrics.cashOnCash?.toFixed(4), tir_real: a.metrics.irrReal?.toFixed(4), riesgo: Math.round(a.risk.total), score: Math.round(a.score), estado: a.gates.passed ? 'verificada' : 'provisional' }; }).filter(Boolean);
  download('comparador.csv', toCSV(rows), 'text/csv;charset=utf-8');
});

// ================================================================== SIMULADOR
function simDefaults() {
  const cfg = S.config, f = cfg.financing, rm = cfg.rentalModel, v = ufv();
  return { mode: 'tradicional', priceUf: 3000, bonoPiePct: 0, creditPct: f.creditPct, annualRate: f.annualRate, rateConvention: f.rateConvention, loanYears: f.loanYears,
    deliveryMonths: 0, rentClp: 450000, gcClp: 90000, contribucionesUfYear: 0, initialVacancyMonths: rm.initialVacancyMonths, turnoverVacancyMonths: rm.turnoverVacancyMonths,
    leaseMonths: rm.leaseMonths, maintenancePctOfRent: rm.maintenancePctOfRent, adminPctOfRent: rm.adminPctOfRent, appreciationReal: cfg.valuation.appreciationReal,
    adrClp: cfg.airbnb.adrClp, occupancy: cfg.airbnb.occupancy, furnishingUf: cfg.airbnb.furnishingUf, _uf: v };
}

function simInput(s) {
  const cfg = S.config, v = ufv(), air = cfg.airbnb;
  return withDefaults({
    mode: s.mode, priceUf: s.priceUf, bonoPiePct: s.bonoPiePct, creditPct: s.creditPct, maxCreditPct: cfg.financing.maxCreditPct, annualRate: s.annualRate,
    rateConvention: s.rateConvention, loanYears: s.loanYears, deliveryMonths: s.deliveryMonths, pieInstallmentsMax: cfg.financing.pieInstallmentsMax,
    closing: cfg.financing.closing, furnishingUf: s.mode === 'renta_corta' ? s.furnishingUf : 0,
    desgravamenPctMonthly: cfg.financing.desgravamenPctMonthly, incendioPctMonthly: cfg.financing.incendioPctMonthly, insuredValueFactor: cfg.financing.insuredValueFactor,
    rentUf: s.rentClp / v, leaseMonths: s.leaseMonths, initialVacancyMonths: s.initialVacancyMonths, turnoverVacancyMonths: s.turnoverVacancyMonths,
    brokeragePctOfRent: cfg.rentalModel.brokeragePctOfRent, collectionLossPct: cfg.rentalModel.collectionLossPct, maintenancePctOfRent: s.maintenancePctOfRent,
    adminPctOfRent: s.adminPctOfRent, capexReserveUfMonth: cfg.rentalModel.capexReserveUfMonth, commonExpensesUf: s.gcClp / v, contribucionesUfYear: s.contribucionesUfYear,
    rentTaxPct: cfg.rentalModel.rentTaxPct, appreciationReal: s.appreciationReal, saleCostPct: cfg.valuation.saleCostPct, horizonYears: cfg.valuation.horizonYears,
    startMonthIndex: monthIndexSantiago(), ufInflation: cfg.valuation.ufInflation, discountRateReal: cfg.valuation.discountRateReal,
    str: { adrUf: s.adrClp / v, occupancy: s.occupancy, occupancyByMonth: air.occupancyByMonth, avgStayNights: air.avgStayNights, cleaningFeeUf: air.cleaningFeeClp / v,
      cleaningCostUf: air.cleaningCostClp / v, suppliesPerNightUf: air.suppliesPerNightClp / v, platformFeePct: air.platformFeePct, cohostPct: air.cohostPct,
      utilitiesUfMonth: air.utilitiesClpMonth / v, replacementPct: air.replacementPct, ivaApplies: air.ivaApplies, ivaRate: air.ivaRate },
  });
}

export function renderSimulador(root) {
  if (S.simFrom) {
    const i = S.simFrom.input, v = ufv();
    S.sim = { ...simDefaults(), mode: i.mode, priceUf: i.priceUf, bonoPiePct: i.bonoPiePct, creditPct: i.creditPct, annualRate: i.annualRate, rateConvention: i.rateConvention,
      loanYears: i.loanYears, deliveryMonths: i.deliveryMonths, rentClp: Math.round(i.rentUf * v), gcClp: Math.round(i.commonExpensesUf * v), contribucionesUfYear: +i.contribucionesUfYear.toFixed(2),
      initialVacancyMonths: i.initialVacancyMonths, turnoverVacancyMonths: i.turnoverVacancyMonths, _from: S.simFrom };
    S.simFrom = null;
  }
  const s = S.sim ||= simDefaults();
  const v = ufv();
  const inp = simInput(s);
  const r = simulate(inp);
  const sc = runScenarios(inp, S.config.scenarios);
  const m = r.metrics;
  const field = (k, l, step, mult = 1, help = '') => `<label class="field"><span>${l}</span><input type="number" step="${step}" data-simf="${k}" data-mult="${mult}" value="${+(s[k] * mult).toFixed(mult === 100 ? 2 : 2)}">${help ? `<span class="tiny muted">${help}</span>` : ''}</label>`;
  const op = r.months.filter((x) => x.t > m.deliveryMonths).slice(0, 24);
  const sens = [
    ['Arriendo', 'rentFactor', [0.8, 0.9, 1, 1.1, 1.2], (x) => `${Math.round((x - 1) * 100)}%`],
    ['Gasto común', 'commonExpensesFactor', [0.7, 0.85, 1, 1.15, 1.3], (x) => `${Math.round((x - 1) * 100)}%`],
    ['Tasa anual', 'annualRate', [-0.01, -0.005, 0, 0.005, 0.01].map((d) => inp.annualRate + d), (x) => pct(x, 2)],
    ['Meses vacíos entre contratos', 'turnoverVacancyMonths', [0, 0.5, 1, 2, 3], (x) => `${x}`],
    ['Precio de compra', 'priceFactor', [0.9, 0.95, 1, 1.05, 1.1], (x) => `${Math.round((x - 1) * 100)}%`],
  ];
  root.innerHTML = `<div class="wrap"><h1 class="page">Simulador hipotecario y de arriendo</h1>
    <p class="lead">Simulación en UF con amortización francesa, seguros, gastos de compra, vacancia, gasto común en meses vacíos y contribuciones. ${s._from ? `Cargado desde <a href="#" data-action="open-project" data-id="${esc(s._from.projectId)}" data-unit="${esc(s._from.unitId)}">${esc(projectById(s._from.projectId)?.name || '')}</a>.` : ''}</p>
    <div class="card"><div class="row" style="margin-bottom:8px"><div class="seg"><button class="${s.mode === 'tradicional' ? 'on' : ''}" data-action="sim-mode" data-m="tradicional">Arriendo tradicional</button><button class="${s.mode === 'renta_corta' ? 'on' : ''}" data-action="sim-mode" data-m="renta_corta">Renta corta (supuestos)</button></div>
      <button class="btn sm" data-action="sim-new">Valores por defecto</button></div>
      <div class="sim-grid">
        ${field('priceUf', 'Precio (UF)', 10)}${field('bonoPiePct', 'Bono pie (%)', 0.5, 100)}${field('creditPct', 'Crédito (%)', 1, 100)}${field('annualRate', 'Tasa anual (%)', 0.05, 100)}
        <label class="field"><span>Convención</span><select data-simf="rateConvention" data-kind="text"><option value="nominal" ${s.rateConvention === 'nominal' ? 'selected' : ''}>Anual/12</option><option value="efectiva" ${s.rateConvention === 'efectiva' ? 'selected' : ''}>Efectiva</option></select></label>
        ${field('loanYears', 'Plazo (años)', 1)}${field('deliveryMonths', 'Meses a la entrega (0 = inmediata)', 1)}
        ${s.mode === 'tradicional' ? field('rentClp', 'Arriendo (CLP/mes)', 5000) : `${field('adrClp', 'Tarifa por noche (CLP)', 1000)}${field('occupancy', 'Ocupación (%)', 1, 100)}${field('furnishingUf', 'Amoblado (UF)', 5)}`}
        ${field('gcClp', 'Gasto común (CLP/mes)', 1000)}${field('contribucionesUfYear', 'Contribuciones (UF/año)', 0.5)}
        ${s.mode === 'tradicional' ? `${field('initialVacancyMonths', 'Meses para arrendar', 0.5)}${field('turnoverVacancyMonths', 'Meses vacíos entre contratos', 0.5)}${field('leaseMonths', 'Duración contrato (meses)', 1)}` : ''}
        ${field('maintenancePctOfRent', 'Mantención (%)', 0.5, 100)}${field('appreciationReal', 'Plusvalía real anual (%)', 0.1, 100)}
      </div></div>
    <div class="card"><div class="kpis">
      <div class="kpi"><div class="k">Dividendo</div><div class="v">${clp(m.dividend * v)}</div><div class="s">${uf(m.dividend)} · renta req. ${clp(m.dividend * v / S.config.financing.incomeRatio)}</div></div>
      <div class="kpi"><div class="k">Capital inicial</div><div class="v">${uf(r.structure.equity, 0)}</div><div class="s">${clp(r.structure.equity * v)}</div></div>
      <div class="kpi"><div class="k">Flujo mensual</div><div class="v ${m.monthlyCf >= 0 ? 'pos' : 'neg'}">${clp(m.monthlyCf * v, { sign: true })}</div><div class="s">promedio estabilizado</div></div>
      <div class="kpi"><div class="k">Equilibrio</div><div class="v">${s.mode === 'tradicional' ? clp(m.breakeven.rentUf * v) : (m.breakeven.occupancy > 1 ? 'inalcanzable' : pct(m.breakeven.occupancy, 0))}</div><div class="s">${s.mode === 'tradicional' ? 'arriendo para flujo 0' : 'ocupación para flujo 0'}</div></div>
      <div class="kpi"><div class="k">Rent. bruta / neta</div><div class="v">${pct(m.grossYield)}</div><div class="s">neta sin deuda ${pct(m.capRate)} · s/capital ${pct(m.cashOnCash)}</div></div>
      <div class="kpi"><div class="k">TIR real 30 años</div><div class="v">${pct(m.irrReal)}</div><div class="s">nominal ≈ ${pct(m.irrNominal)}</div></div>
      <div class="kpi"><div class="k">Caja de respaldo</div><div class="v">${clp(m.liquidityNeededUf * v)}</div><div class="s">${num(m.reserveMonths, 1)} meses de obligaciones</div></div>
    </div>
    ${r.structure.warnings.map((w) => `<div class="note warn small" style="margin-top:6px">${esc(w)}</div>`).join('')}</div>
    <div class="card"><h3>Flujo 24 meses desde la entrega</h3>${barChart({ items: op.map((x, i) => ({ label: MONTHS[x.moy], value: x.cf * v, tip: `Mes ${i + 1} (${MONTHS[x.moy]}): ${clp(x.cf * v)}` })), fmt: (x) => clp(x), diverging: true, labelEvery: 3 })}</div>
    <div class="card"><h3>Escenarios</h3><table class="t"><tr><th></th>${Object.keys(sc).map((k) => `<th class="num">${esc(S.config.scenarios[k].label)}</th>`).join('')}</tr>
      <tr><td>Flujo mensual</td>${Object.values(sc).map((x) => `<td class="num">${clp(x.metrics.monthlyCf * v, { sign: true })}</td>`).join('')}</tr>
      <tr><td>Meses negativos (24)</td>${Object.values(sc).map((x) => `<td class="num">${x.metrics.negativeMonths24}</td>`).join('')}</tr>
      <tr><td>Caja de respaldo</td>${Object.values(sc).map((x) => `<td class="num">${clp(x.metrics.liquidityNeededUf * v)}</td>`).join('')}</tr>
      <tr><td>TIR real</td>${Object.values(sc).map((x) => `<td class="num">${pct(x.metrics.irrReal)}</td>`).join('')}</tr></table></div>
    <div class="card"><h3>Sensibilidad del flujo mensual</h3><div class="table-scroll"><table class="t">
      ${sens.map(([l, param, vals, fmt]) => { const res = sensitivity(inp, param, vals); return `<tr><td><b>${l}</b></td>${res.map((x) => `<td class="num">${fmt(x.value)}<div style="color:var(--${x.metric >= 0 ? 'good' : 'crit'})">${clp(x.metric * v, { sign: true })}</div></td>`).join('')}</tr>`; }).join('')}
    </table></div><p class="tiny muted">Cada celda recalcula la simulación completa cambiando solo ese parámetro.</p></div></div>`;
}
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset.simf) return;
  const s = S.sim;
  if (el.dataset.kind === 'text') s[el.dataset.simf] = el.value;
  else {
    const n = parseFloat(String(el.value).replace(',', '.'));
    if (!Number.isFinite(n)) return;
    s[el.dataset.simf] = n / (+el.dataset.mult || 1);
  }
  setTimeout(() => renderSimulador($('#view-simulador')), 0);
});
handle('sim-mode', (el) => { S.sim.mode = el.dataset.m; renderSimulador($('#view-simulador')); });
handle('sim-new', () => { S.sim = simDefaults(); renderSimulador($('#view-simulador')); });

// ================================================================== RADAR URBANO
export function renderRadar(root) {
  const devs = S.raw.developments;
  const f = S.radarFilter ||= { type: '', stage: '', status: 'publicado' };
  const list = devs.filter((d) => (!f.type || d.type === f.type) && (!f.stage || d.stage === f.stage) && (!f.status || d.status === f.status));
  const year = new Date().getFullYear();
  const buckets = [[1, 'Próximo año'], [3, '1 a 3 años'], [5, '3 a 5 años'], [10, '5 a 10 años']];
  const yr = (d) => parseInt(d.estimated_date || '', 10);
  const radar = S.raw.radar;
  const cands = (radar?.candidates || []).filter((c) => c.status === 'pendiente_revision');
  const focus = S.radarFocus;
  S.radarFocus = null;
  root.innerHTML = `<div class="wrap"><h1 class="page">Radar urbano</h1>
    <p class="lead">Obras y anuncios con fuente, etapa, certeza y radio justificado. Flujo: descubierto → extraído → georreferenciado → deduplicado → clasificado → <b>validado</b> → publicado. Una nota de prensa es una pista, no una confirmación.</p>
    <div class="card"><h3>Qué cambiará en Santiago</h3><div class="grid grid-4">${buckets.map(([y, l], i) => {
    const lo = i ? buckets[i - 1][0] : 0;
    const items = devs.filter((d) => d.status === 'publicado' && yr(d) && yr(d) - year <= y && yr(d) - year > lo - (i ? 0 : 1));
    return `<div class="kpi"><div class="k">${l}</div><div class="s">${items.length ? items.map((d) => `• <a href="#dev-${esc(d.id)}">${esc(d.name)}</a> <span class="muted">(${esc(d.estimated_label || d.estimated_date)})</span>`).join('<br>') : '<span class="muted">nada registrado</span>'}</div></div>`;
  }).join('')}</div><p class="tiny muted">Fechas estimadas por los organismos o medios citados; históricamente se atrasan.</p></div>
    <div class="card"><div class="row">
      <select data-radarf="type"><option value="">Todos los tipos</option>${Object.entries(DEV_LABELS).map(([k, l]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <select data-radarf="stage"><option value="">Todas las etapas</option>${['idea', 'anuncio', 'diseno', 'evaluacion', 'aprobado', 'en_construccion', 'operativo'].map((k) => `<option value="${k}" ${f.stage === k ? 'selected' : ''}>${esc(stageLabel(k))}</option>`).join('')}</select>
      <select data-radarf="status"><option value="">Publicadas y pendientes</option><option value="publicado" ${f.status === 'publicado' ? 'selected' : ''}>Publicadas</option><option value="pendiente_revision" ${f.status === 'pendiente_revision' ? 'selected' : ''}>Pendientes de revisión</option></select>
      <button class="btn sm" data-action="dev-new">+ Proponer obra</button></div></div>
    ${list.map((d) => devCard(d, d.id === focus)).join('') || '<div class="card empty">Sin obras con esos filtros.</div>'}
    <div class="card"><h3>Candidatos del radar de noticias (${cands.length}) <span class="chip warn">sin validar</span></h3>
      <p class="small muted">${radar ? `${esc(radar.source || '')} · ${date(radar.generated_at, { time: true })} · ${esc(radar.detail || '')}` : 'El radar de noticias corre los lunes 08:00 (Santiago) en GitHub Actions. Aún no hay ejecución publicada.'}</p>
      ${cands.slice(0, 60).map((c) => `<div class="row between" style="border-bottom:1px solid var(--border);padding:6px 0"><div style="min-width:0"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>
        <div class="tiny muted">${esc(c.publisher)} · ${date(c.published_at)} · ${esc(c.category)}${c.stage_hint ? ` · etapa sugerida: ${esc(c.stage_hint)}` : ''}${c.communes?.length ? ` · ${esc(c.communes.join(', '))}` : ''}</div></div>
        <button class="btn sm" data-action="dev-from-cand" data-key="${esc(c.key)}">Validar como obra</button></div>`).join('') || '<div class="muted small">Sin candidatos pendientes.</div>'}</div></div>`;
  if (focus) setTimeout(() => document.getElementById(`dev-${focus}`)?.scrollIntoView({ block: 'start' }), 50);
}

function devCard(d, focus) {
  const g = devGeometry(d);
  const nearProjects = g ? S.projects.filter((p) => p.lat != null && distanceToGeometry(p.lon, p.lat, g) <= (d.radius_m || 1000)) : [];
  return `<div class="card" id="dev-${esc(d.id)}" style="border-left:5px solid ${DEV_COLORS[d.type] || '#888'};${focus ? 'box-shadow:0 0 0 2px var(--accent-2)' : ''}">
    <div class="row between"><h3 style="margin:0">${esc(d.name)}</h3><div class="row">${d.status === 'publicado' ? '<span class="chip good">validada</span>' : '<span class="chip warn">pendiente de revisión</span>'}<span class="chip">certeza ${esc(d.certainty || 's/d')}</span></div></div>
    <div class="small muted">${esc(DEV_LABELS[d.type] || d.type)} · ${esc(stageLabel(d.stage))} · ${esc(d.estimated_label || d.estimated_date || 'sin fecha')} · ${esc(d.organism || '')} · revisado ${date(d.last_checked)}</div>
    <p class="small">${esc(d.description || '')}</p>
    ${d.impacts ? `<div class="grid grid-2 small"><div>${(d.impacts.positive || []).map((x) => `<div>➕ ${esc(x)}</div>`).join('')}</div><div>${(d.impacts.negative || []).map((x) => `<div>➖ ${esc(x)}</div>`).join('')}</div></div>` : ''}
    ${(d.timeline || []).length ? `<div class="small" style="margin-top:6px"><b>Hitos:</b> ${d.timeline.map((t) => `${esc(t.date)}: ${esc(t.label)}`).join(' → ')}</div>` : ''}
    <div class="small" style="margin-top:6px"><b>Radio ${meters(d.radius_m)}</b> (zona de estudio): ${esc(d.radius_justification || '')}</div>
    <div class="tiny muted">Ubicación: ${esc(d.geo_precision || d.geo_source || (g ? 'ver mapa' : 'sin ubicación'))}</div>
    <ul class="src-list">${(d.sources || []).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.publisher)}</a> · ${esc(s.publisher || '')} ${s.published_at ? `· ${esc(s.published_at)}` : ''} ${s.official ? '<span class="chip good">oficial</span>' : ''}</li>`).join('')}</ul>
    <div class="row" style="margin-top:6px">${g ? `<button class="btn sm" data-action="dev-map" data-id="${esc(d.id)}">Ver en mapa</button>` : ''}<span class="small muted">${nearProjects.length} proyecto(s) dentro del radio${nearProjects.length ? `: ${nearProjects.slice(0, 6).map((p) => `<a href="#" data-action="open-project" data-id="${esc(p.id)}">${esc(p.name)}</a>`).join(', ')}` : ''}</span></div></div>`;
}
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset.radarf) return;
  S.radarFilter[el.dataset.radarf] = el.value;
  setTimeout(() => renderRadar($('#view-radar')), 0);
});
handle('dev-map', (el) => {
  const d = S.raw.developments.find((x) => x.id === el.dataset.id);
  const g = devGeometry(d);
  actions.flyTo(g.type === 'Point' ? g.coordinates : g.coordinates[0][Math.floor(g.coordinates[0].length / 2)], 14);
});
function devForm(pre = {}) {
  openModal(`<h3>Proponer obra para el radar</h3>
    <p class="small">Se publica como "pendiente de revisión" hasta validarla (idealmente dos fuentes, una oficial). La ubicación se resuelve por dirección/lugar o por estación de Metro de referencia.</p>
    <div class="sim-grid">
      <label class="field"><span>Nombre</span><input type="text" id="dvName" value="${esc(pre.title || '')}"></label>
      <label class="field"><span>Tipo</span><select id="dvType">${Object.entries(DEV_LABELS).map(([k, l]) => `<option value="${k}" ${pre.category === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="field"><span>Etapa</span><select id="dvStage">${['idea', 'anuncio', 'diseno', 'evaluacion', 'aprobado', 'en_construccion', 'operativo'].map((k) => `<option value="${k}" ${pre.stage_hint === k ? 'selected' : ''}>${esc(stageLabel(k))}</option>`).join('')}</select></label>
      <label class="field"><span>Fecha estimada (AAAA o AAAA-MM)</span><input type="text" id="dvDate"></label>
      <label class="field"><span>Certeza</span><select id="dvCert"><option>baja</option><option selected>media</option><option>alta</option></select></label>
      <label class="field"><span>Radio (m)</span><input type="number" id="dvRadius" value="1000"></label>
      <label class="field"><span>Dirección o lugar (para geocodificar)</span><input type="text" id="dvGeo" placeholder="Av. Ejemplo 123, Ñuñoa"></label>
      <label class="field"><span>…o estación de Metro de referencia</span><input type="text" id="dvStation" placeholder="Ñuble"></label>
    </div>
    <label class="field"><span>Justificación del radio</span><input type="text" id="dvJust" placeholder="~10 min a pie…"></label>
    <label class="field"><span>Resumen propio (no copiar el artículo)</span><textarea id="dvDesc"></textarea></label>
    <label class="field"><span>Fuente (URL)</span><input type="url" id="dvUrl" value="${esc(pre.url || '')}"></label>
    <label class="field"><span>Medio / organismo</span><input type="text" id="dvPub" value="${esc(pre.publisher || '')}"></label>
    <label class="check"><input type="checkbox" id="dvOfficial">Fuente oficial</label>
    <div class="row" style="margin-top:10px"><button class="btn primary" data-action="dev-submit">Enviar al repositorio (issue)</button></div>`);
}
handle('dev-new', () => devForm());
handle('dev-from-cand', (el) => devForm((S.raw.radar?.candidates || []).find((c) => c.key === el.dataset.key) || {}));
handle('dev-submit', () => {
  const g = (id) => document.getElementById(id)?.value?.trim();
  if (!g('dvName') || !g('dvUrl')) return toast('Nombre y fuente son obligatorios');
  const dev = { name: g('dvName'), type: g('dvType'), stage: g('dvStage'), estimated_date: g('dvDate') || null, certainty: g('dvCert'), radius_m: +g('dvRadius') || 1000,
    radius_justification: g('dvJust') || null, description: g('dvDesc') || null, status: 'pendiente_revision', impact: 'mixto',
    sources: [{ title: g('dvName'), url: g('dvUrl'), publisher: g('dvPub') || null, official: document.getElementById('dvOfficial').checked }] };
  if (g('dvStation')) dev.anchor = { type: 'station', name: g('dvStation') };
  else if (g('dvGeo')) dev.geocode_query = `${g('dvGeo')}, Región Metropolitana, Chile`;
  closeModal();
  openIssue(`atlas-obra: ${dev.name}`, `Obra propuesta desde la app (queda pendiente de revisión).\n\n\`\`\`json\n${JSON.stringify(dev, null, 1)}\n\`\`\``);
});

// ================================================================== ALERTAS
function localAlerts() {
  const rules = LS.get('alerts.rules', []);
  const out = [];
  for (const r of rules) {
    const p = projectById(r.projectId);
    if (!p) continue;
    const a = analysisOf(p.id);
    const price = a?.priceUf ?? p.price_from_uf;
    const b = r.baseline || {};
    if (b.priceUf && price) {
      const drop = b.priceUf - price;
      if (drop > 0.5 && ((r.pct && (drop / b.priceUf) * 100 >= r.pct) || (r.uf && drop >= r.uf))) {
        out.push({ id: `l-${p.id}-price-${price}`, type: 'baja_precio', title: `Baja de precio en ${p.name}`, before: uf(b.priceUf, 0), after: uf(price, 0), detected_at: new Date().toISOString(), source_url: p.publication_url, evidence: a?.priceEvidence?.includes('verificado') ? 'alta' : 'media', local: true, entity_id: p.id });
      }
    }
    if (r.delivery && (b.status !== a?.status?.code || (b.deliveryDate || null) !== (p.delivery?.date || null))) {
      out.push({ id: `l-${p.id}-del-${a?.status?.code}-${p.delivery?.date}`, type: 'cambio_entrega', title: `Cambió la entrega/stock de ${p.name}`, before: `${b.status || ''} ${b.deliveryDate || ''}`.trim(), after: `${a?.status?.code || ''} ${p.delivery?.date || ''}`.trim(), detected_at: new Date().toISOString(), source_url: p.publication_url, evidence: 'media', local: true, entity_id: p.id });
    }
    if (r.devs && p.lat != null) {
      for (const ev of S.raw.changes?.events || []) {
        if (ev.type !== 'obra_nueva' || ev.detected_at < r.createdAt) continue;
        const d = S.raw.developments.find((x) => x.id === ev.entity_id);
        const g = d && devGeometry(d);
        if (g && distanceToGeometry(p.lon, p.lat, g) <= 1000) out.push({ ...ev, id: `l-${p.id}-${ev.id}`, title: `${ev.title} — a menos de 1 km de ${p.name}`, local: true });
      }
    }
  }
  return out;
}
function allAlerts() {
  const server = (S.raw.changes?.events || []).map((e) => ({ ...e, local: false }));
  return [...localAlerts(), ...server].sort((x, y) => (y.detected_at || '').localeCompare(x.detected_at || ''));
}
actions.unseenAlerts = () => { const seen = new Set(LS.get('alerts.seen', [])); return allAlerts().filter((e) => !seen.has(e.id)).length; };

export function renderAlertas(root) {
  const list = allAlerts();
  const seen = new Set(LS.get('alerts.seen', []));
  const rules = LS.get('alerts.rules', []);
  const top = [...S.analyses.values()].map((x) => x.best).filter((a) => a && !a.project.demo).sort((x, y) => y.score - x.score).slice(0, 10);
  const labels = { proyecto_nuevo: 'Proyecto nuevo', baja_precio: 'Baja de precio', alza_precio: 'Alza de precio', cambio_entrega: 'Cambio de entrega', cambio_stock: 'Cambio de stock', obra_nueva: 'Obra nueva', cambio_obra: 'Cambio en obra', cambio_common_expenses_clp: 'Cambio de gasto común', cambio_brochure_url: 'Nuevo brochure' };
  root.innerHTML = `<div class="wrap"><h1 class="page">Alertas</h1>
    <p class="lead">Cambios detectados por el repositorio en cada actualización (lunes 08:00) y por tus reglas sobre favoritos. Solo diferencias verdaderas (no redondeos), con antes/después, fecha y enlace para verificar.</p>
    <div class="card"><div class="row between"><h3 style="margin:0">Notificaciones (${list.length})</h3><button class="btn sm" data-action="alerts-seen">Marcar todo como leído</button></div>
    ${list.length ? `<div class="table-scroll" style="max-height:520px"><table class="t"><tr><th></th><th>Qué cambió</th><th>Antes</th><th>Después</th><th>Detectado</th><th>Evidencia</th><th>Verificar</th></tr>
      ${list.map((e) => `<tr class="${seen.has(e.id) ? '' : 'hl'}"><td>${e.local ? '<span class="chip info">tu regla</span>' : '<span class="chip">repo</span>'}</td><td><b>${esc(labels[e.type] || e.type)}</b><div class="small">${esc(e.title)}</div>${e.entity_id && projectById(e.entity_id) ? `<a href="#" class="small" data-action="open-project" data-id="${esc(e.entity_id)}">abrir ficha</a>` : ''}</td>
        <td class="small">${esc(fmt(e.before))}</td><td class="small">${esc(fmt(e.after))}</td><td class="small nowrap">${date(e.detected_at, { time: true })}</td><td>${esc(e.evidence || '')}</td><td>${e.source_url ? `<a href="${esc(e.source_url)}" target="_blank" rel="noopener">fuente</a>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="empty">Sin alertas todavía. La primera ejecución semanal crea la línea base.</div>'}</div>
    <div class="card"><h3>Tus reglas (${rules.length})</h3>${rules.length ? rules.map((r) => `<div class="row between small" style="border-bottom:1px solid var(--border);padding:4px 0"><span>${esc(projectById(r.projectId)?.name || r.projectId)} · baja ≥ ${r.pct ?? '–'}% o ≥ ${r.uf ?? '–'} UF${r.delivery ? ' · entrega/stock' : ''}${r.devs ? ' · obras a 1 km' : ''}</span><button class="btn sm" data-action="rule-del" data-id="${esc(r.projectId)}">Quitar</button></div>`).join('') : '<p class="small muted">Crea alertas desde la ficha de un proyecto (🔔 Crear alerta).</p>'}
      <p class="tiny muted">Canal: dentro de la app. Correo semanal: requiere configurar SMTP en GitHub (ver README · "Alertas por correo"). Estado: no configurado.</p></div>
    <div class="card"><h3>Digest: mis 10 mejores oportunidades de la semana</h3>
      ${top.length ? `<ol class="small">${top.map((a) => `<li><a href="#" data-action="open-project" data-id="${esc(a.project.id)}" data-unit="${esc(a.unit.id)}">${esc(a.project.name)}</a> · ${esc(a.project.commune)} · score ${Math.round(a.score)} · flujo ${clp(a.metrics.monthlyCf * ufv(), { sign: true })}/mes ${a.gates.passed ? '<span class="chip good">verificada</span>' : '<span class="chip warn">provisional</span>'}</li>`).join('')}</ol>` : '<div class="muted small">Sin proyectos reales analizables.</div>'}
      <button class="btn sm" data-action="digest-dl">Descargar digest (CSV)</button></div></div>`;
  LS.set('alerts.lastOpen', new Date().toISOString());
}
function fmt(v) { return v == null ? '' : typeof v === 'number' ? num(v, 0) : String(v); }
handle('alerts-seen', () => { LS.set('alerts.seen', allAlerts().map((e) => e.id)); actions.updateCounts(); renderAlertas($('#view-alertas')); });
handle('rule-del', (el) => { LS.set('alerts.rules', LS.get('alerts.rules', []).filter((r) => r.projectId !== el.dataset.id)); renderAlertas($('#view-alertas')); });
handle('digest-dl', () => {
  const rows = [...S.analyses.values()].map((x) => x.best).filter((a) => a && !a.project.demo).sort((x, y) => y.score - x.score).slice(0, 10)
    .map((a, i) => ({ puesto: i + 1, proyecto: a.project.name, comuna: a.project.commune, unidad: a.unit.id, precio_uf: a.priceUf, flujo_clp: Math.round(a.metrics.monthlyCf * ufv()), score: Math.round(a.score), estado: a.gates.passed ? 'verificada' : 'provisional', pendientes: a.gates.fails.join(' | ') }));
  download('digest_semanal.csv', toCSV(rows), 'text/csv;charset=utf-8');
});

// ================================================================== FAVORITOS
export function renderFavoritos(root) {
  const fav = LS.get('favorites', {});
  const entries = Object.entries(fav);
  const v = ufv();
  root.innerHTML = `<div class="wrap"><h1 class="page">Mis favoritos</h1><p class="lead">Seguimiento de proyectos guardados: precio y estado al guardarlos vs hoy.</p>
    ${entries.length ? `<div class="card table-scroll" style="max-height:none"><table class="t"><tr><th>Proyecto</th><th>Guardado</th><th class="num">Precio entonces</th><th class="num">Precio hoy</th><th>Entrega</th><th class="num">Score</th><th class="num">Flujo</th><th></th></tr>
      ${entries.map(([id, f]) => {
    const p = projectById(id);
    if (!p) return `<tr><td colspan="8" class="muted">${esc(id)} (ya no está en los datos)</td></tr>`;
    const a = analysisOf(id);
    const now = a?.priceUf ?? p.price_from_uf;
    const diff = f.priceUf && now ? now - f.priceUf : 0;
    return `<tr><td><a href="#" data-action="open-project" data-id="${esc(id)}">${esc(p.name)}</a> ${p.demo ? '<span class="chip demo">DEMO</span>' : ''}<div class="tiny muted">${esc(p.commune)}</div></td><td>${date(f.savedAt)}</td>
        <td class="num">${uf(f.priceUf, 0)}</td><td class="num">${uf(now, 0)} ${Math.abs(diff) >= 0.5 ? `<span class="chip ${diff < 0 ? 'good' : 'crit'}">${diff < 0 ? '▼' : '▲'} ${uf(Math.abs(diff), 0)}</span>` : ''}</td>
        <td><span class="status-dot" style="background:${a?.status?.color || '#8a8f98'}"></span> ${esc(a?.status?.label || 's/d')}</td><td class="num">${a ? Math.round(a.score) : '–'}</td><td class="num">${a ? clp(a.metrics.monthlyCf * v, { sign: true }) : '–'}</td>
        <td><button class="btn sm" data-action="toggle-fav" data-id="${esc(id)}">Quitar</button></td></tr>`;
  }).join('')}</table></div>` : '<div class="card empty"><b>Sin favoritos</b>Guarda proyectos desde su ficha (☆ Guardar).</div>'}
    <div class="card"><h3>Búsquedas guardadas</h3>
      ${(LS.get('searches', [])).map((s, i) => `<div class="row between small" style="padding:4px 0;border-bottom:1px solid var(--border)"><span>${esc(s.name)} · ${date(s.at)}</span><span><button class="btn sm" data-action="search-load" data-i="${i}">Aplicar</button> <button class="btn sm" data-action="search-del" data-i="${i}">Borrar</button></span></div>`).join('') || '<p class="small muted">Ninguna.</p>'}
      <div class="row" style="margin-top:6px"><input type="text" id="searchName" placeholder="Nombre de la búsqueda" style="max-width:260px"><button class="btn sm" data-action="search-save">Guardar filtros actuales</button></div></div></div>`;
}
handle('search-save', () => {
  const name = $('#searchName').value.trim() || `Búsqueda ${new Date().toLocaleDateString('es-CL')}`;
  LS.set('searches', [...LS.get('searches', []), { name, at: new Date().toISOString(), filters: S.filters, polygon: S.drawPolygon }]);
  renderFavoritos($('#view-favoritos'));
  toast('Búsqueda guardada');
});
handle('search-load', (el) => {
  const s = LS.get('searches', [])[+el.dataset.i];
  if (!s) return;
  S.filters = { ...S.filters, ...s.filters };
  S.drawPolygon = s.polygon || null;
  LS.set('filters', S.filters);
  actions.recompute();
  actions.setView('mapa');
  toast(`Aplicada: ${s.name}`);
});
handle('search-del', (el) => { const l = LS.get('searches', []); l.splice(+el.dataset.i, 1); LS.set('searches', l); renderFavoritos($('#view-favoritos')); });

// ================================================================== FUENTES Y DATOS
export function renderFuentes(root) {
  const h = S.raw.health;
  const chip = (s) => ({ ok: '<span class="chip good">OK</span>', desactualizado: '<span class="chip warn">desactualizado</span>', error: '<span class="chip crit">error</span>', sin_datos: '<span class="chip serious">sin datos</span>', no_configurado: '<span class="chip">no configurado</span>', parcial: '<span class="chip warn">parcial</span>' }[s] || `<span class="chip">${esc(s)}</span>`);
  const jobs = S.raw.jobs || {};
  const local = { p: LS.get('local.projects', []).length, r: LS.get('local.rentals', []).length };
  const real = S.raw.projects.length, demoN = S.raw.demo?.projects?.length || 0;
  root.innerHTML = `<div class="wrap"><h1 class="page">Fuentes y datos</h1>
    <p class="lead">Salud de cada fuente, última actualización, registros, errores y licencias. Si un conector falla se conserva el último dato verificado con aviso de desactualización: nunca se reemplaza por ceros ni por datos ficticios.</p>
    <div class="kpis">
      <div class="kpi"><div class="k">Proyectos reales</div><div class="v">${real}</div><div class="s">${local.p} importados en este navegador · ${demoN} DEMO</div></div>
      <div class="kpi"><div class="k">Avisos de arriendo reales</div><div class="v">${S.raw.rentals.length}</div><div class="s">${local.r} importados localmente</div></div>
      <div class="kpi"><div class="k">Obras en el radar</div><div class="v">${S.raw.developments.length}</div><div class="s">${S.raw.developments.filter((d) => d.status === 'publicado').length} validadas</div></div>
      <div class="kpi"><div class="k">UF</div><div class="v">${clp(S.raw.uf?.value)}</div><div class="s">${date(S.raw.uf?.date)} · ${esc(S.raw.uf?.status || '')}</div></div>
      <div class="kpi"><div class="k">Cálculo</div><div class="v">${Math.round(S.lastComputeMs || 0)} ms</div><div class="s">${S.analyses.size} proyectos analizados en el navegador</div></div>
    </div>
    <div class="card" style="margin-top:12px"><h3>Estado de las fuentes ${h ? `<span class="small muted">(validación ${date(h.generated_at, { time: true })})</span>` : ''}</h3>
      ${h ? `<div class="table-scroll" style="max-height:none"><table class="t"><tr><th>Fuente</th><th>Estado</th><th>Última actualización</th><th class="num">Registros</th><th>Detalle</th></tr>
      ${h.sources.map((s) => `<tr><td>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}${s.kind === 'integracion' ? '<div class="tiny muted">integración</div>' : ''}</td><td>${chip(s.status)}</td><td class="small">${date(s.last_update, { time: true })}</td><td class="num">${s.records ?? ''}</td><td class="small">${esc(s.detail || '')}</td></tr>`).join('')}</table></div>` : '<div class="empty">Aún no hay health.json: correr scripts/atlas/validate.py.</div>'}</div>
    <div class="card"><h3>Ejecuciones programadas</h3>
      <p class="small">Diaria (UF) · Semanal lunes 08:00 America/Santiago (UF, geocodificación, radar de noticias, OSM si está viejo, validación y cambios) · Mensual (capas OSM). Corren en GitHub Actions sobre la rama principal.</p>
      ${(jobs.history || []).length ? `<table class="t"><tr><th>Tarea</th><th>Inicio</th><th>Fin</th><th>Estado</th></tr>${jobs.history.slice(0, 12).map((j) => `<tr><td>${esc(j.task)}</td><td>${date(j.started_at, { time: true })}</td><td>${date(j.finished_at, { time: true })}</td><td>${esc(j.status)}</td></tr>`).join('')}</table>` : '<div class="muted small">Sin ejecuciones registradas.</div>'}
      ${Object.entries(jobs).filter(([k]) => k !== 'history').map(([k, j]) => `<details class="small"><summary>Último "${esc(k)}": ${esc(j.status)} (${date(j.finished_at, { time: true })})</summary>${(j.steps || []).map((st) => `<div>${esc(st.status)} · ${esc(st.name)} (${st.seconds}s)${st.error ? ` — ${esc(st.error)}` : ''}</div>`).join('')}</details>`).join('')}
      <div class="row" style="margin-top:8px"><button class="btn sm" data-action="run-update">Ejecutar actualización ahora</button><a class="btn sm" href="https://github.com/MickaXXX/cosas-de-ia/actions/workflows/atlas-data.yml" target="_blank" rel="noopener">Ver en GitHub Actions</a></div></div>
    <div class="card"><h3>Calidad de datos (${h?.summary?.errors ?? 0} errores · ${h?.summary?.warnings ?? 0} advertencias)</h3>
      ${h?.quality_flags?.length ? `<div class="table-scroll"><table class="t"><tr><th>Nivel</th><th>Entidad</th><th>Campo</th><th>Mensaje</th></tr>${h.quality_flags.map((q) => `<tr><td>${q.level === 'error' ? '<span class="chip crit">error</span>' : '<span class="chip warn">aviso</span>'}</td><td class="small">${esc(q.entity)}</td><td class="small mono">${esc(q.field)}</td><td class="small">${esc(q.message)}</td></tr>`).join('')}</table></div>` : '<div class="muted small">Sin observaciones.</div>'}</div>
    <div class="card"><h3>Integraciones que requieren claves, pagos o acuerdos</h3>
      <table class="t"><tr><th>Integración</th><th>Para qué</th><th>Requisito</th><th>Mientras tanto</th></tr>
      <tr><td>CMF API (UF y series)</td><td>UF oficial con API</td><td>Clave gratuita → secreto CMF_API_KEY</td><td>SII (tabla pública) y mindicador.cl</td></tr>
      <tr><td>Banco Central SIETE</td><td>Tasa de colocación vivienda</td><td>Usuario/clave gratuitos</td><td>Tasa de referencia citada en market.json</td></tr>
      <tr><td>Feed de proyectos (Portal Inmobiliario, TOCTOC, Enlace, GoodProp)</td><td>Precios y stock semanales</td><td>Acuerdo de datos / API privada</td><td>Importación CSV y verificación manual</td></tr>
      <tr><td>Avisos de arriendo autorizados</td><td>Comparables de 2 km</td><td>Proveedor licenciado o levantamiento propio</td><td>Referencia comunal publicada (baja confianza)</td></tr>
      <tr><td>AirDNA u otro</td><td>Ocupación y tarifa Airbnb</td><td>Licencia pagada</td><td>Simulación de supuestos</td></tr>
      <tr><td>CEAD / SIED</td><td>Seguridad comunal</td><td>Descarga manual del portal</td><td>Formulario en Configuración</td></tr>
      <tr><td>Anthropic API (Asesor IA)</td><td>Chat con herramientas</td><td>Clave personal (costo por uso)</td><td>Asesor guiado sin IA</td></tr>
      <tr><td>SMTP (correo)</td><td>Digest y alertas por correo</td><td>Secretos SMTP_* en GitHub</td><td>Alertas dentro de la app</td></tr></table></div>
    <div class="card"><h3>Licencias y atribución</h3><ul class="small">
      <li>Mapa base: OpenFreeMap (datos © colaboradores de OpenStreetMap, ODbL); respaldo raster © CARTO.</li>
      <li>Metro, estaciones, servicios y comunas: © colaboradores de OpenStreetMap (ODbL 1.0), vía Overpass API · ${date(S.raw.osm.meta?.generated_at, { time: true })}.</li>
      <li>Geocodificación: Nominatim (OSM), con límite de 1 consulta por segundo y caché.</li>
      <li>UF: SII / Banco Central de Chile. Noticias: titulares y enlaces de Google News RSS; resúmenes propios, sin copiar artículos.</li>
      <li>Precios de proyectos y referencias de arriendo: cada dato cita su fuente y su estado de verificación en la ficha.</li></ul></div></div>`;
}
export { meter };
