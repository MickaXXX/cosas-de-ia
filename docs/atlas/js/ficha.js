/* Ficha completa de un proyecto/unidad. Todo número relevante trae "¿De dónde sale?". */
import { S, LS, actions } from './core.js';
import { $, handle, why, toast, download, toCSV, toExcelHTML, openModal } from './ui.js';
import { analyzeUnit, unitPrice } from './analysis.js';
import { annuityPayment, monthlyRate, simulate, requiredIncomeClp } from './finance.js';
import { histogram } from './rentals.js';
import { barChart, lineChart, histogramChart, meter } from './charts.js';
import { clp, uf, pct, num, meters, date, esc, MONTHS } from './format.js';
import { DEV_LABELS, DEV_COLORS } from './map.js';
import { riskLabel } from './risk.js';
import { COMPONENTS } from './scoring.js';
import { openVerifyForm } from './admin.js';

const ov = () => (S.fichaOv ||= {});
let current = null;

export function closeFicha() { current = null; }

function key(p, u) { return `${p.id}::${u?.id || ''}`; }

export function computeUnit(p, unit, extra = {}) {
  const o = ov()[key(p, unit)] || {};
  const overrides = { ...(o.fin || {}) };
  if (o.gcClp != null && S.raw.uf?.value) overrides.commonExpensesUf = o.gcClp / S.raw.uf.value;
  return analyzeUnit(p, unit, S.ctx, { mode: o.mode || 'tradicional', overrides, rentClpOverride: o.rentClp, radiusM: o.radiusM, mc: extra.mc ?? true,
    reserveUf: S.config.investor.reserveUf ?? S.config.risk.defaultReserveUf });
}

export function renderFicha(p, unitId) {
  const units = (p.units || []).filter((u) => unitPrice(u));
  let unit = units.find((u) => u.id === unitId) || null;
  if (!unit && units.length) {
    const best = S.analyses.get(p.id)?.best;
    unit = best ? units.find((u) => u.id === best.unit.id) || units[0] : units[0];
  }
  current = { p, unit };
  const el = $('#drawerInner');
  if (!unit) { el.innerHTML = noUnitHTML(p); return; }
  const a = computeUnit(p, unit);
  current.a = a;
  el.innerHTML = fichaHTML(p, units, a);
  if (a.rent && p.lat != null) {
    const used = new Set(a.rent.comps.map((c) => c.id));
    const pts = [...a.rent.comps.map((c) => ({ ...c, used: true })), ...a.rent.excluded.map((x) => x.listing).filter((l) => l.lat != null && !used.has(l.id)).map((l) => ({ ...l, used: false }))];
    actions.showComps([p.lon, p.lat], a.rent.radiusM, pts);
  }
}

function rerender() { if (current) renderFicha(current.p, current.unit?.id); }

// ------------------------------------------------------------------ sin unidad
function noUnitHTML(p) {
  return `${headHTML(p, null)}<div class="ficha-body">
    <div class="card"><h3>Este proyecto aún no tiene una unidad analizable</h3>
    <p>${p.price_from_uf ? `Se conoce el precio "desde" ${uf(p.price_from_uf, 0)}${p.typologies_text ? ` (${esc(p.typologies_text)})` : ''}, pero no una unidad concreta (tipología, m² y precio).` : 'No hay precio publicado.'}</p>
    <p class="small">Opciones: activa "Simular unidades hipotéticas" en los filtros, registra la unidad que cotizaste (botón <b>Registrar verificación</b>) o impórtala por CSV.</p>
    <button class="btn primary" data-action="verify-open" data-id="${esc(p.id)}">Registrar verificación / unidad cotizada</button></div>
    ${evidenceHTML(p)}</div>`;
}

// ------------------------------------------------------------------ cabecera
function headHTML(p, a) {
  const fav = !!LS.get('favorites', {})[p.id];
  const inCmp = a && LS.get('compare', []).includes(`${p.id}::${a.unit.id}`);
  const st = a?.status;
  return `<div class="ficha-head">
    <div class="row between">
      <div style="min-width:0"><h2>${esc(p.name)} ${p.demo ? '<span class="chip demo">DEMO / DATOS SIMULADOS</span>' : ''}</h2>
        <div class="sub">${esc(p.developer?.name || 'Inmobiliaria sin dato')} · ${esc(p.address || 'dirección sin dato')} · ${esc(p.commune)}${p.neighborhood ? ` · ${esc(p.neighborhood)}` : ''}</div></div>
      <button class="btn ghost" data-action="close-project" aria-label="Cerrar ficha">✕</button>
    </div>
    <div class="row" style="margin-top:6px">
      ${st ? `<span class="chip" style="background:${st.color}22;color:var(--text)"><span class="dot" style="background:${st.color}"></span>${esc(st.label)}</span><span class="small muted">${esc(st.reason)}</span>` : ''}
      ${a ? (a.gates.passed ? '<span class="chip good">Oportunidad con evidencia suficiente</span>' : '<span class="chip warn">Calificación provisional · faltan datos</span>') : ''}
      ${p.geo_review ? '<span class="chip serious">Ubicación por revisar</span>' : ''}
    </div>
    <div class="row noprint" style="margin-top:8px">
      <button class="btn sm ${fav ? 'on' : ''}" data-action="toggle-fav" data-id="${esc(p.id)}">${fav ? '★ Guardado' : '☆ Guardar'}</button>
      ${a ? `<button class="btn sm ${inCmp ? 'on' : ''}" data-action="toggle-compare-ficha" data-id="${esc(p.id)}" data-unit="${esc(a.unit.id)}">${inCmp ? '✓ En comparador' : '+ Agregar al comparador'}</button>` : ''}
      <button class="btn sm" data-action="alert-create" data-id="${esc(p.id)}">🔔 Crear alerta</button>
      <button class="btn sm" data-action="verify-open" data-id="${esc(p.id)}">✔ Registrar verificación</button>
      ${a ? '<button class="btn sm" data-action="ficha-print">⬇ Informe PDF</button><button class="btn sm" data-action="ficha-xls">⬇ Excel</button><button class="btn sm" data-action="ficha-sim">Abrir en simulador</button>' : ''}
      ${p.lat != null ? `<button class="btn sm" data-action="ficha-locate" data-lon="${p.lon}" data-lat="${p.lat}">Ver en mapa</button>` : ''}
    </div>
    ${a ? `<nav class="ficha-nav noprint">${[['resumen', 'Resumen'], ['compra', 'Compra y crédito'], ['arriendo', 'Arriendo 2 km'], ['gastos', 'Gastos'], ['flujo', 'Flujo'], ['escenarios', 'Escenarios'], ['proyeccion', '30 años'], ['riesgo', 'Riesgo'], ['airbnb', 'Airbnb'], ['entorno', 'Entorno'], ['obras', 'Obras cercanas'], ['documentos', 'Evidencia'], ['diligencia', 'Checklist'], ['decision', 'Decisión']].map(([id, l]) => `<a href="#sec-${id}" data-action="ficha-goto" data-sec="${id}">${l}</a>`).join('')}</nav>` : ''}
  </div>`;
}

handle('ficha-goto', (el) => document.getElementById(`sec-${el.dataset.sec}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
handle('toggle-compare-ficha', (el) => { actions.toggleCompare(el.dataset.id, el.dataset.unit); rerender(); });
handle('verify-open', (el) => openVerifyForm(el.dataset.id));
handle('ficha-print', () => window.print());
handle('ficha-locate', (el) => { actions.closeProject(); actions.flyTo([+el.dataset.lon, +el.dataset.lat], 16); });
handle('ficha-sim', () => { if (!current?.a) return; S.simFrom = { projectId: current.p.id, unitId: current.unit.id, input: current.a.input }; actions.closeProject(); actions.setView('simulador'); });
handle('ficha-unit', (el) => { renderFicha(current.p, el.dataset.unit); });

// ------------------------------------------------------------------ cuerpo
function fichaHTML(p, units, a) {
  const ufv = a.ufValue, m = a.metrics;
  const ufRef = `UF ${clp(ufv)} del ${date(a.ufDate)}`;
  const cfg = S.config;
  const unitTabs = units.length > 1 ? `<div class="unit-tabs">${units.map((u) => `<button class="btn sm ${u.id === a.unit.id ? 'on' : ''}" data-action="ficha-unit" data-unit="${esc(u.id)}">${esc(u.type || `${u.bedrooms}D`)} · ${u.useful_m2 ?? '?'} m² · ${uf(unitPrice(u), 0)}</button>`).join('')}</div>` : '';
  const rentWhy = why({ title: 'Arriendo mensual estimado', value: clp(a.rentEstimate?.baseClp),
    formula: a.rentSource === 'comparables' ? `${a.rentEstimate.method}\nRango bajo–alto: p25–p75 (${clp(a.rentEstimate.lowClp)} – ${clp(a.rentEstimate.highClp)})` : a.rentSource === 'referencia' ? `${a.rentEstimate.method}\nRango ±12%` : 'Ingresado por el usuario',
    source: a.rentEstimate?.source, url: a.rentEstimate?.source_url, confidence: a.rentEstimate?.confidence,
    notes: a.rentSource === 'referencia' ? `No hay ${cfg.rentals.minSample} comparables homogéneos en ${meters(a.rent?.radiusM || cfg.rentals.radiusM)}: se usa una referencia comunal publicada (no es un radio de 2 km). ${a.rentEstimate.note || ''}` : a.rentSource === 'comparables' ? 'Precios PEDIDOS en avisos, no contratos cerrados. El aviso retirado no se asume arrendado.' : null, warn: a.rentSource !== 'comparables' });
  const divWhy = why({ title: 'Dividendo mensual', value: `${uf(m.dividend)} (${clp(m.dividend * ufv)} de hoy)`,
    formula: `Cuota = C × r / (1 − (1 + r)^−n)\nC = crédito ${uf(a.structure.credit)} · r = ${pct(a.input.annualRate, 2)} ${a.input.rateConvention === 'nominal' ? '/ 12' : 'efectiva → mensual'} · n = ${a.input.loanYears * 12} meses\nSin seguros. Seguros mes 1: desgravamen ${uf(a.base.schedule.rows[0]?.desgravamen)} + incendio/sismo ${uf(a.base.schedule.rows[0]?.incendio)}`,
    source: `Tasa: supuesto editable (referencia BCCh ${pct(S.raw.market?.mortgage_rate?.value, 2)} ${S.raw.market?.mortgage_rate?.period || ''})`, url: S.raw.market?.mortgage_rate?.source_url, confidence: 'supuesto',
    notes: 'En UF el dividendo es fijo; en pesos sube con la UF. La CAE no es la tasa del crédito. No es una preaprobación.' });
  const cfWhy = why({ title: 'Flujo mensual estabilizado (después del dividendo)', value: clp(m.monthlyCf * ufv),
    formula: `Promedio de largo plazo (ocupación ${pct(a.steady?.occupancy ?? 1)}):\n+ arriendo × ocupación × (1 − incobrable − mantención − administración − impuesto)\n− corretaje prorrateado − GC en meses vacíos − contribuciones/12 − reserva de mejoras − seguro incendio\n− dividendo − desgravamen`,
    source: 'Simulación de la app con los supuestos de Configuración', confidence: a.rentSource === 'comparables' ? 'media' : 'baja',
    notes: 'Los meses reales varían: ver Flujo mes a mes (vacancia, corretaje y contribuciones en abril, junio, septiembre y noviembre).' });
  const priceWhy = why({ title: 'Precio de la unidad', value: `${uf(a.priceUf)} = ${clp(a.priceClp)}`, formula: `Precio UF × ${ufRef}`,
    source: (p.evidence || [])[0]?.source_name, url: (p.evidence || [])[0]?.source_url || p.publication_url, date: p.observed_at || (p.evidence || [])[0]?.observed_at,
    confidence: a.priceEvidence.includes('verificado') ? 'alta' : a.priceEvidence.some((s) => ['importado_sin_verificar', 'captura_usuario'].includes(s)) ? 'media' : 'baja',
    notes: a.unit.hypothetical ? 'Unidad HIPOTÉTICA armada con el precio "desde": no es una unidad concreta en venta.' : a.unit.m2_assumed ? `Superficie supuesta (${a.unit.useful_m2} m² típicos).` : (p.evidence || [])[0]?.notes, warn: !!(a.unit.hypothetical || a.unit.m2_assumed) });
  return `${headHTML(p, a)}<div class="ficha-body">
    ${a.unit.hypothetical ? '<div class="note warn" style="margin-bottom:10px">⚠️ <b>Unidad hipotética:</b> se simula con el precio "desde" y una superficie supuesta. Sirve para explorar, no para decidir. Registra la unidad que cotices.</div>' : ''}
    ${p.demo ? '<div class="note warn" style="margin-bottom:10px"><b>DEMO / DATOS SIMULADOS.</b> Proyecto ficticio para probar la app.</div>' : ''}
    ${unitTabs}
    <div class="section card" id="sec-resumen"><h3>Resumen de la unidad ${esc(a.unit.id)} · ${esc(a.unit.type || '')} · ${num(a.unit.useful_m2, 1)} m²${a.unit.m2_assumed ? ' (supuestos)' : ''}</h3>
      <div class="kpis">
        ${kpi('Precio', uf(a.priceUf, 0), `${clp(a.priceClp)} · ${uf(a.pricePerM2Uf, 1)}/m²`, priceWhy)}
        ${kpi('Dividendo 30 años', clp(m.dividend * ufv), `${uf(m.dividend)} · crédito ${pct(a.structure.creditPct, 0)}`, divWhy)}
        ${kpi('Arriendo estimado', a.rentEstimate ? clp(a.rentEstimate.baseClp) : 'sin datos', a.rentEstimate ? `${a.rentSource === 'comparables' ? `${a.rent.counts.used} comparables` : a.rentSource === 'referencia' ? 'referencia comunal (baja confianza)' : 'tu supuesto'}` : 'importa avisos o ingrésalo', rentWhy)}
        ${a.rentEstimate ? kpi('Flujo mensual', clp(m.monthlyCf * ufv, { sign: true }), 'después del dividendo, promedio', cfWhy, m.monthlyCf >= 0 ? 'pos' : 'neg') : kpi('Flujo mensual', 's/d', `sin arriendo: pagarías ${clp(-(m.debtService + a.input.commonExpensesUf) * ufv)}/mes de dividendo + GC`)}
        ${kpi('Capital inicial', uf(a.structure.equity, 0), `pie ${uf(a.structure.pie, 0)} + gastos ${uf(a.structure.closingCosts.total, 0)}`, why({ title: 'Aporte real de capital', value: uf(a.structure.equity), formula: `Pie a pagar ${uf(a.structure.pie)} (precio × (1 − crédito − bono))\n+ gastos operacionales ${uf(a.structure.closingCosts.total)}\n+ amoblado ${uf(a.structure.furnishingUf)}`, confidence: 'supuesto', notes: a.structure.warnings.join(' ') || null, warn: a.structure.warnings.length > 0 }))}
        ${!a.rentEstimate ? kpi('Rentabilidad', 's/d', 'falta un arriendo de referencia: ingrésalo arriba o importa avisos') : kpi('Rentabilidad bruta', pct(m.grossYield), `neta sin deuda ${pct(m.capRate)}`, why({ title: 'Rentabilidades', formula: `Bruta = arriendo × 12 / precio\nNeta sin deuda (cap rate) = NOI anual / (precio real + gastos)\nSobre capital = flujo anual / capital inicial = ${pct(m.cashOnCash)}`, confidence: a.rentSource === 'comparables' ? 'media' : 'baja' }))}
        ${kpi('Riesgo', `${Math.round(a.risk.total)} · ${riskLabel(a.risk.total)}`, a.mc ? `Prob. SIMULADA de año 1 negativo: ${pct(a.mc.probNegativeFirstYear, 0)}` : '', why({ title: 'Riesgo multidimensional (0 = bajo, 100 = alto)', formula: Object.entries(a.risk.dims).map(([k, v]) => `${k}: ${Math.round(v.score)} — ${v.why}`).join('\n'), notes: a.mc?.label, confidence: 'supuesto' }))}
        ${kpi('Score', `${Math.round(a.score)}/100`, `perfil ${esc(cfg.ranking.profiles[cfg.ranking.profile].label)}`, why({ title: 'Score de oportunidad', formula: a.profileScore.contrib.map((c) => `${COMPONENTS[c.key].label}: ${Math.round(c.value)} × peso ${c.weight}`).join('\n'), notes: a.gates.passed ? 'Pasa todas las puertas de calidad.' : `Provisional: ${a.gates.fails.join(' · ')}`, warn: !a.gates.passed }))}
      </div>
      <p class="tiny muted" style="margin-top:8px">CLP en pesos de hoy con ${ufRef} (${esc(S.raw.uf?.source || '')}). Plusvalía separada: ver 30 años.</p>
    </div>
    ${compraHTML(a)}
    ${arriendoHTML(p, a)}
    ${gastosHTML(a)}
    ${flujoHTML(a)}
    ${escenariosHTML(a)}
    ${proyeccionHTML(a)}
    ${riesgoHTML(a)}
    ${airbnbHTML(p, a)}
    ${entornoHTML(p, a)}
    ${obrasHTML(p, a)}
    ${evidenceHTML(p)}
    ${diligenciaHTML(p, a)}
    ${decisionHTML(p, a)}
  </div>`;
}

function kpi(k, v, s, w = '', cls = '') {
  return `<div class="kpi"><div class="k">${esc(k)} ${w}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div>`;
}

// ------------------------------------------------------------------ compra y crédito
function simField(key, label, val, step = 'any', kind = 'num', help = '') {
  return `<label class="field"><span>${esc(label)}</span><input type="number" step="${step}" data-sim="${key}" data-kind="${kind}" value="${val}">${help ? `<span class="tiny muted">${help}</span>` : ''}</label>`;
}

function compraHTML(a) {
  const st = a.structure, ufv = a.ufValue, inp = a.input;
  const o = ov()[key(a.project, a.unit)] || {};
  const rows = [['Precio promesa / escritura', st.finalPrice, 1], ['Bono pie (inmobiliaria)', st.bono, st.bonoPiePct], ['Crédito hipotecario', st.credit, st.creditPct], ['Pie por pagar', st.pie, st.pie / st.finalPrice]];
  const divRows = [];
  for (const cp of S.config.financing.presetsCreditPct) {
    for (const yrs of [15, 20, 25, 30]) {
      const credit = st.finalPrice * cp;
      const d = annuityPayment(credit, monthlyRate(inp.annualRate, inp.rateConvention), yrs * 12);
      divRows.push({ cp, yrs, credit, d, inc: requiredIncomeClp(d * ufv, S.config.financing.incomeRatio), pie: st.finalPrice * (1 - cp - st.bonoPiePct) });
    }
  }
  return `<div class="section card" id="sec-compra"><h3>Estructura de compra y crédito</h3>
    <div class="grid grid-2">
      <div><table class="t"><tr><th>Concepto</th><th class="num">UF</th><th class="num">%</th><th class="num">CLP hoy</th></tr>
        ${rows.map(([l, v, p]) => `<tr><td>${l}</td><td class="num">${num(v, 2)}</td><td class="num">${pct(p, 1)}</td><td class="num">${clp(v * ufv)}</td></tr>`).join('')}
        <tr><td>Gastos operacionales (estimados)</td><td class="num">${num(st.closingCosts.total, 2)}</td><td></td><td class="num">${clp(st.closingCosts.total * ufv)}</td></tr>
        <tr><td><b>Aporte real de capital</b></td><td class="num"><b>${num(st.equity, 2)}</b></td><td></td><td class="num"><b>${clp(st.equity * ufv)}</b></td></tr></table>
        <details class="small" style="margin-top:6px"><summary>Detalle de gastos operacionales</summary>${st.closingCosts.items.map((i) => `<div class="row between"><span>${esc(i.label)}</span><span class="num">${uf(i.uf)}</span></div>`).join('')}<div class="tiny muted">Supuestos editables en Configuración. Cotizar con banco y notaría.</div></details>
        ${st.warnings.map((w) => `<div class="note warn small" style="margin-top:6px">${esc(w)}</div>`).join('')}
        ${a.input.deliveryMonths > 0 ? `<div class="note small" style="margin-top:6px">Compra en verde/blanco: pie en ${Math.min(a.input.deliveryMonths, a.input.pieInstallmentsMax)} cuotas hasta la entrega (~${a.input.deliveryMonths} meses). El crédito, el dividendo y el arriendo parten al escriturar. La tasa se fija al escriturar: puede cambiar. Riesgo de atraso: ver escenario Estrés.</div>` : ''}
      </div>
      <div><h4 style="margin-top:0">Ajusta y recalcula</h4>
        <div class="sim-grid">
          ${simField('creditPct', 'Crédito (%)', +(inp.creditPct * 100).toFixed(1), 1, 'pct')}
          ${simField('bonoPiePct', 'Bono pie (%)', +(inp.bonoPiePct * 100).toFixed(1), 0.5, 'pct')}
          ${simField('annualRate', 'Tasa anual (%)', +(inp.annualRate * 100).toFixed(2), 0.05, 'pct')}
          ${simField('loanYears', 'Plazo (años)', inp.loanYears, 1, 'int')}
          ${simField('rentClp', 'Arriendo mensual (CLP)', Math.round(o.rentClp ?? a.rentEstimate?.baseClp ?? 0), 5000, 'clp', o.rentClp != null ? 'tu supuesto' : 'estimado')}
          ${simField('gcClp', 'Gasto común (CLP)', Math.round(o.gcClp ?? a.gc?.baseClp ?? 0), 1000, 'clp', o.gcClp != null ? 'tu supuesto' : (a.gc?.kind || '').toLowerCase())}
          ${simField('initialVacancyMonths', 'Meses para arrendar', inp.initialVacancyMonths, 0.5)}
          ${simField('turnoverVacancyMonths', 'Meses vacíos entre contratos', inp.turnoverVacancyMonths, 0.5)}
        </div>
        <div class="row" style="margin-top:8px"><div class="seg">${S.config.financing.presetsCreditPct.map((c) => `<button class="${Math.abs(inp.creditPct - c) < 1e-6 ? 'on' : ''}" data-action="sim-preset" data-cp="${c}">${Math.round(c * 100)}%</button>`).join('')}</div>
        <button class="btn sm" data-action="sim-reset">Volver a los supuestos</button></div>
        <p class="tiny muted">Financiar 90% es una evaluación condicional: ningún banco está obligado a aprobarlo.</p>
      </div>
    </div>
    <h4>Dividendo según financiamiento y plazo (tasa ${pct(inp.annualRate, 2)})</h4>
    <div class="table-scroll"><table class="t"><tr><th>Financia</th><th class="num">Crédito UF</th><th class="num">Pie a pagar UF</th><th class="num">Plazo</th><th class="num">Dividendo UF</th><th class="num">Dividendo CLP hoy</th><th class="num">Renta requerida*</th></tr>
      ${divRows.map((r) => `<tr class="${Math.abs(r.cp - inp.creditPct) < 1e-6 && r.yrs === inp.loanYears ? 'hl' : ''}"><td>${pct(r.cp, 0)}</td><td class="num">${num(r.credit, 2)}</td><td class="num">${num(r.pie, 2)}</td><td class="num">${r.yrs} años</td><td class="num">${num(r.d, 2)}</td><td class="num">${clp(r.d * ufv)}</td><td class="num">${clp(r.inc)}</td></tr>`).join('')}</table></div>
    <p class="tiny muted">*Renta líquida estimada con la regla editable dividendo ≤ ${pct(S.config.financing.incomeRatio, 0)} de la renta. No es una preaprobación. Dividendos sin seguros.</p>
  </div>`;
}

document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset.sim || !current) return;
  const k = key(current.p, current.unit);
  const o = (ov()[k] ||= {});
  o.fin ||= {};
  const v = parseFloat(String(el.value).replace(',', '.'));
  if (!Number.isFinite(v)) return;
  const kind = el.dataset.kind;
  if (el.dataset.sim === 'rentClp') o.rentClp = v;
  else if (el.dataset.sim === 'gcClp') o.gcClp = v;
  else o.fin[el.dataset.sim] = kind === 'pct' ? v / 100 : v;
  rerender();
});
handle('sim-preset', (el) => { const o = (ov()[key(current.p, current.unit)] ||= {}); o.fin = { ...(o.fin || {}), creditPct: +el.dataset.cp }; rerender(); });
handle('sim-reset', () => { delete ov()[key(current.p, current.unit)]; rerender(); });

// ------------------------------------------------------------------ arriendo 2 km
function arriendoHTML(p, a) {
  const r = a.rent, cfg = S.config, ufv = a.ufValue;
  if (!r) return `<div class="section card" id="sec-arriendo"><h3>Arriendo en ${meters(cfg.rentals.radiusM)}</h3><div class="empty">Sin ubicación: no se pueden buscar comparables.</div></div>`;
  const s = r.stats, s2 = r.statsPerM2;
  const radiusBtn = r.radiusM < cfg.rentals.expandedRadiusM ? `<button class="btn sm" data-action="rent-expand">Ampliar a ${meters(cfg.rentals.expandedRadiusM)}</button>` : `<button class="btn sm" data-action="rent-reset">Volver a ${meters(cfg.rentals.radiusM)}</button>`;
  const statRow = (label, v) => `<tr><td>${label}</td><td class="num">${clp(v)}</td><td class="num">${uf(v / ufv)}</td></tr>`;
  const bins = histogram(r.comps.map((c) => c.price_clp), 8);
  return `<div class="section card" id="sec-arriendo"><h3>Arriendo tradicional en un radio de ${meters(r.radiusM)} ${p.demo ? '<span class="chip demo">avisos DEMO</span>' : ''}</h3>
    <div class="row small" style="margin-bottom:8px">
      <span class="chip">${r.counts.inRadius} avisos en el radio</span><span class="chip">${r.counts.homogeneous} homogéneos (${a.unit.bedrooms === 0 ? 'estudio' : `${a.unit.bedrooms}D`}, ±${Math.round(cfg.rentals.areaTolerance * 100)}% m², sin amoblar)</span>
      <span class="chip ${r.insufficient ? 'warn' : 'good'}">${r.counts.used} usados${r.insufficient ? ` · evidencia insuficiente (< ${r.minSample})` : ''}</span>
      <span class="chip">${r.counts.duplicates} duplicados · ${r.counts.outliers} extremos excluidos</span>
      ${r.cutoffDate ? `<span class="chip">corte ${date(r.cutoffDate)}</span>` : ''} ${radiusBtn}
    </div>
    ${r.insufficient ? `<div class="note warn small">Hay menos de ${r.minSample} comparables homogéneos: no se reportan promedio, mediana ni percentiles como si fueran robustos. ${a.rentSource === 'referencia' ? `El análisis usa una <b>referencia comunal publicada</b> (${esc(a.rentEstimate.source)}), de baja confianza.` : ''} Para mejorar: importa avisos reales (Configuración → Importar datos) o amplía el radio.</div>` : `
      <div class="grid grid-2"><div><table class="t"><tr><th>Precio pedido mensual</th><th class="num">CLP</th><th class="num">UF</th></tr>
        ${statRow('Promedio', s.mean)}${statRow('Mediana', s.median)}${statRow('Mínimo (depurado)', s.min)}${statRow('Máximo (depurado)', s.max)}${statRow('Percentil 25', s.p25)}${statRow('Percentil 75', s.p75)}
        <tr><td>CLP/m² útil (mediana)</td><td class="num">${clp(s2.median)}</td><td class="num">${s2.n} con m²</td></tr></table>
        <p class="tiny muted">Mínimo y máximo observados antes de depurar: ${clp(r.observedRaw?.min)} – ${clp(r.observedRaw?.max)}. Son precios PEDIDOS, no contratos.</p></div>
        <div>${histogramChart(bins, (v) => clp(v), [{ label: 'mediana', value: s.median }, { label: 'esta unidad (base)', value: a.rentEstimate?.baseClp }], 'Distribución de arriendos')}</div></div>`}
    ${a.rentSource === 'referencia' ? `<div class="note small" style="margin-top:8px"><b>Referencia comunal:</b> ${clp(a.rentEstimate.baseClp)} (${esc(a.rentEstimate.method)}). Fuente: ${a.rentEstimate.source_url ? `<a href="${esc(a.rentEstimate.source_url)}" target="_blank" rel="noopener">${esc(a.rentEstimate.source)}</a>` : esc(a.rentEstimate.source)}. ${esc(a.rentEstimate.note || '')}</div>` : ''}
    ${r.comps.length ? `<details style="margin-top:8px"><summary class="small"><b>${r.comps.length} avisos usados</b> (puntos azules en el mapa)</summary><div class="table-scroll"><table class="t"><tr><th>Distancia</th><th class="num">Precio</th><th class="num">m²</th><th class="num">CLP/m²</th><th>Publicado</th><th>Fuente</th></tr>
      ${r.comps.map((c) => `<tr><td>${meters(c.distance)}</td><td class="num">${clp(c.price_clp)}</td><td class="num">${c.useful_m2 ?? 's/d'}</td><td class="num">${c.useful_m2 ? clp(c.price_clp / c.useful_m2) : ''}</td><td>${date(c.published_at)}</td><td>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.source)}</a>` : esc(c.source)}</td></tr>`).join('')}</table></div></details>` : ''}
    ${r.excluded.length ? `<details><summary class="small">${r.excluded.length} avisos excluidos y por qué</summary><div class="table-scroll"><table class="t"><tr><th>Precio</th><th>Dorm.</th><th>m²</th><th>Motivo</th></tr>${r.excluded.slice(0, 200).map((x) => `<tr><td class="num">${clp(x.listing.price_clp)}</td><td>${x.listing.bedrooms}</td><td>${x.listing.useful_m2 ?? ''}</td><td>${esc(x.reason)}</td></tr>`).join('')}</table></div></details>` : ''}
    ${r.counts.pool === 0 && !p.demo ? '<p class="small muted">Sin avisos reales cargados todavía: no hay un proveedor autorizado conectado. Importa un CSV de avisos o activa el modo DEMO para ver esta sección completa.</p>' : ''}
  </div>`;
}
handle('rent-expand', () => { const o = (ov()[key(current.p, current.unit)] ||= {}); o.radiusM = S.config.rentals.expandedRadiusM; rerender(); toast(`Radio ampliado a ${meters(S.config.rentals.expandedRadiusM)} (cambian los comparables y la confianza)`); });
handle('rent-reset', () => { const o = (ov()[key(current.p, current.unit)] ||= {}); delete o.radiusM; rerender(); });

// ------------------------------------------------------------------ gastos
function gastosHTML(a) {
  const g = a.gc, ufv = a.ufValue, inp = a.input;
  const sched = a.base.schedule.rows[0] || {};
  return `<div class="section card" id="sec-gastos"><h3>Gastos comunes y costos ocultos</h3>
    <div class="grid grid-2"><div>
      <div class="row"><span class="chip ${g.kind === 'PUBLICADO' ? 'good' : 'warn'}">${esc(g.kind)}</span><span class="small">${esc(g.method)}</span></div>
      <table class="t" style="margin-top:6px"><tr><th>Gasto común mensual</th><th class="num">CLP</th></tr>
        <tr><td>Bajo</td><td class="num">${clp(g.lowClp)}</td></tr><tr><td><b>Base (usado)</b></td><td class="num"><b>${clp(g.baseClp)}</b></td></tr><tr><td>Alto</td><td class="num">${clp(g.highClp)}</td></tr></table>
      <p class="tiny muted">Estando arrendado lo paga el arrendatario (supuesto editable); en los meses vacíos lo paga el propietario. ${esc(g.source || '')}</p>
    </div><div>
      <table class="t"><tr><th>Costo del propietario</th><th class="num">CLP/mes (hoy)</th></tr>
        <tr><td>Contribuciones (prorrateado; se pagan en abr/jun/sep/nov)</td><td class="num">${clp((inp.contribucionesUfYear / 12) * ufv)}</td></tr>
        <tr><td>Seguro incendio y sismo</td><td class="num">${clp(sched.incendio * ufv)}</td></tr>
        <tr><td>Seguro desgravamen (mes 1)</td><td class="num">${clp(sched.desgravamen * ufv)}</td></tr>
        <tr><td>Mantención (${pct(inp.maintenancePctOfRent, 0)} del arriendo)</td><td class="num">${clp(inp.rentUf * inp.maintenancePctOfRent * ufv)}</td></tr>
        <tr><td>Reserva para mejoras</td><td class="num">${clp(inp.capexReserveUfMonth * ufv)}</td></tr>
        <tr><td>Corretaje (${pct(inp.brokeragePctOfRent, 0)} de un mes por contrato, prorrateado)</td><td class="num">${clp((inp.rentUf * inp.brokeragePctOfRent / (inp.leaseMonths + inp.turnoverVacancyMonths)) * ufv)}</td></tr>
        <tr><td>Incobrabilidad (${pct(inp.collectionLossPct, 0)})</td><td class="num">${clp(inp.rentUf * inp.collectionLossPct * ufv)}</td></tr></table>
      <p class="tiny muted">Contribuciones: (avalúo supuesto ${pct(S.config.contribuciones.avaluoFactor, 0)} del precio − exento ${clp(S.config.contribuciones.exemptClp)}) × ${pct(S.config.contribuciones.ratePct, 3)}. Confirmar en sii.cl.</p>
    </div></div></div>`;
}

// ------------------------------------------------------------------ flujo mes a mes
function flujoHTML(a) {
  const ufv = a.ufValue;
  const D = a.metrics.deliveryMonths;
  const op = a.base.months.filter((r) => r.t > D).slice(0, 24);
  const items = op.map((r, i) => ({ label: `${MONTHS[r.moy]}${i % 12 === 0 ? ` a${Math.floor(i / 12) + 1}` : ''}`, value: r.cf * ufv,
    tip: `Mes ${i + 1} tras la entrega (${MONTHS[r.moy]})\nArriendo cobrado: ${clp((r.income - r.collectionLoss) * ufv)}\nGC dueño: ${clp(-r.gcOwner * ufv)}\nContribuciones: ${clp(-r.contribuciones * ufv)}\nCorretaje: ${clp(-r.brokerage * ufv)}\nDividendo + seguros: ${clp(-(r.dividend + r.desgravamen + r.incendio) * ufv)}\nFlujo: ${clp(r.cf * ufv)}` }));
  const neg = op.filter((r) => r.cf < 0).length;
  return `<div class="section card" id="sec-flujo"><h3>Flujo de caja mes a mes (24 meses desde la entrega)</h3>
    <p class="small">${neg} de 24 meses con flujo negativo en el escenario base. Peor mes: <b>${clp(a.metrics.worstMonthCf * ufv)}</b>. ${D > 0 ? `Antes de la entrega pagas ${uf(a.base.months.slice(0, D).reduce((s, r) => s + r.equity, 0), 0)} de pie en cuotas.` : ''}</p>
    ${barChart({ items, fmt: (v) => clp(v), diverging: true, title: 'Flujo mensual', labelEvery: 3 })}
    <div class="chart-legend"><span><i class="sq" style="background:var(--pos)"></i>Flujo positivo</span><span><i class="sq" style="background:var(--neg)"></i>Flujo negativo</span><span class="muted">Pasa el cursor sobre una barra para ver el detalle.</span></div>
    <details><summary class="small">Ver tabla</summary><div class="table-scroll"><table class="t"><tr><th>Mes</th><th class="num">Ocupación</th><th class="num">Arriendo</th><th class="num">GC dueño</th><th class="num">Contrib.</th><th class="num">Corretaje</th><th class="num">Dividendo+seg.</th><th class="num">Flujo</th><th class="num">Acumulado</th></tr>
    ${op.map((r, i) => `<tr><td>${i + 1} · ${MONTHS[r.moy]}</td><td class="num">${pct(r.occ, 0)}</td><td class="num">${clp(r.income * ufv)}</td><td class="num">${clp(-r.gcOwner * ufv)}</td><td class="num">${clp(-r.contribuciones * ufv)}</td><td class="num">${clp(-r.brokerage * ufv)}</td><td class="num">${clp(-(r.dividend + r.desgravamen + r.incendio) * ufv)}</td><td class="num">${clp(r.cf * ufv)}</td><td class="num">${clp(op.slice(0, i + 1).reduce((s, x) => s + x.cf, 0) * ufv)}</td></tr>`).join('')}</table></div>
    <button class="btn sm" data-action="flow-csv" style="margin-top:6px">Descargar CSV</button></details>
  </div>`;
}
handle('flow-csv', () => {
  const a = current.a, ufv = a.ufValue;
  download(`flujo_${current.p.id}_${a.unit.id}.csv`, toCSV(a.base.months.map((r) => ({ mes: r.t, fase: r.phase, mes_del_ano: MONTHS[r.moy], ocupacion: r.occ.toFixed(3), aporte_capital_uf: r.equity.toFixed(3), arriendo_uf: r.income.toFixed(3), gc_dueno_uf: r.gcOwner.toFixed(3), contribuciones_uf: r.contribuciones.toFixed(3), corretaje_uf: r.brokerage.toFixed(3), dividendo_uf: r.dividend.toFixed(3), seguros_uf: (r.desgravamen + r.incendio).toFixed(3), flujo_uf: r.cf.toFixed(3), flujo_clp_hoy: Math.round(r.cf * ufv) }))), 'text/csv;charset=utf-8');
});

// ------------------------------------------------------------------ escenarios
function escenariosHTML(a) {
  const ufv = a.ufValue;
  const sc = a.scenarios;
  const rows = [
    ['Arriendo mensual', (r) => clp(r.input.rentUf * ufv)],
    ['Flujo mensual estabilizado', (r) => clp(r.metrics.monthlyCf * ufv, { sign: true })],
    ['Meses negativos (primeros 24)', (r) => `${r.metrics.negativeMonths24}`],
    ['Peor mes', (r) => clp(r.metrics.worstMonthCf * ufv)],
    ['Caja de respaldo necesaria', (r) => `${clp(r.metrics.liquidityNeededUf * ufv)} (${num(r.metrics.reserveMonths, 1)} meses)`],
    ['Rentabilidad sobre capital', (r) => pct(r.metrics.cashOnCash)],
    ['DSCR (cobertura de deuda)', (r) => num(r.metrics.dscr, 2)],
    ['TIR real (30 años, con venta)', (r) => pct(r.metrics.irrReal)],
    ['Entrega', (r) => (r.metrics.deliveryMonths ? `${r.metrics.deliveryMonths} meses` : 'inmediata')],
  ];
  return `<div class="section card" id="sec-escenarios"><h3>Escenarios</h3>
    <div class="table-scroll"><table class="t"><tr><th></th>${Object.entries(sc).map(([k]) => `<th class="num">${esc(S.config.scenarios[k].label)}</th>`).join('')}</tr>
    ${rows.map(([l, f]) => `<tr><td>${l}</td>${Object.values(sc).map((r) => `<td class="num">${f(r)}</td>`).join('')}</tr>`).join('')}</table></div>
    <p class="tiny muted">Conservador y Estrés suben vacancia, mantención y GC y bajan el arriendo${a.input.deliveryMonths > 0 ? '; en compras en verde agregan atraso de entrega y alza de tasa al escriturar' : ''}. Parámetros en Configuración → Escenarios.</p></div>`;
}

// ------------------------------------------------------------------ 30 años
function proyeccionHTML(a) {
  const ufv = a.ufValue, rows = a.base.annual;
  const x = rows.map((r) => `${r.years} a`);
  return `<div class="section card" id="sec-proyeccion"><h3>Proyección patrimonial (escenario base, en UF de hoy)</h3>
    ${lineChart({ x, series: [
    { name: 'Patrimonio neto si vendes (valor − deuda − costo de venta)', values: rows.map((r) => r.saleNet) },
    { name: 'Flujo de caja acumulado (incluye pie y gastos pagados)', values: rows.map((r) => r.cumCf - r.equityPaid) },
    { name: 'Resultado total', values: rows.map((r) => r.result) },
  ], fmt: (v) => uf(v, 0), zero: true, title: 'Proyección patrimonial' })}
    <div class="table-scroll" style="margin-top:8px"><table class="t"><tr><th>Año</th><th class="num">Valor depto</th><th class="num">Deuda</th><th class="num">Neto si vendes</th><th class="num">Flujo acumulado</th><th class="num">Capital aportado</th><th class="num">Resultado</th><th class="num">TIR real</th></tr>
    ${rows.map((r) => `<tr><td>${r.years}${r.underConstruction ? ' (en obra)' : ''}</td><td class="num">${uf(r.value, 0)}</td><td class="num">${uf(r.balance, 0)}</td><td class="num">${r.saleNet == null ? 's/d' : uf(r.saleNet, 0)}</td><td class="num">${uf(r.cumCf, 0)}</td><td class="num">${uf(r.equityPaid, 0)}</td><td class="num">${r.result == null ? 's/d' : uf(r.result, 0)}</td><td class="num">${pct(r.irrReal)}</td></tr>`).join('')}</table></div>
    <p class="tiny muted">Plusvalía real supuesta ${pct(a.input.appreciationReal, 1)} anual sobre el precio real (precio − bono) — proyección, no garantía. Resultado = neto de venta + flujos − capital aportado (sin doble conteo de la amortización). TIR nominal aprox. ${pct(a.metrics.irrNominal)} con inflación ${pct(a.input.ufInflation, 1)}. VAN real al ${pct(a.input.discountRateReal, 1)}: ${uf(a.metrics.npvReal, 0)} (${clp(a.metrics.npvReal * ufv)}).</p></div>`;
}

// ------------------------------------------------------------------ riesgo
function riesgoHTML(a) {
  const ufv = a.ufValue, m = a.metrics, mc = a.mc;
  const fixed = m.fixedMonthly + (a.input.contribucionesUfYear / 12);
  const noRent = [1, 2, 3, 6].map((k) => ({ k, uf: k * fixed }));
  const delay = a.input.deliveryMonths > 0 ? [6, 12].map((d) => ({ d, r: simulate({ ...a.input, deliveryDelayMonths: d }) })) : [];
  const sell = [3, 5].map((y) => ({ y, r: simulate({ ...a.input, appreciationReal: 0, horizonYears: Math.max(y, Math.ceil(a.input.deliveryMonths / 12) + y) }) }));
  const stress = a.scenarios.estres?.metrics;
  return `<div class="section card" id="sec-riesgo"><h3>Riesgo de pérdida</h3>
    <div class="grid grid-2"><div class="dims">
      ${Object.entries(a.risk.dims).map(([k, v]) => `<div class="dim"><span>${esc(k[0].toUpperCase() + k.slice(1))}</span>${meter(v.score, 'risk')}<span class="num small">${Math.round(v.score)}</span><span class="w">${esc(v.why)}</span></div>`).join('')}
      <p class="small"><b>Total: ${Math.round(a.risk.total)}/100 (${riskLabel(a.risk.total)})</b> · pesos en Configuración → Riesgo.</p></div>
      <div>${mc ? `<div class="note small"><b>Simulación Monte Carlo</b> (${mc.iterations} iteraciones, semilla ${mc.seed}, ${mc.years} años). ${esc(mc.label)}</div>
        <table class="t" style="margin-top:6px">
          <tr><td>Probabilidad simulada de flujo anual negativo (año 1)</td><td class="num"><b>${pct(mc.probNegativeFirstYear, 0)}</b></td></tr>
          <tr><td>Probabilidad simulada de algún mes negativo (año 1)</td><td class="num">${pct(mc.probAnyNegativeMonth, 0)}</td></tr>
          <tr><td>Prob. simulada de agotar tu reserva (${uf(S.config.investor.reserveUf ?? S.config.risk.defaultReserveUf, 0)}) en ${mc.years} años</td><td class="num">${pct(mc.probDeficitOverReserve, 0)}</td></tr>
          <tr><td>Flujo año 1 (p5 / mediana / p95)</td><td class="num">${clp(mc.firstYearCf.p5 * ufv)} / ${clp(mc.firstYearCf.p50 * ufv)} / ${clp(mc.firstYearCf.p95 * ufv)}</td></tr>
          <tr><td>Caja necesaria (mediana / p90)</td><td class="num">${clp(mc.liquidityNeededUf.p50 * ufv)} / ${clp(mc.liquidityNeededUf.p90 * ufv)}</td></tr></table>
        <p class="tiny muted">Distribuciones supuestas: arriendo ±${pct(S.config.risk.monteCarlo.rentSd, 0)}, vacancia discreta, GC en su banda, reparación imprevista ${pct(S.config.risk.monteCarlo.capexShockProb, 0)}/año, atraso de entrega. Mercado débil = arriendo menor y más vacancia a la vez.</p>` : '<div class="empty">Sin arriendo estimado: no se simula.</div>'}</div></div>
    <h4>Preguntas clave</h4>
    <table class="t">
      <tr><td>¿Cuánto puedo perder al mes en un escenario malo?</td><td class="num">${stress ? `${clp(stress.monthlyCf * ufv)} promedio en Estrés; peor mes ${clp(stress.worstMonthCf * ufv)}` : 's/d'}</td></tr>
      <tr><td>¿Cuántos meses de caja de respaldo necesitaría?</td><td class="num">Base: ${num(m.reserveMonths, 1)} meses (${clp(m.liquidityNeededUf * ufv)}) · Estrés: ${stress ? `${num(stress.reserveMonths, 1)} meses (${clp(stress.liquidityNeededUf * ufv)})` : 's/d'}</td></tr>
      <tr><td>¿Qué arriendo necesito para empatar?</td><td class="num">${m.breakeven?.rentUf != null ? `${clp(m.breakeven.rentUf * ufv)} (margen ${pct(m.marginOfSafety)})` : m.breakeven?.occupancy != null ? `ocupación ${pct(m.breakeven.occupancy)}` : 's/d'}</td></tr>
      ${noRent.map((x) => `<tr><td>¿Y si no consigo arrendatario durante ${x.k} mes${x.k > 1 ? 'es' : ''}?</td><td class="num">pagas ${clp(x.uf * ufv)} de tu bolsillo (dividendo + seguros + GC + contribuciones)</td></tr>`).join('')}
      ${delay.map((x) => `<tr><td>¿Y si se entrega ${x.d} meses tarde?</td><td class="num">TIR real ${pct(x.r.metrics.irrReal)} (vs ${pct(m.irrReal)}); ${x.d} meses más sin arriendo con el pie ya pagado</td></tr>`).join('') || '<tr><td>¿Y si se entrega tarde?</td><td class="num">No aplica: entrega inmediata o fecha no verificada</td></tr>'}
      ${sell.map((x) => { const row = x.r.annual.find((r) => r.years === x.y); return `<tr><td>¿Y si debo vender en ${x.y} años y el precio no sube?</td><td class="num">${row?.result == null ? 's/d' : `resultado ${uf(row.result, 0)} (${clp(row.result * ufv)}) · TIR ${pct(row.irrReal)}`}</td></tr>`; }).join('')}
    </table></div>`;
}

// ------------------------------------------------------------------ Airbnb
function airbnbHTML(p, a) {
  const strStatus = a.strStatus;
  const labels = { permitido_verificado: ['Permitido / verificado', 'good'], no_permitido_verificado: ['No permitido / verificado', 'crit'], por_verificar: ['Por verificar', 'warn'], condicionado: ['Condicionado', 'serious'] };
  const [lbl, cls] = labels[strStatus] || labels.por_verificar;
  const ufv = a.ufValue;
  const o = ov()[key(p, a.unit)] || {};
  const strA = analyzeUnit(p, a.unit, S.ctx, { mode: 'renta_corta', overrides: { ...(o.fin || {}), ...(o.gcClp != null ? { commonExpensesUf: o.gcClp / ufv } : {}) }, rentClpOverride: o.rentClp, mc: false });
  const sm = strA.metrics;
  const op = strA.base.months.filter((r) => r.t > sm.deliveryMonths).slice(0, 12);
  const items = op.map((r) => ({ label: MONTHS[r.moy], value: r.cf * ufv, tip: `${MONTHS[r.moy]}: ocupación ${pct(r.occ, 0)}\nIngresos ${clp(r.income * ufv)}\nIVA ${clp(-r.iva * ufv)} · plataforma ${clp(-r.platform * ufv)} · co-host ${clp(-r.admin * ufv)}\nLimpieza e insumos ${clp(-r.cleaning * ufv)} · servicios ${clp(-r.utilities * ufv)} · GC ${clp(-r.gcOwner * ufv)}\nDividendo + seguros ${clp(-(r.dividend + r.desgravamen + r.incendio) * ufv)}\nFlujo ${clp(r.cf * ufv)}` }));
  const be = sm.breakeven || {};
  return `<div class="section card" id="sec-airbnb"><h3>Renta corta (Airbnb) — módulo separado</h3>
    <div class="row"><span class="chip ${cls}">Legalidad: ${lbl}</span><span class="small muted">${esc(p.short_term_rental?.notes || 'Revisar reglamento de copropiedad, reglas del condominio, SII y normas locales.')}</span></div>
    ${strStatus !== 'permitido_verificado' ? '<div class="note warn small" style="margin-top:6px">No está verificado que el reglamento permita renta corta: esta unidad no entra al ranking de Airbnb. Que haya Airbnb cerca NO prueba que esté permitido.</div>' : ''}
    <div class="note small" style="margin-top:6px"><b>Simulación de supuestos</b> (sin proveedor licenciado tipo AirDNA): tarifa ${clp(S.config.airbnb.adrClp)}/noche, ocupación ${pct(S.config.airbnb.occupancy, 0)}, co-host ${pct(S.config.airbnb.cohostPct, 0)}, IVA ${S.config.airbnb.ivaApplies ? 'incluido' : 'no'}, amoblado ${uf(S.config.airbnb.furnishingUf, 0)}. Edítalos en Configuración → Supuestos → Renta corta. No son datos de mercado.</div>
    <div class="kpis" style="margin-top:8px">
      ${kpi('Flujo mensual Airbnb', clp(sm.monthlyCf * ufv, { sign: true }), 'promedio después del dividendo', '', sm.monthlyCf >= 0 ? 'pos' : 'neg')}
      ${kpi('vs tradicional', clp((sm.monthlyCf - a.metrics.monthlyCf) * ufv, { sign: true }), 'diferencia mensual (más trabajo y más riesgo)')}
      ${kpi('Ocupación de equilibrio', be.occupancy != null ? (be.occupancy > 1 ? 'inalcanzable' : pct(be.occupancy, 0)) : 's/d', 'flujo neto = 0 con la tarifa actual')}
      ${kpi('Tarifa de equilibrio', be.adrUf != null ? clp(be.adrUf * ufv) : 's/d', 'por noche, con la ocupación actual')}
      ${kpi('Capital inicial', uf(strA.structure.equity, 0), 'incluye amoblado')}
    </div>
    ${barChart({ items, fmt: (v) => clp(v), diverging: true, title: 'Flujo Airbnb mensual', labelEvery: 1 })}
    <p class="tiny muted">Estacionalidad: solo si cargas ocupación por mes con evidencia (Configuración). Eventos y temporadas son contexto, no ingresos garantizados. IVA de arriendos amoblados: confirmar con asesor tributario (SII).</p></div>`;
}

// ------------------------------------------------------------------ entorno
function entornoHTML(p, a) {
  if (p.lat == null) return '';
  const near = a.near || {};
  const cats = { supermercado: 'Supermercado', mall: 'Mall', clinica: 'Clínica / centro médico', hospital: 'Hospital', universidad: 'Universidad / instituto', parque: 'Parque', turismo: 'Museo / atractivo', cultura: 'Teatro / cultura' };
  const sec = a.security;
  return `<div class="section card" id="sec-entorno"><h3>Entorno</h3>
    <div class="grid grid-2"><div><table class="t"><tr><th>Lo más cercano</th><th class="num">Distancia</th><th class="num">A pie ≈</th></tr>
      ${a.metro ? `<tr><td>Ⓜ Metro ${esc(a.metro.name)} (L${esc(a.metro.lines.join('/'))})</td><td class="num">${meters(a.metro.distance)}</td><td class="num">${Math.round(a.metro.walkMin)} min</td></tr>` : '<tr><td>Metro</td><td colspan="2">sin capa</td></tr>'}
      ${Object.entries(cats).map(([k, l]) => near[k] ? `<tr><td>${l}: ${esc(near[k].name)}</td><td class="num">${meters(near[k].distance)}</td><td class="num">${Math.round(near[k].walkMin)} min</td></tr>` : '').join('')}</table>
      <p class="tiny muted">Distancias en línea recta; minutos a pie ≈ distancia × 1,3 / 1,3 m/s (estimación, no ruta real). Fuente: OpenStreetMap.</p></div>
      <div class="stack">
        <div><b>Servicios (score propio):</b> ${a.servicesScore == null ? 's/d' : `${Math.round(a.servicesScore)}/100`} ${meter(a.servicesScore)}<div class="tiny muted">${esc(a.servicesWhy || '')}</div></div>
        <div><b>Atractivo turístico (índice propio):</b> ${a.tourism?.score == null ? 's/d' : `${Math.round(a.tourism.score)}/100`} ${meter(a.tourism?.score)}<div class="tiny muted">${a.tourism?.count ?? 0} museos/atractivos/teatros a ${meters(a.tourism?.radiusM)} (OSM). No mide ocupación de Airbnb ni demanda real.</div></div>
        <div><b>Seguridad (comunal):</b> ${sec ? `índice ${Math.round(sec.index)}/100 · tasa ${num(sec.rate)} x 100 mil (${esc(sec.period || '')}) <a href="${esc(sec.url || 'https://cead.spd.gov.cl/sala-cead/')}" target="_blank" rel="noopener">fuente</a>` : 'sin datos verificados — <a href="#" data-action="goto-security">cargar desde CEAD</a>'}<div class="tiny muted">Dato comunal, no del entorno del inmueble. Indicador entre varios, no una garantía.</div></div>
        ${a.needsMicrosector ? `<div><b>Microsector:</b> ${a.microsector ? `${esc(a.microsector.name)} (${esc(a.microsector.status)})` : '<span class="chip warn">fuera de los microsectores definidos</span>'}</div>` : ''}
        <div><b>Ubicación:</b> precisión ${esc(a.geoPrecision)} ${p.geo_display_name ? `<span class="tiny muted">(${esc(p.geo_display_name)})</span>` : ''} ${p.geo_source ? `<span class="tiny muted">· ${esc(p.geo_source)}</span>` : ''}${p.geo_note ? `<div class="note warn small">${esc(p.geo_note)}</div>` : ''}</div>
      </div></div></div>`;
}
handle('goto-security', () => { actions.closeProject(); S.adminTab = 'comunas'; actions.setView('config'); });

// ------------------------------------------------------------------ obras cercanas
function obrasHTML(p, a) {
  if (p.lat == null) return '';
  const list = a.nearby || [];
  const now = new Date().getFullYear();
  const buckets = [1, 3, 5, 10].map((y) => ({ y, items: list.filter((n) => { const yr = parseInt(n.dev.estimated_date || '0', 10); return yr && yr <= now + y && yr > now + ([0, 1, 3, 5][[1, 3, 5, 10].indexOf(y)]); }) }));
  return `<div class="section card" id="sec-obras"><h3>Obras y anuncios cercanos (${meters(S.config.infrastructure.nearbyRadiusM)} o su radio)</h3>
    ${list.length ? list.map(({ dev: d, distance, insideRadius }) => `<div style="border-left:4px solid ${DEV_COLORS[d.type] || '#888'};padding:6px 10px;margin:8px 0;background:var(--surface-2);border-radius:0 8px 8px 0">
      <div class="row between"><b>${esc(d.name)}</b><span class="small">${meters(distance)} ${insideRadius ? '<span class="chip info">dentro de su radio</span>' : ''}</span></div>
      <div class="small muted">${esc(DEV_LABELS[d.type] || d.type)} · ${esc(d.stage)} · ${esc(d.estimated_label || d.estimated_date || 'sin fecha')} · certeza ${esc(d.certainty || 's/d')} ${d.status !== 'publicado' ? '<span class="chip warn">pendiente de revisión</span>' : ''}</div>
      ${d.impacts ? `<div class="small" style="margin-top:4px">${(d.impacts.positive || []).map((x) => `<div>➕ ${esc(x)}</div>`).join('')}${(d.impacts.negative || []).map((x) => `<div>➖ ${esc(x)}</div>`).join('')}</div>` : ''}
      <div class="tiny muted">${(d.sources || []).slice(0, 2).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher || s.title)}</a>`).join(' · ')}</div></div>`).join('') : '<div class="empty">No hay obras cargadas cerca de este proyecto.</div>'}
    <h4>Qué podría cambiar en este barrio</h4>
    <div class="grid grid-4">${buckets.map((b) => `<div class="kpi"><div class="k">En ${b.y} año${b.y > 1 ? 's' : ''}</div><div class="s">${b.items.length ? b.items.map((n) => esc(n.dev.name)).join('<br>') : '<span class="muted">nada registrado</span>'}</div></div>`).join('')}</div>
    <p class="tiny muted">Fechas de las fuentes, sujetas a cambio. Un radio es una zona de estudio: no implica valorización asegurada ni causalidad. Plusvalía potencial (score proyectivo aparte): ${Math.round(a.appreciation.score)}/100.</p></div>`;
}

// ------------------------------------------------------------------ evidencia
function evidenceHTML(p) {
  const ev = p.evidence || [];
  return `<div class="section card" id="sec-documentos"><h3>Documentos, fuentes y evidencia</h3>
    <div class="row">${p.publication_url ? `<a class="btn sm" href="${esc(p.publication_url)}" target="_blank" rel="noopener">Publicación / fuente</a>` : ''}${p.brochure_url ? `<a class="btn sm" href="${esc(p.brochure_url)}" target="_blank" rel="noopener">Brochure</a>` : '<span class="small muted">Sin brochure enlazado</span>'}${p.developer?.url ? `<a class="btn sm" href="${esc(p.developer.url)}" target="_blank" rel="noopener">Inmobiliaria</a>` : ''}</div>
    ${(p.documents || []).length ? `<ul class="small">${p.documents.map((d) => `<li>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.label)}</a>` : `${esc(d.label)} <span class="muted">(listado en la fuente, sin enlace)</span>`}</li>`).join('')}</ul>` : ''}
    ${(p.benefits || []).length ? `<h4>Beneficios comerciales</h4><ul class="small">${p.benefits.map((b) => `<li><b>${esc(b.label || b.type)}</b>${b.valid_until ? ` · vigente hasta ${date(b.valid_until)}` : ''}${b.note ? ` — ${esc(b.note)}` : ''}</li>`).join('')}</ul><p class="tiny muted">Declaraciones comerciales: no son garantías contractuales.</p>` : ''}
    ${p.typologies_text ? `<p class="small"><b>Tipologías publicadas:</b> ${esc(p.typologies_text)}</p>` : ''}
    ${p.notes ? `<div class="note small">${esc(p.notes)}</div>` : ''}
    ${p.delivery?.note ? `<div class="note small" style="margin-top:6px"><b>Entrega:</b> ${esc(p.delivery.note)}</div>` : ''}
    <h4>Registro de evidencia</h4>
    <div class="table-scroll"><table class="t"><tr><th>Campo</th><th>Valor</th><th>Fuente</th><th>Observado</th><th>Método</th><th>Confianza</th><th>Verificación</th></tr>
    ${ev.map((e) => `<tr><td>${esc(e.field)}</td><td class="small mono">${esc(typeof e.value === 'object' ? JSON.stringify(e.value) : e.value ?? '')}</td><td>${e.source_url ? `<a href="${esc(e.source_url)}" target="_blank" rel="noopener">${esc(e.source_name)}</a>` : esc(e.source_name)}</td><td>${date(e.observed_at)}</td><td>${esc(e.access_method || '')}</td><td>${esc(e.confidence || '')}</td><td>${esc(e.verification_status || '')}${e.notes ? `<div class="tiny muted">${esc(e.notes)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin registros</td></tr>'}</table></div>
    ${(p.price_history || []).length ? `<h4>Historial de precio mínimo</h4><div class="small">${p.price_history.map((h) => `${date(h.date)}: ${uf(h.min_price_uf, 0)}`).join(' → ')}</div>` : ''}
    <p class="tiny muted">Ingresado: ${date(p.first_seen_at, { time: true })}${p.search_observed_at ? ` · búsqueda web ${date(p.search_observed_at)}` : ''}.</p></div>`;
}

// ------------------------------------------------------------------ due diligence
function diligenciaHTML(p, a) {
  const d = p.delivery || {};
  const items = [
    ['dominio', 'Dominio vigente, hipotecas y gravámenes (CBR)', false],
    ['recepcion', 'Recepción final municipal', d.immediate_verified],
    ['promesa', 'Promesa: plazos, multas, devolución de reserva y condiciones', false],
    ['entrega', 'Fecha de entrega comprometida y multas por atraso', d.date_status === 'confirmada' || d.immediate_verified],
    ['reglamento', 'Reglamento de copropiedad (renta corta, mascotas, uso)', ['permitido_verificado', 'no_permitido_verificado'].includes(a.strStatus)],
    ['gc', 'Gastos comunes reales (presupuesto o últimos 3 meses)', a.gc.kind === 'PUBLICADO'],
    ['bono', 'Bono pie y descuentos por escrito; condición de tasación', !(a.input.bonoPiePct > 0)],
    ['credito', 'Preaprobación hipotecaria: tasa, plazo, seguros y CAE', false],
    ['stock', 'Stock y precio de la unidad específica (cotización)', !!d.stock_verified && a.priceEvidence.includes('verificado')],
    ['contribuciones', 'Contribuciones, avalúo fiscal y régimen DFL2', false],
    ['arriendo', `Arriendo de mercado con ≥ ${S.config.rentals.minSample} comparables`, a.rentSource === 'comparables'],
    ['subsidios', 'Subsidios o beneficios aplicables (si corresponde)', false],
  ];
  const user = LS.get(`dd.${p.id}`, {});
  return `<div class="section card" id="sec-diligencia"><h3>Checklist de due diligence</h3>
    <ul class="checklist">${items.map(([k, l, auto]) => {
    const ok = auto || user[k];
    return `<li><input type="checkbox" data-dd="${esc(p.id)}" data-k="${k}" ${ok ? 'checked' : ''} ${auto ? 'disabled' : ''}><span>${esc(l)} ${ok ? `<span class="chip good">${auto ? 'respaldado' : 'marcado por ti'}</span>` : '<span class="chip warn">pendiente</span>'}</span></li>`;
  }).join('')}</ul>
    <h4>Preguntas para la inmobiliaria</h4>
    <ol class="small">${questionsFor(p, a).map((q) => `<li>${esc(q)}</li>`).join('')}</ol></div>`;
}
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset.dd) return;
  const v = LS.get(`dd.${el.dataset.dd}`, {});
  v[el.dataset.k] = el.checked;
  LS.set(`dd.${el.dataset.dd}`, v);
});

export function questionsFor(p, a) {
  const q = [`¿Está disponible la unidad ${a.unit.id} al precio de ${uf(a.priceUf, 0)}? ¿Hasta qué fecha se mantiene?`];
  if (!p.delivery?.immediate_verified) q.push('¿Cuál es la fecha de entrega comprometida en la promesa y qué multa paga la inmobiliaria por atraso?');
  else q.push('¿Tiene recepción final? ¿Puedo ver el certificado?');
  if (a.input.bonoPiePct > 0) q.push('El bono pie, ¿queda por escrito? ¿Qué pasa si la tasación del banco sale bajo el precio de escritura?');
  if (a.gc.kind !== 'PUBLICADO') q.push('¿Cuál es el gasto común estimado de esta unidad y qué incluye (calefacción, agua caliente, conserjería)?');
  q.push('¿El reglamento de copropiedad permite arriendos por días (Airbnb)? ¿Hay restricciones o cobros especiales?');
  q.push('¿Qué gastos operacionales cubre la inmobiliaria (escritura, CBR, tasación)?');
  q.push('¿Hay estacionamiento y bodega incluidos o se venden aparte? ¿A qué precio?');
  if ((p.benefits || []).some((b) => b.type === 'arriendo_garantizado')) q.push('Arriendo garantizado: ¿quién lo paga, por cuánto tiempo, y qué pasa si el arrendatario no paga? Pide el contrato.');
  q.push('¿Cuántas unidades del proyecto se destinan a arriendo/inversionistas? (competencia directa)');
  return q;
}

// ------------------------------------------------------------------ decisión
function decisionHTML(p, a) {
  const ufv = a.ufValue, m = a.metrics, inv = S.config.investor;
  const tol = inv.maxNegativeFlowClp;
  const cfClp = m.monthlyCf * ufv;
  let verdict, cls, reasons = [];
  if (!a.gates.passed) {
    verdict = 'Investigar primero'; cls = 'warn';
    reasons = a.gates.fails.slice(0, 5);
  } else if (tol != null && tol !== 0 && cfClp < tol) {
    verdict = 'Descartar por flujo negativo bajo tu criterio'; cls = 'crit';
    reasons = [`Flujo base ${clp(cfClp)}/mes es peor que tu tolerancia de ${clp(tol)}/mes.`];
  } else {
    verdict = 'Atractivo si se cumple…'; cls = 'good';
    if (a.gc.kind !== 'PUBLICADO') reasons.push('el gasto común real no supera la banda alta estimada');
    reasons.push(`el arriendo de ${clp(a.rentEstimate?.baseClp)} se confirma (equilibrio en ${m.breakeven?.rentUf ? clp(m.breakeven.rentUf * ufv) : 's/d'})`);
    if (a.input.bonoPiePct > 0) reasons.push('la tasación respalda el precio con bono pie');
    if (a.mc && a.mc.probNegativeFirstYear > 0.3) reasons.push(`aceptas una probabilidad simulada de ${pct(a.mc.probNegativeFirstYear, 0)} de año 1 negativo`);
  }
  if (cfClp < 0 && (tol == null || tol === 0)) reasons.push(`Flujo negativo de ${clp(cfClp)}/mes: solo conviene si aceptas aportar ese monto (define tu tolerancia en Configuración → Mi perfil).`);
  return `<div class="section card" id="sec-decision"><h3>Decisión sugerida</h3>
    <div class="decision"><div class="verdict" style="color:var(--${cls === 'warn' ? 'warn' : cls === 'crit' ? 'crit' : 'good'})">${esc(verdict)}</div>
    <ul class="small">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <p class="tiny muted">Recomendación condicionada a los datos y supuestos mostrados. No es asesoría financiera, no garantiza aprobación bancaria ni rentabilidad.</p></div></div>`;
}

// ------------------------------------------------------------------ Excel
handle('ficha-xls', () => {
  const a = current.a, p = current.p, ufv = a.ufValue;
  const resumen = [{ proyecto: p.name, unidad: a.unit.id, comuna: p.commune, precio_uf: a.priceUf, precio_clp: Math.round(a.priceClp), uf_valor: ufv, uf_fecha: a.ufDate,
    dividendo_uf: a.metrics.dividend?.toFixed(2), arriendo_clp: Math.round(a.rentEstimate?.baseClp || 0), fuente_arriendo: a.rentEstimate?.source, flujo_mensual_clp: Math.round(a.metrics.monthlyCf * ufv),
    rent_bruta: a.metrics.grossYield?.toFixed(4), cap_rate: a.metrics.capRate?.toFixed(4), cash_on_cash: a.metrics.cashOnCash?.toFixed(4), dscr: a.metrics.dscr?.toFixed(2),
    tir_real: a.metrics.irrReal?.toFixed(4), riesgo: Math.round(a.risk.total), score: Math.round(a.score), estado: a.gates.passed ? 'verificada' : 'provisional', pendientes: a.gates.fails.join(' | ') }];
  const flujo = a.base.months.slice(0, 60).map((r) => ({ mes: r.t, fase: r.phase, ocupacion: r.occ.toFixed(2), arriendo_uf: r.income.toFixed(2), gc_dueno_uf: r.gcOwner.toFixed(2), dividendo_uf: r.dividend.toFixed(2), flujo_uf: r.cf.toFixed(2), flujo_clp: Math.round(r.cf * ufv) }));
  const proy = a.base.annual.map((r) => ({ anio: r.years, valor_uf: r.value.toFixed(0), deuda_uf: r.balance.toFixed(0), neto_venta_uf: r.saleNet?.toFixed(0), flujo_acum_uf: r.cumCf.toFixed(0), resultado_uf: r.result?.toFixed(0), tir_real: r.irrReal?.toFixed(4) }));
  const esc_ = Object.entries(a.scenarios).map(([k, r]) => ({ escenario: k, arriendo_clp: Math.round(r.input.rentUf * ufv), flujo_mensual_clp: Math.round(r.metrics.monthlyCf * ufv), meses_negativos_24: r.metrics.negativeMonths24, tir_real: r.metrics.irrReal?.toFixed(4) }));
  const comps = (a.rent?.comps || []).map((c) => ({ id: c.id, distancia_m: Math.round(c.distance), precio_clp: c.price_clp, m2: c.useful_m2, fuente: c.source, publicado: c.published_at }));
  const sup = Object.entries(a.input).filter(([, v]) => typeof v !== 'object').map(([k, v]) => ({ supuesto: k, valor: v }));
  download(`atlas_${p.id}_${a.unit.id}.xls`, toExcelHTML([{ name: 'Resumen', rows: resumen }, { name: 'Flujo mensual (60 meses)', rows: flujo }, { name: 'Proyección', rows: proy }, { name: 'Escenarios', rows: esc_ }, { name: 'Comparables', rows: comps }, { name: 'Supuestos', rows: sup }]), 'application/vnd.ms-excel');
});

handle('alert-create', (el) => {
  const p = S.projects.find((x) => x.id === el.dataset.id);
  const rules = LS.get('alerts.rules', []);
  openModal(`<h3>Alerta para ${esc(p.name)}</h3>
    <div class="sim-grid"><label class="field"><span>Avisarme si el precio baja al menos (%)</span><input type="number" id="arPct" value="3"></label>
    <label class="field"><span>…o al menos (UF)</span><input type="number" id="arUf" value="100"></label>
    <label class="check"><input type="checkbox" id="arDel" checked>Cambio de entrega o stock</label>
    <label class="check"><input type="checkbox" id="arDev" checked>Nueva obra a menos de 1 km</label></div>
    <p class="small muted">Las alertas se revisan cada vez que abres la app (contra los datos que publica el repositorio cada lunes). Correo: requiere configurar SMTP en GitHub (ver README).</p>
    <button class="btn primary" data-action="alert-save" data-id="${esc(p.id)}">Guardar alerta</button>`);
  void rules;
});
handle('alert-save', (el) => {
  const rules = LS.get('alerts.rules', []).filter((r) => r.projectId !== el.dataset.id);
  const a = S.analyses.get(el.dataset.id)?.best;
  rules.push({ projectId: el.dataset.id, pct: +document.getElementById('arPct').value || null, uf: +document.getElementById('arUf').value || null,
    delivery: document.getElementById('arDel').checked, devs: document.getElementById('arDev').checked, createdAt: new Date().toISOString(),
    baseline: { priceUf: a?.priceUf ?? S.projects.find((x) => x.id === el.dataset.id)?.price_from_uf ?? null, status: a?.status?.code, deliveryDate: S.projects.find((x) => x.id === el.dataset.id)?.delivery?.date ?? null } });
  LS.set('alerts.rules', rules);
  if (!LS.get('favorites', {})[el.dataset.id]) actions.toggleFavorite(el.dataset.id);
  document.getElementById('modalBack').click();
  toast('Alerta guardada');
});
