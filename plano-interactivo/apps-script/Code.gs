/**
 * Plano Fotográfico de Planta — servidor (Google Apps Script).
 *
 * Base de datos: el Google Sheet que contiene este script (hojas Puntos, Fotos, Observaciones, Config).
 * Fotos: carpeta de Drive creada por instalar(), con una subcarpeta de miniaturas.
 * La app web se publica "Ejecutar como: yo" y "Acceso: usuarios del dominio".
 */

const TZ = 'America/Santiago';

const SECTORES = ['agua', 'vapor', 'frio', 'electrica', 'riles', 'proceso', 'apoyo'];

// [campo en la app, encabezado en la hoja, tipo]
const HOJAS = {
  puntos: {
    nombre: 'Puntos',
    campos: [
      ['id', 'id', 'str'], ['code', 'código', 'str'], ['name', 'nombre', 'str'], ['sector', 'sector', 'str'],
      ['equipo', 'equipo', 'str'], ['descripcion', 'descripción', 'str'], ['x', 'x', 'num'], ['y', 'y', 'num'],
      ['createdAt', 'creado', 'date'], ['updatedAt', 'actualizado', 'date'], ['updatedBy', 'actualizado por', 'str'],
    ],
  },
  fotos: {
    nombre: 'Fotos',
    campos: [
      ['id', 'id', 'str'], ['pointLabel', 'punto', 'str'], ['pointId', 'punto id', 'str'],
      ['capturedAt', 'fecha captura', 'date'], ['dateSource', 'origen fecha', 'str'],
      ['caption', 'observación', 'str'], ['author', 'responsable', 'str'], ['by', 'subida por', 'str'],
      ['uploadedAt', 'fecha subida', 'date'], ['filename', 'archivo original', 'str'],
      ['w', 'ancho', 'num'], ['h', 'alto', 'num'], ['size', 'bytes', 'num'],
      ['link', 'enlace', 'str'], ['assetId', 'archivo drive', 'str'], ['thumbId', 'miniatura drive', 'str'],
      ['updatedAt', 'actualizado', 'date'],
    ],
  },
  notas: {
    nombre: 'Observaciones',
    campos: [
      ['id', 'id', 'str'], ['pointLabel', 'punto', 'str'], ['pointId', 'punto id', 'str'],
      ['text', 'texto', 'str'], ['by', 'autor', 'str'], ['createdAt', 'fecha', 'date'],
    ],
  },
};
const SOLO_SERVIDOR = ['pointLabel', 'link', 'updatedBy'];

const CONFIG_DEF = [
  ['editores_puntos', '', 'Correos que pueden crear, mover, editar o borrar puntos del plano. Separados por coma. "@dominio.cl" = todo el dominio. Vacío = todos. El dueño del script siempre puede.'],
  ['editores_fotos', '', 'Correos que pueden subir, mover o borrar fotos y escribir observaciones. Vacío = todos los usuarios que abren la app.'],
  ['subtitulo', 'Planta Antofagasta · Suministros', 'Texto bajo el título de la app.'],
  ['carpeta_fotos', '', 'Carpeta de Drive donde se guardan las fotos (la crea Instalar).'],
];

// Puntos rotulados en el plano ANT-PLA-GEN-004 (píxeles sobre el plano rotado de 3427 × 2853).
const PLANO = { w: 3427, h: 2853 };
const PUNTOS_BASE = [
  ['P-001', 'Planta de Agua', 'agua', 880, 880, 'Filtro carbón activo · Intercambiador'],
  ['P-002', 'Ósmosis inversa y ultrafiltración', 'agua', 900, 955, 'Ósmosis inversa · Ultrafiltración'],
  ['P-003', 'Estanques TK1 a TK4', 'agua', 545, 965, 'TK1 agua demineralizada · TK2 agua potable · TK3 agua tratada · TK4 agua CIP'],
  ['P-004', 'Reactor y filtros de arena', 'agua', 385, 1100, 'Reactor · Pulmón · Filtros arena · Bomba'],
  ['P-005', 'Filtros de carbón y UV', 'agua', 610, 1065, 'Filtros carbón · Filtro UV'],
  ['P-006', 'Estanque agua potable', 'agua', 3175, 1865, 'Vol. 900 m³'],
  ['P-007', 'Planta presurización y distribución A.P.', 'agua', 3150, 1752, ''],
  ['P-008', 'Sala Calderas', 'vapor', 865, 1090, 'Calderas 1 y 2 · Acumulador desgasificador · Manifold vapor'],
  ['P-009', 'Estanques de petróleo', 'vapor', 600, 1162, 'Estanques 1, 2 y 3'],
  ['P-010', 'Compresores · Sala Máquinas', 'frio', 1005, 1048, 'Compresores · Filtros coalescentes · Filtros estéril'],
  ['P-011', 'Condensadores y estanques de amoníaco', 'frio', 1130, 935, 'Condensadores · Estanques amoníaco'],
  ['P-012', 'Estanques CO₂', 'frio', 1140, 1045, '2 estanques CO₂ · Enfriadoras'],
  ['P-013', 'Generadores', 'electrica', 1150, 1128, 'Generadores · Sala Máquinas'],
  ['P-014', 'Planta de RILES', 'riles', 3120, 2195, ''],
  ['P-015', 'Estanque de drenaje', 'riles', 2540, 2105, ''],
  ['P-016', 'Residuos sólidos reciclables', 'riles', 130, 880, ''],
  ['P-017', 'Unitanques', 'proceso', 925, 1645, 'Unitanques 1 a 8'],
  ['P-018', 'Elaboración cerveza', 'proceso', 1010, 1450, 'Sala aditivos · Elaboración'],
  ['P-019', 'Sala CIP elaboración', 'proceso', 960, 1535, ''],
  ['P-020', 'Cámara de frío', 'frio', 770, 1345, ''],
  ['P-021', 'Estanques de soda', 'proceso', 1270, 1300, 'Soda concentrada · Soda diluida'],
  ['P-022', 'Jarabería', 'proceso', 1420, 1330, 'Sala jarabe simple · Sala jarabe terminado'],
  ['P-023', 'Lavadora', 'proceso', 1640, 1228, ''],
  ['P-024', 'Pasteurizador', 'proceso', 1620, 1725, ''],
  ['P-025', 'Estanques DT 1 a DT 6', 'proceso', 1310, 1710, 'DT 1 a DT 6'],
  ['P-026', 'Estación CIP envasado', 'proceso', 1415, 1885, 'Zona envasado'],
  ['P-027', 'Laboratorio aseguramiento de calidad', 'apoyo', 1625, 1890, ''],
  ['P-028', 'Maestranza', 'apoyo', 1012, 922, ''],
  ['P-029', 'Patio de carga', 'apoyo', 2760, 1498, ''],
  ['P-030', 'Sala soplado', 'proceso', 2150, 1175, 'Bodega pre formas'],
];

/* ======================= app web ======================= */

function doGet() {
  const t = HtmlService.createTemplateFromFile('Index');
  let boot;
  try { boot = estado(); } catch (e) { boot = { error: e.message }; }
  t.boot = JSON.stringify(boot).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('Plano Fotográfico')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function include_(nombre) {
  return HtmlService.createHtmlOutputFromFile(nombre).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Plano Fotográfico')
    .addItem('Instalar o reparar', 'instalar')
    .addItem('Ver enlace de la app', 'mostrarEnlace')
    .addToUi();
}

function mostrarEnlace() {
  let url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  SpreadsheetApp.getUi().alert(url
    ? 'Enlace de la app:\n\n' + url
    : 'La app aún no está publicada. En el editor de Apps Script: Implementar → Nueva implementación → Aplicación web.');
}

/* ======================= lectura ======================= */

/** Todo lo que la app necesita para dibujarse. */
function estado() {
  const yo = usuario_();
  const c = config_();
  return {
    points: tabla_('puntos').objetos(),
    photos: tabla_('fotos').objetos(),
    notes: tabla_('notas').objetos(),
    version: version(),
    me: yo,
    subtitulo: String(c.subtitulo || ''),
  };
}

/** Número que cambia con cada escritura: la app lo consulta para saber si debe recargar. */
function version() {
  return Number(props_().getProperty('VERSION') || 0);
}

/** Devuelve imágenes como data URL cuando el navegador no puede verlas directo desde Drive. */
function imagenes(ids) {
  usuario_();
  if (!Array.isArray(ids)) return {};
  const t = tabla_('fotos');
  const permitidos = {};
  t.rows.forEach(r => { permitidos[String(r[t.col.assetId])] = true; permitidos[String(r[t.col.thumbId])] = true; });
  const out = {};
  let total = 0;
  ids.slice(0, 8).forEach(id => {
    id = String(id);
    if (!permitidos[id] || total > 4e6) return;
    try {
      const b = DriveApp.getFileById(id).getBlob();
      const s = Utilities.base64Encode(b.getBytes());
      total += s.length;
      out[id] = 'data:' + (b.getContentType() || 'image/jpeg') + ';base64,' + s;
    } catch (e) { out[id] = null; }
  });
  return out;
}

/* ======================= fotos ======================= */

function subirFoto(meta, fullB64, thumbB64) {
  const yo = exigir_('puedeFotos');
  meta = meta || {};
  const id = idValido_(meta.id);
  if (!fullB64 || !thumbB64) throw new Error('La foto llegó vacía. Inténtalo de nuevo.');
  const p = props_();
  const carpeta = DriveApp.getFolderById(p.getProperty('FOLDER_ID'));
  const mini = DriveApp.getFolderById(p.getProperty('THUMBS_ID'));
  const capt = Number(meta.capturedAt) || Date.now();
  const base = Utilities.formatDate(new Date(capt), TZ, 'yyyy-MM-dd_HHmm') + '_' +
    texto_(meta.filename || 'foto', 60).replace(/\.[a-z0-9]+$/i, '').replace(/[^\w\-]+/g, '_') + '.jpg';
  const f = carpeta.createFile(Utilities.newBlob(Utilities.base64Decode(fullB64), 'image/jpeg', base));
  const th = mini.createFile(Utilities.newBlob(Utilities.base64Decode(thumbB64), 'image/jpeg', 'min_' + base));
  compartir_(f); compartir_(th);
  const now = Date.now();
  const foto = {
    id: id, pointId: null, capturedAt: capt, dateSource: meta.dateSource === 'exif' ? 'exif' : 'archivo',
    caption: '', author: '', by: yo.email, uploadedAt: now, filename: texto_(meta.filename, 120),
    w: Number(meta.w) || 0, h: Number(meta.h) || 0, size: f.getSize(),
    link: f.getUrl(), assetId: f.getId(), thumbId: th.getId(), updatedAt: now,
  };
  try {
    return escribir_(null, () => {
      const t = tabla_('fotos');
      if (t.fila(id) >= 0) throw new Error('Esta foto ya estaba subida.');
      const pts = tabla_('puntos');
      if (meta.pointId && pts.fila(String(meta.pointId)) >= 0) foto.pointId = String(meta.pointId);
      foto.pointLabel = foto.pointId ? etiqueta_(pts, foto.pointId) : 'Bandeja';
      t.insertar([foto]);
      return { photo: publico_(foto) };
    });
  } catch (e) {
    try { f.setTrashed(true); th.setTrashed(true); } catch (e2) {}
    throw e;
  }
}

function moverFotos(ids, pointId) {
  return escribir_('puedeFotos', () => {
    const pts = tabla_('puntos');
    pointId = pointId ? String(pointId) : '';
    if (pointId && pts.fila(pointId) < 0) throw new Error('Ese punto ya no existe. Recarga la página.');
    const label = pointId ? etiqueta_(pts, pointId) : 'Bandeja';
    const t = tabla_('fotos');
    const now = new Date();
    const cambios = [];
    (ids || []).forEach(id => {
      const i = t.fila(String(id));
      if (i < 0) return;
      t.asignar(i, { pointId: pointId, pointLabel: label, updatedAt: now });
      cambios.push(i);
    });
    t.guardarFilas(cambios);
    return { n: cambios.length };
  });
}

function actualizarFoto(id, cambios) {
  return escribir_('puedeFotos', () => {
    const t = tabla_('fotos');
    const i = t.fila(String(id));
    if (i < 0) throw new Error('La foto ya no existe.');
    const c = {};
    if ('caption' in cambios) c.caption = texto_(cambios.caption, 1000);
    if ('author' in cambios) c.author = texto_(cambios.author, 80);
    if ('capturedAt' in cambios && Number(cambios.capturedAt) > 0) { c.capturedAt = Number(cambios.capturedAt); c.dateSource = 'manual'; }
    c.updatedAt = Date.now();
    t.asignar(i, c);
    t.guardarFilas([i]);
    return {};
  });
}

function eliminarFotos(ids) {
  const archivos = [];
  const r = escribir_('puedeFotos', () => {
    const t = tabla_('fotos');
    const filas = [];
    (ids || []).forEach(id => {
      const i = t.fila(String(id));
      if (i < 0) return;
      filas.push(i);
      archivos.push(String(t.rows[i][t.col.assetId]), String(t.rows[i][t.col.thumbId]));
    });
    t.eliminarFilas(filas);
    return { n: filas.length };
  });
  archivos.filter(Boolean).forEach(fid => { try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) {} });
  return r;
}

/* ======================= puntos ======================= */

function guardarPunto(id, datos) {
  return escribir_('puedePuntos', yo => {
    id = idValido_(id);
    const t = tabla_('puntos');
    if (t.fila(id) >= 0) throw new Error('Ese punto ya existe.');
    const now = Date.now();
    const p = Object.assign(limpiarPunto_(datos, true), { id: id, createdAt: now, updatedAt: now, updatedBy: yo.email });
    t.insertar([p]);
    return {};
  });
}

function actualizarPunto(id, cambios) {
  return escribir_('puedePuntos', yo => {
    const t = tabla_('puntos');
    const i = t.fila(String(id));
    if (i < 0) throw new Error('El punto ya no existe.');
    const c = limpiarPunto_(cambios, false);
    c.updatedAt = Date.now();
    c.updatedBy = yo.email;
    t.asignar(i, c);
    t.guardarFilas([i]);
    if ('code' in c || 'name' in c) reetiquetar_(String(id), etiqueta_(t, String(id)));
    return {};
  });
}

function eliminarPunto(id) {
  return escribir_('puedePuntos', () => {
    id = String(id);
    const t = tabla_('puntos');
    const i = t.fila(id);
    if (i < 0) return { n: 0 };
    const f = tabla_('fotos');
    const now = new Date();
    const filas = [];
    f.rows.forEach((r, k) => { if (String(r[f.col.pointId]) === id) { f.asignar(k, { pointId: '', pointLabel: 'Bandeja', updatedAt: now }); filas.push(k); } });
    f.guardarFilas(filas);
    const n = tabla_('notas');
    n.eliminarFilas(n.rows.map((r, k) => String(r[n.col.pointId]) === id ? k : -1).filter(k => k >= 0));
    t.eliminarFilas([i]);
    return { n: filas.length };
  });
}

function cargarPuntosBase() {
  return escribir_('puedePuntos', yo => ({ n: insertarBase_(tabla_('puntos'), yo.email) }));
}

/* ======================= observaciones ======================= */

function agregarObservacion(nota) {
  return escribir_('puedeFotos', yo => {
    nota = nota || {};
    const id = idValido_(nota.id);
    const pts = tabla_('puntos');
    const pid = String(nota.pointId || '');
    if (pts.fila(pid) < 0) throw new Error('El punto ya no existe.');
    const texto = texto_(nota.text, 2000).trim();
    if (!texto) throw new Error('La observación está vacía.');
    const n = { id: id, pointId: pid, pointLabel: etiqueta_(pts, pid), text: texto, by: yo.email, createdAt: Date.now() };
    tabla_('notas').insertar([n]);
    return { note: publico_(n) };
  });
}

function eliminarObservacion(id) {
  return escribir_('puedeFotos', yo => {
    const t = tabla_('notas');
    const i = t.fila(String(id));
    if (i < 0) return { n: 0 };
    const autor = String(t.rows[i][t.col.by]).toLowerCase();
    if (autor && autor !== yo.email && !yo.puedePuntos) throw new Error('Solo quien escribió la observación puede borrarla.');
    t.eliminarFilas([i]);
    return { n: 1 };
  });
}

/* ======================= instalación ======================= */

/** Ejecutar una vez desde el editor (o desde el menú del Sheet). Se puede repetir sin perder datos. */
function instalar() {
  const p = props_();
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (!ss && p.getProperty('SHEET_ID')) ss = SpreadsheetApp.openById(p.getProperty('SHEET_ID'));
  if (!ss) ss = SpreadsheetApp.create('Plano Fotográfico — Base de datos');
  p.setProperty('SHEET_ID', ss.getId());
  SS_ = ss;
  ss.setSpreadsheetTimeZone(TZ);

  Object.keys(HOJAS).forEach(k => prepararHoja_(ss, HOJAS[k]));
  prepararConfig_(ss);
  ss.getSheets().forEach(sh => {
    const nuestra = ['Config'].concat(Object.keys(HOJAS).map(k => HOJAS[k].nombre)).indexOf(sh.getName()) >= 0;
    if (!nuestra && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  let carpeta = carpeta_(p.getProperty('FOLDER_ID'));
  if (!carpeta) {
    const padres = DriveApp.getFileById(ss.getId()).getParents();
    const padre = padres.hasNext() ? padres.next() : DriveApp.getRootFolder();
    carpeta = padre.createFolder('Plano Fotográfico — Fotos');
    p.setProperty('FOLDER_ID', carpeta.getId());
  }
  let mini = carpeta_(p.getProperty('THUMBS_ID'));
  if (!mini) { mini = carpeta.createFolder('miniaturas'); p.setProperty('THUMBS_ID', mini.getId()); }
  let compartida = true;
  try { carpeta.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { compartida = false; }
  guardarConfig_(ss, 'carpeta_fotos', carpeta.getUrl());

  CONFIG_ = null;
  const t = tabla_('puntos');
  const nuevos = t.objetos().length ? 0 : insertarBase_(t, (Session.getEffectiveUser().getEmail() || ''));
  if (!p.getProperty('VERSION')) p.setProperty('VERSION', '1'); else bump_();

  const msg = 'Plano Fotográfico instalado.\n\n' +
    (nuevos ? nuevos + ' puntos cargados desde el plano ANT-PLA-GEN-004.\n' : 'Los puntos existentes se mantuvieron.\n') +
    'Fotos en: ' + carpeta.getUrl() + '\n' +
    (compartida ? '' : 'Aviso: la política del dominio no permitió compartir la carpeta; la app mostrará las fotos a través del script (más lento).\n') +
    '\nSiguiente paso: Implementar → Nueva implementación → Aplicación web (Ejecutar como: yo · Acceso: usuarios del dominio).';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
  return msg;
}

/* ======================= internos ======================= */

let SS_ = null, CONFIG_ = null, USUARIO_ = null;
const props_ = () => PropertiesService.getScriptProperties();

function ss_() {
  if (SS_) return SS_;
  const id = props_().getProperty('SHEET_ID');
  if (id) return (SS_ = SpreadsheetApp.openById(id));
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (!ss) throw new Error('La app no está instalada. Abre el Google Sheet y usa el menú Plano Fotográfico → Instalar o reparar.');
  return (SS_ = ss);
}

function carpeta_(id) {
  if (!id) return null;
  try { const f = DriveApp.getFolderById(id); return f.isTrashed() ? null : f; } catch (e) { return null; }
}

function compartir_(archivo) {
  try { archivo.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
}

function config_() {
  if (CONFIG_) return CONFIG_;
  const c = {};
  CONFIG_DEF.forEach(d => { c[d[0]] = d[1]; });
  const sh = ss_().getSheetByName('Config');
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(r => { if (r[0]) c[String(r[0]).trim()] = String(r[1]).trim(); });
  }
  return (CONFIG_ = c);
}

function usuario_() {
  if (USUARIO_) return USUARIO_;
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  let dueno = '';
  try { dueno = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  const c = config_();
  const lista = s => String(s || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  const permite = l => {
    if (email && email === dueno) return true;
    if (!l.length) return true;
    return !!email && l.some(x => x.charAt(0) === '@' ? email.slice(-x.length) === x : x === email);
  };
  return (USUARIO_ = { email: email, puedeFotos: permite(lista(c.editores_fotos)), puedePuntos: permite(lista(c.editores_puntos)) });
}

function exigir_(permiso) {
  const yo = usuario_();
  if (permiso && !yo[permiso]) {
    throw new Error(permiso === 'puedePuntos'
      ? 'No tienes permiso para modificar los puntos del plano. Pídelo a quien administra la app.'
      : 'No tienes permiso para modificar fotos u observaciones. Pídelo a quien administra la app.');
  }
  return yo;
}

/** Ejecuta una escritura con bloqueo y aumenta la versión. */
function escribir_(permiso, fn) {
  const yo = exigir_(permiso);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Hay otro cambio guardándose. Intenta de nuevo en unos segundos.');
  try {
    const r = fn(yo) || {};
    SpreadsheetApp.flush();
    r.version = bump_();
    return r;
  } finally {
    lock.releaseLock();
  }
}

function bump_() {
  const v = version() + 1;
  props_().setProperty('VERSION', String(v));
  return v;
}

function idValido_(id) {
  id = String(id || '');
  if (!/^[A-Za-z0-9_-]{3,60}$/.test(id)) throw new Error('Identificador inválido.');
  return id;
}

function texto_(v, max) {
  return String(v == null ? '' : v).slice(0, max);
}

function limpiarPunto_(d, completo) {
  d = d || {};
  const c = {};
  if (completo || 'code' in d) { c.code = texto_(d.code, 12).trim(); if (!c.code) throw new Error('El punto necesita un código.'); }
  if (completo || 'name' in d) { c.name = texto_(d.name, 80).trim(); if (!c.name) throw new Error('El punto necesita un nombre.'); }
  if (completo || 'sector' in d) c.sector = SECTORES.indexOf(d.sector) >= 0 ? d.sector : 'apoyo';
  if (completo || 'equipo' in d) c.equipo = texto_(d.equipo, 160);
  if (completo || 'descripcion' in d) c.descripcion = texto_(d.descripcion, 1200);
  ['x', 'y'].forEach(k => {
    if (completo || k in d) {
      const n = Number(d[k]);
      if (!(n >= 0 && n <= 1)) throw new Error('La ubicación del punto está fuera del plano.');
      c[k] = Math.round(n * 10000) / 10000;
    }
  });
  return c;
}

function etiqueta_(tablaPuntos, id) {
  const i = tablaPuntos.fila(id);
  if (i < 0) return 'Bandeja';
  const r = tablaPuntos.rows[i];
  return String(r[tablaPuntos.col.code]) + ' · ' + String(r[tablaPuntos.col.name]);
}

function reetiquetar_(pointId, label) {
  ['fotos', 'notas'].forEach(k => {
    const t = tabla_(k);
    const filas = [];
    t.rows.forEach((r, i) => { if (String(r[t.col.pointId]) === pointId) { t.asignar(i, { pointLabel: label }); filas.push(i); } });
    t.guardarFilas(filas);
  });
}

function insertarBase_(t, email) {
  const now = Date.now();
  const nuevos = PUNTOS_BASE
    .map(b => ({ id: 'p' + b[0].slice(2), code: b[0], name: b[1], sector: b[2], equipo: b[5], descripcion: '',
      x: Math.round(b[3] / PLANO.w * 10000) / 10000, y: Math.round(b[4] / PLANO.h * 10000) / 10000,
      createdAt: now, updatedAt: now, updatedBy: email }))
    .filter(p => t.fila(p.id) < 0);
  if (nuevos.length) t.insertar(nuevos);
  return nuevos.length;
}

function publico_(o) {
  const c = {};
  Object.keys(o).forEach(k => { if (SOLO_SERVIDOR.indexOf(k) < 0) c[k] = o[k]; });
  return c;
}

function prepararHoja_(ss, def) {
  let sh = ss.getSheetByName(def.nombre);
  if (!sh) sh = ss.insertSheet(def.nombre);
  const encabezados = def.campos.map(c => c[1]);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, encabezados.length).setValues([encabezados]);
  } else {
    const actuales = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
    const faltan = encabezados.filter(h => actuales.indexOf(h) < 0);
    if (faltan.length) sh.getRange(1, actuales.length + 1, 1, faltan.length).setValues([faltan]);
  }
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#17201c').setFontColor('#ffffff');
  const filas = Math.max(1, sh.getMaxRows() - 1);
  def.campos.forEach(c => {
    const col = head.indexOf(c[1]) + 1;
    const r = sh.getRange(2, col, filas, 1);
    if (c[2] === 'str') r.setNumberFormat('@');
    if (c[2] === 'date') r.setNumberFormat('yyyy-mm-dd hh:mm');
  });
}

function prepararConfig_(ss) {
  let sh = ss.getSheetByName('Config');
  if (!sh) sh = ss.insertSheet('Config');
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, 3).setValues([['clave', 'valor', 'descripción']]);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#17201c').setFontColor('#ffffff');
  const claves = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0])) : [];
  let dueno = '';
  try { dueno = Session.getEffectiveUser().getEmail() || ''; } catch (e) {}
  const nuevas = CONFIG_DEF.filter(d => claves.indexOf(d[0]) < 0)
    .map(d => [d[0], d[0] === 'editores_puntos' ? dueno : d[1], d[2]]);
  if (nuevas.length) sh.getRange(sh.getLastRow() + 1, 1, nuevas.length, 3).setValues(nuevas);
  sh.getRange(2, 2, Math.max(1, sh.getMaxRows() - 1), 1).setNumberFormat('@');
}

function guardarConfig_(ss, clave, valor) {
  const sh = ss.getSheetByName('Config');
  const n = sh.getLastRow() - 1;
  const claves = n > 0 ? sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0])) : [];
  const i = claves.indexOf(clave);
  if (i >= 0) sh.getRange(i + 2, 2).setValue(valor);
}

/** Acceso a una hoja como tabla de objetos, por nombre de encabezado. */
function tabla_(clave) {
  const def = HOJAS[clave];
  const sh = ss_().getSheetByName(def.nombre);
  if (!sh) throw new Error('Falta la hoja "' + def.nombre + '". Usa el menú Plano Fotográfico → Instalar o reparar.');
  const valores = sh.getDataRange().getValues();
  const head = (valores[0] || []).map(String);
  const col = {}, tipo = {};
  def.campos.forEach(c => {
    const i = head.indexOf(c[1]);
    if (i < 0) throw new Error('Falta la columna "' + c[1] + '" en la hoja ' + def.nombre + '. Usa Instalar o reparar.');
    col[c[0]] = i; tipo[c[0]] = c[2];
  });
  const ancho = head.length;
  const rows = valores.slice(1);
  let indice = null;
  const celda = (campo, v) => {
    const t = tipo[campo];
    if (t === 'date') return v == null || v === '' ? '' : new Date(v instanceof Date ? v.getTime() : Number(v));
    if (t === 'num') return Number(v) || 0;
    const s = v == null ? '' : String(v);
    return /^[=+\-@]/.test(s) ? "'" + s : s;
  };
  const valor = (campo, v) => {
    const t = tipo[campo];
    if (t === 'date') { if (v instanceof Date) return v.getTime(); if (v === '' || v == null) return null; const n = new Date(v).getTime(); return isNaN(n) ? null : n; }
    if (t === 'num') return Number(v) || 0;
    return v == null ? '' : String(v);
  };
  const t = {
    sh: sh, col: col, rows: rows,
    fila(id) {
      if (!indice) { indice = {}; rows.forEach((r, i) => { indice[String(r[col.id])] = i; }); }
      return id in indice ? indice[id] : -1;
    },
    objetos() {
      return rows.filter(r => String(r[col.id])).map(r => {
        const o = {};
        def.campos.forEach(c => { if (SOLO_SERVIDOR.indexOf(c[0]) < 0) o[c[0]] = valor(c[0], r[col[c[0]]]); });
        if ('pointId' in o && !o.pointId) o.pointId = null;
        return o;
      });
    },
    asignar(i, cambios) {
      Object.keys(cambios).forEach(k => { if (k in col) rows[i][col[k]] = celda(k, cambios[k]); });
    },
    guardarFilas(filas) {
      if (!filas.length) return;
      if (filas.length > 25) { sh.getRange(2, 1, rows.length, ancho).setValues(rows); return; }
      filas.forEach(i => sh.getRange(i + 2, 1, 1, ancho).setValues([rows[i]]));
    },
    insertar(objs) {
      const nuevas = objs.map(o => {
        const r = new Array(ancho).fill('');
        Object.keys(o).forEach(k => { if (k in col) r[col[k]] = celda(k, o[k]); });
        return r;
      });
      sh.getRange(rows.length + 2, 1, nuevas.length, ancho).setValues(nuevas);
      nuevas.forEach(r => rows.push(r));
      indice = null;
    },
    eliminarFilas(filas) {
      filas.slice().sort((a, b) => b - a).forEach(i => { sh.deleteRow(i + 2); rows.splice(i, 1); });
      indice = null;
    },
  };
  return t;
}
