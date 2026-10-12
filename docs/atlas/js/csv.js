/* Importación CSV en el navegador: parseo, validación en línea con el mismo esquema que
 * usa el pipeline (config/import_schema.json) y armado de proyectos/avisos.
 * La lógica replica scripts/atlas/import_data.py; las pruebas cubren ambos lados. */

const TRUE = new Set(['si', 'sí', 's', 'yes', 'y', 'true', '1', 'x', 'verdadero']);
const FALSE = new Set(['no', 'n', 'false', '0', 'falso', '']);

/** Parser CSV con comillas, saltos de línea dentro de comillas y separador , o ; */
export function parseCSV(text) {
  const t = text.replace(/^﻿/, '');
  const head = t.slice(0, 2000);
  const delim = (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const cols = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(cols.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** '2.921' → 2921 · '2.921,5' → 2921.5 · '35,5' → 35.5 · '2,921.5' → 2921.5 */
export function parseNumber(v) {
  let s = String(v).trim().replace(/\s|\$|UF/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) s = s.replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1 || /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  if (!Number.isFinite(n) || s === '') throw new Error('no es un número');
  return n;
}

function parseDate(raw) {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = m[3] ? +m[3] : 1;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return m[3] ? s : s.slice(0, 7);
  }
  m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (m) return parseDate(`${m[3]}-${m[2]}-${m[1]}`);
  return null;
}

export function validateRow(row, columns, line) {
  const out = {}, errors = [];
  for (const col of columns) {
    const raw = (row[col.name] ?? '').trim();
    if (raw === '') {
      if (col.required) errors.push({ line, column: col.name, message: 'obligatorio' });
      out[col.name] = null;
      continue;
    }
    try {
      let v;
      switch (col.type) {
        case 'number': case 'integer':
          v = parseNumber(raw);
          if (col.type === 'integer' && !Number.isInteger(v)) throw new Error('debe ser entero');
          if ((col.min != null && v < col.min) || (col.max != null && v > col.max)) throw new Error(`fuera de rango [${col.min}, ${col.max}]`);
          break;
        case 'date':
          v = parseDate(raw);
          if (!v) throw new Error('fecha inválida (usar AAAA-MM-DD)');
          break;
        case 'url':
          if (!/^https?:\/\/\S+$/.test(raw)) throw new Error('URL inválida');
          v = raw; break;
        case 'bool': {
          const low = raw.toLowerCase();
          if (TRUE.has(low)) v = true; else if (FALSE.has(low)) v = false; else throw new Error('usar si/no');
          break;
        }
        case 'enum':
          if (!col.enum.includes(raw)) throw new Error(`debe ser uno de ${col.enum.join(', ')}`);
          v = raw; break;
        default: v = raw;
      }
      out[col.name] = v;
    } catch (e) {
      errors.push({ line, column: col.name, value: raw, message: e.message });
    }
  }
  return { record: out, errors };
}

export function validateRows(rows, schema) {
  const errors = [];
  const names = new Set(schema.columns.map((c) => c.name));
  const present = rows[0] ? Object.keys(rows[0]) : [];
  const unknown = present.filter((c) => !names.has(c));
  const missing = schema.columns.filter((c) => c.required && !present.includes(c.name)).map((c) => c.name);
  if (missing.length) errors.push({ line: 1, column: missing.join(', '), message: 'faltan columnas obligatorias' });
  const records = rows.map((r, i) => {
    const { record, errors: e } = validateRow(r, schema.columns, i + 2);
    errors.push(...e);
    return record;
  });
  return { records, errors, unknown };
}

export function buildProjects(records, nowIso) {
  const map = new Map();
  for (const r of records) {
    let p = map.get(r.project_id);
    if (!p) {
      const immediate = !!r.immediate_delivery_verified;
      const hasGeo = r.latitude != null && r.longitude != null;
      p = {
        id: r.project_id, name: r.project_name,
        developer: { name: r.developer_name, url: r.developer_url },
        address: r.address, commune: r.commune, neighborhood: r.neighborhood,
        lat: r.latitude, lon: r.longitude,
        geo_precision: r.geolocation_precision || (hasGeo ? 'exacta' : 'pendiente'),
        geo_source: hasGeo ? 'manual' : null,
        delivery: { status: immediate ? 'inmediata' : r.delivery_date ? 'futura' : 'desconocida', date: r.delivery_date,
          date_status: r.delivery_date_status || (immediate ? 'confirmada' : 'desconocida'),
          immediate_verified: immediate, stock_verified: !!r.available_stock_verified, verified_at: r.data_observed_at },
        publication_url: r.publication_url, brochure_url: r.brochure_url,
        short_term_rental: { status: r.short_term_rental_status || 'por_verificar' },
        observed_at: r.data_observed_at, demo: !!r.is_demo, units: [],
        first_seen_at: nowIso, source_kind: 'importacion_local',
        evidence: [{ field: 'units', source_name: 'Importación CSV (navegador)', source_url: r.publication_url,
          observed_at: r.data_observed_at, ingested_at: nowIso, access_method: 'importacion_csv',
          license_status: 'declarado_por_quien_importa', confidence: 'media', verification_status: 'importado_sin_verificar',
          notes: r.evidence_notes }],
      };
      map.set(r.project_id, p);
    }
    p.units.push({ id: r.unit_id, type: r.unit_type, bedrooms: r.bedrooms, bathrooms: r.bathrooms, useful_m2: r.useful_area_m2,
      total_m2: r.total_area_m2, list_price_uf: r.list_price_uf, offer_price_uf: r.offer_price_uf, bono_pie_pct: r.bono_pie_pct,
      parking: r.parking, storage: r.storage, floor: r.floor, orientation: r.orientation,
      common_expenses_clp: r.common_expenses_clp,
      available: r.available_stock_verified == null ? null : !!r.available_stock_verified });
  }
  return [...map.values()];
}

export function buildRentals(records, nowIso) {
  return records.map((r) => ({
    id: r.listing_id, source: r.source, url: r.url, address: r.address, commune: r.commune,
    lat: r.latitude, lon: r.longitude, geo_precision: r.geolocation_precision || (r.latitude != null ? 'exacta' : 'pendiente'),
    price_clp: r.price_clp, common_expenses_clp: r.common_expenses_clp, common_expenses_included: r.common_expenses_included,
    bedrooms: r.bedrooms, bathrooms: r.bathrooms, useful_m2: r.useful_area_m2, furnished: r.furnished, parking: r.parking,
    building_year: r.building_year, published_at: r.published_at, observed_at: r.observed_at, notes: r.notes,
    demo: !!r.is_demo, ingested_at: nowIso, price_kind: 'pedido', source_kind: 'importacion_local',
  }));
}

/** Plantilla descargable: encabezados + una fila de ejemplo rotulada DEMO. */
export function template(schema, example = {}) {
  const cols = schema.columns.map((c) => c.name);
  const line = cols.map((c) => {
    const v = example[c] ?? '';
    return /[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  });
  return `${cols.join(',')}\n${line.join(',')}\n`;
}
