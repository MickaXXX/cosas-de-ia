/* Configuración / administración sin tocar código.
 *  - Ajustes locales (este navegador) sobre config/defaults.json, con auditoría
 *    quién/cuándo/antes/después, reversión por cambio y "Restablecer supuestos originales".
 *  - "Publicar para todos": abre un issue atlas-config con la configuración; el workflow
 *    (solo el dueño del repo) la valida y la commitea (git guarda el antes/después).
 *  - Importación CSV con validación en línea, plantillas y publicación al repo.
 *  - Registro de verificaciones hechas con la inmobiliaria. */
import { S, LS, actions, deepMerge, getPath, setPath, uid, projectById } from './core.js';
import { $, handle, toast, openModal, closeModal, openIssue, download } from './ui.js';
import { parseCSV, validateRows, buildProjects, buildRentals, template } from './csv.js';
import { esc, date, clp, pct } from './format.js';

export function effectiveConfig() {
  return deepMerge(S.raw.defaults, LS.get('config.overrides', {}));
}

function who() { return LS.get('admin.name', '') || 'usuario sin nombre'; }

export function setConfigValue(path, value) {
  const before = getPath(effectiveConfig(), path);
  if (JSON.stringify(before) === JSON.stringify(value)) return;
  const ov = LS.get('config.overrides', {});
  setPath(ov, path, value);
  LS.set('config.overrides', ov);
  const audit = LS.get('config.audit', []);
  audit.unshift({ id: uid('a'), who: who(), when: new Date().toISOString(), path, before, after: value });
  LS.set('config.audit', audit.slice(0, 500));
  actions.recompute();
}

function revert(id) {
  const audit = LS.get('config.audit', []);
  const e = audit.find((x) => x.id === id);
  if (!e) return;
  setConfigValue(e.path, e.before);
  toast(`Revertido: ${e.path}`);
}

// ------------------------------------------------------------------ campos
const F = (path, label, kind = 'num', extra = {}) => ({ path, label, kind, ...extra });
const SECTIONS = [
  { id: 'perfil', title: 'Mi perfil de inversionista', help: 'Opcional. Se usa en "Mejores con mi presupuesto", en el Asesor y en la reserva de caja del análisis de riesgo. No se envía a ningún lado.', fields: [
    F('investor.pieAvailableUf', 'Capital disponible para pie + gastos (UF)'), F('investor.reserveUf', 'Reserva de emergencia para el depto (UF)'),
    F('investor.monthlyIncomeClp', 'Ingreso líquido mensual (CLP)', 'num', { step: 10000 }), F('investor.maxNegativeFlowClp', 'Flujo negativo mensual que toleras (CLP, ej. -80000)', 'num', { step: 5000 }),
    F('investor.horizonYears', 'Horizonte de inversión (años)', 'int')] },
  { id: 'fin', title: 'Financiamiento', help: 'Tasa de referencia: promedio BCCh 3,97% (jun-2026) + margen. La CAE no es la tasa del crédito.', fields: [
    F('financing.annualRate', 'Tasa anual del crédito', 'pct', { step: 0.01 }),
    F('financing.rateConvention', 'Convención de tasa', 'select', { options: [['nominal', 'Anual/12 (habitual en Chile)'], ['efectiva', 'Efectiva anual']] }),
    F('financing.loanYears', 'Plazo (años)', 'int'), F('financing.creditPct', 'Financiamiento bancario', 'pct'), F('financing.maxCreditPct', 'Máximo financiable considerado', 'pct'),
    F('financing.incomeRatio', 'Dividendo / renta máx. (regla)', 'pct'), F('financing.desgravamenPctMonthly', 'Seguro desgravamen (% mensual del saldo)', 'pct', { step: 0.001, digits: 4 }),
    F('financing.incendioPctMonthly', 'Seguro incendio y sismo (% mensual)', 'pct', { step: 0.001, digits: 4 }), F('financing.insuredValueFactor', 'Valor asegurado / precio', 'pct'),
    F('financing.pieInstallmentsMax', 'Cuotas máx. del pie (en verde)', 'int'), F('financing.reservaUf', 'Reserva (UF)'),
    F('financing.closing.tasacionUf', 'Tasación (UF)'), F('financing.closing.estudioTitulosUf', 'Estudio de títulos (UF)'), F('financing.closing.borradorUf', 'Borrador/gestoría (UF)'),
    F('financing.closing.notariaUf', 'Notaría (UF)'), F('financing.closing.cbrPct', 'CBR (% del precio)', 'pct', { step: 0.01 }), F('financing.closing.timbresPct', 'Impuesto de timbres (% del crédito)', 'pct', { step: 0.01 })] },
  { id: 'arriendo', title: 'Arriendo tradicional y costos del propietario', fields: [
    F('rentalModel.leaseMonths', 'Duración media del contrato (meses)', 'int'), F('rentalModel.initialVacancyMonths', 'Meses para arrendar tras la entrega'),
    F('rentalModel.turnoverVacancyMonths', 'Meses vacíos entre arrendatarios'), F('rentalModel.brokeragePctOfRent', 'Corretaje por contrato (% de un mes)', 'pct'),
    F('rentalModel.collectionLossPct', 'Incobrabilidad', 'pct'), F('rentalModel.maintenancePctOfRent', 'Mantención (% del arriendo)', 'pct'),
    F('rentalModel.adminPctOfRent', 'Administración (% del arriendo)', 'pct'), F('rentalModel.capexReserveUfMonth', 'Reserva de mejoras (UF/mes)'),
    F('rentalModel.ownerGcShareWhenRented', 'GC que paga el dueño estando arrendado', 'pct'), F('rentalModel.rentTaxPct', 'Impuesto sobre arriendo', 'pct'),
    F('rentalModel.rentRealGrowth', 'Crecimiento real del arriendo (anual)', 'pct', { step: 0.1 }),
    F('contribuciones.exemptClp', 'Contribuciones: monto exento (CLP)', 'num', { step: 1000 }), F('contribuciones.ratePct', 'Contribuciones: tasa', 'pct', { step: 0.001, digits: 3 }),
    F('contribuciones.avaluoFactor', 'Avalúo fiscal / precio (supuesto)', 'pct')] },
  { id: 'valor', title: 'Valorización y horizonte', help: 'Separado del flujo: la plusvalía es proyección, no ganancia observada. Todo en UF (real).', fields: [
    F('valuation.appreciationReal', 'Plusvalía real anual (base)', 'pct', { step: 0.1 }), F('valuation.saleCostPct', 'Costo de vender', 'pct'),
    F('valuation.ufInflation', 'Inflación esperada (para TIR nominal)', 'pct', { step: 0.1 }), F('valuation.discountRateReal', 'Tasa de descuento real (VAN)', 'pct', { step: 0.1 }),
    F('valuation.horizonYears', 'Horizonte de la simulación (años)', 'int')] },
  { id: 'comparables', title: 'Comparables y calidad', fields: [
    F('rentals.radiusM', 'Radio de comparables (m)', 'int'), F('rentals.expandedRadiusM', 'Radio ampliado (m)', 'int'),
    F('rentals.areaTolerance', 'Tolerancia de superficie (±)', 'pct'), F('rentals.minSample', 'Muestra mínima', 'int'),
    F('rentals.areaElasticity', 'Elasticidad arriendo-superficie (referencia comunal)', 'num', { step: 0.05 }),
    F('status.maxVerificationAgeDays', 'Días máx. de una verificación de entrega inmediata', 'int'),
    F('ranking.gates.maxPriceAgeDays', 'Días máx. del precio para ranking real', 'int'), F('ranking.gates.minComps', 'Comparables mínimos para ranking real', 'int'),
    F('infrastructure.nearbyRadiusM', 'Radio para obras cercanas (m)', 'int')] },
  { id: 'airbnb', title: 'Renta corta (Airbnb) — supuestos', help: 'Sin proveedor licenciado (AirDNA): son SUPUESTOS editables, no datos de mercado. Verificar reglamento de copropiedad y SII (IVA).', fields: [
    F('airbnb.adrClp', 'Tarifa diaria promedio (CLP)', 'num', { step: 1000 }), F('airbnb.occupancy', 'Ocupación promedio', 'pct'),
    F('airbnb.avgStayNights', 'Noches por reserva'), F('airbnb.cleaningFeeClp', 'Tarifa de limpieza cobrada (CLP)', 'num', { step: 500 }),
    F('airbnb.cleaningCostClp', 'Costo de limpieza por reserva (CLP)', 'num', { step: 500 }), F('airbnb.suppliesPerNightClp', 'Insumos por noche (CLP)', 'num', { step: 100 }),
    F('airbnb.platformFeePct', 'Comisión plataforma', 'pct'), F('airbnb.cohostPct', 'Administración / co-host', 'pct'),
    F('airbnb.utilitiesClpMonth', 'Luz, agua, gas e internet (CLP/mes)', 'num', { step: 1000 }), F('airbnb.replacementPct', 'Reposición y desgaste', 'pct'),
    F('airbnb.ivaApplies', 'Aplica IVA', 'bool'), F('airbnb.ivaRate', 'Tasa IVA', 'pct'), F('airbnb.furnishingUf', 'Amoblado inicial (UF)')] },
  { id: 'riesgo', title: 'Riesgo y Monte Carlo', help: 'Las probabilidades salen de estas distribuciones supuestas: se rotulan como SIMULADAS.', fields: [
    F('risk.monteCarlo.iterations', 'Iteraciones (ficha)', 'int'), F('risk.monteCarlo.rankingIterations', 'Iteraciones (ranking)', 'int'),
    F('risk.monteCarlo.seed', 'Semilla', 'int'), F('risk.monteCarlo.rentSd', 'Volatilidad del arriendo (σ)', 'pct'), F('risk.monteCarlo.occupancySd', 'Volatilidad de ocupación Airbnb (σ)', 'pct'),
    F('risk.monteCarlo.capexShockProb', 'Prob. anual de reparación imprevista', 'pct'),
    ...['flujo', 'vacancia', 'liquidez', 'entrega', 'costos', 'datos', 'legal', 'estacionalidad'].map((k) => F(`risk.weights.${k}`, `Peso riesgo: ${k}`, 'int'))] },
];

function fieldHTML(fd, cfg) {
  const v = getPath(cfg, fd.path);
  const def = getPath(S.raw.defaults, fd.path);
  const changed = JSON.stringify(v) !== JSON.stringify(def);
  const label = `<span>${esc(fd.label)}${changed ? ` <span class="chip info" data-tip="Original: ${esc(fmtVal(fd, def))}">editado</span>` : ''}</span>`;
  if (fd.kind === 'bool') return `<label class="check"><input type="checkbox" data-cfg="${fd.path}" data-kind="bool" ${v ? 'checked' : ''}>${esc(fd.label)}${changed ? ' <span class="chip info">editado</span>' : ''}</label>`;
  if (fd.kind === 'select') return `<label class="field">${label}<select data-cfg="${fd.path}" data-kind="select">${fd.options.map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const shown = fd.kind === 'pct' ? (v == null ? '' : +(v * 100).toFixed(fd.digits || 2)) : (v ?? '');
  return `<label class="field">${label}<input type="number" step="${fd.step ?? (fd.kind === 'int' ? 1 : 'any')}" data-cfg="${fd.path}" data-kind="${fd.kind}" value="${shown}">${fd.kind === 'pct' ? '<span class="tiny muted">en %</span>' : ''}</label>`;
}
function fmtVal(fd, v) { return fd.kind === 'pct' && typeof v === 'number' ? `${(v * 100).toFixed(fd.digits || 2)}%` : String(v); }

document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset.cfg) return;
  const k = el.dataset.kind;
  let v;
  if (k === 'bool') v = el.checked;
  else if (k === 'select' || k === 'text') v = el.value;
  else {
    const n = parseFloat(String(el.value).replace(',', '.'));
    if (!Number.isFinite(n)) { if (el.value === '' && el.dataset.cfg.startsWith('investor.')) v = null; else return toast('Valor inválido'); }
    else v = k === 'pct' ? n / 100 : k === 'int' ? Math.round(n) : n;
  }
  setConfigValue(el.dataset.cfg, v);
  toast('Guardado en este navegador. Recalculado.');
  renderConfig($('#view-config'));
});

// ------------------------------------------------------------------ vista
export function renderConfig(root) {
  const cfg = S.config;
  const tab = S.adminTab || 'supuestos';
  const tabs = [['supuestos', 'Supuestos'], ['escenarios', 'Escenarios'], ['ranking', 'Ranking'], ['comunas', 'Comunas y seguridad'], ['gc', 'Gastos comunes'], ['importar', 'Importar datos'], ['verificar', 'Verificaciones'], ['auditoria', 'Auditoría y publicación']];
  root.innerHTML = `<div class="wrap">
    <h1 class="page">Configuración</h1>
    <p class="lead">Edita supuestos sin tocar código. Los cambios se guardan en este navegador con registro de quién, cuándo, antes y después. Para que valgan para todos, usa <b>Publicar para todos</b> (crea un issue que solo el dueño del repositorio puede aplicar).</p>
    <div class="row" style="margin-bottom:12px"><label class="field" style="max-width:260px"><span>Tu nombre (para la auditoría)</span><input type="text" id="adminName" value="${esc(LS.get('admin.name', ''))}"></label></div>
    <div class="rank-tabs">${tabs.map(([k, l]) => `<button class="btn sm ${tab === k ? 'on' : ''}" data-action="admin-tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="adminBody">${BODY[tab](cfg)}</div></div>`;
  $('#adminName').addEventListener('change', (e) => LS.set('admin.name', e.target.value.trim()));
}
handle('admin-tab', (el) => { S.adminTab = el.dataset.tab; renderConfig($('#view-config')); });

const BODY = {
  supuestos: (cfg) => SECTIONS.map((s) => `<div class="card"><h3>${esc(s.title)}</h3>${s.help ? `<p class="small muted" style="margin-top:-4px">${esc(s.help)}</p>` : ''}
    <div class="sim-grid">${s.fields.map((f) => fieldHTML(f, cfg)).join('')}</div></div>`).join('')
    + `<div class="card"><h3>Ocupación Airbnb por mes (opcional)</h3><p class="small muted">Vacío = usa la ocupación promedio. Solo con evidencia (proveedor licenciado o historial propio); si no, déjalo vacío.</p>
      <div class="sim-grid">${['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'].map((m, i) => {
      const v = cfg.airbnb.occupancyByMonth?.[i];
      return `<label class="field"><span>${m} (%)</span><input type="number" step="1" data-occ-month="${i}" value="${v == null ? '' : Math.round(v * 100)}"></label>`;
    }).join('')}</div></div>`,
  escenarios: (cfg) => {
    const cols = [['rentFactor', 'Arriendo ×', 1], ['initialVacancyMonths', 'Meses para arrendar', 0], ['turnoverVacancyMonths', 'Meses vacíos entre contratos', 0], ['maintenancePctOfRent', 'Mantención %', 100],
      ['collectionLossPct', 'Incobrable %', 100], ['commonExpensesFactor', 'GC ×', 1], ['appreciationReal', 'Plusvalía real %', 100], ['marketValueFactor', 'Valor reventa ×', 1],
      ['deliveryDelayMonths', 'Atraso entrega (meses)', 0], ['rateBumpIfFuture', 'Alza tasa si es en verde (pp)', 100], ['occupancyFactor', 'Ocupación Airbnb ×', 1], ['adrFactor', 'Tarifa Airbnb ×', 1]];
    return `<div class="card"><h3>Escenarios obligatorios</h3><p class="small muted">Conservador, base, optimista y estrés se aplican a cada unidad. Edita una celda y se recalcula todo.</p>
      <div class="table-scroll"><table class="t"><tr><th>Parámetro</th>${Object.values(cfg.scenarios).map((s) => `<th class="num">${esc(s.label)}</th>`).join('')}</tr>
      ${cols.map(([k, l, mult]) => `<tr><td>${esc(l)}</td>${Object.keys(cfg.scenarios).map((sk) => {
      const v = cfg.scenarios[sk][k];
      return `<td class="num"><input type="number" step="any" style="width:90px" data-scen="${sk}.${k}" data-mult="${mult || 1}" value="${v == null ? '' : +(mult === 100 ? v * 100 : v).toFixed(3)}"></td>`;
    }).join('')}</tr>`).join('')}</table></div></div>`;
  },
  ranking: (cfg) => {
    const prof = cfg.ranking.profiles;
    return `<div class="card"><h3>Perfil activo</h3><div class="seg">${Object.entries(prof).map(([k, p]) => `<button class="${cfg.ranking.profile === k ? 'on' : ''}" data-action="set-profile" data-p="${k}">${esc(p.label)}</button>`).join('')}</div>
      <p class="small muted">También se cambia desde la pestaña Ranking (ahí se ve cómo se mueven las posiciones).</p></div>
      ${Object.entries(prof).map(([k, p]) => `<div class="card"><h3>Pesos del perfil ${esc(p.label)}</h3><div class="weights">${Object.entries(p.weights).map(([w, v]) => `<label class="field"><span>${esc(w)}: <b class="num">${v}</b></span><input type="range" min="0" max="50" step="1" value="${v}" data-weight="${k}.${w}"></label>`).join('')}</div></div>`).join('')}`;
  },
  comunas: (cfg) => {
    const all = [...new Set([...cfg.communes.active, ...cfg.communes.available])];
    const sec = cfg.security.byCommune || {};
    return `<div class="card"><h3>Comunas analizadas</h3><p class="small muted">${esc(cfg.communes.note)}</p>
      <div class="comm-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:4px">${all.map((c) => `<label class="check"><input type="checkbox" data-active-commune="${esc(c)}" ${cfg.communes.active.includes(c) ? 'checked' : ''}>${esc(c)}</label>`).join('')}</div>
      <label class="field" style="margin-top:10px"><span>Agregar comuna</span><input type="text" id="newCommune" placeholder="Ej. La Reina"></label><button class="btn sm" data-action="add-commune" style="margin-top:6px">Agregar</button></div>
      <div class="card"><h3>Microsectores de Santiago Centro</h3><p class="small muted">Solo en comunas marcadas "microsectores": un proyecto fuera de estos círculos queda como provisional. Edita centro [lon, lat], radio y estado. Son propuestas: verificar con datos CEAD y terreno.</p>
      <textarea id="microJson" rows="10">${esc(JSON.stringify(cfg.communes.microsectors, null, 2))}</textarea><button class="btn sm" data-action="save-micro" style="margin-top:6px">Guardar microsectores</button></div>
      <div class="card"><h3>Seguridad por comuna (CEAD / SIED)</h3>
      <p class="small muted">No hay descarga automática. Ingresa la tasa de casos policiales (DMCS) por 100 mil habitantes del portal <a href="https://cead.spd.gov.cl/sala-cead/" target="_blank" rel="noopener">CEAD</a>, su período y la tasa de referencia (promedio regional). Índice = 100 × (1 − tasa / (2 × referencia)), acotado a 0–100: igual a la referencia → 50. Es un dato COMUNAL, no del entorno del inmueble.</p>
      <label class="field" style="max-width:260px"><span>Tasa de referencia (promedio regional)</span><input type="number" id="secRef" value="${esc(cfg.security.referenceRate ?? '')}"></label>
      <div class="table-scroll"><table class="t"><tr><th>Comuna</th><th class="num">Tasa x 100 mil</th><th>Período</th><th>Fuente (URL)</th><th class="num">Índice</th></tr>
      ${cfg.communes.active.map((c) => { const s = sec[c] || {}; return `<tr><td>${esc(c)}</td><td class="num"><input type="number" data-sec="${esc(c)}" data-k="rate" value="${s.rate ?? ''}" style="width:100px"></td>
        <td><input type="text" data-sec="${esc(c)}" data-k="period" value="${esc(s.period || '')}" style="width:100px"></td><td><input type="url" data-sec="${esc(c)}" data-k="url" value="${esc(s.url || '')}"></td>
        <td class="num">${s.index != null ? Math.round(s.index) : '<span class="muted">sin dato</span>'}</td></tr>`; }).join('')}</table></div>
      <button class="btn sm primary" data-action="save-security" style="margin-top:8px">Guardar seguridad</button></div>`;
  },
  gc: (cfg) => `<div class="card"><h3>Bandas de gasto común (CLP por m² útil)</h3><p class="small muted">${esc(cfg.commonExpenses._bandsNote || '')}</p>
    <div class="table-scroll"><table class="t"><tr><th>Comuna</th><th class="num">Bajo</th><th class="num">Base</th><th class="num">Alto</th><th>Fuente</th></tr>
    ${Object.entries({ ...cfg.commonExpenses.bandsByCommune, '(por defecto)': cfg.commonExpenses.defaultBand }).map(([c, b]) => `<tr><td>${esc(c)}</td>${['low', 'base', 'high'].map((k) => `<td class="num"><input type="number" style="width:90px" data-gc="${esc(c)}" data-k="${k}" value="${b[k]}"></td>`).join('')}<td class="small muted">${esc(b.source || '')}</td></tr>`).join('')}
    </table></div>
    <h4>Ajuste por amenities (sobre la banda)</h4><div class="sim-grid">${Object.entries(cfg.commonExpenses.amenityAdjust).map(([k, v]) => `<label class="field"><span>${esc(k)} (%)</span><input type="number" step="1" data-amen="${esc(k)}" value="${Math.round(v * 100)}"></label>`).join('')}</div></div>`,
  importar: () => importHTML(),
  verificar: () => verifyListHTML(),
  auditoria: (cfg) => {
    const audit = LS.get('config.audit', []);
    const ov = LS.get('config.overrides', {});
    return `<div class="card"><h3>Publicar para todos</h3>
      <p class="small">Tus ajustes viven en este navegador. Para dejarlos como predeterminados del repositorio: abre el issue (debes ser el dueño del repo y estar con sesión en GitHub). El workflow valida que las claves existan y sean del tipo correcto, hace commit y comenta el resultado; el historial de git guarda el antes/después y se puede revertir.</p>
      <div class="row"><button class="btn primary" data-action="publish-config" ${Object.keys(ov).length ? '' : 'disabled'}>Publicar ${Object.keys(ov).length} sección(es) editada(s)</button>
      <button class="btn" data-action="export-config">Descargar configuración efectiva (JSON)</button>
      <button class="btn" data-action="reset-config">Restablecer supuestos originales</button></div></div>
      <div class="card"><h3>Registro de cambios (este navegador)</h3>
      ${audit.length ? `<div class="table-scroll"><table class="t"><tr><th>Cuándo</th><th>Quién</th><th>Parámetro</th><th>Antes</th><th>Después</th><th></th></tr>
      ${audit.map((e) => `<tr><td class="nowrap">${date(e.when, { time: true })}</td><td>${esc(e.who)}</td><td class="mono small">${esc(e.path)}</td><td class="mono small">${esc(JSON.stringify(e.before))}</td><td class="mono small">${esc(JSON.stringify(e.after))}</td><td><button class="btn sm" data-action="revert" data-id="${e.id}">Revertir</button></td></tr>`).join('')}</table></div>` : '<div class="empty">Sin cambios todavía.</div>'}</div>
      <div class="card"><h3>Ejecutar actualización ahora</h3><p class="small">Pide al repositorio que corra UF, capas OSM, geocodificación, radar y validación (issue "atlas-actualizar:"). También: <a href="https://github.com/MickaXXX/cosas-de-ia/actions/workflows/atlas-data.yml" target="_blank" rel="noopener">Actions → Atlas · actualizar datos → Run workflow</a>.</p>
      <button class="btn" data-action="run-update">Ejecutar actualización ahora</button></div>`;
  },
};

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.occMonth != null) {
    const arr = [...(S.config.airbnb.occupancyByMonth || Array(12).fill(null))];
    arr[+el.dataset.occMonth] = el.value === '' ? null : Math.max(0, Math.min(100, +el.value)) / 100;
    setConfigValue('airbnb.occupancyByMonth', arr);
  } else if (el.dataset.scen) {
    const n = parseFloat(el.value);
    if (!Number.isFinite(n)) return;
    setConfigValue(`scenarios.${el.dataset.scen}`, +el.dataset.mult === 100 ? n / 100 : n);
    toast('Escenario actualizado');
  } else if (el.dataset.weight) {
    setConfigValue(`ranking.profiles.${el.dataset.weight.split('.')[0]}.weights.${el.dataset.weight.split('.')[1]}`, +el.value);
    renderConfig($('#view-config'));
  } else if (el.dataset.activeCommune) {
    const c = el.dataset.activeCommune;
    const act = S.config.communes.active;
    setConfigValue('communes.active', el.checked ? [...new Set([...act, c])] : act.filter((x) => x !== c));
    if (S.filters) S.filters.communes = el.checked ? [...new Set([...S.filters.communes, c])] : S.filters.communes.filter((x) => x !== c);
    actions.recompute();
  } else if (el.dataset.gc) {
    const c = el.dataset.gc, k = el.dataset.k, v = +el.value;
    if (c === '(por defecto)') setConfigValue(`commonExpenses.defaultBand.${k}`, v);
    else setConfigValue(`commonExpenses.bandsByCommune.${c}`, { ...(S.config.commonExpenses.bandsByCommune[c] || {}), [k]: v, source: 'editado por el usuario' });
  } else if (el.dataset.amen) {
    setConfigValue(`commonExpenses.amenityAdjust.${el.dataset.amen}`, (+el.value || 0) / 100);
  }
});

handle('set-profile', (el) => { setConfigValue('ranking.profile', el.dataset.p); renderConfig($('#view-config')); });
handle('add-commune', () => {
  const c = $('#newCommune').value.trim();
  if (!c) return;
  setConfigValue('communes.available', [...new Set([...S.config.communes.available, c])]);
  renderConfig($('#view-config'));
});
handle('save-micro', () => {
  try {
    const v = JSON.parse($('#microJson').value);
    if (!Array.isArray(v) || !v.every((m) => Array.isArray(m.center) && m.center.length === 2 && m.radius_m > 0 && m.commune)) throw new Error('cada microsector necesita commune, center [lon, lat] y radius_m');
    setConfigValue('communes.microsectors', v);
    toast('Microsectores guardados');
  } catch (e) { toast(`JSON inválido: ${e.message}`); }
});
handle('save-security', () => {
  const ref = parseFloat($('#secRef').value);
  const by = structuredClone(S.config.security.byCommune || {});
  document.querySelectorAll('[data-sec]').forEach((el) => {
    const c = el.dataset.sec, k = el.dataset.k;
    by[c] = by[c] || {};
    by[c][k] = k === 'rate' ? (el.value === '' ? null : +el.value) : el.value;
  });
  for (const [c, s] of Object.entries(by)) {
    s.index = s.rate != null && ref > 0 ? Math.max(0, Math.min(100, 100 * (1 - s.rate / (2 * ref)))) : null;
    s.source = 'CEAD (ingresado por el usuario)';
    if (s.rate == null) delete by[c];
  }
  if (Number.isFinite(ref)) setConfigValue('security.referenceRate', ref);
  setConfigValue('security.byCommune', by);
  renderConfig($('#view-config'));
  toast('Seguridad guardada: el componente "seguridad y servicios" ya la usa.');
});
handle('revert', (el) => { revert(el.dataset.id); renderConfig($('#view-config')); });
handle('reset-config', () => {
  if (!confirm('¿Restablecer todos los supuestos originales? Se borran tus ajustes locales (el registro se conserva).')) return;
  const audit = LS.get('config.audit', []);
  audit.unshift({ id: uid('a'), who: who(), when: new Date().toISOString(), path: '(todo)', before: LS.get('config.overrides', {}), after: '(originales)' });
  LS.set('config.audit', audit);
  LS.set('config.overrides', {});
  actions.recompute();
  renderConfig($('#view-config'));
  toast('Supuestos originales restablecidos');
});
handle('export-config', () => download('atlas-config.json', JSON.stringify(effectiveConfig(), null, 2), 'application/json'));
handle('publish-config', () => {
  const ov = LS.get('config.overrides', {});
  const eff = effectiveConfig();
  const payload = Object.fromEntries(Object.keys(ov).filter((k) => k in S.raw.defaults).map((k) => [k, eff[k]]));
  openIssue(`atlas-config: ${who()} ${new Date().toISOString().slice(0, 10)}`,
    `Configuración publicada desde la app (secciones: ${Object.keys(payload).join(', ')}).\n\n\`\`\`json\n${JSON.stringify(payload, null, 1)}\n\`\`\``);
});
handle('run-update', () => openIssue('atlas-actualizar: ahora', 'Pedido desde la app: correr UF, capas OSM, geocodificación, radar y validación.'));

// ------------------------------------------------------------------ importación CSV
function importHTML() {
  const lp = LS.get('local.projects', []), lr = LS.get('local.rentals', []);
  const log = S.raw.importLog?.imports || [];
  return `<div class="card"><h3>Importar proyectos o avisos de arriendo (CSV)</h3>
    <p class="small">Columnas según el Anexo B (proyectos) y el esquema de avisos. Se valida antes de guardar: errores por fila y columna. Fuentes permitidas: archivos de la inmobiliaria, tu propio levantamiento, exportaciones de plataformas a las que tienes acceso legítimo (p. ej. tu cuenta de GoodProp). No uses scraping que viole términos de uso.</p>
    <div class="row"><button class="btn sm" data-action="tpl" data-kind="projects">Plantilla de proyectos (CSV)</button><button class="btn sm" data-action="tpl" data-kind="rentals">Plantilla de avisos (CSV)</button></div>
    <div class="row" style="margin-top:10px"><select id="impKind"><option value="projects">Proyectos y unidades</option><option value="rentals">Avisos de arriendo</option></select>
    <input type="file" id="impFile" accept=".csv,text/csv"><span class="small muted">o pega el CSV:</span></div>
    <textarea id="impText" placeholder="project_id,project_name,commune,unit_id,bedrooms,useful_area_m2,data_observed_at,…"></textarea>
    <div class="row" style="margin-top:6px"><button class="btn primary" data-action="imp-validate">Validar</button></div>
    <div id="impResult"></div></div>
    <div class="card"><h3>Datos importados en este navegador</h3>
    <p class="small">${lp.length} proyectos · ${lr.length} avisos. ${lp.length || lr.length ? '<button class="btn sm" data-action="imp-clear">Borrar importaciones locales</button>' : ''}</p>
    ${lp.map((p) => `<div class="small">• ${esc(p.name)} (${esc(p.commune)}) — ${p.units.length} unidades · <a href="#" data-action="open-project" data-id="${esc(p.id)}">ver</a></div>`).join('')}</div>
    <div class="card"><h3>Importaciones publicadas en el repositorio</h3>${log.length ? `<table class="t"><tr><th>Cuándo</th><th>Quién</th><th>Tipo</th><th>Estado</th><th class="num">Filas</th></tr>${log.slice(0, 20).map((l) => `<tr><td>${date(l.at, { time: true })}</td><td>${esc(l.actor)}</td><td>${esc(l.kind)}</td><td>${esc(l.status)}</td><td class="num">${l.rows}</td></tr>`).join('')}</table>` : '<div class="muted small">Ninguna todavía.</div>'}</div>`;
}

handle('tpl', (el) => {
  const kind = el.dataset.kind;
  const ex = kind === 'projects'
    ? { project_id: 'demo-ejemplo', project_name: 'DEMO Proyecto Ejemplo', developer_name: 'Inmobiliaria Ejemplo', address: 'Av. Ejemplo 123', commune: 'Ñuñoa', unit_id: '101', unit_type: '1D1B', bedrooms: 1, bathrooms: 1, useful_area_m2: '38,5', list_price_uf: '3.250', offer_price_uf: '3.150', bono_pie_pct: 10, delivery_date: '2027-06', delivery_date_status: 'estimada', immediate_delivery_verified: 'no', available_stock_verified: 'si', publication_url: 'https://example.com', data_observed_at: '2026-10-12', evidence_notes: 'Fila de ejemplo: borrar', is_demo: 'si' }
    : { listing_id: 'demo-aviso-1', source: 'Levantamiento propio', commune: 'Ñuñoa', latitude: '-33.4569', longitude: '-70.5978', price_clp: '450.000', bedrooms: 1, bathrooms: 1, useful_area_m2: 38, furnished: 'no', observed_at: '2026-10-12', notes: 'Fila de ejemplo: borrar', is_demo: 'si' };
  download(`plantilla_${kind}.csv`, `﻿${template(S.raw.schema[kind], ex)}`, 'text/csv;charset=utf-8');
});

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'impFile') return;
  const f = e.target.files[0];
  if (!f) return;
  if (/\.xlsx?$/i.test(f.name)) return toast('Para XLSX: guárdalo como CSV en Excel o usa scripts/atlas/import_data.py (lee XLSX con openpyxl).', 6000);
  $('#impText').value = await f.text();
});

let pending = null;
handle('imp-validate', () => {
  const kind = $('#impKind').value;
  const rows = parseCSV($('#impText').value || '');
  if (!rows.length) return toast('No hay filas');
  const { records, errors, unknown } = validateRows(rows, S.raw.schema[kind]);
  const now = new Date().toISOString();
  pending = errors.length ? null : { kind, records, csv: $('#impText').value };
  const preview = kind === 'projects' ? buildProjects(records, now) : buildRentals(records, now);
  $('#impResult').innerHTML = `<h4>Resultado: ${rows.length} filas · ${errors.length} errores</h4>
    ${unknown.length ? `<div class="note warn small">Columnas que no están en el esquema y se ignoran: ${esc(unknown.join(', '))}</div>` : ''}
    ${errors.length ? `<div class="table-scroll"><table class="t"><tr><th>Fila</th><th>Columna</th><th>Valor</th><th>Problema</th></tr>${errors.slice(0, 200).map((er) => `<tr><td>${er.line}</td><td class="mono">${esc(er.column)}</td><td class="mono">${esc(er.value ?? '')}</td><td>${esc(er.message)}</td></tr>`).join('')}</table></div>
      <div class="note crit small">Corrige el archivo: no se importa nada si hay errores.</div>`
    : `<div class="note good small">Todo válido: ${kind === 'projects' ? `${preview.length} proyectos, ${records.length} unidades` : `${preview.length} avisos`}.</div>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-action="imp-save">Guardar en este navegador</button><button class="btn" data-action="imp-publish">Publicar en el repositorio (issue)</button></div>`}`;
});

handle('imp-save', () => {
  if (!pending) return;
  const now = new Date().toISOString();
  if (pending.kind === 'projects') {
    const cur = LS.get('local.projects', []).filter((p) => !pending.records.some((r) => r.project_id === p.id));
    const fresh = buildProjects(pending.records, now);
    for (const p of fresh) if (p.lat == null) p.geo_note = 'Sin coordenadas: se geocodifica al publicar en el repositorio, o agrega latitude/longitude.';
    LS.set('local.projects', [...cur, ...fresh]);
  } else {
    const cur = LS.get('local.rentals', []);
    const fresh = buildRentals(pending.records, now);
    const ids = new Set(fresh.map((r) => r.id));
    LS.set('local.rentals', [...cur.filter((r) => !ids.has(r.id)), ...fresh]);
  }
  actions.recompute();
  renderConfig($('#view-config'));
  toast('Importado en este navegador.');
});
handle('imp-publish', () => {
  if (!pending) return;
  openIssue(`atlas-import: ${pending.kind === 'projects' ? 'proyectos' : 'arriendos'} ${new Date().toISOString().slice(0, 10)}`,
    `Importación desde la app (${pending.records.length} filas). El workflow valida con el mismo esquema, geocodifica y publica.\n\n\`\`\`csv\n${pending.csv.trim()}\n\`\`\``);
});
handle('imp-clear', () => { LS.set('local.projects', []); LS.set('local.rentals', []); actions.recompute(); renderConfig($('#view-config')); });

// ------------------------------------------------------------------ verificaciones con la inmobiliaria
function verifyListHTML() {
  const v = LS.get('verifications', {});
  const entries = Object.entries(v);
  return `<div class="card"><h3>Verificaciones registradas</h3><p class="small">Cuando confirmas con la inmobiliaria (entrega, stock, precio de una unidad concreta), el proyecto deja de ser gris/provisional. Se registran desde el botón <b>Registrar verificación</b> de cada ficha.</p>
    ${entries.length ? `<table class="t"><tr><th>Proyecto</th><th>Fecha</th><th>Quién</th><th>Entrega inmediata</th><th>Stock</th><th>Unidad</th><th></th></tr>
    ${entries.map(([id, x]) => `<tr><td>${esc(projectById(id)?.name || id)}</td><td>${date(x.at)}</td><td>${esc(x.by || '')}</td><td>${x.immediate ? 'sí' : 'no'}</td><td>${x.stock ? 'sí' : 'no'}</td><td>${x.unit ? `${esc(x.unit.type || '')} ${x.unit.useful_m2} m² · UF ${x.unit.offer_price_uf || x.unit.list_price_uf}` : '–'}</td>
    <td><button class="btn sm" data-action="verif-publish" data-id="${esc(id)}">Publicar</button> <button class="btn sm" data-action="verif-del" data-id="${esc(id)}">Borrar</button></td></tr>`).join('')}</table>` : '<div class="empty">Ninguna todavía.</div>'}</div>`;
}

export function openVerifyForm(projectId) {
  const p = projectById(projectId);
  if (!p) return;
  const prev = LS.get('verifications', {})[projectId] || {};
  const u = prev.unit || {};
  openModal(`<h3>Registrar verificación — ${esc(p.name)}</h3>
    <p class="small">Lo que confirmaste directamente con la inmobiliaria (correo, cotización, visita). Queda con tu nombre y fecha y sube la confianza del análisis.</p>
    <div class="sim-grid">
      <label class="field"><span>Fecha de verificación</span><input type="date" id="vAt" value="${prev.at || new Date().toISOString().slice(0, 10)}"></label>
      <label class="check"><input type="checkbox" id="vImm" ${prev.immediate ? 'checked' : ''}>Entrega inmediata / recepción final</label>
      <label class="check"><input type="checkbox" id="vStock" ${prev.stock ? 'checked' : ''}>Stock disponible confirmado</label>
      <label class="field"><span>Fecha de entrega confirmada (si es futura)</span><input type="text" id="vDate" placeholder="AAAA-MM" value="${esc(prev.deliveryDate || '')}"></label>
    </div>
    <h4>Unidad cotizada</h4>
    <div class="sim-grid">
      <label class="field"><span>Id/número</span><input type="text" id="vUid" value="${esc(u.id || '')}"></label>
      <label class="field"><span>Tipología</span><input type="text" id="vType" value="${esc(u.type || '')}" placeholder="1D1B"></label>
      <label class="field"><span>Dormitorios</span><input type="number" id="vBed" value="${u.bedrooms ?? ''}"></label>
      <label class="field"><span>m² útiles</span><input type="number" step="0.01" id="vM2" value="${u.useful_m2 ?? ''}"></label>
      <label class="field"><span>Precio UF</span><input type="number" step="0.01" id="vPrice" value="${u.offer_price_uf ?? u.list_price_uf ?? ''}"></label>
      <label class="field"><span>Bono pie %</span><input type="number" step="0.1" id="vBono" value="${u.bono_pie_pct ?? ''}"></label>
      <label class="field"><span>Gasto común informado (CLP)</span><input type="number" id="vGc" value="${prev.commonExpensesClp ?? ''}"></label>
      <label class="field"><span>Renta corta según reglamento</span><select id="vStr"><option value="">(sin cambios)</option>${['permitido_verificado', 'no_permitido_verificado', 'condicionado', 'por_verificar'].map((s) => `<option ${prev.strStatus === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    </div>
    ${p.lat == null ? `<h4>Ubicación</h4><div class="sim-grid"><label class="field"><span>Dirección</span><input type="text" id="vAddr" value="${esc(prev.address || '')}"></label><label class="field"><span>Latitud</span><input type="number" step="any" id="vLat" value="${prev.lat ?? ''}"></label><label class="field"><span>Longitud</span><input type="number" step="any" id="vLon" value="${prev.lon ?? ''}"></label></div>` : ''}
    <label class="field"><span>Enlace o referencia del respaldo</span><input type="url" id="vUrl" value="${esc(prev.url || '')}"></label>
    <label class="field"><span>Notas</span><input type="text" id="vNotes" value="${esc(prev.notes || '')}"></label>
    <div class="row" style="margin-top:10px"><button class="btn primary" data-action="verif-save" data-id="${esc(projectId)}">Guardar verificación</button></div>`);
}
handle('verif-save', (el) => {
  const id = el.dataset.id;
  const g = (s) => document.getElementById(s)?.value?.trim();
  const unit = g('vM2') && g('vPrice') ? { id: g('vUid') || 'verificada', type: g('vType') || null, bedrooms: +(g('vBed') || 1), bathrooms: null,
    useful_m2: +g('vM2'), offer_price_uf: +g('vPrice'), list_price_uf: +g('vPrice'), bono_pie_pct: g('vBono') ? +g('vBono') : 0, available: document.getElementById('vStock').checked } : null;
  const v = { at: g('vAt'), by: LS.get('admin.name', '') || 'usuario', immediate: document.getElementById('vImm').checked, stock: document.getElementById('vStock').checked,
    deliveryDate: g('vDate') || null, unit, commonExpensesClp: g('vGc') ? +g('vGc') : null, strStatus: g('vStr') || null, url: g('vUrl') || null, notes: g('vNotes') || null,
    address: g('vAddr') || null, lat: g('vLat') ? +g('vLat') : null, lon: g('vLon') ? +g('vLon') : null };
  if (v.immediate && v.deliveryDate) return toast('Entrega inmediata y fecha futura a la vez: elige una.');
  const all = LS.get('verifications', {});
  all[id] = v;
  LS.set('verifications', all);
  closeModal();
  actions.recompute();
  actions.openProject(id);
  toast('Verificación guardada (en este navegador). Publícala desde Configuración → Verificaciones.');
});
handle('verif-del', (el) => { const all = LS.get('verifications', {}); delete all[el.dataset.id]; LS.set('verifications', all); actions.recompute(); renderConfig($('#view-config')); });
handle('verif-publish', (el) => {
  const id = el.dataset.id, x = LS.get('verifications', {})[id], p = projectById(id);
  if (!x?.unit) return toast('Para publicar hace falta la unidad cotizada (m² y precio).');
  const cols = ['project_id', 'project_name', 'developer_name', 'address', 'commune', 'latitude', 'longitude', 'unit_id', 'unit_type', 'bedrooms', 'useful_area_m2', 'offer_price_uf', 'bono_pie_pct', 'common_expenses_clp', 'delivery_date', 'delivery_date_status', 'immediate_delivery_verified', 'available_stock_verified', 'short_term_rental_status', 'publication_url', 'data_observed_at', 'evidence_notes'];
  const row = [p.id, p.name, p.developer?.name || '', x.address || p.address || '', p.commune, x.lat ?? p.lat ?? '', x.lon ?? p.lon ?? '', x.unit.id, x.unit.type || '', x.unit.bedrooms, x.unit.useful_m2, x.unit.offer_price_uf, x.unit.bono_pie_pct || '', x.commonExpensesClp || '',
    x.deliveryDate || '', x.deliveryDate ? 'confirmada' : '', x.immediate ? 'si' : 'no', x.stock ? 'si' : 'no', x.strStatus || '', x.url || p.publication_url || '', x.at, `Verificado por ${x.by}. ${x.notes || ''}`.trim()];
  const q = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : s);
  openIssue(`atlas-import: proyectos verificación ${p.name}`, `Verificación con la inmobiliaria registrada en la app.\n\n\`\`\`csv\n${cols.join(',')}\n${row.map(q).join(',')}\n\`\`\``);
});
export { pct, clp };
