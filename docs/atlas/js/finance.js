/* Motor financiero de Atlas Inversión Santiago.
 *
 * Todo se calcula en UF (términos reales): el dividendo de un crédito en UF es fijo
 * en UF y el arriendo se supone reajustable por UF/IPC. Las cifras en CLP se muestran
 * "en pesos de hoy" (UF de referencia × monto en UF); en pesos nominales futuros
 * suben con la UF. Así no se finge un dividendo en pesos constantes.
 *
 * Funciones puras, sin DOM: se usan igual en el navegador y en las pruebas (node --test).
 *
 * Convención de tasa: los créditos hipotecarios en UF en Chile se cotizan como tasa
 * anual y el dividendo se calcula con tasa mensual = anual / 12 (convención 'nominal').
 * Con esa convención UF 3.249,18 al 3,80% a 30 años da UF 15,14, que es lo que muestra
 * el simulador de GoodProp. Para una tasa efectiva anual usar 'efectiva':
 * mensual = (1 + anual)^(1/12) − 1. La CAE (carga anual equivalente) NO es la tasa del
 * crédito: incluye seguros y gastos, y no se usa para calcular el dividendo.
 */

const EPS = 1e-9;

export function monthlyRate(annualRate, convention = 'nominal') {
  if (!Number.isFinite(annualRate)) throw new Error('tasa inválida');
  return convention === 'efectiva' ? Math.pow(1 + annualRate, 1 / 12) - 1 : annualRate / 12;
}

/** Cuota fija (amortización francesa). */
export function annuityPayment(principal, rMonthly, nMonths) {
  if (principal <= 0 || nMonths <= 0) return 0;
  if (Math.abs(rMonthly) < EPS) return principal / nMonths;
  return (principal * rMonthly) / (1 - Math.pow(1 + rMonthly, -nMonths));
}

const SCHED_CACHE = new Map();

/** Tabla de amortización mes a mes en UF, separando interés, amortización y seguros.
 *  Seguro de desgravamen sobre saldo insoluto; incendio y sismo sobre valor asegurado.
 *  Se memoiza: el Monte Carlo y el ranking piden miles de veces la misma tabla. */
export function amortizationSchedule(args) {
  const key = JSON.stringify(args);
  const hit = SCHED_CACHE.get(key);
  if (hit) return hit;
  const out = buildSchedule(args);
  if (SCHED_CACHE.size > 300) SCHED_CACHE.delete(SCHED_CACHE.keys().next().value);
  SCHED_CACHE.set(key, out);
  return out;
}

function buildSchedule({ principal, annualRate, years, convention = 'nominal',
  desgravamenPctMonthly = 0, incendioPctMonthly = 0, insuredValueUf = 0 }) {
  const n = Math.round(years * 12);
  const r = monthlyRate(annualRate, convention);
  const payment = annuityPayment(principal, r, n);
  const rows = [];
  let balance = principal;
  for (let m = 1; m <= n; m++) {
    const interest = balance * r;
    let amort = payment - interest;
    if (m === n) amort = balance;                 // cierre exacto del saldo
    const desgravamen = balance * desgravamenPctMonthly;
    const incendio = insuredValueUf * incendioPctMonthly;
    balance = Math.max(0, balance - amort);
    rows.push({ month: m, payment: interest + amort, interest, amortization: amort, balance, desgravamen, incendio,
      total: interest + amort + desgravamen + incendio });
  }
  return { payment, rMonthly: r, n, rows };
}

export function balanceAfter(principal, rMonthly, nMonths, k) {
  if (k <= 0) return principal;
  if (k >= nMonths) return 0;
  if (Math.abs(rMonthly) < EPS) return principal * (1 - k / nMonths);
  const p = annuityPayment(principal, rMonthly, nMonths);
  const g = Math.pow(1 + rMonthly, k);
  return principal * g - p * (g - 1) / rMonthly;
}

/** Gastos operacionales de compra (escritura, tasación, estudio de títulos, CBR,
 *  impuesto de timbres sobre el crédito). Supuestos editables, no cotizaciones. */
export function closingCosts(priceUf, creditUf, c) {
  const items = [
    { key: 'tasacion', label: 'Tasación', uf: c.tasacionUf },
    { key: 'estudio_titulos', label: 'Estudio de títulos', uf: c.estudioTitulosUf },
    { key: 'borrador', label: 'Borrador de escritura / gestoría', uf: c.borradorUf },
    { key: 'notaria', label: 'Notaría', uf: c.notariaUf },
    { key: 'cbr', label: 'Inscripción CBR', uf: priceUf * c.cbrPct },
    { key: 'timbres', label: 'Impuesto de timbres y estampillas (sobre el crédito)', uf: creditUf * c.timbresPct },
  ];
  if (!creditUf) items.splice(0, 3, { key: 'notaria_sc', label: 'Gestión de escritura sin crédito', uf: c.borradorUf });
  const total = items.reduce((s, i) => s + (i.uf || 0), 0);
  return { items, total };
}

/** Estructura de compra: precio, bono pie, crédito, pie a pagar y aporte real de capital.
 *  El bono pie lo "pone" la inmobiliaria sobre el precio de escritura: el banco presta
 *  creditPct del precio y el comprador paga el resto menos el bono. El precio económico
 *  real es precio × (1 − bono). Si la tasación sale bajo el precio, el banco presta menos
 *  y el pie real sube: es el riesgo de los pies "gratis". */
export function purchaseStructure({ priceUf, discountPct = 0, bonoPiePct = 0, creditPct = 0.8, maxCreditPct = 0.9,
  closing, furnishingUf = 0 }) {
  const warnings = [];
  const finalPrice = priceUf * (1 - discountPct);
  const bono = finalPrice * bonoPiePct;
  const credit = finalPrice * creditPct;
  let pie = finalPrice - credit - bono;
  if (creditPct > maxCreditPct + EPS) warnings.push(`Crédito de ${(creditPct * 100).toFixed(0)}% supera el máximo configurado (${(maxCreditPct * 100).toFixed(0)}%): ningún banco está obligado a aprobarlo.`);
  if (pie < -EPS) {
    warnings.push('Crédito + bono pie superan el 100% del precio: estructura imposible.');
    pie = 0;
  }
  if (bonoPiePct > 0) warnings.push(`El bono pie (${(bonoPiePct * 100).toFixed(0)}%) depende de que la tasación del banco respalde el precio de escritura. Si tasan bajo, el crédito baja y hay que poner más pie.`);
  const cc = closing ? closingCosts(finalPrice, credit, closing) : { items: [], total: 0 };
  const equity = pie + cc.total + furnishingUf;
  return { listPrice: priceUf, finalPrice, discountUf: priceUf - finalPrice, bono, credit, pie, realPrice: finalPrice - bono,
    closingCosts: cc, furnishingUf, equity, creditPct, bonoPiePct, warnings };
}

/** Renta líquida mínima según regla editable (dividendo ≤ ratio de la renta). No es preaprobación. */
export function requiredIncomeClp(monthlyDebtClp, maxRatio = 0.25) {
  return maxRatio > 0 ? monthlyDebtClp / maxRatio : Infinity;
}

// ------------------------------------------------------------------ TIR / VAN
export function npv(rate, flows) {
  return flows.reduce((s, f, i) => s + f / Math.pow(1 + rate, i), 0);
}

/** TIR por bisección sobre flujos periódicos (mensuales en la app).
 *  Rango de búsqueda −50% a +100% por período: con 360 meses, una tasa de −90% hace
 *  que (1 + r)^i se vaya a 0 y el VAN a infinito, y la bisección se pierde.
 *  null si no hay cambio de signo o la raíz cae en el borde (TIR sin sentido económico). */
export function irr(flows) {
  if (!flows.some((f) => f > 0) || !flows.some((f) => f < 0)) return null;
  let lo = -0.5, hi = 1.0;
  let flo = npv(lo, flows);
  const fhi = npv(hi, flows);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200 && hi - lo > 1e-11; i++) {      // 1e-11 mensual: ~36 iteraciones
    const mid = (lo + hi) / 2;
    const fm = npv(mid, flows);
    if (!Number.isFinite(fm)) return null;
    if (Math.abs(fm) < 1e-10) return mid;
    if (flo * fm < 0) hi = mid; else { lo = mid; flo = fm; }
  }
  const r = (lo + hi) / 2;
  return r > 0.999 || r < -0.499 ? null : r;
}

export const annualize = (m) => (m == null ? null : Math.pow(1 + m, 12) - 1);

// ------------------------------------------------------------------ ocupación
/** Fracción del mes k (k = 0 es el primer mes tras la entrega) con arrendatario, y si en ese
 *  mes empieza un contrato (se paga corretaje). Calendario: vacancia inicial de colocación,
 *  contratos de leaseMonths y vacancia de rotación entre contratos. Admite fracciones. */
export function occupancyAt(k, { initialVacancyMonths = 1, leaseMonths = 24, turnoverVacancyMonths = 1 }) {
  const cycle = leaseMonths + turnoverVacancyMonths;
  const a = k, b = k + 1;
  let occ = 0, starts = 0;
  // Inicio del primer contrato y de los siguientes.
  const firstIdx = Math.max(0, Math.floor((a - initialVacancyMonths - leaseMonths) / cycle));
  for (let i = firstIdx; ; i++) {
    const s = initialVacancyMonths + i * cycle;
    if (s >= b) break;
    const e = s + leaseMonths;
    occ += Math.max(0, Math.min(b, e) - Math.max(a, s));
    if (s >= a && s < b) starts += 1;
  }
  return { occ: Math.min(1, occ), leaseStart: starts > 0 };
}

const CONTRIB_MONTHS = new Set([3, 5, 8, 10]);   // abril, junio, septiembre, noviembre

// ------------------------------------------------------------------ calendario de aportes
/**
 * Calendario de aportes de capital del comprador, mes a mes (t = 0 es este mes).
 * - Al contado (t = 0): reserva + el pie que el comprador decide adelantar (`upfrontUf`).
 * - El resto del pie en `installmentsMax` cuotas iguales en UF, sin interés, desde t = 0.
 *   Sin `postDelivery`, las cuotas terminan a más tardar en la entrega PROMETIDA (un atraso
 *   no las estira); con `postDelivery` pueden seguir después de escriturar (crédito directo
 *   de la inmobiliaria). Si no hay cuotas, el saldo del pie se paga en la escritura.
 * - En la escritura (t = D) se pagan los gastos operacionales y el amoblado.
 */
export function equitySchedule({ pie, closingUf = 0, furnishingUf = 0, deliveryMonths = 0, promisedMonths = deliveryMonths,
  reservaUf = 0, upfrontUf = 0, installmentsMax = 48, postDelivery = false }, H) {
  const D = Math.max(0, Math.round(deliveryMonths));
  const promised = Math.max(0, Math.round(promisedMonths));
  const upfront = Math.min(pie, Math.max(0, reservaUf) + Math.max(0, upfrontUf));
  const rest = Math.max(0, pie - upfront);
  const maxN = Math.max(0, Math.round(installmentsMax ?? 0));
  let cuotas = 0;
  if (rest > EPS && maxN > 0) cuotas = postDelivery ? maxN : (D > 0 ? Math.max(1, Math.min(promised || D, maxN)) : 0);
  const cuota = cuotas ? rest / cuotas : 0;
  const atEscrituraPie = cuotas ? 0 : rest;
  const len = Math.max(H, D, cuotas) + 1;
  const rows = new Array(len).fill(0);
  rows[0] += upfront;
  for (let t = 0; t < cuotas; t++) rows[t] += cuota;
  rows[D] += atEscrituraPie + closingUf + furnishingUf;
  return { rows, upfront, cuota, cuotas, cuotasAfterDelivery: Math.max(0, cuotas - D), atEscrituraPie,
    atEscritura: atEscrituraPie + closingUf + furnishingUf + (D < cuotas ? cuota : 0), D };
}

// ------------------------------------------------------------------ simulación
/**
 * Simulación mes a mes desde hoy (t = 0) hasta el horizonte, para arriendo tradicional
 * ('tradicional') o renta corta ('renta_corta').
 *
 * Fases: hasta la entrega se paga reserva + pie en cuotas; en la entrega se escritura,
 * se pagan gastos operacionales (y amoblado) y empieza el crédito; el primer dividendo
 * es el mes siguiente. Durante la vacancia el propietario paga el gasto común.
 */
export function simulate(inp) {
  const p = withDefaults(inp);
  const st = purchaseStructure({ priceUf: p.priceUf, discountPct: p.discountPct, bonoPiePct: p.bonoPiePct,
    creditPct: p.creditPct, maxCreditPct: p.maxCreditPct, closing: p.closing, furnishingUf: p.furnishingUf });
  const D = Math.max(0, Math.round(p.deliveryMonths + p.deliveryDelayMonths));
  const H = Math.round(p.horizonYears * 12);
  const sched = amortizationSchedule({ principal: st.credit, annualRate: p.annualRate, years: p.loanYears,
    convention: p.rateConvention, desgravamenPctMonthly: p.desgravamenPctMonthly,
    incendioPctMonthly: p.incendioPctMonthly, insuredValueUf: st.finalPrice * p.insuredValueFactor });
  const months = [];
  // El pie en cuotas se paga según la fecha de entrega PROMETIDA: un atraso no estira las cuotas.
  const eq = equitySchedule({ pie: st.pie, closingUf: st.closingCosts.total, furnishingUf: st.furnishingUf,
    deliveryMonths: D, promisedMonths: p.deliveryMonths, reservaUf: p.reservaUf, upfrontUf: p.pieUpfrontUf,
    installmentsMax: p.pieInstallmentsMax, postDelivery: p.piePostDelivery }, H);
  let cum = 0, cumOp = 0;
  const equityFlows = [];                         // perspectiva del inversionista, para TIR
  for (let t = 0; t <= H; t++) {
    const moy = (p.startMonthIndex + t) % 12;
    const row = { t, moy, phase: t < D ? 'construccion' : (t === D ? 'escritura' : 'operacion'),
      equity: 0, income: 0, occ: 0, vacancyLoss: 0, collectionLoss: 0, gcOwner: 0, contribuciones: 0,
      maintenance: 0, capex: 0, admin: 0, brokerage: 0, tax: 0, platform: 0, cleaning: 0, utilities: 0,
      iva: 0, other: 0, noi: 0, dividend: 0, desgravamen: 0, incendio: 0, cf: 0 };
    row.equity = eq.rows[t] || 0;                // aportes de capital (pie, cuotas, escritura)
    const k = t - D - 1;                          // índice de mes de operación (0 = primer mes tras escriturar)
    if (k >= 0) {
      const loanRow = sched.rows[k];
      if (loanRow) { row.dividend = loanRow.payment; row.desgravamen = loanRow.desgravamen; row.incendio = loanRow.incendio; }
      const growth = Math.pow(1 + p.rentRealGrowth, k / 12);
      if (p.mode === 'renta_corta') Object.assign(row, strMonth(p, moy, growth));
      else Object.assign(row, ltrMonth(p, k, growth));
      row.contribuciones = CONTRIB_MONTHS.has(moy) ? p.contribucionesUfYear / 4 : 0;
      row.capex = p.capexReserveUfMonth;
      row.noi = row.income - row.collectionLoss - row.gcOwner - row.contribuciones - row.maintenance - row.capex - row.admin
        - row.brokerage - row.tax - row.platform - row.cleaning - row.utilities - row.iva - row.other - row.incendio;
      row.cf = row.noi - row.dividend - row.desgravamen;
    }
    cumOp += row.cf;
    cum += row.cf - row.equity;
    row.cumOperating = cumOp;
    row.cumTotal = cum;
    months.push(row);
    equityFlows.push(row.cf - row.equity);
  }
  // Valor del activo y venta
  const baseValue = st.realPrice * p.marketValueFactor;
  const valueAt = (t) => baseValue * Math.pow(1 + p.appreciationReal, t / 12);
  const loanBalanceAt = (t) => (t <= D ? (t === D ? st.credit : 0) : balanceAfter(st.credit, sched.rMonthly, sched.n, t - D));
  const saleNetAt = (t) => (t < D ? null : valueAt(t) * (1 - p.saleCostPct) - loanBalanceAt(t));
  const horizons = [1, 3, 5, 10, 15, 20, 25, 30].filter((y) => y <= p.horizonYears);
  const equityInvested = st.equity;
  const annual = horizons.map((y) => {
    const t = y * 12;
    const flows = equityFlows.slice(0, t + 1);
    const sale = saleNetAt(t);
    const cumCf = months.slice(0, t + 1).reduce((s, r) => s + r.cf, 0);
    const paidIn = months.slice(0, t + 1).reduce((s, r) => s + r.equity, 0);
    let irrM = null;
    if (sale != null && !p.skipIrr) { const f = flows.slice(); f[f.length - 1] += sale; irrM = irr(f); }
    return { years: y, value: valueAt(t), balance: loanBalanceAt(t), saleNet: sale, cumCf, equityPaid: paidIn,
      result: sale == null ? null : sale + cumCf - paidIn, irrReal: annualize(irrM),
      underConstruction: t < D };
  });
  const fullFlows = equityFlows.slice();
  const finalSale = saleNetAt(H);
  if (finalSale != null) fullFlows[fullFlows.length - 1] += finalSale;
  const irrReal = p.skipIrr ? null : annualize(irr(fullFlows));      // skipIrr: solo flujos (alternativas del plan)
  // Métricas estabilizadas (valor esperado de largo plazo, no un año puntual)
  const ss = steadyState(p, st, sched);
  const op = months.filter((r) => r.t > D);
  const first24 = op.slice(0, 24);
  const first36 = op.slice(0, 36);
  let run = 0, worstCum = 0;
  for (const r of op.slice(0, 60)) { run += r.cf; worstCum = Math.min(worstCum, run); }
  const fixedMonthly = sched.payment + (sched.rows[0]?.desgravamen || 0) + p.commonExpensesUf;
  const metrics = {
    deliveryMonths: D,
    grossYield: p.mode === 'renta_corta' ? (ss.grossIncome * 12) / st.finalPrice : (p.rentUf * 12) / st.finalPrice,
    capRate: (ss.noi * 12) / (st.realPrice + st.closingCosts.total + st.furnishingUf),
    cashOnCash: st.equity > 0 ? (ss.cf * 12) / st.equity : null,
    dscr: ss.debtService > 0 ? ss.noi / ss.debtService : null,
    monthlyNoi: ss.noi,
    monthlyCf: ss.cf,
    debtService: ss.debtService,
    dividend: sched.payment,
    breakeven: ss.breakeven,
    marginOfSafety: ss.marginOfSafety,
    negativeMonths24: first24.filter((r) => r.cf < 0).length,
    worstMonthCf: first36.length ? Math.min(...first36.map((r) => r.cf)) : 0,
    liquidityNeededUf: -worstCum,
    reserveMonths: fixedMonthly > 0 ? -worstCum / fixedMonthly : 0,
    irrReal,
    irrNominal: irrReal == null ? null : (1 + irrReal) * (1 + p.ufInflation) - 1,
    npvReal: npv(Math.pow(1 + p.discountRateReal, 1 / 12) - 1, fullFlows),
    equity: st.equity,
    fixedMonthly,
  };
  return { input: p, structure: st, schedule: sched, equity: eq, months, annual, metrics, steady: ss };
}

function ltrMonth(p, k, growth) {
  const { occ, leaseStart } = occupancyAt(k, p);
  const rent = p.rentUf * growth;
  const income = rent * occ;
  return {
    occ,
    income,
    vacancyLoss: rent * (1 - occ),
    collectionLoss: income * p.collectionLossPct,
    gcOwner: p.commonExpensesUf * ((1 - occ) + occ * p.ownerGcShareWhenRented),
    maintenance: income * p.maintenancePctOfRent,
    admin: income * p.adminPctOfRent,
    brokerage: leaseStart ? rent * p.brokeragePctOfRent : 0,
    tax: income * p.rentTaxPct,
    utilities: 0,
  };
}

function strMonth(p, moy, growth) {
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][moy];
  const occ = Math.max(0, Math.min(1, p.str.occupancyByMonth[moy] ?? p.str.occupancy));
  const nights = days * occ;
  const stays = p.str.avgStayNights > 0 ? nights / p.str.avgStayNights : 0;
  const adr = p.str.adrUf * growth * (p.str.seasonalAdrFactor?.[moy] ?? 1);
  const gross = nights * adr + stays * p.str.cleaningFeeUf;
  const iva = p.str.ivaApplies ? gross * p.str.ivaRate / (1 + p.str.ivaRate) : 0;
  const net = gross - iva;
  return {
    occ,
    income: gross,
    iva,
    platform: gross * p.str.platformFeePct,
    admin: net * p.str.cohostPct,
    cleaning: stays * p.str.cleaningCostUf + nights * p.str.suppliesPerNightUf,
    utilities: p.str.utilitiesUfMonth,
    gcOwner: p.commonExpensesUf,
    maintenance: net * p.maintenancePctOfRent,
    other: net * p.str.replacementPct,
    tax: net * p.rentTaxPct,
    collectionLoss: 0,
    brokerage: 0,
    vacancyLoss: 0,
  };
}

/** Valores mensuales esperados en régimen (ocupación promedio de largo plazo) y punto de
 *  equilibrio. El flujo es lineal en el arriendo (o en la ocupación/ADR), así que el
 *  equilibrio se resuelve exacto: f(x) = a·x − b ⇒ x* = b / a. */
export function steadyState(p, st, sched) {
  const debtService = sched.payment + (sched.rows[0]?.desgravamen || 0);
  const incendio = sched.rows[0]?.incendio || 0;
  const fixed = p.contribucionesUfYear / 12 + p.capexReserveUfMonth + incendio;
  if (p.mode === 'renta_corta') {
    const evalAt = (occScale, adrScale) => {
      let gross = 0, noi = 0;
      for (let m = 0; m < 12; m++) {
        const q = { ...p, str: { ...p.str, adrUf: p.str.adrUf * adrScale,
          occupancyByMonth: p.str.occupancyByMonth.map((o) => (o ?? p.str.occupancy) * occScale) } };
        const r = strMonth(q, m, 1);
        gross += r.income;
        noi += r.income - r.iva - r.platform - r.admin - r.cleaning - r.utilities - r.gcOwner - r.maintenance - r.other - r.tax;
      }
      return { gross: gross / 12, noi: noi / 12 - fixed };
    };
    const base = evalAt(1, 1);
    const zeroOcc = evalAt(0, 1);
    const cf = base.noi - debtService;
    const slopeOcc = base.noi - zeroOcc.noi;      // NOI lineal en la escala de ocupación
    const occScaleBE = slopeOcc > 0 ? (debtService - zeroOcc.noi) / slopeOcc : null;
    const avgOcc = p.str.occupancyByMonth.reduce((s, o) => s + (o ?? p.str.occupancy), 0) / 12;
    const zeroAdr = evalAt(1, 0);
    const slopeAdr = base.noi - zeroAdr.noi;
    const adrScaleBE = slopeAdr > 0 ? (debtService - zeroAdr.noi) / slopeAdr : null;
    return {
      grossIncome: base.gross, noi: base.noi, cf, debtService,
      breakeven: { occupancy: occScaleBE == null ? null : occScaleBE * avgOcc, adrUf: adrScaleBE == null ? null : adrScaleBE * p.str.adrUf },
      marginOfSafety: occScaleBE == null ? null : 1 - occScaleBE,
    };
  }
  const L = p.leaseMonths, v = p.turnoverVacancyMonths;
  const occ = L / (L + v);
  const coefRent = occ * (1 - p.collectionLossPct - p.maintenancePctOfRent - p.adminPctOfRent - p.rentTaxPct)
    - p.brokeragePctOfRent / (L + v);
  const gc = p.commonExpensesUf * ((1 - occ) + occ * p.ownerGcShareWhenRented);
  const noi = p.rentUf * coefRent - gc - fixed;
  const cf = noi - debtService;
  const rentBE = coefRent > 0 ? (gc + fixed + debtService) / coefRent : null;
  return {
    grossIncome: p.rentUf * occ, noi, cf, debtService, occupancy: occ,
    breakeven: { rentUf: rentBE },
    marginOfSafety: rentBE == null || p.rentUf <= 0 ? null : (p.rentUf - rentBE) / p.rentUf,
  };
}

export const DEFAULT_INPUT = {
  mode: 'tradicional',
  priceUf: 3000, discountPct: 0, bonoPiePct: 0, creditPct: 0.8, maxCreditPct: 0.9,
  annualRate: 0.045, rateConvention: 'nominal', loanYears: 30,
  deliveryMonths: 0, deliveryDelayMonths: 0, pieInstallmentsMax: 48, reservaUf: 0, pieUpfrontUf: 0, piePostDelivery: false,
  closing: { tasacionUf: 3, estudioTitulosUf: 5, borradorUf: 6, notariaUf: 4, cbrPct: 0.004, timbresPct: 0.008 },
  furnishingUf: 0,
  desgravamenPctMonthly: 0.00012, incendioPctMonthly: 0.00022, insuredValueFactor: 0.8,
  rentUf: 12, rentRealGrowth: 0,
  leaseMonths: 24, initialVacancyMonths: 1, turnoverVacancyMonths: 1,
  brokeragePctOfRent: 0.595, collectionLossPct: 0.02, maintenancePctOfRent: 0.05, adminPctOfRent: 0,
  capexReserveUfMonth: 0.3, commonExpensesUf: 2, ownerGcShareWhenRented: 0,
  contribucionesUfYear: 0, rentTaxPct: 0,
  appreciationReal: 0.01, marketValueFactor: 1, saleCostPct: 0.025,
  horizonYears: 30, startMonthIndex: 0, ufInflation: 0.03, discountRateReal: 0.04,
  str: { adrUf: 1.2, occupancy: 0.6, occupancyByMonth: [null, null, null, null, null, null, null, null, null, null, null, null],
    seasonalAdrFactor: null, avgStayNights: 3, cleaningFeeUf: 0.5, cleaningCostUf: 0.45, suppliesPerNightUf: 0.05,
    platformFeePct: 0.03, cohostPct: 0.2, utilitiesUfMonth: 1.6, replacementPct: 0.03, ivaApplies: true, ivaRate: 0.19 },
};

export function withDefaults(inp = {}) {
  const out = { ...DEFAULT_INPUT, ...inp };
  out.closing = { ...DEFAULT_INPUT.closing, ...(inp.closing || {}) };
  out.str = { ...DEFAULT_INPUT.str, ...(inp.str || {}) };
  if (!Array.isArray(out.str.occupancyByMonth) || out.str.occupancyByMonth.length !== 12) {
    out.str.occupancyByMonth = Array(12).fill(null);
  }
  return out;
}

/** Ejecuta los cuatro escenarios obligatorios sobre la misma unidad. Cada escenario es un
 *  conjunto de ajustes editables (config/defaults.json → scenarios). */
export function runScenarios(baseInput, scenarios) {
  const out = {};
  for (const [name, s] of Object.entries(scenarios)) {
    const inp = { ...baseInput };
    inp.rentUf = baseInput.rentUf * (s.rentFactor ?? 1);
    for (const k of ['initialVacancyMonths', 'turnoverVacancyMonths', 'maintenancePctOfRent', 'collectionLossPct',
      'appreciationReal', 'marketValueFactor', 'capexReserveUfMonth']) if (s[k] != null) inp[k] = s[k];
    inp.commonExpensesUf = baseInput.commonExpensesUf * (s.commonExpensesFactor ?? 1);
    inp.deliveryDelayMonths = baseInput.deliveryMonths > 0 ? (s.deliveryDelayMonths ?? 0) : 0;
    // En compras en verde la tasa se fija al escriturar: puede subir antes de la entrega.
    if (baseInput.deliveryMonths > 0 && s.rateBumpIfFuture) inp.annualRate = baseInput.annualRate + s.rateBumpIfFuture;
    if (baseInput.mode === 'renta_corta' && baseInput.str) {
      inp.str = { ...baseInput.str, occupancy: baseInput.str.occupancy * (s.occupancyFactor ?? 1),
        occupancyByMonth: (baseInput.str.occupancyByMonth || []).map((o) => (o == null ? null : o * (s.occupancyFactor ?? 1))),
        adrUf: baseInput.str.adrUf * (s.adrFactor ?? 1) };
    }
    out[name] = simulate(inp);
  }
  return out;
}

/** Sensibilidad de una métrica a variaciones de un parámetro (para la tabla de sensibilidad). */
export function sensitivity(baseInput, param, values, metric = 'monthlyCf') {
  return values.map((v) => {
    const inp = { ...baseInput };
    if (param === 'rentFactor') inp.rentUf = baseInput.rentUf * v;
    else if (param === 'commonExpensesFactor') inp.commonExpensesUf = baseInput.commonExpensesUf * v;
    else if (param === 'priceFactor') inp.priceUf = baseInput.priceUf * v;
    else inp[param] = v;
    const r = simulate(inp);
    return { value: v, metric: r.metrics[metric] };
  });
}
