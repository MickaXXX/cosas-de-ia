// Plan de pago personal: caja de hoy + ahorro mensual + pie en cuotas.  node --test tests/atlas/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { simulate, equitySchedule, withDefaults } from '../../docs/atlas/js/finance.js';
import { cashPlan, maxPriceApprox, planRank } from '../../docs/atlas/js/plan.js';
import { analyzeUnit, buildContext, paymentTerms } from '../../docs/atlas/js/analysis.js';

const CONFIG = JSON.parse(readFileSync(new URL('../../docs/atlas/config/defaults.json', import.meta.url)));
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} esperado ${b}, obtenido ${a}`);
const UF = 40000;
const INV = { cashTodayClp: 5_000_000, monthlySavingsClp: 400_000, minCushionClp: 0, upfrontPolicy: 'optimo',
  savingsIndexedToUf: true, planMonthsAfterDelivery: 36 };
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

test('calendario del pie: contado, cuotas hasta la entrega, saldo en escritura y cuotas post entrega', () => {
  const base = { pie: 600, closingUf: 50, deliveryMonths: 24, promisedMonths: 24, installmentsMax: 48 };
  const a = equitySchedule(base, 60);
  assert.equal(a.cuotas, 24, 'sin post entrega, a lo más hasta la entrega');
  close(a.cuota, 25, 1e-9);
  close(sum(a.rows), 650, 1e-9, 'se paga todo el pie + escritura');
  close(a.rows[24], 50, 1e-9, 'la escritura paga los gastos operacionales');
  const b = equitySchedule({ ...base, upfrontUf: 120 }, 60);
  close(b.rows[0], 120 + 20, 1e-9, 'contado + primera cuota');
  close(b.cuota, 20, 1e-9, 'el contado baja la cuota');
  const c = equitySchedule({ ...base, deliveryMonths: 0, promisedMonths: 0 }, 60);
  assert.equal(c.cuotas, 0);
  close(c.rows[0], 650, 1e-9, 'entrega inmediata sin cuotas: todo al escriturar');
  const d = equitySchedule({ ...base, deliveryMonths: 0, promisedMonths: 0, installmentsMax: 36, postDelivery: true }, 60);
  assert.equal(d.cuotas, 36);
  assert.equal(d.cuotasAfterDelivery, 36);
  close(d.rows[0], 50 + 600 / 36, 1e-9, 'escritura + primera cuota');
});

function sim(over = {}) {
  return simulate(withDefaults({ priceUf: 2500, creditPct: 0.8, bonoPiePct: 0.1, deliveryMonths: 24, pieInstallmentsMax: 24,
    rentUf: 11, commonExpensesUf: 1.8, annualRate: 0.042, startMonthIndex: 0, ...over }));
}

test('el saldo cuadra: caja + ahorro − aportes + flujo del depto', () => {
  const s = sim();
  const p = cashPlan(s, { ...INV, upfrontPolicy: 'solo_reserva' }, { ufValue: UF, terms: { installmentsMax: 24, source: 'publicado' } });
  const last = p.series.at(-1);
  const expect = 5_000_000 / UF + sum(p.series.map((r) => r.savings)) - sum(p.series.map((r) => r.equity)) + sum(p.series.map((r) => r.cf));
  close(last.balance, expect, 1e-6);
  close(p.pieUf, 2500 * 0.1, 1e-9, 'pie del 10% (crédito 80% + bono 10%)');
  assert.equal(p.cuotas, 24);
  close(p.cuotaUf, 250 / 24, 1e-9);
  assert.ok(['alcanzable', 'ajustado'].includes(p.status), p.reasons.join(' | '));
});

test('política óptima: adelanta el máximo sin bajar del colchón; más pie al contado lo rompería', () => {
  const s = sim();
  const inv = { ...INV, minCushionClp: 1_000_000 };
  const p = cashPlan(s, inv, { ufValue: UF, terms: { installmentsMax: 24, source: 'publicado' } });
  assert.ok(p.upfrontUf > 0, 'usa parte de la caja de hoy');
  assert.ok(p.minBalanceUf >= p.cushionUf - 1e-6, 'nunca bajo el colchón');
  assert.ok(p.cuotaUf < 250 / 24, 'la cuota baja respecto de no adelantar');
  // Toda la caja (menos el colchón) es más agresivo: el saldo mínimo nunca es mejor.
  const all = cashPlan(s, { ...inv, upfrontPolicy: 'toda_la_caja' }, { ufValue: UF, terms: { installmentsMax: 24, source: 'publicado' } });
  assert.ok(all.minBalanceUf <= p.minBalanceUf + 1e-9);
  // Y no adelantar nada deja el saldo mínimo más alto o igual.
  const none = cashPlan(s, { ...inv, upfrontPolicy: 'solo_reserva' }, { ufValue: UF, terms: { installmentsMax: 24, source: 'publicado' } });
  assert.ok(none.minBalanceUf >= p.minBalanceUf - 1e-9);
});

test('la política óptima no se deja a sí misma "ajustada": conserva 3 meses de costos fijos si se puede', () => {
  const s = sim({ rentUf: 14 });
  const terms = { installmentsMax: 24, source: 'publicado' };
  const none = cashPlan(s, { ...INV, upfrontPolicy: 'solo_reserva' }, { ufValue: UF, terms });
  const healthy = 3 * s.metrics.fixedMonthly;
  assert.ok(none.minBalanceUf > healthy, 'sin adelantar hay margen sano');
  const opt = cashPlan(s, INV, { ufValue: UF, terms });
  assert.ok(opt.upfrontUf > 0);
  assert.ok(opt.minBalanceUf >= healthy - 1e-6, 'adelanta solo hasta el margen sano');
  assert.notEqual(opt.status, 'no_alcanzable');
  if (opt.steadyNetUf >= 0) assert.equal(opt.status, 'alcanzable');
});

test('entrega inmediata sin cuotas: no alcanza y dice cuántas cuotas necesitaría', () => {
  const s = sim({ deliveryMonths: 0, bonoPiePct: 0.1, pieInstallmentsMax: 0, rentUf: 13 });
  const terms = { installmentsMax: 0, postDelivery: false, source: 'sin_cuotas' };
  const p = cashPlan(s, INV, { ufValue: UF, terms });
  assert.equal(p.status, 'no_alcanzable');
  assert.equal(p.firstShortT, 0, 'falta plata al escriturar');
  assert.ok(p.minInstallmentsNeeded > 0, p.reasons.join(' | '));
  // Con exactamente ese número de cuotas (después de la entrega) alcanza; con una menos, no.
  const ok = cashPlan(simulate({ ...s.input, pieInstallmentsMax: p.minInstallmentsNeeded, piePostDelivery: true }), { ...INV, upfrontPolicy: 'solo_reserva' },
    { ufValue: UF, terms: { installmentsMax: p.minInstallmentsNeeded, postDelivery: true, source: 'publicado' } });
  assert.notEqual(ok.status, 'no_alcanzable');
  const n1 = p.minInstallmentsNeeded - 1;
  if (n1 >= 1) {
    const ko = cashPlan(simulate({ ...s.input, pieInstallmentsMax: n1, piePostDelivery: true }), { ...INV, upfrontPolicy: 'solo_reserva' },
      { ufValue: UF, terms: { installmentsMax: n1, postDelivery: true, source: 'publicado' } });
    assert.equal(ko.status, 'no_alcanzable');
  }
});

test('flujo negativo mayor que el ahorro: más cuotas no lo arreglan', () => {
  const s = sim({ deliveryMonths: 0, bonoPiePct: 0, creditPct: 0.9, rentUf: 4 });
  const p = cashPlan(s, { ...INV, monthlySavingsClp: 100_000 }, { ufValue: UF, terms: { installmentsMax: 0, source: 'sin_cuotas' } });
  assert.equal(p.status, 'no_alcanzable');
  assert.equal(p.minInstallmentsNeeded, null);
  assert.ok(p.reasons.some((r) => /se come todo tu ahorro/.test(r)));
});

test('ahorro fijo en pesos pierde valor en UF; indexado no', () => {
  const s = sim();
  const fixed = cashPlan(s, { ...INV, savingsIndexedToUf: false }, { ufValue: UF });
  close(fixed.series[12].savings, 400_000 / UF / 1.03, 1e-9);
  const idx = cashPlan(s, INV, { ufValue: UF });
  close(idx.series[12].savings, 400_000 / UF, 1e-12);
  assert.equal(cashPlan(s, { ...INV, cashTodayClp: null }, { ufValue: UF }), null, 'sin caja no hay plan');
});

test('precio máximo aproximado por pie y gastos de escritura', () => {
  const closing = CONFIG.financing.closing;
  const avail = 125 + 10 * 24;
  const p20 = maxPriceApprox({ cashUf: 125, savingsUf: 10, months: 24, piePct: 0.2, creditPct: 0.8, closing });
  const fixed = closing.tasacionUf + closing.estudioTitulosUf + closing.borradorUf + closing.notariaUf;
  close(p20, (avail - fixed) / (0.2 + closing.cbrPct + closing.timbresPct * 0.8), 1e-9);
  assert.ok(maxPriceApprox({ cashUf: 125, savingsUf: 10, months: 24, piePct: 0.1, creditPct: 0.8, closing }) > p20);
  assert.ok(planRank({ status: 'alcanzable' }) > planRank({ status: 'ajustado' }));
  assert.ok(planRank({ status: 'no_alcanzable' }) > planRank(null));
});

// ------------------------------------------------------------------ integración con el análisis
const ctxWith = (projects) => buildContext({ projects, rentals: [], references: [], stations: [], pois: [], developments: [],
  config: CONFIG, uf: { value: UF, date: '2026-10-12' }, today: '2026-10-12' });
const proj = (over = {}) => ({ id: 'p', name: 'P', commune: 'Ñuñoa', lat: -33.45, lon: -70.6, observed_at: '2026-10-05',
  delivery: { status: 'futura', date: '2028-10', date_status: 'estimada' }, evidence: [{ verification_status: 'verificado' }],
  units: [{ id: 'u', bedrooms: 1, useful_m2: 38, offer_price_uf: 3000 }], ...over });

test('condiciones de pie: publicadas > supuesto rotulado (entrega futura) > sin datos', () => {
  const pub = proj({ payment_terms: { pie_installments_max: 36, pie_post_delivery: false, source_url: 'https://example.cl', verification_status: 'extraido_busqueda_web' } });
  const a = analyzeUnit(pub, pub.units[0], ctxWith([pub]), { rentClpOverride: 480000 });
  assert.equal(a.terms.source, 'publicado');
  assert.equal(a.plan.terms.source, 'publicado');
  assert.ok(a.plan.cuotas > 0 && a.plan.cuotas <= 36);
  const sup = proj();
  const b = analyzeUnit(sup, sup.units[0], ctxWith([sup]), { rentClpOverride: 480000 });
  assert.equal(b.terms.source, 'supuesto');
  assert.ok(b.plan.reasons.some((r) => /SUPUESTO/.test(r)));
  const unk = proj({ delivery: { status: 'desconocida' } });
  const c = analyzeUnit(unk, unk.units[0], ctxWith([unk]), { rentClpOverride: 480000 });
  assert.equal(c.terms.source, 'sin_datos');
  assert.equal(c.plan.cuotas, 0);
  assert.equal(paymentTerms(unk, unk.units[0], { deliveryMonths: 0, deliveryAssumed: true }, CONFIG).installmentsMax, 0);
});

test('el pie adelantado entra al calendario de aportes de la simulación (TIR coherente con el plan)', () => {
  const p = proj();
  const a = analyzeUnit(p, p.units[0], ctxWith([p]), { rentClpOverride: 480000 });
  if (a.plan.upfrontUf > 0) {
    close(a.input.pieUpfrontUf, a.plan.upfrontUf, 1e-9);
    close(a.base.months[0].equity, a.plan.series[0].equity, 1e-9);
  }
  close(sum(a.base.months.map((m) => m.equity)), a.structure.equity, 1e-6, 'se aporta todo el capital');
});
