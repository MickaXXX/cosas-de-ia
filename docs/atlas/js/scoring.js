/* Score de oportunidad 0–100, explicable y configurable por perfil.
 *
 * - Cada componente se normaliza a 0–100 con tramos lineales documentados (TRANSFORMS).
 * - Un dato faltante nunca sube el puntaje: el componente toma un valor bajo (missing).
 * - La plusvalía potencial va en un score aparte (es proyectiva), nunca mezclada con el
 *   flujo observado.
 * - Puertas de calidad: sin precio reciente, ubicación confiable, arriendo con comparables
 *   suficientes, financiamiento posible y estado de entrega verificado, la unidad va a la
 *   lista "Calificación provisional / faltan datos", no al top de oportunidades reales.
 */
import { lerp } from './risk.js';

export const COMPONENTS = {
  flujo: { label: 'Flujo y cobertura de deuda', missing: 20 },
  vacancia: { label: 'Facilidad de arrendar', missing: 25 },
  rentabilidad_capital: { label: 'Rentabilidad sobre capital propio', missing: 20 },
  rentabilidad_neta: { label: 'Rentabilidad neta sin deuda', missing: 20 },
  liquidez: { label: 'Liquidez para revender', missing: 25 },
  seguridad_servicios: { label: 'Seguridad y servicios del entorno', missing: 30 },
  evidencia: { label: 'Calidad de la evidencia', missing: 0 },
};

export const TRANSFORMS = {
  dscr: [[0.5, 0], [0.8, 25], [1.0, 50], [1.2, 75], [1.5, 100]],
  cashOnCash: [[-0.15, 0], [-0.05, 25], [0, 45], [0.04, 75], [0.08, 100]],
  capRate: [[0.02, 0], [0.03, 30], [0.04, 60], [0.05, 85], [0.06, 100]],
};

export function evidenceScore({ priceAgeDays, hasUrl, hasBrochure, geoPrecision, geoReview, rentSource, compsN, minComps = 8, gcKind, deliveryVerified }) {
  const parts = [];
  const add = (pts, label) => { parts.push({ pts, label }); return pts; };
  let s = 0;
  s += add(priceAgeDays == null ? 0 : priceAgeDays <= 30 ? 25 : priceAgeDays <= 60 ? 15 : 5, `precio observado ${priceAgeDays == null ? 'sin fecha' : `hace ${priceAgeDays} días`}`);
  s += add((hasUrl ? 10 : 0) + (hasBrochure ? 5 : 0), hasUrl ? 'fuente con enlace' : 'sin enlace a la fuente');
  s += add(geoReview ? 2 : ({ exacta: 15, calle: 10, aproximada: 4 }[geoPrecision] ?? 0), `ubicación ${geoReview ? 'por revisar' : geoPrecision || 'sin dato'}`);
  s += add(rentSource === 'comparables' ? (compsN >= minComps * 2 ? 25 : 20) : rentSource === 'referencia' ? 8 : 0,
    rentSource === 'comparables' ? `${compsN} comparables` : rentSource === 'referencia' ? 'arriendo de referencia comunal' : 'sin arriendo');
  s += add(gcKind === 'PUBLICADO' ? 10 : gcKind === 'ESTIMADO' ? 4 : 0, `gasto común ${gcKind?.toLowerCase() || 'sin dato'}`);
  s += add(deliveryVerified ? 10 : 0, deliveryVerified ? 'entrega verificada' : 'entrega no verificada');
  return { score: Math.round(s), parts };
}

export function componentScores(a) {
  const c = {};
  c.flujo = lerp(a.metrics.dscr, TRANSFORMS.dscr);
  c.vacancia = a.risk?.dims?.vacancia ? 100 - a.risk.dims.vacancia.score : null;
  c.rentabilidad_capital = lerp(a.metrics.cashOnCash, TRANSFORMS.cashOnCash);
  c.rentabilidad_neta = lerp(a.metrics.capRate, TRANSFORMS.capRate);
  c.liquidez = a.risk?.dims?.liquidez ? 100 - a.risk.dims.liquidez.score : null;
  const sec = a.securityIndex, svc = a.servicesScore;
  c.seguridad_servicios = sec == null && svc == null ? null : ((sec ?? COMPONENTS.seguridad_servicios.missing) + (svc ?? COMPONENTS.seguridad_servicios.missing)) / 2;
  c.evidencia = a.evidence?.score ?? null;
  for (const k of Object.keys(c)) if (c[k] == null) c[k] = COMPONENTS[k].missing;
  return c;
}

export function scoreWithProfile(components, weights) {
  let tw = 0, ts = 0;
  const contrib = [];
  for (const [k, w] of Object.entries(weights)) {
    if (!(k in components) || !w) continue;
    tw += w;
    ts += w * components[k];
    contrib.push({ key: k, weight: w, value: components[k], points: (w * components[k]) / 100 });
  }
  return { score: tw ? ts / tw : 0, contrib: contrib.sort((x, y) => y.points - x.points) };
}

export function qualityGates(a, gates) {
  const fails = [];
  if (a.project.demo) fails.push('Dato DEMO: nunca entra al ranking real');
  if (a.priceAgeDays == null || a.priceAgeDays > gates.maxPriceAgeDays) fails.push(`Precio sin verificar en los últimos ${gates.maxPriceAgeDays} días`);
  if (!a.project.publication_url && !(a.project.evidence || []).some((e) => e.source_url)) fails.push('Precio sin fuente enlazada');
  if (!gates.geoPrecision.includes(a.geoPrecision) || a.project.geo_review) fails.push('Ubicación aproximada o por revisar');
  if (a.rentSource !== 'comparables' || (a.rent?.counts?.used ?? 0) < gates.minComps) fails.push(`Arriendo sin ${gates.minComps} comparables homogéneos en el radio`);
  if (a.structure.warnings.some((w) => /imposible|supera el máximo/.test(w))) fails.push('Financiamiento no factible con los parámetros actuales');
  if (a.status.code === 'gris') fails.push(`Entrega/stock sin verificar: ${a.status.reason}`);
  if (a.mode === 'renta_corta' && a.strStatus !== 'permitido_verificado') fails.push('Renta corta no verificada en el reglamento de copropiedad');
  return { passed: fails.length === 0, fails };
}

/** Plusvalía potencial (proyectiva, score aparte): obras futuras cercanas ponderadas por
 *  etapa y certeza, y distancia. No es valorización asegurada. */
export function appreciationPotential(nearbyDevelopments, cfg) {
  const stageW = cfg.stageWeights;
  const certW = { alta: 1, media: 0.7, baja: 0.4 };
  let s = 0;
  const reasons = [];
  for (const { dev, distance } of nearbyDevelopments) {
    if (dev.impact === 'negativo_transitorio') continue;
    const radius = dev.radius_m || 1000;
    if (distance > radius) continue;
    const prox = 1 - distance / radius;
    const typeW = cfg.typeWeights[dev.type] ?? 0.3;
    const pts = 40 * typeW * (stageW[dev.stage] ?? 0.2) * (certW[dev.certainty] ?? 0.5) * (0.4 + 0.6 * prox);
    if (pts >= 1) reasons.push({ name: dev.name, pts, distance, stage: dev.stage });
    s += pts;
  }
  return { score: Math.min(100, s), reasons: reasons.sort((x, y) => y.pts - x.pts).slice(0, 5),
    label: 'Proyección: depende de obras que pueden atrasarse o no concretarse.' };
}

const fmtPct = (x) => (x == null ? 's/d' : `${(x * 100).toFixed(1).replace('.', ',')}%`);

export function explain(a, profileScore) {
  const c = a.components;
  const textFor = {
    flujo: () => `cobertura de deuda ${a.metrics.dscr?.toFixed(2).replace('.', ',') ?? 's/d'} y flujo mensual ${a.metrics.monthlyCf >= 0 ? 'positivo' : 'negativo'}`,
    vacancia: () => a.risk.dims.vacancia.why,
    rentabilidad_capital: () => `rentabilidad sobre capital ${fmtPct(a.metrics.cashOnCash)}`,
    rentabilidad_neta: () => `rentabilidad neta sin deuda ${fmtPct(a.metrics.capRate)}`,
    liquidez: () => a.risk.dims.liquidez.why,
    seguridad_servicios: () => a.servicesWhy || 'entorno con servicios',
    evidencia: () => `evidencia ${a.evidence.score}/100`,
  };
  const ranked = Object.keys(c).sort((x, y) => c[y] - c[x]);
  const top = profileScore.contrib.slice(0, 2).map((x) => COMPONENTS[x.key].label.toLowerCase());
  return {
    why: `Aparece por ${top.join(' y ')}.`,
    pros: ranked.slice(0, 3).map((k) => `${COMPONENTS[k].label}: ${textFor[k]()}`),
    cons: Object.entries(a.risk.dims).sort((x, y) => y[1].score - x[1].score).slice(0, 3)
      .map(([k, v]) => `${k[0].toUpperCase() + k.slice(1)}: ${v.why}`),
    pending: a.gates.fails,
  };
}
