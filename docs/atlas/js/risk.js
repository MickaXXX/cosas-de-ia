/* Riesgo de pérdida: puntaje multidimensional y simulación Monte Carlo.
 *
 * Las probabilidades que salen de aquí son SIMULADAS: dependen de distribuciones
 * supuestas (editables en Configuración → riesgo) y no son frecuencias observadas.
 * La interfaz las rotula así y muestra los parámetros usados.
 */
import { simulate } from './finance.js';

/** PRNG reproducible (mulberry32): misma semilla ⇒ mismos resultados. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function pickDiscrete(r, dist) {
  const x = r();
  let acc = 0;
  for (const [value, p] of dist) { acc += p; if (x <= acc) return value; }
  return dist[dist.length - 1][0];
}

function triangular(r, a, c, b) {
  if (!(b > a)) return c;
  const u = r(), f = (c - a) / (b - a);
  return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

const percentile = (arr, q) => {
  const s = [...arr].sort((x, y) => x - y);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

/**
 * Simula los primeros `years` años de operación con shocks correlacionados.
 * Un factor de mercado común z empuja a la vez el arriendo a la baja y la vacancia al alza
 * (en un mercado débil ambas cosas pasan juntas).
 */
export function monteCarlo(baseInput, mc, { reserveUf = 0, years = 3 } = {}) {
  const r = rng(mc.seed || 1);
  const n = mc.iterations || 1000;
  const firstYear = [], window = [], worst = [], deficits = [];
  let negYear = 0, overReserve = 0, anyNeg12 = 0;
  for (let i = 0; i < n; i++) {
    const z = normal(r);
    const rentShock = Math.exp((mc.rentSd || 0.08) * (0.7 * z + 0.714 * normal(r)));
    const rentLowHigh = baseInput._rentBand;
    const rentBase = rentLowHigh ? triangular(r, rentLowHigh[0], baseInput.rentUf, rentLowHigh[1]) : baseInput.rentUf;
    const tilt = z < -1 ? mc.badMarketVacancy : mc.vacancyMonths;
    const inp = {
      ...baseInput,
      horizonYears: Math.min(baseInput.horizonYears, Math.ceil((baseInput.deliveryMonths || 0) / 12) + years + 1),
      rentUf: rentBase * rentShock,
      initialVacancyMonths: pickDiscrete(r, tilt),
      turnoverVacancyMonths: pickDiscrete(r, tilt),
      commonExpensesUf: baseInput._gcBand ? baseInput._gcBand[0] + r() * (baseInput._gcBand[1] - baseInput._gcBand[0]) : baseInput.commonExpensesUf,
      deliveryDelayMonths: (baseInput.deliveryMonths || 0) > 0 ? pickDiscrete(r, mc.deliveryDelay) : 0,
    };
    if (inp.mode === 'renta_corta') {
      const occF = Math.max(0.2, 1 + (mc.occupancySd || 0.15) * (0.7 * z + 0.714 * normal(r)));
      inp.str = { ...inp.str, occupancy: Math.min(0.98, inp.str.occupancy * occF),
        occupancyByMonth: inp.str.occupancyByMonth.map((o) => (o == null ? null : Math.min(0.98, o * occF))) };
    }
    const res = simulate(inp);
    const D = res.metrics.deliveryMonths;
    const op = res.months.filter((m) => m.t > D);
    // Shock de mantención: con probabilidad anual p, un gasto imprevisto en un mes al azar.
    for (let y = 0; y < years; y++) {
      if (r() < (mc.capexShockProb || 0.1)) {
        const idx = Math.min(op.length - 1, y * 12 + Math.floor(r() * 12));
        if (idx >= 0) op[idx] = { ...op[idx], cf: op[idx].cf - triangular(r, mc.capexShockUf[0], mc.capexShockUf[1], mc.capexShockUf[2]) };
      }
    }
    const y1 = op.slice(0, 12).reduce((s, m) => s + m.cf, 0);
    firstYear.push(y1);
    if (y1 < 0) negYear++;
    let run = 0, minRun = 0;
    for (const m of op.slice(0, years * 12)) { run += m.cf; minRun = Math.min(minRun, run); }
    window.push(run);
    deficits.push(-minRun);
    if (-minRun > reserveUf) overReserve++;
    if (op.slice(0, 12).some((m) => m.cf < 0)) anyNeg12++;
    worst.push(Math.min(...op.slice(0, years * 12).map((m) => m.cf)));
  }
  return {
    iterations: n, seed: mc.seed, years,
    probNegativeFirstYear: negYear / n,
    probDeficitOverReserve: overReserve / n,
    probAnyNegativeMonth: anyNeg12 / n,
    firstYearCf: { p5: percentile(firstYear, 0.05), p50: percentile(firstYear, 0.5), p95: percentile(firstYear, 0.95) },
    cumCf: { p5: percentile(window, 0.05), p50: percentile(window, 0.5), p95: percentile(window, 0.95) },
    liquidityNeededUf: { p50: percentile(deficits, 0.5), p90: percentile(deficits, 0.9) },
    worstMonthCf: { p5: percentile(worst, 0.05), p50: percentile(worst, 0.5) },
    label: 'Probabilidad SIMULADA con supuestos editables; no es una frecuencia observada.',
  };
}

const lerp = (x, pts) => {
  if (x == null || !Number.isFinite(x)) return null;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
};
export { lerp };

/** Puntaje de riesgo 0–100 (100 = más riesgoso) por dimensión, con explicación.
 *  Falta de datos ⇒ riesgo más alto, nunca más bajo. */
export function riskScores(ctx, weights) {
  const d = {};
  const m = ctx.metrics;
  d.flujo = { score: lerp(m.dscr, [[0.5, 95], [0.8, 70], [1.0, 45], [1.25, 15], [1.6, 5]]) ?? 80,
    why: m.dscr == null ? 'Sin deuda o sin datos de cobertura' : `Cobertura de deuda (DSCR) ${m.dscr.toFixed(2)}` };
  let vac = 30, vacWhy = [];
  if (ctx.metroDistance == null) { vac += 15; vacWhy.push('distancia a Metro desconocida'); }
  else if (ctx.metroDistance > 1200) { vac += 20; vacWhy.push(`Metro a ${Math.round(ctx.metroDistance)} m`); }
  else if (ctx.metroDistance > 700) { vac += 8; vacWhy.push(`Metro a ${Math.round(ctx.metroDistance)} m`); }
  else vacWhy.push(`Metro a ${Math.round(ctx.metroDistance)} m`);
  if (ctx.rentSource === 'referencia') { vac += 15; vacWhy.push('arriendo sin comparables suficientes'); }
  if (ctx.rentSource === 'sin_datos') { vac += 30; vacWhy.push('sin estimación de arriendo'); }
  if (ctx.compsActive != null && ctx.compsActive > 40) { vac += 10; vacWhy.push(`${ctx.compsActive} avisos similares activos (competencia)`); }
  if (ctx.newSupplyNearby > 0) { vac += Math.min(15, ctx.newSupplyNearby * 3); vacWhy.push(`${ctx.newSupplyNearby} proyectos nuevos en 1 km`); }
  d.vacancia = { score: Math.min(100, vac), why: vacWhy.join(' · ') };
  let liq = 35, liqWhy = [];
  const cl = ctx.communeLiquidity;
  if (cl == null) { liq += 10; liqWhy.push('liquidez comunal sin dato'); } else { liq += (50 - cl) * 0.5; liqWhy.push(`liquidez de la comuna ${cl}/100 (supuesto editable)`); }
  if (ctx.metroDistance != null && ctx.metroDistance > 1000) { liq += 10; liqWhy.push('lejos del Metro'); }
  if (ctx.priceUf > 9000) { liq += 10; liqWhy.push('ticket alto: menos compradores'); }
  d.liquidez = { score: Math.max(0, Math.min(100, liq)), why: liqWhy.join(' · ') };
  const mt = ctx.monthsToDelivery;
  d.entrega = { score: mt == null ? 70 : mt === 0 ? 5 : mt <= 12 ? 30 : mt <= 24 ? 50 : 70,
    why: mt == null ? 'Fecha de entrega no verificada' : mt === 0 ? 'Entrega inmediata' : `Entrega en ~${mt} meses (riesgo de atraso y de tasación)` };
  d.costos = { score: ctx.gcKind === 'PUBLICADO' ? 20 : ctx.gcKind === 'ESTIMADO' ? 50 : 75,
    why: ctx.gcKind === 'PUBLICADO' ? 'Gasto común publicado' : 'Gasto común estimado (no publicado)' };
  d.datos = { score: 100 - (ctx.evidenceScore ?? 30), why: `Confianza de la evidencia ${ctx.evidenceScore ?? 30}/100` };
  if (ctx.mode === 'renta_corta') {
    const legal = ctx.strStatus;
    d.legal = { score: legal === 'permitido_verificado' ? 15 : legal === 'condicionado' ? 50 : 90,
      why: legal === 'permitido_verificado' ? 'Renta corta permitida y verificada' : 'Renta corta sin verificación legal en el reglamento de copropiedad' };
    d.estacionalidad = { score: 60, why: 'Ingresos dependen de ocupación y tarifa: supuestos sin fuente licenciada' };
  }
  let tw = 0, ts = 0;
  for (const [k, v] of Object.entries(d)) { const w = weights[k] ?? 0; tw += w; ts += w * v.score; }
  return { dims: d, total: tw ? ts / tw : null };
}

export function riskLabel(score) {
  if (score == null) return 'sin datos';
  if (score < 30) return 'bajo';
  if (score < 50) return 'moderado';
  if (score < 70) return 'alto';
  return 'muy alto';
}
