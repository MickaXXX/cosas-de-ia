/* Estimador explicable de gastos comunes (GC).
 *
 * Prioridad de evidencia:
 *  1. PUBLICADO   la unidad o el proyecto informa el GC (CLP o CLP/m²) con su fuente.
 *  2. COMPARABLES avisos de arriendo cercanos que informan su GC: mediana de CLP/m² útil
 *                 (rango p25–p75) × m² de la unidad, con mínimo de muestra.
 *  3. SUPUESTO    banda editable CLP/m² por comuna (config/defaults.json →
 *                 commonExpenses.bandsByCommune). Se rotula ESTIMADO y nunca se presenta
 *                 como dato real.
 * En los tres casos se ajusta por amenities (piscina, gimnasio, conserjería 24 h…) solo
 * cuando la fuente no las incluye ya.
 */
import { stats, withinRadius } from './rentals.js';

export function amenityFactor(amenities = [], adjust = {}) {
  let f = 1;
  const set = new Set((amenities || []).map((a) => String(a).toLowerCase()));
  for (const [key, pct] of Object.entries(adjust)) if ([...set].some((a) => a.includes(key))) f += pct;
  return f;
}

export function estimateCommonExpenses(project, unit, { listings = [], cfg }) {
  const m2 = unit.useful_m2 || null;
  if (unit.common_expenses_clp) {
    const v = unit.common_expenses_clp;
    return { lowClp: v, baseClp: v, highClp: v * 1.1, method: 'publicado para la unidad', kind: 'PUBLICADO', confidence: 'alta',
      notes: 'El GC informado suele ser de un mes "típico"; puede variar con consumos y fondo de reserva.' };
  }
  if (project.common_expenses_clp_m2 && m2) {
    const v = project.common_expenses_clp_m2 * m2;
    return { lowClp: v, baseClp: v, highClp: v * 1.1, method: `publicado por el proyecto (${Math.round(project.common_expenses_clp_m2)} CLP/m²)`,
      kind: 'PUBLICADO', confidence: 'alta' };
  }
  if (project.common_expenses_clp && !project.demo) {
    const v = project.common_expenses_clp;
    return { lowClp: v * 0.9, baseClp: v, highClp: v * 1.15, method: 'publicado por el proyecto (monto de referencia, no por unidad)',
      kind: 'PUBLICADO', confidence: 'media' };
  }
  const fac = amenityFactor(project.amenities, cfg.amenityAdjust);
  if (m2 && project.lat != null) {
    const near = withinRadius(project.lon, project.lat, listings.filter((r) => !!r.demo === !!project.demo
      && r.common_expenses_clp > 0 && r.useful_m2 > 0), cfg.radiusM || 1500);
    const recent = near.filter((r) => !r.building_year || r.building_year >= (cfg.minBuildingYear || 2012));
    const s = stats(recent.map((r) => r.common_expenses_clp / r.useful_m2));
    if (s.n >= (cfg.minSample || 5)) {
      return { lowClp: s.p25 * m2, baseClp: s.median * m2, highClp: s.p75 * m2,
        method: `${s.n} edificios cercanos con GC informado: mediana ${Math.round(s.median)} CLP/m²`,
        kind: 'ESTIMADO', confidence: s.n >= 12 ? 'media' : 'baja', n: s.n };
    }
  }
  const band = (cfg.bandsByCommune || {})[project.commune] || cfg.defaultBand;
  if (!band || !m2) return { lowClp: null, baseClp: null, highClp: null, method: 'sin datos', kind: 'SIN DATOS', confidence: 'nula' };
  return {
    lowClp: band.low * m2 * fac, baseClp: band.base * m2 * fac, highClp: band.high * m2 * fac,
    method: `supuesto editable para ${project.commune}: ${band.low}–${band.high} CLP/m² útil${fac !== 1 ? ` × ${fac.toFixed(2)} por amenities` : ''}`,
    kind: 'ESTIMADO', confidence: 'baja', source: band.source || 'supuesto de la app (editable en Configuración)',
  };
}
