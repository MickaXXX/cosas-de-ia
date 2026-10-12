/* Análisis completo de una unidad: une estado de entrega, entorno, arriendo, gasto común,
 * finanzas, escenarios, riesgo, score y explicación. Es la única función que conoce a
 * todos los módulos; la interfaz y el ranking solo llaman a analyzeUnit(). */
import { simulate, runScenarios, requiredIncomeClp } from './finance.js';
import { cashPlan } from './plan.js';
import { deliveryStatus, monthsToDelivery } from './status.js';
import { rentAnalysis, referenceEstimate } from './rentals.js';
import { estimateCommonExpenses } from './commonexp.js';
import { riskScores, monteCarlo, lerp } from './risk.js';
import { evidenceScore, componentScores, scoreWithProfile, qualityGates, appreciationPotential, explain } from './scoring.js';
import { haversine, distanceToGeometry, pointInGeometry, walkMinutes } from './geo.js';
import { todaySantiago, monthIndexSantiago } from './format.js';

export const ACCEPTED_PRICE_EVIDENCE = new Set(['verificado', 'importado_sin_verificar', 'captura_usuario']);

export function unitPrice(u) {
  return u.offer_price_uf ?? u.list_price_uf ?? null;
}

/** Proyecto sin unidades publicadas: unidad hipotética con el precio "desde" y la tipología
 * del texto (o m² típicos). Siempre rotulada y fuera de la lista verificada del ranking. */
export function hypotheticalUnit(p, cfg) {
  if (!p.price_from_uf || (p.units || []).length) return null;
  const txt = (p.typologies_text || '').toLowerCase();
  const bedrooms = /estudio/.test(txt) ? 0 : /(\d)\s*d/.test(txt) ? +txt.match(/(\d)\s*d/)[1] : 1;
  const m = txt.match(/(\d{2,3})\s*[-–a]\s*\d{2,3}\s*m/);
  const m2 = m ? +m[1] : (cfg.typicalM2 || {})[String(bedrooms)];
  return { id: 'hipotetica', type: bedrooms === 0 ? 'Estudio (hipotético)' : `${bedrooms}D (hipotético)`, bedrooms, bathrooms: 1, useful_m2: m2,
    list_price_uf: p.price_from_uf, offer_price_uf: null, reference: true, hypothetical: true, available: null };
}

/** Índices que se calculan una vez por carga de datos. */
export function buildContext({ projects = [], rentals = [], references = [], stations = [], metroLines = [], pois = [],
  developments = [], communesGeo = [], config, uf, today = todaySantiago() }) {
  const opStations = stations.filter((s) => (s.properties.status || 'operativa') === 'operativa');
  const poisByCat = {};
  for (const f of pois) (poisByCat[f.properties.category] ||= []).push(f);
  return { projects, rentals, references, stations: opStations, allStations: stations, metroLines, pois, poisByCat,
    developments, communesGeo, config, uf, today, cache: new Map() };
}

function nearestStation(p, ctx) {
  let best = null;
  for (const s of ctx.stations) {
    const [lon, lat] = s.geometry.coordinates;
    const d = haversine(p.lon, p.lat, lon, lat);
    if (!best || d < best.distance) best = { name: s.properties.name, lines: s.properties.lines || [], distance: d };
  }
  return best ? { ...best, walkMin: walkMinutes(best.distance) } : null;
}

function nearestByCategory(p, ctx, radius = 3000) {
  const out = {};
  for (const [cat, feats] of Object.entries(ctx.poisByCat)) {
    let best = null, count = 0;
    for (const f of feats) {
      const [lon, lat] = f.geometry.coordinates;
      const d = haversine(p.lon, p.lat, lon, lat);
      if (d <= radius) count++;
      if (!best || d < best.distance) best = { name: f.properties.name, distance: d };
    }
    out[cat] = best ? { ...best, countInRadius: count, walkMin: walkMinutes(best.distance) } : null;
  }
  return out;
}

function servicesScore(metro, near, cfg) {
  if (!metro && !Object.keys(near).length) return { score: null, why: 'sin capas de servicios cargadas' };
  let s = 0;
  const why = [];
  if (metro) { s += lerp(metro.distance, cfg.metroPoints); why.push(`Metro ${metro.name} a ${Math.round(metro.distance)} m`); }
  for (const [cat, [radius, pts]] of Object.entries(cfg.within)) {
    const n = near[cat];
    if (n && n.distance <= radius) { s += pts; why.push(`${cat} a ${Math.round(n.distance)} m`); }
  }
  return { score: Math.min(100, s), why: why.slice(0, 4).join(' · ') };
}

function tourismIndex(p, ctx) {
  const cfg = ctx.config.tourism;
  const feats = [...(ctx.poisByCat.turismo || []), ...(ctx.poisByCat.cultura || [])];
  if (!feats.length) return { score: null, count: 0 };
  const count = feats.filter((f) => haversine(p.lon, p.lat, f.geometry.coordinates[0], f.geometry.coordinates[1]) <= cfg.radiusM).length;
  return { score: Math.min(100, (100 * count) / cfg.saturation), count, radiusM: cfg.radiusM };
}

export function devGeometry(d) {
  if (d.geometry) return d.geometry;
  if (d.lat != null && d.lon != null) return { type: 'Point', coordinates: [d.lon, d.lat] };
  return null;
}

export function nearbyDevelopments(p, ctx, maxDist = null) {
  const out = [];
  for (const d of ctx.developments) {
    const g = devGeometry(d);
    if (!g) continue;
    const dist = distanceToGeometry(p.lon, p.lat, g);
    const lim = maxDist ?? Math.max(d.radius_m || 1000, ctx.config.infrastructure.nearbyRadiusM);
    if (dist <= lim) out.push({ dev: d, distance: dist, insideRadius: dist <= (d.radius_m || 1000) });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

export function contribucionesUfYear(priceUf, ufValue, cfg) {
  if (!ufValue) return 0;
  const avaluo = priceUf * ufValue * cfg.avaluoFactor;
  return Math.max(0, avaluo - cfg.exemptClp) * cfg.ratePct / ufValue;
}

export function microsectorOf(p, cfg) {
  for (const m of cfg.communes.microsectors || []) {
    if (m.commune !== p.commune) continue;
    if (haversine(p.lon, p.lat, m.center[0], m.center[1]) <= m.radius_m) return m;
  }
  return null;
}

/**
 * Condiciones de pago del pie para una unidad:
 * - publicadas en el proyecto/unidad (`payment_terms`, con fuente), o
 * - SUPUESTO rotulado: pie en cuotas hasta la entrega prometida si la entrega es futura, o
 * - sin cuotas: entrega inmediata (o fecha desconocida) → pie completo al escriturar.
 */
export function paymentTerms(project, unit, a, cfg) {
  const pt = { ...(project.payment_terms || {}), ...(unit.payment_terms || {}) };
  const fin = cfg.financing, inv = cfg.investor || {};
  if (pt.pie_installments_max != null) {
    return { installmentsMax: Math.max(0, +pt.pie_installments_max || 0), postDelivery: !!pt.pie_post_delivery,
      minUpfrontPct: pt.pie_min_upfront_pct != null ? pt.pie_min_upfront_pct / 100 : 0, interest: pt.pie_interest || null,
      source: 'publicado', verification: pt.verification_status || 'extraido_busqueda_web', sourceName: pt.source_name || null,
      url: pt.source_url || null, publishedAt: pt.published_at || null, notes: pt.notes || null };
  }
  if (a.deliveryMonths > 0 && inv.assumeInstallmentsUntilDelivery !== false) {
    return { installmentsMax: Math.min(a.deliveryMonths, fin.pieInstallmentsMax ?? 48), postDelivery: false, minUpfrontPct: 0,
      source: 'supuesto', notes: 'Pie en cuotas hasta la entrega: práctica habitual en venta en verde/blanco, no publicada para este proyecto.' };
  }
  return { installmentsMax: 0, postDelivery: false, minUpfrontPct: 0, source: a.deliveryAssumed ? 'sin_datos' : 'sin_cuotas' };
}

/** Arma el input del simulador para una unidad, con los supuestos de configuración y los
 *  ajustes del usuario (overrides). */
export function financeInput(project, unit, a, ctx, mode, overrides = {}) {
  const cfg = ctx.config, fin = cfg.financing, rm = cfg.rentalModel, val = cfg.valuation, ufv = ctx.uf?.value;
  const price = unitPrice(unit);
  const rentClp = a.rentEstimate?.baseClp ?? null;
  const air = cfg.airbnb;
  const inp = {
    mode,
    priceUf: price,
    discountPct: 0,
    bonoPiePct: (unit.bono_pie_pct ?? 0) / 100,
    creditPct: fin.creditPct, maxCreditPct: fin.maxCreditPct,
    annualRate: fin.annualRate, rateConvention: fin.rateConvention, loanYears: fin.loanYears,
    deliveryMonths: a.deliveryMonths, deliveryDelayMonths: 0, reservaUf: fin.reservaUf,
    pieInstallmentsMax: a.terms ? a.terms.installmentsMax : fin.pieInstallmentsMax, piePostDelivery: !!a.terms?.postDelivery, pieUpfrontUf: 0,
    closing: fin.closing, furnishingUf: mode === 'renta_corta' ? air.furnishingUf : 0,
    desgravamenPctMonthly: fin.desgravamenPctMonthly, incendioPctMonthly: fin.incendioPctMonthly, insuredValueFactor: fin.insuredValueFactor,
    rentUf: rentClp && ufv ? rentClp / ufv : 0,
    _rentBand: a.rentEstimate && ufv ? [a.rentEstimate.lowClp / ufv, a.rentEstimate.highClp / ufv] : null,
    rentRealGrowth: rm.rentRealGrowth,
    leaseMonths: rm.leaseMonths, initialVacancyMonths: rm.initialVacancyMonths, turnoverVacancyMonths: rm.turnoverVacancyMonths,
    brokeragePctOfRent: rm.brokeragePctOfRent, collectionLossPct: rm.collectionLossPct, maintenancePctOfRent: rm.maintenancePctOfRent,
    adminPctOfRent: rm.adminPctOfRent, capexReserveUfMonth: rm.capexReserveUfMonth, ownerGcShareWhenRented: rm.ownerGcShareWhenRented,
    commonExpensesUf: a.gc?.baseClp && ufv ? a.gc.baseClp / ufv : 0,
    _gcBand: a.gc?.lowClp && ufv ? [a.gc.lowClp / ufv, a.gc.highClp / ufv] : null,
    contribucionesUfYear: price ? contribucionesUfYear(price, ufv, cfg.contribuciones) : 0,
    rentTaxPct: rm.rentTaxPct,
    appreciationReal: val.appreciationReal, marketValueFactor: 1, saleCostPct: val.saleCostPct,
    horizonYears: val.horizonYears, startMonthIndex: monthIndexSantiago(), ufInflation: val.ufInflation, discountRateReal: val.discountRateReal,
    str: ufv ? {
      adrUf: air.adrClp / ufv, occupancy: air.occupancy, occupancyByMonth: air.occupancyByMonth, avgStayNights: air.avgStayNights,
      cleaningFeeUf: air.cleaningFeeClp / ufv, cleaningCostUf: air.cleaningCostClp / ufv, suppliesPerNightUf: air.suppliesPerNightClp / ufv,
      platformFeePct: air.platformFeePct, cohostPct: air.cohostPct, utilitiesUfMonth: air.utilitiesClpMonth / ufv,
      replacementPct: air.replacementPct, ivaApplies: air.ivaApplies, ivaRate: air.ivaRate,
    } : undefined,
  };
  return deepMerge(inp, overrides);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  }
  return out;
}

/**
 * @param {object} project
 * @param {object} unit
 * @param {object} ctx  buildContext()
 * @param {{mode?:'tradicional'|'renta_corta', overrides?:object, profile?:string, weights?:object, mc?:boolean|number, radiusM?:number}} opt
 */
export function analyzeUnit(project, unitIn, ctx, opt = {}) {
  const cfg = ctx.config;
  let unit = unitIn;
  if (!unit.useful_m2) {
    const typ = (cfg.typicalM2 || {})[String(Math.min(unit.bedrooms ?? 1, 3))];
    if (typ) unit = { ...unit, useful_m2: typ, m2_assumed: true };
  }
  const mode = opt.mode || 'tradicional';
  const ufv = ctx.uf?.value;
  const a = { project, unit, mode, ufValue: ufv, ufDate: ctx.uf?.date };
  a.status = deliveryStatus(project, ctx.today, cfg.status);
  const mtd = monthsToDelivery(a.status);
  a.monthsToDelivery = mtd;
  a.deliveryMonths = mtd ?? 0;
  a.deliveryAssumed = mtd == null;
  a.priceUf = unitPrice(unit);
  a.priceClp = a.priceUf && ufv ? a.priceUf * ufv : null;
  a.pricePerM2Uf = a.priceUf && unit.useful_m2 ? a.priceUf / unit.useful_m2 : null;
  a.priceAgeDays = project.observed_at ? Math.round((Date.parse(ctx.today) - Date.parse(project.observed_at.slice(0, 10))) / 86400000) : null;
  a.priceEvidence = (project.evidence || []).map((e) => e.verification_status);
  a.geoPrecision = project.geo_precision || (project.lat != null ? 'exacta' : 'pendiente');
  a.hasGeo = project.lat != null && project.lon != null;
  a.microsector = a.hasGeo ? microsectorOf(project, cfg) : null;
  a.needsMicrosector = (cfg.communes.microsectorsOnly || []).includes(project.commune);
  if (a.hasGeo) {
    a.metro = nearestStation(project, ctx);
    a.near = nearestByCategory(project, ctx);
    const svc = servicesScore(a.metro, a.near, cfg.services);
    a.servicesScore = svc.score; a.servicesWhy = svc.why;
    a.tourism = tourismIndex(project, ctx);
    a.nearby = nearbyDevelopments(project, ctx);
    a.newSupplyNearby = ctx.projects.filter((q) => q !== project && !!q.demo === !!project.demo && q.lat != null
      && (q.delivery?.status === 'futura') && haversine(project.lon, project.lat, q.lon, q.lat) <= 1000).length;
  } else {
    a.near = {}; a.nearby = []; a.newSupplyNearby = 0; a.tourism = { score: null, count: 0 };
  }
  const sec = cfg.security?.byCommune?.[project.commune];
  a.securityIndex = sec?.index ?? null;
  a.security = sec || null;
  // Arriendo
  const radiusM = opt.radiusM || cfg.rentals.radiusM;
  a.rent = a.hasGeo ? rentAnalysis(project, unit, ctx.rentals, { radiusM, areaTolerance: cfg.rentals.areaTolerance, minSample: cfg.rentals.minSample, ufClp: ufv }) : null;
  if (a.rent?.estimate) { a.rentEstimate = a.rent.estimate; a.rentSource = 'comparables'; }
  else {
    const ref = project.demo ? null : referenceEstimate(project.commune, unit, ctx.references, cfg.rentals.areaElasticity, cfg.typicalM2);
    if (ref) { a.rentEstimate = ref; a.rentSource = 'referencia'; } else { a.rentEstimate = null; a.rentSource = 'sin_datos'; }
  }
  if (opt.rentClpOverride) {
    a.rentEstimate = { lowClp: opt.rentClpOverride * 0.9, baseClp: opt.rentClpOverride, highClp: opt.rentClpOverride * 1.1, method: 'ingresado por el usuario', confidence: 'usuario', source: 'supuesto del usuario' };
    a.rentSource = 'usuario';
  }
  a.gc = estimateCommonExpenses(project, unit, { listings: ctx.rentals, cfg: cfg.commonExpenses });
  // Finanzas y plan de pago personal (caja de hoy + ahorro mensual + pie en cuotas)
  a.terms = paymentTerms(project, unit, a, cfg);
  a.input = financeInput(project, unit, a, ctx, mode, opt.overrides);
  a.base = a.priceUf ? simulate(a.input) : null;
  a.plan = a.base ? cashPlan(a.base, cfg.investor, { ufValue: ufv, terms: { ...a.terms, installmentsMax: a.input.pieInstallmentsMax, postDelivery: a.input.piePostDelivery } }) : null;
  if (a.plan && a.plan.upfrontUf > 1e-6 && !(opt.overrides && 'pieUpfrontUf' in opt.overrides)) {
    // El pie que adelantas cambia el calendario de aportes (y la TIR), no el flujo del depto.
    a.input = { ...a.input, pieUpfrontUf: a.plan.upfrontUf };
    a.base = simulate(a.input);
  }
  if (a.plan && a.plan.status === 'no_alcanzable' && a.input.creditPct < a.input.maxCreditPct - 1e-9) {
    const alt = simulate({ ...a.input, creditPct: a.input.maxCreditPct, pieUpfrontUf: 0, skipIrr: true });
    const p2 = cashPlan(alt, cfg.investor, { ufValue: ufv, terms: { ...a.terms, installmentsMax: a.input.pieInstallmentsMax, postDelivery: a.input.piePostDelivery } });
    a.planMaxCredit = p2 && { creditPct: a.input.maxCreditPct, status: p2.status, label: p2.short, minInstallmentsNeeded: p2.minInstallmentsNeeded,
      cuotaUf: p2.cuotaUf, cuotas: p2.cuotas, marginUf: p2.marginUf, monthlyCfUf: alt.metrics.monthlyCf };
  }
  a.metrics = a.base?.metrics || {};
  a.structure = a.base?.structure || { warnings: ['Sin precio: no se puede simular'] };
  a.scenarios = a.priceUf ? runScenarios(a.input, cfg.scenarios) : {};
  if (a.base && ufv) {
    const debtClp = (a.metrics.dividend + (a.base.schedule.rows[0]?.desgravamen || 0)) * ufv;
    a.requiredIncomeClp = requiredIncomeClp(debtClp, cfg.financing.incomeRatio);
  }
  // Riesgo, evidencia y score
  a.strStatus = project.short_term_rental?.status || 'por_verificar';
  a.evidence = evidenceScore({
    priceAgeDays: a.priceAgeDays, hasUrl: !!project.publication_url, hasBrochure: !!project.brochure_url,
    geoPrecision: a.geoPrecision, geoReview: !!project.geo_review, rentSource: a.rentSource === 'usuario' ? 'sin_datos' : a.rentSource,
    compsN: a.rent?.counts?.used ?? 0, minComps: cfg.rentals.minSample, gcKind: a.gc?.kind, deliveryVerified: a.status.code !== 'gris',
  });
  if (!a.priceEvidence.some((s) => ACCEPTED_PRICE_EVIDENCE.has(s))) a.evidence.score = Math.min(a.evidence.score, 45);
  a.risk = riskScores({
    metrics: a.metrics, metroDistance: a.metro?.distance ?? null, rentSource: a.rentSource, compsActive: a.rent?.counts?.homogeneous,
    newSupplyNearby: a.newSupplyNearby, communeLiquidity: cfg.communeLiquidity?.[project.commune] ?? null, priceUf: a.priceUf,
    monthsToDelivery: mtd, gcKind: a.gc?.kind, evidenceScore: a.evidence.score, mode, strStatus: a.strStatus,
  }, cfg.risk.weights);
  if (opt.mc && a.base && a.input.rentUf > 0) {
    const iters = typeof opt.mc === 'number' ? opt.mc : cfg.risk.monteCarlo.iterations;
    a.mc = monteCarlo(a.input, { ...cfg.risk.monteCarlo, iterations: iters }, { reserveUf: opt.reserveUf ?? cfg.investor.reserveUf ?? cfg.risk.defaultReserveUf });
  }
  a.components = componentScores(a);
  const profileKey = opt.profile || cfg.ranking.profile;
  const weights = opt.weights || cfg.ranking.profiles[profileKey].weights;
  a.profileScore = scoreWithProfile(a.components, weights);
  a.score = a.profileScore.score;
  a.gates = qualityGates(a, cfg.ranking.gates);
  if (!a.priceEvidence.some((s) => ACCEPTED_PRICE_EVIDENCE.has(s))) a.gates.fails.push('Precio extraído de búsqueda web: confirmar con la inmobiliaria');
  if (unit.reference) a.gates.fails.push(unit.hypothetical ? 'Unidad hipotética armada con el precio "desde"' : 'Precio "desde" referencial: no es una unidad concreta');
  if (unit.m2_assumed) a.gates.fails.push(`Superficie supuesta (${unit.useful_m2} m² típicos de la tipología)`);
  if (a.needsMicrosector && !a.microsector) a.gates.fails.push(`${project.commune}: fuera de los microsectores definidos`);
  if (a.deliveryAssumed) a.gates.fails.push('Fecha de entrega no verificada: se simuló como entrega inmediata');
  if (a.rentSource === 'usuario') a.gates.fails.push('Arriendo ingresado a mano');
  a.gates.passed = a.gates.fails.length === 0;
  a.appreciation = appreciationPotential(a.nearby.filter((n) => n.dev.status === 'publicado'), cfg.ranking.appreciation);
  a.explanation = explain(a, a.profileScore);
  return a;
}

/** Analiza todas las unidades de un proyecto y elige la de mejor score como representativa. */
export function analyzeProject(project, ctx, opt = {}) {
  const units = (project.units || []).filter((u) => unitPrice(u));
  const results = units.map((u) => analyzeUnit(project, u, ctx, opt));
  results.sort((x, y) => y.score - x.score);
  return { project, units: results, best: results[0] || null };
}

/** Comunas activas y microsectores: ¿se muestra este proyecto con los filtros por defecto? */
export function inActiveZone(project, cfg) {
  return (cfg.communes.active || []).includes(project.commune);
}

export function communeOfPoint(lon, lat, communesGeo) {
  const f = communesGeo.find((c) => pointInGeometry([lon, lat], c.geometry));
  return f?.properties?.name || null;
}
