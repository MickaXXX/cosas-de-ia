// Pruebas del motor de Atlas. Correr con:  node --test tests/atlas/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { monthlyRate, annuityPayment, amortizationSchedule, balanceAfter, simulate, runScenarios, purchaseStructure, irr, occupancyAt, steadyState, withDefaults } from '../../docs/atlas/js/finance.js';
import { deliveryStatus, parseDeliveryDate, daysBetween } from '../../docs/atlas/js/status.js';
import { haversine, destination, circlePolygon, pointInGeometry, distanceToLine } from '../../docs/atlas/js/geo.js';
import { rentAnalysis, dedupe, stats, quantile, referenceEstimate } from '../../docs/atlas/js/rentals.js';
import { estimateCommonExpenses } from '../../docs/atlas/js/commonexp.js';
import { monteCarlo, rng } from '../../docs/atlas/js/risk.js';
import { scoreWithProfile } from '../../docs/atlas/js/scoring.js';
import { parseCSV, validateRows, buildProjects, parseNumber } from '../../docs/atlas/js/csv.js';
import { analyzeUnit, buildContext, contribucionesUfYear } from '../../docs/atlas/js/analysis.js';
import { clp, uf as fmtUf, ufToClp } from '../../docs/atlas/js/format.js';

const CONFIG = JSON.parse(readFileSync(new URL('../../docs/atlas/config/defaults.json', import.meta.url)));
const SCHEMA = JSON.parse(readFileSync(new URL('../../docs/atlas/config/import_schema.json', import.meta.url)));
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} esperado ${b}, obtenido ${a}`);

// ------------------------------------------------------------------ 1. colores de entrega
test('criterio 1: 365 días es amarillo y 366 es verde', () => {
  const today = '2026-10-12';
  const at = (days) => new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);
  const p = (date) => ({ delivery: { status: 'futura', date, date_status: 'estimada' } });
  assert.equal(daysBetween(today, at(365)), 365);
  assert.equal(deliveryStatus(p(at(365)), today).code, 'amarillo');
  assert.equal(deliveryStatus(p(at(366)), today).code, 'verde');
  assert.equal(deliveryStatus(p(at(1)), today).code, 'amarillo');
});

test('criterio 1: entrega inmediata solo con evidencia; desconocida o vencida es gris', () => {
  const today = '2026-10-12';
  assert.equal(deliveryStatus({ delivery: { immediate_verified: true, stock_verified: true, verified_at: '2026-10-01' } }, today).code, 'rojo');
  assert.equal(deliveryStatus({ delivery: { immediate_verified: true, stock_verified: false, verified_at: '2026-10-01' } }, today).code, 'gris');
  assert.equal(deliveryStatus({ delivery: { immediate_verified: true, stock_verified: true, verified_at: '2026-01-01' } }, today).code, 'gris', 'verificación vencida');
  // La fecha proyectada ya pasó: NO se asume entrega inmediata.
  assert.equal(deliveryStatus({ delivery: { status: 'futura', date: '2026-06', date_status: 'estimada' } }, today).code, 'gris');
  assert.equal(deliveryStatus({ delivery: {} }, today).code, 'gris');
  assert.equal(deliveryStatus({ delivery: { date: '2027-03', date_status: 'desconocida' } }, today).code, 'gris');
});

test('fecha con precisión de mes se lee como fin de mes', () => {
  assert.equal(parseDeliveryDate('2027-02').toISOString().slice(0, 10), '2027-02-28');
  assert.equal(parseDeliveryDate('2028-02').toISOString().slice(0, 10), '2028-02-29');
});

// ------------------------------------------------------------------ 2. geografía y comparables
test('criterio 2: distancia geoespacial de 2.000 m', () => {
  const [lon, lat] = destination(-70.61, -33.43, 45, 2000);
  close(haversine(-70.61, -33.43, lon, lat), 2000, 0.5);
  const circle = circlePolygon(-70.61, -33.43, 2000);
  assert.ok(pointInGeometry(destination(-70.61, -33.43, 120, 1990), circle));
  assert.ok(!pointInGeometry(destination(-70.61, -33.43, 120, 2015), circle));
  const line = { type: 'LineString', coordinates: [[-70.62, -33.44], [-70.60, -33.44]] };
  close(distanceToLine(-70.61, -33.44 + 500 / 110950, line), 500, 3);
});

function listing(id, distM, bearing, price, extra = {}) {
  const [lon, lat] = destination(-70.6, -33.45, bearing, distM);
  return { id, lon, lat, price_clp: price, bedrooms: 1, useful_m2: 38, furnished: false, observed_at: '2026-10-01', geo_precision: 'exacta', ...extra };
}

test('criterio 2: radio 2 km, deduplicación y homogeneidad', () => {
  const ls = [
    listing('a', 500, 10, 450000), listing('a', 500, 10, 450000),               // mismo id
    listing('b', 800, 90, 460000), { ...listing('b2', 800, 90, 460000) },         // mismo aviso en otro portal
    listing('c', 2100, 0, 300000),                                                 // fuera de radio
    listing('d', 900, 200, 470000, { bedrooms: 2 }),                               // otra tipología
    listing('e', 1000, 300, 480000, { furnished: true }),                          // amoblado
    listing('f', 1200, 270, 480000, { useful_m2: 60 }),                            // superficie fuera de ±20%
  ];
  const { unique, duplicates } = dedupe(ls);
  assert.equal(unique.length, 6);
  assert.equal(duplicates.length, 2);
  const r = rentAnalysis({ lon: -70.6, lat: -33.45 }, { bedrooms: 1, useful_m2: 38 }, ls, { minSample: 2 });
  assert.equal(r.counts.inRadius, 5);
  assert.deepEqual(r.comps.map((c) => c.id).sort(), ['a', 'b']);
  assert.ok(r.excluded.some((e) => /dormitorios/.test(e.reason)));
  assert.ok(r.excluded.some((e) => /amoblado/.test(e.reason)));
  assert.ok(r.excluded.some((e) => /superficie/.test(e.reason)));
});

test('datos DEMO nunca se mezclan con reales', () => {
  const ls = Array.from({ length: 10 }, (_, i) => listing(`d${i}`, 300 + i * 50, i * 30, 400000 + i * 1000, { demo: true }));
  const real = rentAnalysis({ lon: -70.6, lat: -33.45, demo: false }, { bedrooms: 1, useful_m2: 38 }, ls);
  assert.equal(real.counts.pool, 0);
  const demo = rentAnalysis({ lon: -70.6, lat: -33.45, demo: true }, { bedrooms: 1, useful_m2: 38 }, ls);
  assert.equal(demo.counts.used, 10);
});

// ------------------------------------------------------------------ 3. dividendo
test('criterio 3: dividendo reproduce simulador de mercado (tasa anual/12)', () => {
  // GoodProp: UF 3.249,18 al 3,80% a 30 años → UF 15,14
  close(annuityPayment(3249.18, monthlyRate(0.038), 360), 15.14, 0.005);
  close(annuityPayment(3249.18, monthlyRate(0.038), 300), 16.79, 0.005);
  close(annuityPayment(3249.18, monthlyRate(0.038), 240), 19.35, 0.005);
  // Rau Santa Lucía: UF 2.290,4 al 5% a 30 años → $505.720 con UF ≈ 41.131
  close(annuityPayment(2290.4, monthlyRate(0.05), 360) * 41131, 505720, 300);
});

test('criterio 3: amortización concilia y tasa nominal ≠ efectiva', () => {
  const s = amortizationSchedule({ principal: 3000, annualRate: 0.045, years: 30 });
  const sumAmort = s.rows.reduce((t, r) => t + r.amortization, 0);
  close(sumAmort, 3000, 1e-6, 'la amortización suma el capital');
  close(s.rows.at(-1).balance, 0, 1e-9);
  close(s.rows[119].balance, balanceAfter(3000, s.rMonthly, 360, 120), 1e-6, 'saldo insoluto cerrado = tabla');
  const nom = annuityPayment(3000, monthlyRate(0.045, 'nominal'), 360);
  const eff = annuityPayment(3000, monthlyRate(0.045, 'efectiva'), 360);
  assert.ok(nom > eff, 'con la misma tasa anual, la convención nominal da un dividendo mayor');
  close(Math.pow(1 + monthlyRate(0.045, 'efectiva'), 12) - 1, 0.045, 1e-12);
});

test('estructura de compra con bono pie: pie real y advertencia de tasación', () => {
  const st = purchaseStructure({ priceUf: 3610.2, bonoPiePct: 0.1, creditPct: 0.9 });
  close(st.credit, 3249.18, 1e-6);
  close(st.bono, 361.02, 1e-6);
  close(st.pie, 0, 1e-9);
  close(st.realPrice, 3249.18, 1e-6);
  assert.ok(st.warnings.some((w) => /tasación/.test(w)));
  const bad = purchaseStructure({ priceUf: 3000, bonoPiePct: 0.15, creditPct: 0.9 });
  assert.ok(bad.warnings.some((w) => /imposible/.test(w)));
});

// ------------------------------------------------------------------ 4. UF/CLP
test('criterio 4: conversión UF/CLP con valor de referencia y redondeo controlado', () => {
  assert.equal(ufToClp(2921, 41065.38), 2921 * 41065.38);
  assert.equal(clp(119951975.98), '$119.951.976');
  assert.equal(fmtUf(2921), 'UF 2.921,00');
  assert.equal(clp(-1500.4), '−$1.500');
  assert.equal(ufToClp(10, null), null, 'sin UF no se inventa un tipo de cambio');
});

// ------------------------------------------------------------------ 5. muestras chicas
test('criterio 5: menos de 8 comparables ⇒ evidencia insuficiente, sin estadísticos robustos', () => {
  const ls = Array.from({ length: 5 }, (_, i) => listing(`x${i}`, 300 + i * 100, i * 60, 420000 + i * 5000));
  const r = rentAnalysis({ lon: -70.6, lat: -33.45 }, { bedrooms: 1, useful_m2: 38 }, ls);
  assert.equal(r.insufficient, true);
  assert.equal(r.stats, null);
  assert.equal(r.estimate, null);
  assert.equal(r.comps.length, 5, 'los avisos se muestran igual');
  const ok = rentAnalysis({ lon: -70.6, lat: -33.45 }, { bedrooms: 1, useful_m2: 38 },
    Array.from({ length: 10 }, (_, i) => listing(`y${i}`, 300 + i * 100, i * 36, 400000 + i * 10000)));
  assert.equal(ok.insufficient, false);
  close(ok.stats.median, 445000, 1);
  assert.ok(ok.estimate.baseClp < ok.stats.max, 'el arriendo base nunca es el máximo');
});

test('extremos excluidos pero visibles', () => {
  const ls = Array.from({ length: 10 }, (_, i) => listing(`z${i}`, 300 + i * 100, i * 36, 400000 + i * 5000));
  ls.push(listing('outlier', 700, 45, 2500000));
  const r = rentAnalysis({ lon: -70.6, lat: -33.45 }, { bedrooms: 1, useful_m2: 38 }, ls);
  assert.equal(r.counts.outliers, 1);
  assert.equal(r.observedRaw.max, 2500000);
  assert.ok(r.stats.max < 2500000);
});

test('cuantiles tipo 7', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  const s = stats([10, 20, 30, 40, 50]);
  assert.deepEqual([s.min, s.p25, s.median, s.p75, s.max], [10, 20, 30, 40, 50]);
});

// ------------------------------------------------------------------ 6. Airbnb
function ctxWith(projects, rentals = []) {
  return buildContext({ projects, rentals, references: [], stations: [], pois: [], developments: [], config: CONFIG,
    uf: { value: 41000, date: '2026-10-12' }, today: '2026-10-12' });
}

const baseProject = (over = {}) => ({
  id: 'p', name: 'P', commune: 'Ñuñoa', lat: -33.45, lon: -70.6, geo_precision: 'exacta', observed_at: '2026-10-05',
  publication_url: 'https://example.cl/p', delivery: { status: 'inmediata', immediate_verified: true, stock_verified: true, verified_at: '2026-10-05' },
  evidence: [{ verification_status: 'verificado' }], units: [{ id: 'u1', bedrooms: 1, useful_m2: 38, offer_price_uf: 3200 }], ...over,
});

test('criterio 6: renta corta sin verificación legal no entra al top Airbnb', () => {
  const rentals = Array.from({ length: 12 }, (_, i) => listing(`r${i}`, 300 + i * 80, i * 30, 430000 + i * 4000));
  const p = baseProject({ short_term_rental: { status: 'por_verificar' } });
  const a = analyzeUnit(p, p.units[0], ctxWith([p], rentals), { mode: 'renta_corta' });
  assert.equal(a.gates.passed, false);
  assert.ok(a.gates.fails.some((f) => /Renta corta/.test(f)));
  assert.ok(a.risk.dims.legal.score >= 80);
  const pv = baseProject({ short_term_rental: { status: 'permitido_verificado' } });
  const b = analyzeUnit(pv, pv.units[0], ctxWith([pv], rentals), { mode: 'renta_corta' });
  assert.ok(!b.gates.fails.some((f) => /Renta corta/.test(f)));
});

// ------------------------------------------------------------------ 7. GC en vacancia
test('criterio 7: en vacancia el propietario paga el gasto común en todos los escenarios', () => {
  const inp = withDefaults({ priceUf: 3000, rentUf: 11, commonExpensesUf: 2.5, initialVacancyMonths: 2, horizonYears: 5, startMonthIndex: 0 });
  const res = runScenarios(inp, CONFIG.scenarios);
  for (const [name, r] of Object.entries(res)) {
    const op = r.months.filter((m) => m.phase === 'operacion');
    assert.ok(op.some((m) => m.occ < 1), `${name} tiene vacancia`);
    for (const m of op) close(m.gcOwner, r.input.commonExpensesUf * (1 - m.occ), 1e-9, `${name} mes ${m.t}`);
    assert.ok(r.metrics.monthlyNoi < r.input.rentUf, `${name}: el NOI descuenta costos`);
  }
  // Y cuando está arrendado, lo paga el arrendatario (por defecto).
  const r = simulate(inp);
  assert.ok(r.months.some((m) => m.occ === 1 && m.gcOwner === 0));
});

test('ocupación con vacancia inicial, contratos y rotación', () => {
  const p = { initialVacancyMonths: 1, leaseMonths: 12, turnoverVacancyMonths: 1 };
  assert.equal(occupancyAt(0, p).occ, 0);
  assert.deepEqual(occupancyAt(1, p), { occ: 1, leaseStart: true });
  assert.equal(occupancyAt(13, p).occ, 0);
  assert.equal(occupancyAt(14, p).leaseStart, true);
  const half = occupancyAt(0, { initialVacancyMonths: 0.5, leaseMonths: 12, turnoverVacancyMonths: 1 });
  close(half.occ, 0.5, 1e-12);
});

test('el equilibrio de arriendo deja el flujo estabilizado en cero', () => {
  const inp = withDefaults({ priceUf: 3000, rentUf: 11, commonExpensesUf: 2.5, contribucionesUfYear: 3 });
  const r = simulate(inp);
  const be = r.metrics.breakeven.rentUf;
  const r2 = simulate({ ...inp, rentUf: be });
  close(r2.metrics.monthlyCf, 0, 1e-9);
});

test('equilibrio Airbnb: ocupación y tarifa', () => {
  const inp = withDefaults({ mode: 'renta_corta', priceUf: 3000, commonExpensesUf: 2.5, str: { adrUf: 1.2, occupancy: 0.6, ivaApplies: true } });
  const r = simulate(inp);
  const occBE = r.metrics.breakeven.occupancy;
  const r2 = simulate({ ...inp, str: { ...inp.str, occupancy: occBE } });
  close(r2.metrics.monthlyCf, 0, 1e-6);
  const adrBE = r.metrics.breakeven.adrUf;
  const r3 = simulate({ ...inp, str: { ...inp.str, adrUf: adrBE } });
  close(r3.metrics.monthlyCf, 0, 1e-6);
});

test('compra en verde: pie en cuotas, crédito y arriendo empiezan tras la entrega; atraso empeora la TIR', () => {
  const inp = withDefaults({ priceUf: 3000, rentUf: 12, commonExpensesUf: 2, deliveryMonths: 12, creditPct: 0.8, horizonYears: 10 });
  const r = simulate(inp);
  assert.ok(r.months.slice(0, 12).every((m) => m.dividend === 0 && m.income === 0));
  close(r.months.slice(0, 12).reduce((s, m) => s + m.equity, 0), 600, 1e-6, 'pie del 20% en cuotas');
  assert.ok(r.months[13].dividend > 0);
  const late = simulate({ ...inp, deliveryDelayMonths: 12 });
  close(late.months.slice(0, 12).reduce((s, m) => s + m.equity, 0), 600, 1e-6, 'el atraso no estira las cuotas del pie');
  assert.ok(late.months.slice(0, 25).every((m) => m.income === 0), 'sin arriendo durante el atraso');
  assert.ok(late.months.slice(0, 120).reduce((s, m) => s + m.income, 0) < r.months.slice(0, 120).reduce((s, m) => s + m.income, 0));
  const sc = runScenarios(inp, CONFIG.scenarios);
  assert.ok(sc.estres.input.annualRate > inp.annualRate, 'en verde, el estrés sube la tasa de escritura');
  assert.ok(sc.estres.metrics.deliveryMonths === 24);
});

test('TIR de flujos conocidos', () => {
  close(irr([-100, 110]), 0.1, 1e-9);
  assert.equal(irr([100, 10]), null);
  // 30 años mensuales con aporte chico y venta al final: la TIR debe ser finita y razonable.
  const flows = [-50, ...Array(359).fill(-8), 2500];
  const m = irr(flows);
  assert.ok(m != null && m > -0.5 && m < 0.05, `TIR mensual ${m}`);
  close(flows.reduce((s, f, i) => s + f / Math.pow(1 + m, i), 0), 0, 1e-6);
});

test('compra con pie cero y bono: la TIR a 30 años no explota', () => {
  const r = simulate(withDefaults({ priceUf: 1930, bonoPiePct: 0.1, creditPct: 0.9, rentUf: 8.6, commonExpensesUf: 1.45, horizonYears: 30 }));
  assert.ok(r.metrics.irrReal == null || (r.metrics.irrReal > -1 && r.metrics.irrReal < 1), `TIR ${r.metrics.irrReal}`);
  for (const row of r.annual) assert.ok(row.irrReal == null || Math.abs(row.irrReal) < 5, `año ${row.years}: ${row.irrReal}`);
});

// ------------------------------------------------------------------ 8. stock
test('criterio 8: un proyecto sin stock verificado no se muestra como oferta inmediata', () => {
  const p = baseProject({ delivery: { status: 'inmediata', immediate_verified: true, stock_verified: false, verified_at: '2026-10-05' } });
  const a = analyzeUnit(p, p.units[0], ctxWith([p]));
  assert.equal(a.status.code, 'gris');
  assert.equal(a.gates.passed, false);
});

// ------------------------------------------------------------------ 9. ranking reproducible
test('criterio 9: el ranking cambia al editar pesos y es reproducible', () => {
  const A = { flujo: 90, rentabilidad_capital: 20 };
  const B = { flujo: 40, rentabilidad_capital: 90 };
  const w1 = { flujo: 80, rentabilidad_capital: 20 };
  const w2 = { flujo: 20, rentabilidad_capital: 80 };
  assert.ok(scoreWithProfile(A, w1).score > scoreWithProfile(B, w1).score);
  assert.ok(scoreWithProfile(A, w2).score < scoreWithProfile(B, w2).score);
  assert.equal(scoreWithProfile(A, w1).score, scoreWithProfile(A, w1).score);
});

test('Monte Carlo reproducible con la misma semilla y rotulado como simulado', () => {
  const inp = withDefaults({ priceUf: 3000, rentUf: 11, commonExpensesUf: 2.5, horizonYears: 30 });
  const mc = { ...CONFIG.risk.monteCarlo, iterations: 150 };
  const a = monteCarlo(inp, mc, { reserveUf: 30 });
  const b = monteCarlo(inp, mc, { reserveUf: 30 });
  assert.equal(a.probNegativeFirstYear, b.probNegativeFirstYear);
  assert.match(a.label, /SIMULADA/);
  const r = rng(1);
  assert.notEqual(r(), r());
});

test('la falta de datos no mejora el score', () => {
  const rentals = Array.from({ length: 12 }, (_, i) => listing(`r${i}`, 300 + i * 80, i * 30, 430000 + i * 4000));
  const full = baseProject();
  const a = analyzeUnit(full, full.units[0], ctxWith([full], rentals));
  const sparse = baseProject({ publication_url: null, observed_at: null, geo_precision: 'aproximada', evidence: [] });
  const b = analyzeUnit(sparse, sparse.units[0], ctxWith([sparse], rentals));
  assert.ok(b.evidence.score < a.evidence.score);
  assert.ok(b.score < a.score);
  assert.equal(a.gates.passed, true, a.gates.fails.join(' | '));
  assert.equal(b.gates.passed, false);
});

// ------------------------------------------------------------------ gasto común
test('gasto común: publicado > comparables > supuesto, siempre rotulado', () => {
  const cfg = CONFIG.commonExpenses;
  const pub = estimateCommonExpenses({ commune: 'Ñuñoa' }, { useful_m2: 40, common_expenses_clp: 95000 }, { cfg });
  assert.equal(pub.kind, 'PUBLICADO');
  const sup = estimateCommonExpenses({ commune: 'Ñuñoa', lat: -33.45, lon: -70.6 }, { useful_m2: 40 }, { cfg });
  assert.equal(sup.kind, 'ESTIMADO');
  close(sup.baseClp, 2730 * 40, 1e-6);
  const comps = Array.from({ length: 6 }, (_, i) => listing(`g${i}`, 300 + i * 100, i * 50, 400000, { common_expenses_clp: 80000 + i * 2000, useful_m2: 40 }));
  const byComps = estimateCommonExpenses({ commune: 'Ñuñoa', lat: -33.45, lon: -70.6 }, { useful_m2: 40 }, { listings: comps, cfg });
  assert.match(byComps.method, /edificios cercanos/);
});

test('contribuciones: exento bajo el umbral', () => {
  assert.equal(contribucionesUfYear(1500, 41000, CONFIG.contribuciones), 0);
  assert.ok(contribucionesUfYear(8000, 41000, CONFIG.contribuciones) > 20);
});

test('referencia comunal ajustada por superficie y rotulada de baja confianza', () => {
  const refs = [{ commune: 'Ñuñoa', typology: 'todas', value_clp: 777252, ref_m2: 70, source_name: 'Yapo', period: '2025' }];
  const e = referenceEstimate('Ñuñoa', { bedrooms: 0, useful_m2: 25 }, refs, 0.7);
  assert.equal(e.confidence, 'baja');
  close(e.baseClp, 777252 * Math.pow(25 / 70, 0.7), 1e-6);
});

// ------------------------------------------------------------------ CSV
test('CSV: números chilenos, errores en línea y armado de proyectos', () => {
  assert.equal(parseNumber('2.921'), 2921);
  assert.equal(parseNumber('2.921,5'), 2921.5);
  assert.equal(parseNumber('1.250.000'), 1250000);
  const csv = 'project_id;project_name;commune;unit_id;bedrooms;useful_area_m2;data_observed_at;offer_price_uf\n'
    + 'p1;Uno;Ñuñoa;101;1;38,5;2026-10-01;3.200\n'
    + 'p1;Uno;Ñuñoa;102;1,5;8;2026-13-01;x\n';
  const rows = parseCSV(csv);
  const { records, errors } = validateRows(rows, SCHEMA.projects);
  assert.equal(records[0].useful_area_m2, 38.5);
  assert.equal(records[0].offer_price_uf, 3200);
  const cols = errors.map((e) => `${e.line}:${e.column}`);
  assert.ok(cols.includes('3:bedrooms'));
  assert.ok(cols.includes('3:useful_area_m2'));
  assert.ok(cols.includes('3:data_observed_at'));
  assert.ok(cols.includes('3:offer_price_uf'));
  const ps = buildProjects([records[0]], '2026-10-12T00:00:00Z');
  assert.equal(ps[0].delivery.status, 'desconocida');
  assert.equal(ps[0].units[0].available, null, 'stock desconocido no se asume disponible');
});
