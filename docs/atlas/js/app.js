/* Atlas Inversión Santiago — arranque, datos, filtros, mapa y navegación.
 * Las vistas viven en sus propios módulos y se comunican vía core.js (S, actions). */
import { S, LS, actions, deepMerge, projectById, analysisOf, on, emit } from './core.js';
import { $, $$, handle, toast, openModal, closeModal } from './ui.js';
import * as M from './map.js';
import { buildContext, analyzeProject, unitPrice, devGeometry, hypotheticalUnit } from './analysis.js';
import { STATUS } from './status.js';
import { circlePolygon, pointInGeometry, haversine } from './geo.js';
import { clp, uf, pct, meters, date, esc, todaySantiago } from './format.js';
import { renderFicha, closeFicha } from './ficha.js';
import { renderRanking } from './ranking.js';
import { renderComparador, renderSimulador, renderRadar, renderAlertas, renderFavoritos, renderFuentes } from './views.js';
import { renderConfig, effectiveConfig } from './admin.js';
import { renderAsesor } from './advisor.js';

const DATA = 'data/';
const VIEWS = { ranking: renderRanking, comparador: renderComparador, simulador: renderSimulador, radar: renderRadar,
  alertas: renderAlertas, favoritos: renderFavoritos, asesor: renderAsesor, fuentes: renderFuentes, config: renderConfig };

async function getJSON(path, def = null) {
  try {
    const r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch { return def; }
}

// ------------------------------------------------------------------ carga
async function loadAll() {
  const fc = { type: 'FeatureCollection', features: [] };
  const [defaults, schema, projects, rentals, refs, devs, radar, ufData, market, health, changes, jobs, importLog,
    lines, stations, future, pois, communes, osmMeta] = await Promise.all([
    getJSON('config/defaults.json'), getJSON('config/import_schema.json'),
    getJSON(`${DATA}projects.json`, { projects: [] }), getJSON(`${DATA}rentals.json`, { listings: [] }),
    getJSON(`${DATA}rent_reference.json`, { references: [] }), getJSON(`${DATA}developments.json`, { developments: [] }),
    getJSON(`${DATA}radar_candidates.json`, null), getJSON(`${DATA}uf.json`, null), getJSON(`${DATA}market.json`, {}),
    getJSON(`${DATA}health.json`, null), getJSON(`${DATA}changes.json`, { events: [] }), getJSON(`${DATA}jobs.json`, {}),
    getJSON(`${DATA}import_log.json`, { imports: [] }),
    getJSON(`${DATA}osm/metro_lines.geojson`, fc), getJSON(`${DATA}osm/metro_stations.geojson`, fc),
    getJSON(`${DATA}osm/metro_future.geojson`, fc), getJSON(`${DATA}osm/pois.geojson`, fc),
    getJSON(`${DATA}osm/communes.geojson`, fc), getJSON(`${DATA}osm/meta.json`, {}),
  ]);
  if (!defaults) throw new Error('No se pudo leer config/defaults.json');
  let ufv = ufData;
  if (!ufv?.value && market?.uf_fallback) {
    ufv = { ...market.uf_fallback, status: 'respaldo', source: `${market.uf_fallback.source_name} (respaldo: falta data/uf.json)` };
  }
  // La UF "de hoy": si la serie trae el valor del día (el BCCh publica por adelantado), se usa.
  if (ufv?.series?.length) {
    const t = todaySantiago();
    const hit = ufv.series.filter((x) => x.date <= t).at(-1);
    if (hit && hit.date > (ufv.date || '')) ufv = { ...ufv, value: hit.value, date: hit.date };
  }
  S.raw = { defaults, schema, projects: projects.projects || [], rentals: rentals.listings || [], references: refs.references || [],
    developments: devs.developments || [], radar, uf: ufv, market, health, changes, jobs, importLog,
    osm: { lines: lines.features, stations: stations.features, future: future.features, pois: pois.features, communes: communes.features, meta: osmMeta } };
}

async function loadDemo() {
  if (!S.raw.demo) S.raw.demo = await getJSON(`${DATA}demo.json`, { projects: [], listings: [] });
}

// ------------------------------------------------------------------ proyectos efectivos
function applyVerification(p, v) {
  if (!v) return p;
  const q = structuredClone(p);
  q.delivery = { ...(q.delivery || {}) };
  if (v.immediate != null) q.delivery.immediate_verified = !!v.immediate;
  if (v.stock != null) q.delivery.stock_verified = !!v.stock;
  if (v.deliveryDate) { q.delivery.date = v.deliveryDate; q.delivery.date_status = 'confirmada'; q.delivery.status = 'futura'; }
  if (v.immediate) q.delivery.status = 'inmediata';
  q.delivery.verified_at = v.at;
  q.observed_at = v.at;
  if (v.unit) q.units = [...(q.units || []).filter((u) => u.id !== v.unit.id), v.unit];
  if (v.commonExpensesClp) q.common_expenses_clp = v.commonExpensesClp;
  if (v.strStatus) q.short_term_rental = { ...(q.short_term_rental || {}), status: v.strStatus };
  if (v.pieInstallmentsMax != null) {
    q.payment_terms = { pie_installments_max: v.pieInstallmentsMax, pie_post_delivery: !!v.piePostDelivery, pie_min_upfront_pct: v.pieMinUpfrontPct ?? null,
      source_name: `Verificación de ${v.by || 'usuario'} con la inmobiliaria`, source_url: v.url || null, observed_at: v.at, verification_status: 'verificado' };
  }
  if (v.address && v.lat != null) { q.address = v.address; q.lat = v.lat; q.lon = v.lon; q.geo_precision = 'exacta'; q.geo_review = false; }
  q.evidence = [{ field: 'verificacion', source_name: `Verificación de ${v.by || 'usuario'} con la inmobiliaria`, source_url: v.url || q.publication_url,
    observed_at: v.at, access_method: 'verificacion_manual', confidence: 'alta', verification_status: 'verificado', notes: v.notes }, ...(q.evidence || [])];
  q.verified_locally = true;
  return q;
}

export function buildProjects() {
  const verif = LS.get('verifications', {});
  const local = LS.get('local.projects', []);
  const byId = new Map();
  for (const p of S.raw.projects) byId.set(p.id, p);
  for (const p of local) byId.set(p.id, p);
  if (S.demo) for (const p of S.raw.demo?.projects || []) byId.set(p.id, p);
  const includeHypo = S.filters?.includeHypo ?? true;
  S.projects = [...byId.values()].map((p) => {
    let q = applyVerification(p, verif[p.id]);
    if (includeHypo && !(q.units || []).length) {
      const h = hypotheticalUnit(q, S.config);
      if (h) q = { ...q, units: [h], hypothetical_units: true };
    }
    return q;
  });
}

function rentalsPool() {
  return [...S.raw.rentals, ...LS.get('local.rentals', []), ...(S.demo ? S.raw.demo?.listings || [] : [])];
}

export function recompute() {
  S.config = effectiveConfig();
  buildProjects();
  const ctx = buildContext({
    projects: S.projects, rentals: rentalsPool(), references: S.raw.references, stations: S.raw.osm.stations,
    metroLines: S.raw.osm.lines, pois: S.raw.osm.pois,
    developments: S.raw.developments.filter((d) => devGeometry(d)), communesGeo: S.raw.osm.communes, config: S.config, uf: S.raw.uf,
  });
  S.ctx = ctx;
  S.analyses = new Map();
  const t0 = performance.now();
  for (const p of S.projects) S.analyses.set(p.id, analyzeProject(p, ctx));
  S.lastComputeMs = performance.now() - t0;
  emit('recomputed');
}

// ------------------------------------------------------------------ filtros
function defaultFilters() {
  return {
    communes: [...S.config.communes.active], priceMin: null, priceMax: null, ufm2Max: null, m2Min: null, m2Max: null,
    bedrooms: [], status: Object.keys(STATUS), metroMax: null, grossYieldMin: null, cfMin: null, dividendMax: null,
    pieMax: null, riskMax: null, evidenceMin: null, onlyStock: false, onlyMicro: false, developer: '', includeHypo: true,
    strVerified: false, onlyAnalyzable: false, planReachable: false, pieCuotas: false,
  };
}

function metricFiltersActive(f) {
  return ['grossYieldMin', 'cfMin', 'dividendMax', 'pieMax', 'riskMax', 'evidenceMin', 'metroMax'].some((k) => f[k] != null && f[k] !== '');
}

/** ¿Pasa el proyecto los filtros? Devuelve la mejor unidad que pasa (o true si no tiene unidades). */
export function passes(p) {
  const f = S.filters;
  if (!f.communes.includes(p.commune)) return false;
  if (S.drawPolygon && !(p.lat != null && pointInGeometry([p.lon, p.lat], S.drawPolygon))) return false;
  if (f.developer && !(p.developer?.name || '').toLowerCase().includes(f.developer.toLowerCase())) return false;
  const an = S.analyses.get(p.id);
  const st = an?.best?.status?.code || 'gris';
  if (!f.status.includes(st)) return false;
  if (f.onlyStock && !p.delivery?.stock_verified) return false;
  if (f.onlyMicro && an?.best?.needsMicrosector && !an.best.microsector) return false;
  if (f.strVerified && p.short_term_rental?.status !== 'permitido_verificado') return false;
  const units = an?.units || [];
  if (!units.length) {
    if (f.onlyAnalyzable || metricFiltersActive(f) || f.bedrooms.length || f.planReachable || f.pieCuotas) return false;
    const pr = p.price_from_uf;
    if (f.priceMin && (!pr || pr < f.priceMin)) return false;
    if (f.priceMax && (!pr || pr > f.priceMax)) return false;
    return true;
  }
  return units.find((a) => unitPasses(a, f)) || false;
}

function unitPasses(a, f) {
  const u = a.unit, m = a.metrics, ufv = S.raw.uf?.value;
  if (f.priceMin && a.priceUf < f.priceMin) return false;
  if (f.priceMax && a.priceUf > f.priceMax) return false;
  if (f.ufm2Max && a.pricePerM2Uf > f.ufm2Max) return false;
  if (f.m2Min && u.useful_m2 < f.m2Min) return false;
  if (f.m2Max && u.useful_m2 > f.m2Max) return false;
  if (f.bedrooms.length && !f.bedrooms.includes(Math.min(3, u.bedrooms))) return false;
  if (f.metroMax && !(a.metro && a.metro.distance <= f.metroMax)) return false;
  if (f.grossYieldMin && !(m.grossYield * 100 >= f.grossYieldMin)) return false;
  if (f.cfMin != null && f.cfMin !== '' && !(m.monthlyCf * ufv >= f.cfMin)) return false;
  if (f.dividendMax && !(m.dividend * ufv <= f.dividendMax)) return false;
  if (f.pieMax && !(a.structure.equity <= f.pieMax)) return false;
  if (f.riskMax && !(a.risk.total <= f.riskMax)) return false;
  if (f.evidenceMin && !(a.evidence.score >= f.evidenceMin)) return false;
  if (f.planReachable && !(a.plan && a.plan.status !== 'no_alcanzable')) return false;
  if (f.pieCuotas && !(a.terms?.source === 'publicado' && a.terms.installmentsMax > 0)) return false;
  return true;
}

export function visibleProjects() {
  return S.projects.filter((p) => passes(p));
}

function saveFilters() { LS.set('filters', { ...S.filters }); }

function num(v) { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }

function renderFilters() {
  const f = S.filters, cfg = S.config;
  const allCommunes = [...cfg.communes.active, ...cfg.communes.available.filter((c) => !cfg.communes.active.includes(c))];
  const counts = {};
  for (const p of S.projects) counts[p.commune] = (counts[p.commune] || 0) + 1;
  const inp = (key, ph, step = 'any') => `<input type="number" step="${step}" data-filter="${key}" value="${f[key] ?? ''}" placeholder="${ph}">`;
  $('#filters').innerHTML = `
    <div class="row between"><h2>Filtros</h2><div class="row"><button class="btn sm ghost" data-action="filters-reset">Restablecer</button><button class="btn sm primary panel-close" data-action="filters-close">Ver mapa</button></div></div>
    <details open><summary>Comunas</summary><div class="fbody">
      <div class="comm-list">${allCommunes.map((c) => `<label class="check"><input type="checkbox" data-commune="${esc(c)}" ${f.communes.includes(c) ? 'checked' : ''}>${esc(c)} <span class="muted tiny">${counts[c] || ''}</span></label>`).join('')}</div>
      <div class="tiny muted">Activas por defecto: lista inicial editable (Configuración). No es una certificación de seguridad.</div>
      <label class="check"><input type="checkbox" data-filter-bool="onlyMicro" ${f.onlyMicro ? 'checked' : ''}>Santiago: solo dentro de microsectores definidos</label>
    </div></details>
    <details open><summary>Zona dibujada</summary><div class="fbody">
      <div class="row"><button class="btn sm" data-action="draw-start">✏️ Dibujar zona</button>${S.drawPolygon ? '<button class="btn sm" data-action="draw-clear">Quitar zona</button>' : ''}</div>
    </div></details>
    <details open><summary>Entrega</summary><div class="fbody">
      ${Object.entries(STATUS).map(([k, s]) => `<label class="check"><input type="checkbox" data-status="${k}" ${f.status.includes(k) ? 'checked' : ''}><span class="status-dot" style="background:${s.color}"></span>${s.label}</label>`).join('')}
      <label class="check"><input type="checkbox" data-filter-bool="onlyStock" ${f.onlyStock ? 'checked' : ''}>Solo stock verificado</label>
    </div></details>
    <details open><summary>Precio y tamaño</summary><div class="fbody">
      <div class="pair"><label class="field"><span>UF mín.</span>${inp('priceMin', '2.000')}</label><label class="field"><span>UF máx.</span>${inp('priceMax', '6.000')}</label></div>
      <div class="pair"><label class="field"><span>m² mín.</span>${inp('m2Min', '25')}</label><label class="field"><span>m² máx.</span>${inp('m2Max', '80')}</label></div>
      <label class="field"><span>UF/m² útil máx.</span>${inp('ufm2Max', '110')}</label>
      <div class="row">${[['Estudio', 0], ['1D', 1], ['2D', 2], ['3D+', 3]].map(([l, b]) => `<button class="btn sm ${f.bedrooms.includes(b) ? 'on' : ''}" data-action="filter-bed" data-bed="${b}">${l}</button>`).join('')}</div>
    </div></details>
    <details open><summary>Mi plan de pago</summary><div class="fbody">
      <div class="small">Caja ${clp(cfg.investor.cashTodayClp)} + ahorro ${clp(cfg.investor.monthlySavingsClp)}/mes <button class="btn sm ghost" data-action="goto-plan-config">Cambiar</button></div>
      <label class="check"><input type="checkbox" data-filter-bool="planReachable" ${f.planReachable ? 'checked' : ''}>Solo alcanzables con mi plan (incluye ajustados)</label>
      <label class="check"><input type="checkbox" data-filter-bool="pieCuotas" ${f.pieCuotas ? 'checked' : ''}>Solo con pie en cuotas publicado</label>
      <div class="tiny muted">Pie en cuotas publicado hay en pocos proyectos: en el resto la ficha usa un supuesto rotulado o asume pie al contado.</div>
    </div></details>
    <details><summary>Inversión</summary><div class="fbody">
      <label class="field"><span>Rentabilidad bruta mín. (%)</span>${inp('grossYieldMin', '4,5')}</label>
      <label class="field"><span>Flujo mensual mín. (CLP)</span>${inp('cfMin', '-100000', '1000')}</label>
      <label class="field"><span>Dividendo máx. (CLP)</span>${inp('dividendMax', '600000', '1000')}</label>
      <label class="field"><span>Capital inicial máx. (UF, pie + gastos)</span>${inp('pieMax', '400')}</label>
      <label class="field"><span>Riesgo máx. (0–100)</span>${inp('riskMax', '50')}</label>
      <label class="field"><span>Evidencia mín. (0–100)</span>${inp('evidenceMin', '60')}</label>
      <label class="field"><span>Metro a menos de (m)</span>${inp('metroMax', '800', '50')}</label>
      <label class="check"><input type="checkbox" data-filter-bool="strVerified" ${f.strVerified ? 'checked' : ''}>Renta corta permitida y verificada</label>
    </div></details>
    <details><summary>Otros</summary><div class="fbody">
      <label class="field"><span>Inmobiliaria contiene</span><input type="text" data-filter="developer" value="${esc(f.developer)}"></label>
      <label class="check"><input type="checkbox" data-filter-bool="includeHypo" ${f.includeHypo ? 'checked' : ''}>Simular unidades hipotéticas con el precio "desde"</label>
      <label class="check"><input type="checkbox" data-filter-bool="onlyAnalyzable" ${f.onlyAnalyzable ? 'checked' : ''}>Ocultar proyectos sin unidad analizable</label>
    </div></details>
    <div class="tiny muted" style="margin-top:10px">${S.projects.length} proyectos cargados · ${S.projects.filter((p) => p.lat == null).length} sin ubicación${S.demo ? ' · incluye DEMO' : ''}</div>`;
}

function onFiltersChanged({ rebuild = false } = {}) {
  saveFilters();
  if (rebuild) recompute();
  updateMap();
  renderOpps();
  if (S.view !== 'mapa') VIEWS[S.view]?.($(`#view-${S.view}`));
}

handle('filters-reset', () => { S.filters = defaultFilters(); S.drawPolygon = null; M.clearDraw(); renderFilters(); onFiltersChanged({ rebuild: true }); });
handle('filter-bed', (el) => {
  const b = +el.dataset.bed, f = S.filters;
  f.bedrooms = f.bedrooms.includes(b) ? f.bedrooms.filter((x) => x !== b) : [...f.bedrooms, b];
  el.classList.toggle('on');
  onFiltersChanged();
});
handle('draw-start', () => {
  if (S.view !== 'mapa') actions.setView('mapa');
  $('#drawHint').hidden = false;
  document.querySelector('.view-map')?.classList.remove('show-filters');
  M.startDraw((poly) => {
    $('#drawHint').hidden = true;
    S.drawPolygon = poly;
    renderFilters();
    onFiltersChanged();
    toast(poly ? 'Zona aplicada: solo se muestran proyectos dentro del polígono.' : 'Zona cancelada.');
  });
});
handle('draw-clear', () => { S.drawPolygon = null; M.clearDraw(); renderFilters(); onFiltersChanged(); });
actions.onEscape = () => { if (M.isDrawing()) { M.cancelDraw(); $('#drawHint').hidden = true; } };

document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.closest('#filters')) return;
  const f = S.filters;
  if (el.dataset.commune) {
    const c = el.dataset.commune;
    f.communes = el.checked ? [...new Set([...f.communes, c])] : f.communes.filter((x) => x !== c);
    onFiltersChanged();
  } else if (el.dataset.status) {
    const s = el.dataset.status;
    f.status = el.checked ? [...new Set([...f.status, s])] : f.status.filter((x) => x !== s);
    onFiltersChanged();
  } else if (el.dataset.filterBool) {
    f[el.dataset.filterBool] = el.checked;
    onFiltersChanged({ rebuild: el.dataset.filterBool === 'includeHypo' });
  } else if (el.dataset.filter) {
    f[el.dataset.filter] = el.type === 'number' ? num(el.value) : el.value;
    onFiltersChanged();
  }
});

// ------------------------------------------------------------------ mapa
function projectFeatures() {
  const feats = [];
  for (const p of visibleProjects()) {
    if (p.lat == null || p.lon == null) continue;
    const an = S.analyses.get(p.id);
    const a = an?.best;
    const st = a?.status?.code || 'gris';
    const ev = a?.priceEvidence || [];
    const unverified = !p.delivery?.stock_verified || !ev.some((s) => ['verificado', 'importado_sin_verificar', 'captura_usuario'].includes(s));
    const price = a?.priceUf ?? p.price_from_uf;
    feats.push({ type: 'Feature', id: undefined, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { id: p.id, status: st, unverified, demo: !!p.demo, score: Math.round(a?.score ?? 0), label: price ? `UF ${Math.round(price).toLocaleString('es-CL')}` : '' } });
  }
  return { type: 'FeatureCollection', features: feats };
}

function devFeatures() {
  const pub = [], pending = [], centers = [];
  for (const d of S.raw.developments) {
    const g = devGeometry(d);
    if (!g) continue;
    const color = M.DEV_COLORS[d.type] || '#607d8b';
    const isPending = d.status !== 'publicado';
    const props = { id: d.id, name: d.name, color, radius: d.radius_m || 1000, negative: d.impact === 'negativo_transitorio', pending: isPending };
    let area;
    if (g.type === 'Point') area = { type: 'Feature', properties: props, geometry: circlePolygon(g.coordinates[0], g.coordinates[1], d.radius_m || 1000) };
    else area = { type: 'Feature', properties: props, geometry: g.type === 'MultiLineString' ? g : g };
    if (g.type === 'MultiLineString') {
      for (const line of dedupeTracks(g.coordinates)) (isPending ? pending : pub).push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: line } });
      const mid = g.coordinates[0][Math.floor(g.coordinates[0].length / 2)];
      centers.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: mid } });
    } else {
      (isPending ? pending : pub).push(area);
      const c = g.type === 'Point' ? g.coordinates : g.coordinates[0][0];
      centers.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: c } });
    }
  }
  return { pub: { type: 'FeatureCollection', features: pub }, pending: { type: 'FeatureCollection', features: pending.filter((f) => f.geometry.type === 'Polygon') }, centers: { type: 'FeatureCollection', features: centers } };
}

/** OSM mapea una vía por sentido: se deja una sola para que la franja no se pinte doble. */
function dedupeTracks(lines) {
  const kept = [];
  const near = (a, b) => haversine(a[0], a[1], b[0], b[1]) < 80;
  for (const l of lines) {
    const a = l[0], b = l.at(-1);
    if (kept.some((k) => (near(k[0], b) && near(k.at(-1), a)) || (near(k[0], a) && near(k.at(-1), b)))) continue;
    kept.push(l);
  }
  return kept;
}

function staticLayers() {
  const cfg = S.config;
  const communes = { type: 'FeatureCollection', features: S.raw.osm.communes.map((f) => ({ ...f, properties: { ...f.properties, active: cfg.communes.active.includes(f.properties.name) } })) };
  M.setLayerData('communes', communes);
  M.setLayerData('micro', { type: 'FeatureCollection', features: (cfg.communes.microsectors || []).map((m) => ({ type: 'Feature', properties: { name: m.name }, geometry: circlePolygon(m.center[0], m.center[1], m.radius_m) })) });
  M.setLayerData('metroLines', { type: 'FeatureCollection', features: S.raw.osm.lines });
  M.setLayerData('metroFuture', { type: 'FeatureCollection', features: S.raw.osm.future.filter((f) => !/maniobra|patio/i.test(f.properties.name || '')) });
  M.setLayerData('stations', { type: 'FeatureCollection', features: S.raw.osm.stations });
  M.setLayerData('pois', { type: 'FeatureCollection', features: S.raw.osm.pois });
  const d = devFeatures();
  M.setLayerData('devs', d.pub);
  M.setLayerData('devsPending', d.pending);
  M.setLayerData('devCenters', d.centers);
}

function updateMap() {
  if (!M.getMap()) return;
  M.setProjects(projectFeatures());
}

function popupHTML(p) {
  const an = S.analyses.get(p.id);
  const a = an?.best;
  const ufv = S.raw.uf?.value;
  const st = a?.status || { color: STATUS.gris.color, label: STATUS.gris.label, reason: 'Sin análisis' };
  const lines = [];
  if (a) {
    lines.push(['Precio', `${uf(a.priceUf, 0)} · ${clp(a.priceClp)}`]);
    lines.push(['Dividendo 30 años', a.metrics.dividend ? `${uf(a.metrics.dividend)} · ${clp(a.metrics.dividend * ufv)}` : 's/d']);
    lines.push(['Arriendo estimado', a.rentEstimate ? `${clp(a.rentEstimate.baseClp)} (${a.rentSource === 'comparables' ? `${a.rent.counts.used} comparables` : a.rentSource === 'referencia' ? 'ref. comunal' : a.rentSource})` : 'sin datos']);
    lines.push(['Flujo mensual', a.metrics.monthlyCf != null ? clp(a.metrics.monthlyCf * ufv, { sign: true }) : 's/d']);
    if (a.plan) {
      const pl = a.plan;
      lines.push(['Tu plan', `<span class="chip ${pl.tone}">${pl.icon} ${esc(pl.short)}</span>`]);
      lines.push(['Pie', pl.cuotas ? `hoy ${clp(pl.paidTodayUf * ufv)} + ${pl.cuotas} × ${clp(pl.cuotaUf * ufv)}${a.terms.source === 'publicado' ? '' : ' (supuesto)'}`
        : pl.minInstallmentsNeeded ? `necesitas ≥ ${pl.minInstallmentsNeeded} cuotas` : `${clp(pl.pieUf * ufv)} al escriturar`]);
    }
    lines.push(['Score', `${Math.round(a.score)} · ${a.gates.passed ? 'oportunidad verificada' : 'provisional'}`]);
  } else if (p.price_from_uf) lines.push(['Desde', `${uf(p.price_from_uf, 0)} · ${clp(p.price_from_uf * ufv)}`]);
  return `<div class="pop">
    <h4>${esc(p.name)} ${p.demo ? '<span class="chip demo">DEMO</span>' : ''}</h4>
    <div class="sub">${esc(p.developer?.name || 'Inmobiliaria s/d')} · ${esc(p.commune)}${p.neighborhood ? ` · ${esc(p.neighborhood)}` : ''}</div>
    <span class="chip" style="background:${st.color}22;color:var(--text)"><span class="dot" style="background:${st.color}"></span>${esc(st.label)}</span>
    <div class="tiny muted" style="margin-top:3px">${esc(st.reason || '')}</div>
    <div class="lines">${lines.map(([k, v]) => `<span class="muted">${k}</span><b>${v}</b>`).join('')}</div>
    ${a?.unit?.hypothetical ? '<div class="tiny" style="margin-bottom:6px">⚠️ Unidad hipotética con el precio "desde"</div>' : ''}
    <button class="btn primary sm" data-action="open-project" data-id="${esc(p.id)}">Ver análisis completo</button>
    <button class="btn sm" data-action="toggle-compare" data-id="${esc(p.id)}">+ Comparar</button>
  </div>`;
}

function devPopupHTML(d) {
  const src = (d.sources || []).slice(0, 3).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher || s.title)}</a>${s.official ? ' <span class="chip good">oficial</span>' : ''}</li>`).join('');
  return `<div class="pop"><h4>${esc(d.name)}</h4>
    <div class="sub">${esc(M.DEV_LABELS[d.type] || d.type)} · ${esc(stageLabel(d.stage))} · ${esc(d.estimated_label || d.estimated_date || 'sin fecha')}</div>
    ${d.status !== 'publicado' ? '<span class="chip warn">Pendiente de revisión</span>' : `<span class="chip">Certeza ${esc(d.certainty || 's/d')}</span>`}
    <p class="small" style="margin:6px 0">${esc((d.description || '').slice(0, 260))}${(d.description || '').length > 260 ? '…' : ''}</p>
    <div class="tiny"><b>Radio ${meters(d.radius_m)}:</b> ${esc(d.radius_justification || '')}</div>
    <div class="tiny muted" style="margin-top:4px">Zona de estudio, no plusvalía asegurada.</div>
    <ul class="src-list">${src}</ul>
    <button class="btn sm" data-action="open-dev" data-id="${esc(d.id)}">Ver en radar urbano</button></div>`;
}

export function stageLabel(s) {
  return { idea: 'Idea', anuncio: 'Anuncio', diseno: 'Diseño', evaluacion: 'En evaluación', aprobado: 'Aprobado', en_construccion: 'En construcción', operativo: 'Operativo' }[s] || s || 's/d';
}

function renderLegend() {
  const collapsed = LS.get('legend.collapsed', innerWidth <= 860);
  const house = (c, dashed) => `<svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">${dashed ? `<circle cx="16" cy="17" r="14" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="3 2"/>` : ''}<path d="M16 5 27 14h-2.5v12h-17V14H5z" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`;
  $('#legend').innerHTML = `<div class="ttl"><span>Leyenda</span><button data-action="legend-toggle" aria-label="Mostrar u ocultar leyenda">${collapsed ? '▸' : '▾'}</button></div>
    ${collapsed ? '' : `${Object.values(STATUS).map((s) => `<div class="li">${house(s.color)}${s.label}</div>`).join('')}
    <div class="li">${house('#8a8f98', true)}Borde punteado: precio o stock sin verificar</div>
    <div class="li"><span class="chip demo">DEMO</span> dato ficticio</div>
    <div class="li"><svg width="18" height="10"><rect width="18" height="10" rx="3" fill="#6250d6" opacity=".25" stroke="#6250d6"/></svg>Radio de obra (zona de estudio)</div>
    <div class="li"><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="#6250d6" stroke-width="3" stroke-dasharray="4 3"/></svg>Metro en construcción (OSM)</div>
    <div class="tiny muted" style="margin-top:4px">Rojo exige entrega Y stock verificados. Fecha desconocida o vencida sin confirmar: gris.</div>`}`;
}
handle('legend-toggle', () => { LS.set('legend.collapsed', !LS.get('legend.collapsed', innerWidth <= 860)); renderLegend(); });

function renderLayersPanel() {
  const vis = LS.get('layers', {});
  $('#layersPanel').innerHTML = `<details ${LS.get('layers.open', false) ? 'open' : ''} data-layers-panel><summary>Capas</summary><div class="lbody">
    ${M.LAYERS.map((l) => {
    const on = vis[l.key] ?? l.on;
    const sw = l.poi ? `<span class="swatch dot" style="background:${M.POI_STYLE[l.poi].color}"></span>` : '';
    return `<label class="check"><input type="checkbox" data-layer="${l.key}" ${on ? 'checked' : ''}>${sw}${esc(l.label)}</label>`;
  }).join('')}
    <div class="tiny muted">Servicios desde OpenStreetMap (${date(S.raw.osm.meta?.generated_at)}).</div>
  </div></details>`;
}
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.layer) {
    const vis = LS.get('layers', {});
    vis[el.dataset.layer] = el.checked;
    LS.set('layers', vis);
    M.applyVisibility(vis);
  }
});
document.addEventListener('toggle', (e) => { if (e.target.matches?.('[data-layers-panel]')) LS.set('layers.open', e.target.open); }, true);

// ------------------------------------------------------------------ panel de oportunidades (sincronizado con el mapa)
function renderOpps() {
  const el = $('#opps');
  if (!el) return;
  const b = M.currentBounds();
  const inView = visibleProjects().filter((p) => p.lat != null && (!b || (p.lon >= b[0] && p.lon <= b[2] && p.lat >= b[1] && p.lat <= b[3])));
  const rows = inView.map((p) => ({ p, a: S.analyses.get(p.id)?.best })).sort((x, y) => (y.a?.score ?? -1) - (x.a?.score ?? -1));
  const ufv = S.raw.uf?.value;
  const noGeo = visibleProjects().filter((p) => p.lat == null);
  const outside = visibleProjects().filter((p) => p.lat != null).length - inView.length;
  el.innerHTML = `<div class="opps-head"><div class="row between"><h2>Oportunidades en el mapa</h2><div class="row"><span class="chip">${rows.length}</span><button class="btn sm panel-close" data-action="opps-toggle" aria-label="Cerrar">✕</button></div></div>
    <div class="tiny muted">Solo los proyectos dentro del mapa visible, ordenados por score (${esc(S.config.ranking.profiles[S.config.ranking.profile].label)}). Provisional = faltan datos para recomendar.</div>
    ${outside > 0 ? `<div class="row small" style="margin-top:4px"><span>${outside} proyecto${outside === 1 ? '' : 's'} fuera de esta vista</span><button class="btn sm" data-action="fit-all">Ver todos</button></div>` : ''}</div>
    ${rows.length ? rows.slice(0, 120).map(({ p, a }) => {
    const st = a?.status || STATUS.gris;
    return `<div class="opp ${S.selected?.projectId === p.id ? 'on' : ''}" data-action="opp-click" data-id="${esc(p.id)}" data-hover="${esc(p.id)}">
        <span class="status-dot" style="background:${st.color};margin-top:4px" title="${esc(st.label)}"></span>
        <div><div class="t">${esc(p.name)}</div>
          <div class="m">${esc(p.commune)} · ${a ? `${uf(a.priceUf, 0)} · ${a.unit.hypothetical ? 'hipotética' : esc(a.unit.type || `${a.unit.bedrooms}D`)}` : p.price_from_uf ? `desde ${uf(p.price_from_uf, 0)}` : 'sin precio'}</div>
          ${a ? `<div class="m">Flujo ${clp(a.metrics.monthlyCf * ufv, { sign: true })}/mes · bruta ${pct(a.metrics.grossYield)}</div>` : '<div class="m muted">Sin unidad analizable</div>'}
          <div class="row" style="margin-top:3px">${p.demo ? '<span class="chip demo">DEMO</span>' : ''}${a?.plan ? `<span class="chip ${a.plan.tone}" title="${esc(a.plan.label)}">${a.plan.icon} ${esc(a.plan.short)}</span>` : ''}${a?.terms?.source === 'publicado' && a.terms.installmentsMax > 0 ? '<span class="chip info">pie en cuotas</span>' : ''}${a && !a.gates.passed ? '<span class="chip warn">provisional</span>' : ''}${a?.gates.passed ? '<span class="chip good">verificada</span>' : ''}</div></div>
        <div class="score">${a ? Math.round(a.score) : '–'}<small>score</small></div></div>`;
  }).join('') : '<div class="empty"><b>Sin proyectos en esta vista</b>Mueve el mapa o ajusta los filtros. Si no hay datos: Configuración → Importar proyectos, o activa el modo DEMO.</div>'}
    ${noGeo.length ? `<div class="opps-head" style="position:static"><div class="tiny muted">${noGeo.length} proyecto(s) sin ubicación (no aparecen en el mapa): ${noGeo.map((p) => `<a href="#" data-action="open-project" data-id="${esc(p.id)}">${esc(p.name)}</a>`).join(', ')}</div></div>` : ''}`;
}

handle('opp-click', (el) => {
  const p = projectById(el.dataset.id);
  if (!p) return;
  if (innerWidth <= 1180) $('.view-map').classList.remove('show-opps');
  selectProject(p.id, { fly: true, popup: true });
});
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('[data-hover]');
  if (!el) return;
  const p = projectById(el.dataset.hover);
  if (p?.lat != null) M.setSelected([p.lon, p.lat]);
});

function selectProject(id, { fly = false, popup = false } = {}) {
  const p = projectById(id);
  if (!p) return;
  S.selected = { projectId: id };
  if (p.lat != null) {
    M.setSelected([p.lon, p.lat]);
    if (fly) M.flyTo([p.lon, p.lat], 15);
    if (popup) M.showPopup([p.lon, p.lat], popupHTML(p));
  }
  $$('.opp').forEach((o) => o.classList.toggle('on', o.dataset.id === id));
  $(`.opp[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
actions.selectProject = selectProject;

// ------------------------------------------------------------------ búsqueda
function searchItems(q) {
  const n = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const t = n(q);
  if (t.length < 2) return [];
  const out = [];
  for (const p of S.projects) {
    const hay = n(`${p.name} ${p.address} ${p.developer?.name} ${p.commune} ${p.neighborhood}`);
    if (hay.includes(t)) out.push({ kind: 'Proyecto', label: p.name, sub: p.commune, go: () => { actions.openProject(p.id); if (p.lat != null) selectProject(p.id, { fly: true }); } });
  }
  for (const c of S.raw.osm.communes) if (n(c.properties.name).includes(t)) out.push({ kind: 'Comuna', label: c.properties.name, go: () => fitFeature(c) });
  for (const s of S.raw.osm.stations) if (n(s.properties.name).includes(t)) out.push({ kind: `Metro ${s.properties.lines.join('/')}`, label: s.properties.name, go: () => M.flyTo(s.geometry.coordinates, 15) });
  for (const d of S.raw.developments) if (n(d.name).includes(t)) out.push({ kind: 'Obra', label: d.name, go: () => { const g = devGeometry(d); if (g) M.flyTo(g.type === 'Point' ? g.coordinates : g.coordinates[0][0], 14); } });
  return out.slice(0, 12);
}

function fitVisibleProjects() {
  const pts = visibleProjects().filter((p) => p.lat != null);
  if (!pts.length) return false;
  const xs = pts.map((p) => p.lon), ys = pts.map((p) => p.lat);
  M.fitTo([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]]);
  return true;
}
handle('fit-all', () => { fitVisibleProjects(); });

function fitFeature(f) {
  const xs = [], ys = [];
  const walk = (c) => (typeof c[0] === 'number' ? (xs.push(c[0]), ys.push(c[1])) : c.forEach(walk));
  walk(f.geometry.coordinates);
  M.fitTo([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]]);
}

let searchSel = [];
function bindSearch() {
  const box = $('#searchBox'), res = $('#searchResults');
  box.addEventListener('input', () => {
    searchSel = searchItems(box.value);
    res.hidden = !searchSel.length && box.value.length < 4;
    res.innerHTML = searchSel.map((it, i) => `<button data-sidx="${i}"><span>${esc(it.label)}${it.sub ? ` <span class="muted small">${esc(it.sub)}</span>` : ''}</span><span class="kind">${esc(it.kind)}</span></button>`).join('')
      + (box.value.length >= 4 ? `<button data-geocode="1"><span>Buscar dirección «${esc(box.value)}» en OpenStreetMap</span><span class="kind">Nominatim</span></button>` : '');
  });
  res.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    res.hidden = true;
    if (b.dataset.geocode) return geocodeAddress(box.value);
    searchSel[+b.dataset.sidx]?.go();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { res.hidden = true; if (searchSel[0]) searchSel[0].go(); else if (box.value.length >= 4) geocodeAddress(box.value); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.map-search')) res.hidden = true; });
}

async function geocodeAddress(q) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=cl&viewbox=-70.86,-33.30,-70.43,-33.66&bounded=1&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'Accept-Language': 'es' } });
    const j = await r.json();
    if (!j[0]) return toast('No se encontró esa dirección en Santiago.');
    M.flyTo([+j[0].lon, +j[0].lat], 16);
    toast(j[0].display_name, 4500);
  } catch { toast('No se pudo consultar el geocodificador (sin red o bloqueado).'); }
}

// ------------------------------------------------------------------ vistas
function setView(v) {
  if (!VIEWS[v] && v !== 'mapa') v = 'mapa';
  S.view = v;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('main .view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  if (v === 'mapa') { M.getMap()?.resize(); renderOpps(); } else VIEWS[v]($(`#view-${v}`));
  history.replaceState(null, '', v === 'mapa' ? location.pathname : `#${v}`);
}
actions.setView = setView;
handle('goto-plan-config', () => {
  S.adminTab = 'supuestos';
  setView('config');
  setTimeout(() => document.getElementById('cfg-perfil')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
});
actions.rerenderView = () => { if (S.view !== 'mapa') VIEWS[S.view]($(`#view-${S.view}`)); else renderOpps(); };

$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });

// ------------------------------------------------------------------ ficha
actions.openProject = (id, unitId) => {
  const p = projectById(id);
  if (!p) return toast('Proyecto no encontrado');
  S.selected = { projectId: id, unitId };
  renderFicha(p, unitId);
  const d = $('#drawer');
  d.classList.add('open'); d.setAttribute('aria-hidden', 'false');
  history.replaceState(null, '', `#p=${encodeURIComponent(id)}`);
  if (p.lat != null) M.setSelected([p.lon, p.lat]);
};
actions.closeProject = () => {
  closeFicha();
  $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true');
  M.setComps(null);
  history.replaceState(null, '', S.view === 'mapa' ? location.pathname : `#${S.view}`);
};
actions.showComps = (center, radiusM, comps) => M.setComps(center, radiusM, comps);
actions.flyTo = (lonlat, z) => { setView('mapa'); M.flyTo(lonlat, z); };
handle('open-project', (el) => { M.closePopup(); actions.openProject(el.dataset.id, el.dataset.unit); });
handle('close-project', () => actions.closeProject());
handle('open-dev', (el) => { M.closePopup(); S.radarFocus = el.dataset.id; setView('radar'); });

// Comparador y favoritos (estado local)
actions.toggleCompare = (projectId, unitId) => {
  const a = analysisOf(projectId, unitId);
  const key = `${projectId}::${a?.unit?.id || unitId || ''}`;
  let list = LS.get('compare', []);
  if (list.includes(key)) list = list.filter((k) => k !== key);
  else {
    if (list.length >= 5) return toast('El comparador admite hasta 5 unidades. Quita una primero.');
    list.push(key);
  }
  LS.set('compare', list);
  updateCounts();
  toast(list.includes(key) ? 'Agregada al comparador' : 'Quitada del comparador');
};
handle('toggle-compare', (el) => actions.toggleCompare(el.dataset.id, el.dataset.unit));
actions.toggleFavorite = (projectId) => {
  const fav = LS.get('favorites', {});
  if (fav[projectId]) delete fav[projectId];
  else {
    const a = analysisOf(projectId);
    fav[projectId] = { savedAt: new Date().toISOString(), priceUf: a?.priceUf ?? projectById(projectId)?.price_from_uf ?? null, status: a?.status?.code, score: a?.score ?? null };
  }
  LS.set('favorites', fav);
  toast(fav[projectId] ? 'Guardado en favoritos (se te avisará si cambia)' : 'Quitado de favoritos');
  updateCounts();
};
handle('toggle-fav', (el) => { actions.toggleFavorite(el.dataset.id); actions.rerenderView(); if ($('#drawer').classList.contains('open')) actions.openProject(el.dataset.id, S.selected?.unitId); });

export function updateCounts() {
  const c = LS.get('compare', []).length;
  $('#cmpCount').textContent = c ? String(c) : '';
  const unseen = actions.unseenAlerts?.() || 0;
  $('#alertCount').textContent = unseen ? String(unseen) : '';
}
actions.updateCounts = updateCounts;

// ------------------------------------------------------------------ UF, tema, demo
function renderUfChip() {
  const u = S.raw.uf;
  const el = $('#ufChip');
  if (!u?.value) { el.textContent = 'UF sin datos'; return; }
  el.innerHTML = `<button data-action="uf-info" title="Ver fuente">UF ${clp(u.value).replace('$', '$')} · ${date(u.date)}${u.status !== 'ok' ? ' ⚠️' : ''}</button>`;
}
handle('uf-info', () => {
  const u = S.raw.uf;
  openModal(`<h3>Valor de la UF</h3>
    <p class="num" style="font-size:22px;font-weight:700">${clp(u.value)} <span class="muted small">al ${date(u.date)}</span></p>
    <div class="stack small"><div><b>Fuente:</b> ${u.source_url ? `<a href="${esc(u.source_url)}" target="_blank" rel="noopener">${esc(u.source)}</a>` : esc(u.source)}</div>
    <div><b>Estado:</b> ${esc(u.status)}${u.fetched_at ? ` · descargada ${date(u.fetched_at, { time: true })}` : ''}</div>
    ${u.status !== 'ok' ? '<div class="note warn">Dato de respaldo o desactualizado: los montos en pesos pueden diferir del valor de hoy.</div>' : ''}
    <div class="note">Todos los montos en CLP de la app usan esta UF ("pesos de hoy"). Los dividendos en pesos futuros subirán con la UF.</div></div>`);
});

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  LS.set('theme', t);
}
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}
$('#themeBtn').addEventListener('click', () => {
  applyTheme(isDark() ? 'light' : 'dark');
  const st = S.config.map.styles;
  M.setTheme(isDark(), isDark() ? st.oscuro : st.claro);
});

$('#demoToggle').addEventListener('change', async (e) => {
  S.demo = e.target.checked;
  LS.set('demo', S.demo);
  $('#demoBanner').hidden = !S.demo;
  if (S.demo) await loadDemo();
  recompute();
  renderFilters();
  updateMap();
  renderOpps();
  if (S.view !== 'mapa') VIEWS[S.view]($(`#view-${S.view}`));
  toast(S.demo ? 'Modo DEMO activo: se suman proyectos y avisos FICTICIOS (rotulados).' : 'Modo DEMO desactivado.');
});

// ------------------------------------------------------------------ móvil
$('#filtersToggle').addEventListener('click', () => $('.view-map').classList.toggle('show-filters'));
handle('opps-toggle', () => $('.view-map').classList.toggle('show-opps'));
handle('filters-close', () => $('.view-map').classList.remove('show-filters'));

// ------------------------------------------------------------------ arranque
async function boot() {
  try {
    await loadAll();
  } catch (e) {
    $('#main').innerHTML = `<div class="empty"><b>No se pudieron cargar los datos</b>${esc(e.message)}</div>`;
    return;
  }
  S.demo = LS.get('demo', false);
  $('#demoToggle').checked = S.demo;
  $('#demoBanner').hidden = !S.demo;
  if (S.demo) await loadDemo();
  S.config = effectiveConfig();
  S.filters = { ...defaultFilters(), ...(LS.get('filters') || {}) };
  recompute();
  renderUfChip();
  renderFilters();
  renderLegend();
  renderLayersPanel();
  bindSearch();
  updateCounts();
  const cfg = S.config;
  try {
    M.initMap('map', {
      styleUrl: isDark() ? cfg.map.styles.oscuro : cfg.map.styles.claro, raster: cfg.map.fallbackRaster, dark: isDark(),
      center: cfg.map.center, zoom: cfg.map.zoom, visibility: LS.get('layers', {}),
      onStyleReady: (mode) => {
        staticLayers(); updateMap();
        // MapLibre puede descartar un setData hecho mientras la fuente aún carga: se repite al quedar ocioso.
        M.onIdleOnce(() => { staticLayers(); updateMap(); });
        M.applyVisibility(LS.get('layers', {}));
        const note = $('#mapNote');
        if (mode === 'offline') { note.hidden = false; note.textContent = 'No se pudo cargar el mapa base (sin conexión a los servidores de teselas). Se muestran límites comunales, Metro y proyectos.'; }
        else if (mode === 'raster') { note.hidden = false; note.textContent = 'Mapa base alternativo (CARTO/OSM) porque el principal no respondió.'; setTimeout(() => { note.hidden = true; }, 6000); }
      },
      onProjectClick: (id) => selectProject(id, { popup: true }),
      onDevClick: (id, ll) => { const d = S.raw.developments.find((x) => x.id === id); if (d) M.showPopup([ll.lng, ll.lat], devPopupHTML(d)); },
    });
    M.onMove(renderOpps);
    // En el celular el centro fijo deja proyectos fuera de la vista: se encuadran todos al abrir.
    if (window.innerWidth <= 860 && !location.hash) fitVisibleProjects();
  } catch (e) {
    $('#mapNote').hidden = false;
    $('#mapNote').textContent = `El mapa no pudo iniciar: ${e.message}`;
  }
  renderOpps();
  on('recomputed', () => { updateCounts(); });
  S.ready = true;
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('p=')) actions.openProject(h.slice(2));
  else if (h && VIEWS[h]) setView(h);
  if (!LS.get('welcomed')) {
    LS.set('welcomed', true);
    openModal(`<h3>Bienvenido a Atlas Inversión Santiago</h3>
      <p>Mapa de proyectos de departamentos con análisis de inversión: entrega, dividendo, arriendo en 2 km, flujo, riesgo y ranking explicable.</p>
      <div class="note warn">Los ${S.raw.projects.length} proyectos reales cargados vienen de búsquedas web y capturas: <b>ninguno tiene entrega ni stock verificados</b>, por eso salen en gris y en la lista provisional. Verifícalos con la inmobiliaria (botón “Registrar verificación” en cada ficha) o importa tu CSV.</div>
      <p class="small">¿Quieres ver todas las funciones con datos completos? Activa <b>Modo DEMO</b> (arriba a la derecha): agrega proyectos y arriendos ficticios rotulados.</p>
      <div class="row"><button class="btn primary" data-action="modal-close">Explorar el mapa</button><button class="btn" data-action="welcome-demo">Activar DEMO</button><button class="btn" data-action="welcome-tutorial">Ver tutorial</button></div>`);
  }
}
handle('welcome-demo', () => { closeModal(); const t = $('#demoToggle'); t.checked = true; t.dispatchEvent(new Event('change')); });
handle('welcome-tutorial', () => { closeModal(); S.advisorTab = 'tutorial'; setView('asesor'); });

actions.recompute = () => { recompute(); renderFilters(); updateMap(); renderOpps(); renderUfChip(); staticLayers(); };
actions.reloadData = async () => { await loadAll(); actions.recompute(); };

window.addEventListener('hashchange', () => {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('p=')) actions.openProject(h.slice(2));
});

boot();
