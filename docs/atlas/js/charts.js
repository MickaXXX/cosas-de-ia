/* Gráficos SVG sin dependencias.
 * Reglas: un solo eje Y; marcas delgadas con extremo redondeado anclado a la línea base;
 * grilla y ejes recesivos; texto en tinta neutra (nunca en el color de la serie);
 * hover por columna (data-tip) en todos los gráficos; leyenda cuando hay ≥ 2 series.
 * Flujos: azul = positivo, rojo = negativo (par divergente validado). */
import { esc } from './format.js';

export function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

/** Barra con extremo de datos redondeado (4px) y base recta. */
function barPath(x, y0, y1, w, r = 4) {
  const top = Math.min(y0, y1), bot = Math.max(y0, y1), h = bot - top;
  r = Math.min(r, w / 2, h);
  if (h <= 0.5) return `M${x},${y0}h${w}`;
  if (y1 < y0) { // hacia arriba: redondeo arriba
    return `M${x},${bot}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bot}Z`;
  }
  return `M${x},${top}V${bot - r}Q${x},${bot} ${x + r},${bot}H${x + w - r}Q${x + w},${bot} ${x + w},${bot - r}V${top}Z`;
}

/**
 * Barras (opcionalmente divergentes: positivo/negativo).
 * @param {{items:{label:string,value:number,tip?:string}[], fmt:(n:number)=>string, height?:number, diverging?:boolean, color?:string, labelEvery?:number, title?:string}} o
 */
export function barChart(o) {
  const W = 760, H = o.height || 220, L = 64, R = 10, T = 12, B = 30;
  const vals = o.items.map((i) => i.value).filter(Number.isFinite);
  if (!vals.length) return '<div class="empty">Sin datos para graficar</div>';
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 4);
  const y = (v) => T + (H - T - B) * (1 - (v - ticks[0]) / (ticks.at(-1) - ticks[0]));
  const n = o.items.length, band = (W - L - R) / n, bw = Math.max(2, Math.min(28, band - 2));
  const every = o.labelEvery || Math.ceil(n / 12);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title || 'Gráfico de barras')}">`;
  const tickFmt = o.tickFmt || o.fmt;
  for (const t of ticks) s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(tickFmt(t))}</text>`;
  s += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
  o.items.forEach((it, i) => {
    const x = L + i * band + (band - bw) / 2;
    const col = o.diverging ? (it.value >= 0 ? 'var(--pos)' : 'var(--neg)') : (o.color || 'var(--s1)');
    const tipText = it.tip || `${it.label}: ${o.fmt(it.value)}`;
    s += `<g data-tip="${esc(tipText)}"><rect class="hit" x="${L + i * band}" y="${T}" width="${band}" height="${H - T - B}"/>`;
    if (Number.isFinite(it.value)) s += `<path class="mark" d="${barPath(x, y(0), y(it.value), bw)}" fill="${col}"/>`;
    s += '</g>';
    if (i % every === 0) s += `<text x="${L + i * band + band / 2}" y="${H - 10}" text-anchor="middle">${esc(it.label)}</text>`;
  });
  return `${s}</svg>`;
}

/**
 * Líneas (≤ 5 series, colores categóricos en orden fijo). Hover por columna con todos los valores.
 * @param {{x:string[], series:{name:string,values:number[],color?:string,dashed?:boolean}[], fmt:(n:number)=>string, height?:number, title?:string, zero?:boolean}} o
 */
export function lineChart(o) {
  const W = 760, H = o.height || 240, L = 70, R = 12, T = 12, B = 30;
  const all = o.series.flatMap((s) => s.values).filter(Number.isFinite);
  if (!all.length) return '<div class="empty">Sin datos para graficar</div>';
  const ticks = niceTicks(Math.min(o.zero ? 0 : Infinity, ...all), Math.max(o.zero ? 0 : -Infinity, ...all), 4);
  const n = o.x.length;
  const xs = (i) => L + (n === 1 ? 0 : (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (H - T - B) * (1 - (v - ticks[0]) / (ticks.at(-1) - ticks[0]));
  const colors = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title || 'Gráfico de líneas')}">`;
  for (const t of ticks) s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(o.fmt(t))}</text>`;
  if (ticks[0] < 0 && ticks.at(-1) > 0) s += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
  o.series.forEach((sr, k) => {
    const col = sr.color || colors[k % colors.length];
    const pts = sr.values.map((v, i) => (Number.isFinite(v) ? `${xs(i).toFixed(1)},${y(v).toFixed(1)}` : null)).filter(Boolean);
    s += `<polyline fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" ${sr.dashed ? 'stroke-dasharray="5 4"' : ''} points="${pts.join(' ')}"/>`;
  });
  for (const mk of o.markers || []) {                // marcas verticales (p. ej., la entrega)
    if (!(mk.i >= 0 && mk.i < n)) continue;
    const x = xs(mk.i);
    s += `<line class="axis" stroke-dasharray="3 3" x1="${x}" x2="${x}" y1="${T}" y2="${H - B}"/><text x="${Math.min(x + 4, W - R - 60)}" y="${T + 10}">${esc(mk.label)}</text>`;
  }
  const every = Math.ceil(n / 10);
  for (let i = 0; i < n; i++) {
    const x0 = i === 0 ? L : (xs(i - 1) + xs(i)) / 2, x1 = i === n - 1 ? W - R : (xs(i) + xs(i + 1)) / 2;
    const tipText = `${o.x[i]}\n${o.series.map((sr) => `${sr.name}: ${o.fmt(sr.values[i])}`).join('\n')}`;
    s += `<rect class="hit" data-tip="${esc(tipText)}" x="${x0}" y="${T}" width="${Math.max(1, x1 - x0)}" height="${H - T - B}"/>`;
    if (i % every === 0 || i === n - 1) s += `<text x="${xs(i)}" y="${H - 10}" text-anchor="middle">${esc(o.x[i])}</text>`;
  }
  s += '</svg>';
  if (o.series.length > 1) {
    s += `<div class="chart-legend">${o.series.map((sr, k) => `<span><i style="background:${sr.color || colors[k % colors.length]}"></i>${esc(sr.name)}</span>`).join('')}</div>`;
  }
  return s;
}

/** Histograma con marcas verticales (mediana, valor de la unidad…). */
export function histogramChart(bins, fmt, markers = [], title = 'Distribución') {
  if (!bins.length) return '<div class="empty">Sin datos</div>';
  const W = 760, H = 170, L = 36, R = 10, T = 14, B = 30;
  const max = Math.max(...bins.map((b) => b.count));
  const lo = bins[0].from, hi = bins.at(-1).to;
  const x = (v) => L + ((v - lo) / (hi - lo || 1)) * (W - L - R);
  const y = (c) => T + (H - T - B) * (1 - c / (max || 1));
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`;
  s += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
  for (const b of bins) {
    const x0 = x(b.from) + 1, w = Math.max(1, x(b.to) - x(b.from) - 2);
    s += `<g data-tip="${esc(`${fmt(b.from)} – ${fmt(b.to)}: ${b.count} aviso${b.count === 1 ? '' : 's'}`)}"><rect class="hit" x="${x(b.from)}" y="${T}" width="${x(b.to) - x(b.from)}" height="${H - T - B}"/>`;
    s += `<path class="mark" d="${barPath(x0, y(0), y(b.count), w)}" fill="var(--s1)"/></g>`;
  }
  s += `<text x="${L}" y="${H - 10}">${esc(fmt(lo))}</text><text x="${W - R}" y="${H - 10}" text-anchor="end">${esc(fmt(hi))}</text>`;
  markers.forEach((m, k) => {
    if (!Number.isFinite(m.value)) return;
    const xm = x(Math.max(lo, Math.min(hi, m.value)));
    s += `<line x1="${xm}" x2="${xm}" y1="${T - 4}" y2="${y(0)}" stroke="var(--text)" stroke-width="1.5" ${k ? 'stroke-dasharray="4 3"' : ''}/>`;
    s += `<text x="${xm + 4}" y="${T + 6 + k * 12}" style="fill:var(--text)">${esc(m.label)}</text>`;
  });
  return `${s}</svg>`;
}

/** Barra horizontal simple 0–100 (scores y riesgos). */
export function meter(v, kind = '') {
  const pct = Math.max(0, Math.min(100, v ?? 0));
  return `<div class="bar ${kind}" role="meter" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>`;
}
