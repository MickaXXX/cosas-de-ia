/* Tasador comparativo de arriendo tradicional en un radio (2 km por defecto).
 *
 * Reglas:
 *  - Solo avisos realmente publicados (o importados con autorización). Un aviso retirado
 *    no se asume arrendado. Los precios son PEDIDOS, no contratos cerrados.
 *  - Comparables homogéneos: mismos dormitorios, superficie ±tolerancia (20% por defecto),
 *    amoblado con amoblado y sin amoblar con sin amoblar. Nunca se mezclan datos DEMO con
 *    datos reales.
 *  - Deduplicación por id y, entre portales, por ubicación + precio + dormitorios + m².
 *  - Extremos fuera de 1,5 × rango intercuartílico se excluyen del cálculo, pero el
 *    mínimo y máximo originales quedan visibles con la explicación.
 *  - Con menos de minSample (8) comparables: "evidencia insuficiente". Se muestran los
 *    avisos, pero no se reportan estadísticos como si fueran robustos.
 *  - Arriendo base = mediana (o mediana de CLP/m² × m² de la unidad), nunca el máximo.
 */
import { haversine } from './geo.js';

/** Cuantil con interpolación lineal (tipo 7, el de Excel/NumPy por defecto). */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, median: quantile(v, 0.5), min: v[0], max: v[n - 1], p25: quantile(v, 0.25), p75: quantile(v, 0.75), sd };
}

const fingerprint = (r) => (r.lat == null || r.lon == null ? null
  : [r.lat.toFixed(4), r.lon.toFixed(4), Math.round(r.price_clp / 1000), r.bedrooms, Math.round(r.useful_m2 || 0)].join('|'));

export function dedupe(listings) {
  const byId = new Set(), byFp = new Set();
  const unique = [], duplicates = [];
  for (const r of listings) {
    const fp = fingerprint(r);
    if (byId.has(r.id) || (fp && byFp.has(fp))) { duplicates.push(r); continue; }
    byId.add(r.id);
    if (fp) byFp.add(fp);
    unique.push(r);
  }
  return { unique, duplicates };
}

export function iqrFilter(items, valueFn, k = 1.5) {
  const vals = items.map(valueFn).filter(Number.isFinite).sort((a, b) => a - b);
  if (vals.length < 4) return { kept: items, outliers: [], bounds: null };
  const q1 = quantile(vals, 0.25), q3 = quantile(vals, 0.75), iqr = q3 - q1;
  const lo = q1 - k * iqr, hi = q3 + k * iqr;
  const kept = [], outliers = [];
  for (const it of items) {
    const x = valueFn(it);
    (x < lo || x > hi ? outliers : kept).push(it);
  }
  return { kept, outliers, bounds: [lo, hi] };
}

export function withinRadius(lon, lat, listings, radiusM) {
  const out = [];
  for (const r of listings) {
    if (r.lat == null || r.lon == null) continue;
    const d = haversine(lon, lat, r.lon, r.lat);
    if (d <= radiusM) out.push({ ...r, distance: d });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/**
 * @param {{lat:number, lon:number, demo?:boolean}} project
 * @param {{bedrooms:number, useful_m2?:number, furnished?:boolean}} unit
 * @param {Array} listings  avisos (reales y/o demo; se filtra según project.demo)
 * @param {{radiusM?:number, areaTolerance?:number, minSample?:number, requireArea?:boolean, ufClp?:number}} opts
 */
export function rentAnalysis(project, unit, listings, opts = {}) {
  const { radiusM = 2000, areaTolerance = 0.2, minSample = 8, ufClp = null } = opts;
  const demo = !!project.demo;
  const pool = (listings || []).filter((r) => !!r.demo === demo);
  const { unique, duplicates } = dedupe(pool);
  const inRadius = withinRadius(project.lon, project.lat, unique, radiusM);
  const excluded = duplicates.map((r) => ({ listing: r, reason: 'duplicado (mismo aviso en otra fuente o repetido)' }));
  const homog = [];
  const wantFurnished = !!unit.furnished;
  for (const r of inRadius) {
    if (r.bedrooms !== unit.bedrooms) { excluded.push({ listing: r, reason: `dormitorios distintos (${r.bedrooms})` }); continue; }
    if (r.furnished != null && !!r.furnished !== wantFurnished) { excluded.push({ listing: r, reason: r.furnished ? 'amoblado (se compara sin amoblar)' : 'sin amoblar (se compara amoblado)' }); continue; }
    if (unit.useful_m2 && r.useful_m2) {
      const rel = Math.abs(r.useful_m2 - unit.useful_m2) / unit.useful_m2;
      if (rel > areaTolerance) { excluded.push({ listing: r, reason: `superficie fuera de ±${Math.round(areaTolerance * 100)}% (${r.useful_m2} m²)` }); continue; }
    } else if (opts.requireArea) { excluded.push({ listing: r, reason: 'sin superficie informada' }); continue; }
    homog.push(r);
  }
  const rawStats = stats(homog.map((r) => r.price_clp));
  const { kept, outliers, bounds } = iqrFilter(homog, (r) => r.price_clp);
  for (const r of outliers) excluded.push({ listing: r, reason: 'valor extremo (fuera de 1,5 × rango intercuartílico)' });
  const priceStats = stats(kept.map((r) => r.price_clp));
  const withArea = kept.filter((r) => r.useful_m2 > 0);
  const m2Stats = stats(withArea.map((r) => r.price_clp / r.useful_m2));
  const insufficient = priceStats.n < minSample;
  let estimate = null;
  if (!insufficient) {
    const byM2 = unit.useful_m2 && withArea.length >= minSample;
    const base = byM2 ? m2Stats.median * unit.useful_m2 : priceStats.median;
    const low = byM2 ? m2Stats.p25 * unit.useful_m2 : priceStats.p25;
    const high = byM2 ? m2Stats.p75 * unit.useful_m2 : priceStats.p75;
    estimate = {
      lowClp: low, baseClp: base, highClp: high,
      method: byM2 ? 'mediana de CLP/m² de comparables × m² útiles de la unidad' : 'mediana del arriendo de comparables',
      confidence: priceStats.n >= minSample * 2 ? 'alta' : 'media',
      source: `${priceStats.n} avisos en ${(radiusM / 1000).toFixed(1)} km`,
    };
  }
  const cutoffs = kept.map((r) => r.observed_at).filter(Boolean).sort();
  return {
    radiusM, minSample, insufficient,
    counts: { pool: pool.length, inRadius: inRadius.length, homogeneous: homog.length, used: kept.length,
      duplicates: duplicates.length, outliers: outliers.length,
      geoPrecise: inRadius.filter((r) => r.geo_precision === 'exacta' || r.geo_precision === 'calle').length },
    stats: insufficient ? null : priceStats,
    statsUf: insufficient || !ufClp ? null : Object.fromEntries(Object.entries(priceStats).map(([k, v]) => [k, k === 'n' ? v : v / ufClp])),
    statsPerM2: insufficient ? null : m2Stats,
    observedRaw: rawStats.n ? { min: rawStats.min, max: rawStats.max } : null,
    outlierBounds: bounds,
    estimate,
    comps: kept,
    excluded,
    cutoffDate: cutoffs.length ? cutoffs[cutoffs.length - 1] : null,
    priceKind: 'pedido',
  };
}

/** Respaldo cuando no hay comparables suficientes: referencia comunal publicada por
 *  terceros (promedio por tipología o por m²). Confianza baja y etiqueta explícita: no es
 *  un radio de 2 km. Si la referencia trae superficie (ref_m2), se ajusta con
 *  arriendo ∝ m²^elasticidad (los departamentos chicos rinden más por m²). */
export function referenceEstimate(commune, unit, references, elasticity = 0.7, typicalM2 = null) {
  const refs = (references || []).filter((r) => r.commune === commune);
  if (!refs.length) return null;
  const typ = unit.bedrooms === 0 ? 'estudio' : `${Math.min(unit.bedrooms, 3)}D`;
  let ref = refs.find((r) => r.typology === typ) || refs.find((r) => r.typology === 'todas');
  let refM2 = ref?.ref_m2 ?? null;
  let assumedRefM2 = false;
  if (!ref && typicalM2) {
    // Solo hay otra tipología (p. ej. 1D): se ajusta por superficie suponiendo su m² típico.
    ref = refs.find((r) => /^\dD$/.test(r.typology) && typicalM2[r.typology[0]]);
    if (ref) { refM2 = typicalM2[ref.typology[0]]; assumedRefM2 = true; }
  }
  if (!ref) return null;
  let base = ref.value_clp;
  let method = `referencia comunal ${ref.typology === 'todas' ? 'general' : ref.typology}`;
  if (refM2 && unit.useful_m2) {
    const factor = Math.pow(unit.useful_m2 / refM2, elasticity);
    base *= factor;
    method += ` ajustada por superficie (${unit.useful_m2} m² vs ${refM2} m²${assumedRefM2 ? ' supuestos para la tipología de referencia' : ''}, elasticidad ${elasticity})`;
  }
  return {
    lowClp: base * 0.88, baseClp: base, highClp: base * 1.12, method,
    confidence: 'baja', source: `${ref.source_name} (${ref.period})`, source_url: ref.source_url, isReference: true,
    note: ref.note || null,
  };
}

/** Histograma simple para el gráfico de distribución. */
export function histogram(values, bins = 8) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return [];
  const min = Math.min(...v), max = Math.max(...v);
  const w = (max - min) / bins || 1;
  const out = Array.from({ length: bins }, (_, i) => ({ from: min + i * w, to: min + (i + 1) * w, count: 0 }));
  for (const x of v) out[Math.min(bins - 1, Math.floor((x - min) / w))].count++;
  return out;
}
