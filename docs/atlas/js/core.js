/* Estado global, almacenamiento local y registro de acciones.
 * Las vistas importan de aquí (nunca de app.js) para evitar dependencias circulares. */

export const REPO = { owner: 'MickaXXX', name: 'cosas-de-ia' };

export const S = {
  raw: {},             // datos tal como llegan (JSON del repo)
  config: null,        // configuración efectiva = defaults + ajustes locales
  ctx: null,           // contexto de análisis (analysis.buildContext)
  projects: [],        // proyectos visibles (reales + importados localmente [+ demo])
  analyses: new Map(), // id proyecto → analyzeProject()
  view: 'mapa',
  demo: false,
  selected: null,      // { projectId, unitId }
  filters: null,
  drawPolygon: null,
  ready: false,
};

/** localStorage envuelto: puede fallar (modo privado, cuota) y la app debe seguir. */
export const LS = {
  get(key, def = null) {
    try { const v = localStorage.getItem(`atlas.${key}`); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(`atlas.${key}`, JSON.stringify(val)); return true; } catch { return false; }
  },
  del(key) { try { localStorage.removeItem(`atlas.${key}`); } catch { /* nada */ } },
};

/** Acciones que registra app.js y usan las vistas. */
export const actions = {};

const listeners = new Map();
export function on(evt, fn) { (listeners.get(evt) || listeners.set(evt, []).get(evt)).push(fn); }
export function emit(evt, payload) { for (const fn of listeners.get(evt) || []) fn(payload); }

export function deepMerge(a, b) {
  if (Array.isArray(b) || b == null || typeof b !== 'object') return b === undefined ? a : b;
  const out = Array.isArray(a) ? [...a] : { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, val) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
  o[keys.at(-1)] = val;
  return obj;
}

export function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

/** Proyecto por id entre todos los datasets cargados. */
export function projectById(id) {
  return S.projects.find((p) => p.id === id) || null;
}

export function analysisOf(projectId, unitId) {
  const a = S.analyses.get(projectId);
  if (!a) return null;
  if (!unitId) return a.best;
  return a.units.find((x) => x.unit.id === unitId) || a.best;
}

export function ufValue() { return S.raw.uf?.value ?? null; }
