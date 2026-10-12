/* Plan de pago personal: ¿me alcanza para comprar esta unidad con la caja que tengo hoy y
 * lo que ahorro cada mes, pagando el pie en cuotas?
 *
 * Todo en UF (el pie en cuotas se pacta en UF). La caja de hoy y el ahorro se convierten con
 * la UF de hoy; si el ahorro NO está indexado, se supone fijo en pesos y su valor en UF cae
 * con la inflación (supuesto conservador).
 *
 * Saldo de tu caja al cierre del mes t:
 *   saldo(t) = caja hoy + Σ ahorro − Σ aportes (reserva, pie al contado, cuotas, escritura) + Σ flujo del depto
 * El flujo del depto (arriendo − dividendo − GC − …) viene de finance.simulate() y no depende
 * de cómo pagues el pie. Por eso el calendario del pie se puede re-armar aquí sin re-simular.
 */
import { equitySchedule } from './finance.js';
import { clp } from './format.js';

export const PLAN_STATUS = {
  alcanzable: { label: 'Alcanzable con tu plan', short: 'Alcanzable', icon: '✓', tone: 'good' },
  ajustado: { label: 'Ajustado: alcanza con poco margen', short: 'Ajustado', icon: '!', tone: 'warn' },
  no_alcanzable: { label: 'No alcanza con tu plan', short: 'No alcanza', icon: '✕', tone: 'crit' },
};

export const POLICIES = {
  optimo: 'Pagar al contado todo el pie posible manteniendo un margen de 3 meses de dividendo + gasto común (cuota más baja sin quedar justo)',
  toda_la_caja: 'Pagar al contado toda la caja de hoy (menos el colchón)',
  solo_reserva: 'No adelantar pie: guardar la caja como colchón',
};

const EPS = 1e-6;

/** Saldo mes a mes para un calendario de aportes dado. */
function balancePath(eqRows, cf, savings, cash, end) {
  let bal = cash, min = Infinity, minT = 0;
  const bals = new Array(end + 1);
  for (let t = 0; t <= end; t++) {
    bal += savings[t] - (eqRows[t] || 0) + (cf[t] || 0);
    bals[t] = bal;
    if (bal < min) { min = bal; minT = t; }
  }
  return { bals, min, minT };
}

/**
 * @param {object} sim    resultado de finance.simulate() (con pieUpfrontUf = 0)
 * @param {object} inv    config.investor: cashTodayClp, monthlySavingsClp, minCushionClp,
 *                        upfrontPolicy, savingsIndexedToUf, planMonthsAfterDelivery
 * @param {object} opt    { ufValue, terms: {installmentsMax, postDelivery, minUpfrontPct, source}, searchMax }
 * @returns {object|null} null si falta la caja, el ahorro, la UF o la simulación.
 */
export function cashPlan(sim, inv, opt = {}) {
  const ufValue = opt.ufValue;
  if (!sim || !ufValue || inv?.cashTodayClp == null || inv?.monthlySavingsClp == null) return null;
  const st = sim.structure, p = sim.input;
  const terms = opt.terms || { installmentsMax: p.pieInstallmentsMax, postDelivery: !!p.piePostDelivery, source: 'supuesto' };
  const H = sim.months.length - 1;
  const D = sim.equity.D;
  const promised = Math.max(0, Math.round(p.deliveryMonths));
  const after = Math.max(12, inv.planMonthsAfterDelivery ?? 36);
  const cf = sim.months.map((r) => r.cf);
  const infl = p.ufInflation ?? 0.03;
  const savings = sim.months.map((r) => inv.monthlySavingsClp / ufValue / (inv.savingsIndexedToUf ? 1 : Math.pow(1 + infl, r.t / 12)));
  const cash = inv.cashTodayClp / ufValue;
  const cushion = Math.max(0, inv.minCushionClp || 0) / ufValue;
  const base = { pie: st.pie, closingUf: st.closingCosts.total, furnishingUf: st.furnishingUf, deliveryMonths: D,
    promisedMonths: promised, reservaUf: p.reservaUf };
  const sched = (upfrontUf, installmentsMax, postDelivery) => equitySchedule({ ...base, upfrontUf, installmentsMax, postDelivery }, H);
  const endFor = (cuotas) => Math.min(H, Math.max(D, cuotas) + after);
  const reserva = Math.min(st.pie, Math.max(0, p.reservaUf || 0));

  // 1) Cuánto pie pagar al contado hoy
  const policy = POLICIES[inv.upfrontPolicy] ? inv.upfrontPolicy : 'optimo';
  const minUp = Math.max(0, (terms.minUpfrontPct || 0) * st.finalPrice - reserva);
  const maxUp = Math.max(0, Math.min(st.pie - reserva, cash - cushion - reserva));
  const s0 = sched(0, terms.installmentsMax, terms.postDelivery);
  let upfront = 0;
  const fixedMonthly = sim.metrics.fixedMonthly || 0;
  const healthy = cushion + 3 * fixedMonthly;     // bajo esto el plan queda "ajustado"
  if (policy === 'toda_la_caja') upfront = maxUp;
  else if (policy === 'optimo' && s0.cuotas > 0) {
    // Con U al contado, lo pagado hasta t sube en U·(1 − k_t/N) (k_t = cuotas ya pagadas):
    // el máximo U que mantiene el saldo sobre el margen sano (colchón + 3 meses de costos fijos)
    // en todos los meses. Si ni sin adelantar se logra, no se adelanta nada (es lo más holgado).
    const end = endFor(s0.cuotas);
    const p0 = balancePath(s0.rows, cf, savings, cash, end);
    let u = maxUp;
    for (let t = 0; t <= end; t++) {
      const w = 1 - Math.min(t + 1, s0.cuotas) / s0.cuotas;
      if (w > EPS) u = Math.min(u, (p0.bals[t] - healthy) / w);
    }
    upfront = Math.max(0, u);
  }
  upfront = Math.max(upfront, minUp);

  // 2) Saldo con el plan elegido
  const sch = sched(upfront, terms.installmentsMax, terms.postDelivery);
  const end = endFor(sch.cuotas);
  const path = balancePath(sch.rows, cf, savings, cash, end);
  const firstShortT = path.bals.findIndex((b) => b < cushion - EPS);
  const steadyNet = savings[end] + (sim.metrics.monthlyCf || 0);
  const margin = path.min - cushion;
  let status = 'alcanzable';
  if (margin < -EPS) status = 'no_alcanzable';
  else if (margin < 3 * fixedMonthly || steadyNet < 0) status = 'ajustado';

  // 3) Si no alcanza: ¿con cuántas cuotas de pie alcanzaría? (sin adelantar pie, que es lo más holgado)
  let minInstallmentsNeeded = null, installmentsHelp = false;
  if (status === 'no_alcanzable' && st.pie - reserva > EPS) {
    const searchMax = opt.searchMax ?? 120;
    for (let n = Math.max(1, sch.cuotas + 1); n <= searchMax; n++) {
      const s = sched(0, n, n > promised);
      if (balancePath(s.rows, cf, savings, cash, endFor(s.cuotas)).min >= cushion - EPS) { minInstallmentsNeeded = n; break; }
    }
    installmentsHelp = minInstallmentsNeeded != null;
  }

  const toClp = (u) => u * ufValue;
  const reasons = [];
  const shortT = firstShortT >= 0 ? firstShortT : null;
  if (status === 'no_alcanzable') {
    const at = shortT === D ? 'en la escritura' : shortT < D ? `en el mes ${shortT} (antes de la entrega)` : `en el mes ${shortT} (${shortT - D} meses después de la entrega)`;
    reasons.push(`Tu caja quedaría bajo ${cushion > 0 ? 'tu colchón' : 'cero'} ${at}: faltarían ${clp(toClp(-margin))} en el peor mes (mes ${path.minT}).`);
    if (installmentsHelp) reasons.push(`Alcanzaría si la inmobiliaria te da el pie en al menos ${minInstallmentsNeeded} cuotas${minInstallmentsNeeded > promised ? ` (${minInstallmentsNeeded - promised} después de la entrega)` : ''}.`);
    else if (st.pie - reserva > EPS) {
      reasons.push(steadyNet <= 0
        ? 'Más cuotas de pie no lo arreglan: después de la entrega el flujo negativo del depto se come todo tu ahorro.'
        : `Ni con ${opt.searchMax ?? 120} cuotas alcanza: después de la entrega te quedarían ${clp(toClp(steadyNet))}/mes libres (ahorro − flujo negativo del depto) para un pie de ${clp(toClp(st.pie))}.`);
    }
  }
  if (sch.cuotas > 0 && sch.cuota > savings[0] + EPS) reasons.push(`La cuota del pie (${clp(toClp(sch.cuota))}/mes) supera tu ahorro mensual (${clp(toClp(savings[0]))}): la diferencia sale de tu caja.`);
  if (steadyNet < 0) reasons.push(`Después de la entrega el depto te pide ${clp(toClp(-sim.metrics.monthlyCf))}/mes y ahorras ${clp(toClp(savings[end]))}: tu caja baja ${clp(toClp(-steadyNet))} cada mes.`);
  if (status === 'ajustado' && margin < 3 * fixedMonthly) reasons.push(`Tu colchón en el peor mes (${clp(toClp(path.min))}) cubre menos de 3 meses de dividendo + gasto común (${clp(toClp(3 * fixedMonthly))}).`);
  if (terms.source === 'supuesto') reasons.push('Pie en cuotas hasta la entrega SUPUESTO (práctica habitual en verde/blanco): confírmalo con la inmobiliaria.');
  if (terms.source === 'sin_datos') reasons.push('Sin datos verificados de pie en cuotas ni de fecha de entrega: se supuso pie al contado en la escritura.');
  if (terms.source === 'sin_cuotas') reasons.push('Entrega inmediata sin pie en cuotas publicado: el pie se paga completo al escriturar.');

  return {
    status, ...PLAN_STATUS[status], policy, reasons, terms,
    cashUf: cash, cushionUf: cushion, savingsUf: savings[0], savingsEndUf: savings[end], savingsIndexed: !!inv.savingsIndexedToUf,
    pieUf: st.pie, bonoUf: st.bono, reservaUf: reserva, upfrontUf: upfront, paidTodayUf: sch.upfront, month0Uf: sch.rows[0],
    cuotas: sch.cuotas, cuotaUf: sch.cuota, cuotasAfterDelivery: sch.cuotasAfterDelivery,
    closingUf: st.closingCosts.total + st.furnishingUf, atEscrituraUf: sch.atEscritura, atEscrituraPieUf: sch.atEscrituraPie,
    cuotaAtEscritura: D < sch.cuotas,
    balanceAtEscrituraUf: path.bals[Math.min(D, end)], minBalanceUf: path.min, minBalanceT: path.minT,
    firstShortT: shortT, marginUf: margin, fixedMonthlyUf: fixedMonthly, steadyNetUf: steadyNet,
    minInstallmentsNeeded, installmentsHelp, deliveryMonths: D, promisedMonths: promised, end,
    series: path.bals.map((b, t) => ({ t, balance: b, equity: sch.rows[t] || 0, cf: cf[t] || 0, savings: savings[t], phase: sim.months[t].phase })),
  };
}

/**
 * Precio máximo APROXIMADO (UF) cuyo pie + gastos de escritura cubres con tu caja de hoy más tu
 * ahorro hasta la entrega. No incluye el flujo del depto después de la entrega (eso lo evalúa
 * cashPlan en cada ficha) ni la pérdida de valor del ahorro en UF. Infinity = el pie no limita.
 */
export function maxPriceApprox({ cashUf, savingsUf, months, piePct, creditPct, closing, cushionUf = 0 }) {
  const avail = cashUf - cushionUf + savingsUf * Math.max(0, months);
  const fixed = (closing.tasacionUf || 0) + (closing.estudioTitulosUf || 0) + (closing.borradorUf || 0) + (closing.notariaUf || 0);
  const variable = piePct + (closing.cbrPct || 0) + (closing.timbresPct || 0) * creditPct;
  if (avail <= fixed) return 0;
  return piePct <= 0 && variable <= 0 ? Infinity : (avail - fixed) / variable;
}

/** Orden para listas: alcanzable > ajustado > no alcanza > sin plan. */
export function planRank(plan) {
  return plan ? { alcanzable: 3, ajustado: 2, no_alcanzable: 1 }[plan.status] : 0;
}
