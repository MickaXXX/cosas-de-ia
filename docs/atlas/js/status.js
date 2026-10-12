/* Estado de entrega → color del pin.
 *
 *  ROJO      entrega inmediata con entrega/recepción Y stock disponible verificados, y
 *            verificación reciente (≤ maxVerificationAgeDays). Nunca se infiere solo
 *            porque la fecha proyectada ya pasó.
 *  AMARILLO  fecha de entrega futura verificada a 365 días o menos.
 *  VERDE     fecha de entrega futura a más de 365 días.
 *  GRIS      fecha desconocida, contradictoria, vencida sin confirmación o
 *            disponibilidad no verificada.
 *
 * Fechas con precisión de mes ("2027-03") se interpretan como el último día del mes:
 * es la lectura conservadora (la entrega puede ser a fin de mes).
 */

export const STATUS = {
  rojo: { color: '#D93025', label: 'Entrega inmediata' },
  amarillo: { color: '#F2B705', label: 'Entrega ≤ 1 año' },
  verde: { color: '#1E8E3E', label: 'Entrega > 1 año' },
  gris: { color: '#8A8F98', label: 'Sin verificar / desconocida' },
};

const DAY = 86400000;

/** 'AAAA-MM-DD' | 'AAAA-MM' | 'AAAA' → Date UTC a medianoche (o null). */
export function parseDeliveryDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = str.match(/^(\d{4})-(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2], 0));          // último día del mes
  m = str.match(/^(\d{4})$/);
  if (m) return new Date(Date.UTC(+m[1], 11, 31));
  return null;
}

export function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

/** Días calendario entre dos fechas ISO (b − a). */
export function daysBetween(aISO, bISO) {
  const a = parseDeliveryDate(aISO), b = parseDeliveryDate(bISO);
  if (!a || !b) return null;
  return Math.round((b - a) / DAY);
}

export function deliveryStatus(project, todayISO, { maxVerificationAgeDays = 60 } = {}) {
  const d = project?.delivery || {};
  const out = (code, reason, extra = {}) => ({ code, color: STATUS[code].color, label: STATUS[code].label, reason, ...extra });
  const date = parseDeliveryDate(d.date);
  const days = date ? daysBetween(todayISO, toISODate(date)) : null;
  if (d.immediate_verified) {
    if (days != null && days > 30) return out('gris', 'Datos contradictorios: dice entrega inmediata pero informa una fecha futura', { days });
    if (!d.stock_verified) return out('gris', 'Entrega inmediata declarada, pero el stock disponible no está verificado');
    const age = d.verified_at ? daysBetween(d.verified_at, todayISO) : null;
    if (age == null) return out('gris', 'Entrega inmediata sin fecha de verificación');
    if (age > maxVerificationAgeDays) return out('gris', `Verificación vencida: se comprobó hace ${age} días (máx. ${maxVerificationAgeDays})`, { verifiedAgeDays: age });
    return out('rojo', `Entrega inmediata y stock verificados hace ${age} días`, { verifiedAgeDays: age, days: 0 });
  }
  if (!date || d.date_status === 'desconocida') return out('gris', 'Fecha de entrega desconocida');
  if (days <= 0) return out('gris', 'La fecha proyectada ya pasó y no hay confirmación de entrega ni de stock', { days });
  const est = d.date_status === 'estimada' ? ' (fecha estimada por la inmobiliaria)' : '';
  if (days <= 365) return out('amarillo', `Entrega en ${days} días${est}`, { days });
  return out('verde', `Entrega en ${days} días${est}`, { days });
}

/** Meses (enteros, hacia arriba) hasta la entrega: 0 si es inmediata. null si no se sabe. */
export function monthsToDelivery(status) {
  if (status.code === 'rojo') return 0;
  if (status.days == null || status.days <= 0) return null;
  return Math.ceil(status.days / 30.4375);
}
