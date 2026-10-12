/* Formatos es-CL: CLP con separador de miles, UF con dos decimales, fechas en
 * America/Santiago. Una sola fuente para toda la interfaz. */

const TZ = 'America/Santiago';
const nf = (d) => new Intl.NumberFormat('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d });
const NF0 = nf(0), NF1 = nf(1), NF2 = nf(2);

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function clp(x, { sign = false } = {}) {
  if (!isNum(x)) return 's/d';
  const s = NF0.format(Math.round(Math.abs(x)));
  return `${x < 0 ? '−' : sign && x > 0 ? '+' : ''}$${s}`;
}

export function uf(x, d = 2, { sign = false } = {}) {
  if (!isNum(x)) return 's/d';
  const f = d === 0 ? NF0 : d === 1 ? NF1 : NF2;
  return `${x < 0 ? '−' : sign && x > 0 ? '+' : ''}UF ${f.format(Math.abs(x))}`;
}

export function num(x, d = 0) {
  if (!isNum(x)) return 's/d';
  return (d === 0 ? NF0 : d === 1 ? NF1 : NF2).format(x);
}

export function pct(x, d = 1, { sign = false } = {}) {
  if (!isNum(x)) return 's/d';
  const v = x * 100;
  return `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}${(d === 0 ? NF0 : d === 1 ? NF1 : NF2).format(Math.abs(v))}%`;
}

export function meters(m) {
  if (!isNum(m)) return 's/d';
  return m >= 1000 ? `${NF1.format(m / 1000)} km` : `${NF0.format(Math.round(m / 10) * 10)} m`;
}

/** 'AAAA-MM-DD' o ISO → '12-10-2026' (hora de Santiago para timestamps). */
export function date(s, { time = false } = {}) {
  if (!s) return 's/d';
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-');
    return `${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][+m - 1]} ${y}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${d}-${m}-${y}`;
  }
  const dt = new Date(s);
  if (Number.isNaN(+dt)) return String(s);
  const opts = { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' };
  if (time) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return new Intl.DateTimeFormat('es-CL', opts).format(dt);
}

/** Fecha de hoy en Santiago como 'AAAA-MM-DD'. */
export function todaySantiago(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export function monthIndexSantiago(now = new Date()) {
  return +todaySantiago(now).slice(5, 7) - 1;
}

export const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Convierte UF→CLP con el valor y la fecha de referencia (se muestran juntos). */
export function ufToClp(x, ufValue) {
  return isNum(x) && isNum(ufValue) ? x * ufValue : null;
}
