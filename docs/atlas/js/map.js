/* Mapa (MapLibre GL JS + teselas OpenFreeMap/OSM; respaldo raster CARTO; respaldo sin
 * teselas: límites comunales propios). Capas de proyectos, Metro, obras con radio,
 * servicios, comunas, microsectores, comparables y zona dibujada por el usuario. */
import { STATUS } from './status.js';
import { circlePolygon } from './geo.js';
import { esc } from './format.js';

/* global maplibregl */
const ML = () => window.maplibregl;

export const DEV_COLORS = {
  metro_futuro: '#6250d6', metro_extension: '#6250d6', transporte: '#0f8b8d', vial: '#7a7a7a',
  mall: '#d55181', comercio: '#d55181', hospital: '#2a78d6', clinica: '#2a78d6', universidad: '#3f51b5', educacion: '#3f51b5',
  parque: '#19a7a1', cultura: '#9c6ade', polo_empleo: '#455a64', residencial: '#8d6e63', normativa: '#607d8b', otro: '#607d8b',
};
export const DEV_LABELS = {
  metro_futuro: 'Metro futuro', metro_extension: 'Extensión de Metro', transporte: 'Transporte', vial: 'Vialidad', mall: 'Mall / centro comercial',
  comercio: 'Comercio', hospital: 'Hospital', clinica: 'Clínica', universidad: 'Universidad', educacion: 'Educación', parque: 'Parque / espacio público',
  cultura: 'Cultura', polo_empleo: 'Polo de empleo', residencial: 'Gran proyecto residencial (competencia)', normativa: 'Normativa', otro: 'Otro',
};
export const POI_STYLE = {
  mall: { color: '#d55181', label: 'Malls' }, supermercado: { color: '#a06cb4', label: 'Supermercados' },
  hospital: { color: '#1c5cab', label: 'Hospitales' }, clinica: { color: '#5598e7', label: 'Clínicas y centros médicos' },
  universidad: { color: '#3f51b5', label: 'Universidades e institutos' }, parque: { color: '#19a7a1', label: 'Parques' },
  turismo: { color: '#8d6e63', label: 'Museos y atractivos' }, cultura: { color: '#9c6ade', label: 'Teatros y cultura' },
};

export const LAYERS = [
  { key: 'projects', label: 'Proyectos', on: true },
  { key: 'metro', label: 'Metro operativo', on: true },
  { key: 'metroFuture', label: 'Metro en construcción/proyectado (OSM)', on: true },
  { key: 'devs', label: 'Obras y anuncios con radio', on: true },
  { key: 'devsPending', label: 'Obras pendientes de revisión', on: false },
  { key: 'communes', label: 'Límites comunales', on: true },
  { key: 'microsectors', label: 'Microsectores (Santiago)', on: true },
  ...Object.entries(POI_STYLE).map(([k, v]) => ({ key: `poi_${k}`, label: v.label, on: ['mall', 'hospital', 'clinica', 'parque'].includes(k), poi: k })),
  { key: 'comps', label: 'Comparables de arriendo (proyecto abierto)', on: true },
];

const LAYER_IDS = {
  projects: ['proj-pins', 'proj-labels', 'proj-selected', 'proj-demo'],
  metro: ['metro-lines', 'metro-stations', 'metro-station-labels'],
  metroFuture: ['metro-future', 'metro-future-labels'],
  devs: ['dev-fill', 'dev-line', 'dev-line-neg', 'dev-buffer', 'dev-center', 'dev-labels'],
  devsPending: ['devp-fill', 'devp-line', 'devp-center'],
  communes: ['communes-dim', 'communes-line', 'communes-labels'],
  microsectors: ['micro-fill', 'micro-line'],
  comps: ['comps-radius', 'comps-points'],
};

let map = null;
let opts = null;
let styleMode = 'vector';
const data = {};
const clusterMarkers = new Map();
let onScreenClusters = new Map();
let draw = null;
let handlersBound = false;

export function getMap() { return map; }

function houseImage(color, { dashed = false, demo = false } = {}) {
  const S = 64, c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  if (dashed) {
    g.setLineDash([5, 4]); g.lineWidth = 3; g.strokeStyle = color;
    g.beginPath(); g.arc(32, 34, 29, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
  }
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 4; g.shadowOffsetY = 1;
  g.beginPath();
  g.moveTo(32, 9); g.lineTo(54, 28); g.lineTo(49, 28); g.lineTo(49, 52); g.lineTo(15, 52); g.lineTo(15, 28); g.lineTo(10, 28); g.closePath();
  g.fillStyle = color; g.fill();
  g.shadowColor = 'transparent';
  g.lineWidth = 3; g.strokeStyle = '#ffffff'; g.stroke();
  g.fillStyle = '#ffffff'; g.fillRect(27, 38, 10, 14);
  if (demo) {
    g.fillStyle = '#111'; g.fillRect(36, 6, 26, 14);
    g.fillStyle = '#ffd54a'; g.font = 'bold 10px sans-serif'; g.fillText('DEMO', 37.5, 17);
  }
  return g.getImageData(0, 0, S, S);
}

function addImages() {
  for (const [code, st] of Object.entries(STATUS)) {
    for (const dashed of [false, true]) for (const demo of [false, true]) {
      const id = `house-${code}${dashed ? '-u' : ''}${demo ? '-d' : ''}`;
      if (!map.hasImage(id)) map.addImage(id, houseImage(st.color, { dashed, demo }), { pixelRatio: 2 });
    }
  }
}

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

function setData(id, fc) {
  data[id] = fc;
  const src = map?.getSource(id);
  if (src) src.setData(fc);
}

export function initMap(container, o) {
  opts = o;
  const ml = ML();
  if (!ml) throw new Error('MapLibre no cargó');
  map = new ml.Map({
    container, style: o.styleUrl, center: o.center, zoom: o.zoom, minZoom: 9, maxZoom: 19,
    attributionControl: { compact: true, customAttribution: '© colaboradores de OpenStreetMap · Datos: OSM, fuentes citadas en cada ficha' },
    cooperativeGestures: false,
  });
  map.addControl(new ml.NavigationControl({ visualizePitch: false }), 'bottom-right');
  map.addControl(new ml.GeolocateControl({ trackUserLocation: false }), 'bottom-right');
  map.addControl(new ml.ScaleControl({ unit: 'metric' }), 'bottom-right');
  let loaded = false;
  const fallbackTimer = setTimeout(() => { if (!loaded) useFallback('raster'); }, 9000);
  map.on('error', (e) => {
    const msg = String(e?.error?.message || '');
    if (!loaded && /style|Failed to fetch|NetworkError|404|load/i.test(msg)) useFallback('raster');
  });
  map.on('style.load', () => {
    loaded = true;
    clearTimeout(fallbackTimer);
    addImages();
    addOverlays();
    o.onStyleReady?.(styleMode);
  });
  map.on('styleimagemissing', (e) => {
    const m = /^house-(rojo|amarillo|verde|gris)/.exec(e.id);
    if (m) addImages();
  });
  return map;
}

function useFallback(kind) {
  if (styleMode !== 'vector' && kind === 'raster') return;
  styleMode = kind;
  const dark = opts.dark;
  const style = {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: kind === 'raster' ? { base: { type: 'raster', tiles: [opts.raster[dark ? 'oscuro' : 'claro'].replace('{z}', '{z}')], tileSize: 256, attribution: opts.raster.attribution } } : {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': dark ? '#1b1c1f' : '#eceae4' } }]
      .concat(kind === 'raster' ? [{ id: 'base', type: 'raster', source: 'base' }] : []),
  };
  map.setStyle(style);
  if (kind === 'raster') {
    // Si tampoco cargan las teselas raster, se queda con fondo + comunas propias.
    setTimeout(() => {
      if (!map.isSourceLoaded?.('base')) { styleMode = 'offline'; opts.onStyleReady?.('offline'); }
    }, 8000);
  }
}

export function setTheme(dark, styleUrl) {
  opts.dark = dark; opts.styleUrl = styleUrl;
  if (styleMode === 'vector') map.setStyle(styleUrl);
  else { styleMode = 'vector'; useFallback(styleMode === 'offline' ? 'offline' : 'raster'); }
}

const FONT = ['Noto Sans Regular'];
const FONT_B = ['Noto Sans Bold'];

function addOverlays() {
  const dark = opts.dark;
  const halo = dark ? '#111' : '#fff';
  const ink = dark ? '#eee' : '#222';
  for (const id of ['communes', 'micro', 'devs', 'devsPending', 'devCenters', 'metroLines', 'metroFuture', 'stations', 'pois', 'comps', 'compsRadius', 'draw', 'selected', 'projects']) {
    if (map.getSource(id)) continue;
    const base = { type: 'geojson', data: data[id] || emptyFC() };
    if (id === 'projects') {
      Object.assign(base, {
        cluster: true, clusterRadius: 46, clusterMaxZoom: 13,
        clusterProperties: Object.fromEntries(Object.keys(STATUS).map((k) => [k, ['+', ['case', ['==', ['get', 'status'], k], 1, 0]]])),
      });
    }
    map.addSource(id, base);
  }
  const before = undefined;
  // Comunas: se atenúan las no activas y se dibuja el borde.
  map.addLayer({ id: 'communes-dim', type: 'fill', source: 'communes', filter: ['!', ['get', 'active']], paint: { 'fill-color': dark ? '#000' : '#6b6b6b', 'fill-opacity': dark ? 0.25 : 0.08 } }, before);
  map.addLayer({ id: 'communes-line', type: 'line', source: 'communes', paint: { 'line-color': dark ? '#8a8a8a' : '#5c5c5c', 'line-width': ['case', ['get', 'active'], 1.6, 0.8], 'line-opacity': 0.7, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'communes-labels', type: 'symbol', source: 'communes', minzoom: 10.5, maxzoom: 14,
    layout: { 'text-field': ['get', 'name'], 'text-font': FONT_B, 'text-size': 12, 'symbol-placement': 'point', 'text-allow-overlap': false },
    paint: { 'text-color': dark ? '#bbb' : '#555', 'text-halo-color': halo, 'text-halo-width': 1.5, 'text-opacity': 0.85 } });
  map.addLayer({ id: 'micro-fill', type: 'fill', source: 'micro', paint: { 'fill-color': '#2a78d6', 'fill-opacity': 0.05 } });
  map.addLayer({ id: 'micro-line', type: 'line', source: 'micro', paint: { 'line-color': '#2a78d6', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
  // Obras: radios (zonas de estudio)
  map.addLayer({ id: 'dev-fill', type: 'fill', source: 'devs', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.13 } });
  map.addLayer({ id: 'dev-line', type: 'line', source: 'devs', filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['!', ['get', 'negative']]], paint: { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.8 } });
  map.addLayer({ id: 'dev-line-neg', type: 'line', source: 'devs', filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['get', 'negative']], paint: { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.8, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'dev-buffer', type: 'line', source: 'devs', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.12,
      'line-width': ['interpolate', ['exponential', 2], ['zoom'], 10, ['/', ['*', 2, ['get', 'radius']], 127.5], 18, ['/', ['*', 2, ['get', 'radius']], 0.498]] } });
  map.addLayer({ id: 'devp-fill', type: 'fill', source: 'devsPending', paint: { 'fill-color': '#888', 'fill-opacity': 0.07 } });
  map.addLayer({ id: 'devp-line', type: 'line', source: 'devsPending', paint: { 'line-color': '#888', 'line-width': 1.2, 'line-dasharray': [1, 2] } });
  // Metro
  map.addLayer({ id: 'metro-future', type: 'line', source: 'metroFuture', layout: { 'line-cap': 'round' },
    paint: { 'line-color': ['case', ['==', ['get', 'status'], 'en_construccion'], '#6250d6', '#9e9e9e'], 'line-width': 3.5, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 } });
  map.addLayer({ id: 'metro-future-labels', type: 'symbol', source: 'metroFuture', minzoom: 12,
    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11 },
    paint: { 'text-color': '#6250d6', 'text-halo-color': halo, 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'metro-lines', type: 'line', source: 'metroLines', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'colour'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 15, 5], 'line-opacity': 0.95 } });
  map.addLayer({ id: 'metro-stations', type: 'circle', source: 'stations', minzoom: 11,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 15, 6], 'circle-color': ['case', ['==', ['get', 'status'], 'operativa'], '#ffffff', '#d9d2ff'],
      'circle-stroke-color': ['case', ['==', ['get', 'status'], 'operativa'], '#222', '#6250d6'], 'circle-stroke-width': 1.6 } });
  map.addLayer({ id: 'metro-station-labels', type: 'symbol', source: 'stations', minzoom: 13.5,
    layout: { 'text-field': ['concat', 'Ⓜ ', ['get', 'name']], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top' },
    paint: { 'text-color': ink, 'text-halo-color': halo, 'text-halo-width': 1.5 } });
  // POIs
  for (const [cat, st] of Object.entries(POI_STYLE)) {
    map.addLayer({ id: `poi-${cat}`, type: 'circle', source: 'pois', minzoom: 12.5, filter: ['==', ['get', 'category'], cat],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12.5, 2.5, 16, 6], 'circle-color': st.color, 'circle-stroke-color': halo, 'circle-stroke-width': 1, 'circle-opacity': 0.9 } });
    map.addLayer({ id: `poi-${cat}-labels`, type: 'symbol', source: 'pois', minzoom: 15.5, filter: ['==', ['get', 'category'], cat],
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 10, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': st.color, 'text-halo-color': halo, 'text-halo-width': 1.2 } });
  }
  map.addLayer({ id: 'dev-center', type: 'circle', source: 'devCenters', paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'devp-center', type: 'circle', source: 'devCenters', filter: ['==', ['get', 'pending'], true], paint: { 'circle-radius': 5, 'circle-color': '#888', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'dev-labels', type: 'symbol', source: 'devCenters', minzoom: 12, filter: ['!=', ['get', 'pending'], true],
    layout: { 'text-field': ['get', 'name'], 'text-font': FONT_B, 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-max-width': 12 },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': halo, 'text-halo-width': 1.6 } });
  // Comparables del proyecto abierto
  map.addLayer({ id: 'comps-radius', type: 'line', source: 'compsRadius', paint: { 'line-color': '#2a78d6', 'line-width': 2, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'comps-points', type: 'circle', source: 'comps',
    paint: { 'circle-radius': 4.5, 'circle-color': ['case', ['get', 'used'], '#2a78d6', '#9e9e9e'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2 } });
  // Zona dibujada
  map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', paint: { 'fill-color': '#eb6834', 'fill-opacity': 0.08 } });
  map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', paint: { 'line-color': '#eb6834', 'line-width': 2 } });
  // Proyectos
  map.addLayer({ id: 'proj-selected', type: 'circle', source: 'selected', paint: { 'circle-radius': 22, 'circle-color': '#2a78d6', 'circle-opacity': 0.18, 'circle-stroke-color': '#2a78d6', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'proj-pins', type: 'symbol', source: 'projects', filter: ['!', ['has', 'point_count']],
    layout: { 'icon-image': ['concat', 'house-', ['get', 'status'], ['case', ['get', 'unverified'], '-u', ''], ['case', ['get', 'demo'], '-d', '']],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.75, 15, 1.05], 'icon-allow-overlap': true, 'icon-anchor': 'bottom', 'symbol-sort-key': ['-', 100, ['get', 'score']] } });
  map.addLayer({ id: 'proj-labels', type: 'symbol', source: 'projects', minzoom: 14, filter: ['!', ['has', 'point_count']],
    layout: { 'text-field': ['get', 'label'], 'text-font': FONT_B, 'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 0.2], 'text-optional': true },
    paint: { 'text-color': ink, 'text-halo-color': halo, 'text-halo-width': 1.6 } });
  map.addLayer({ id: 'proj-cluster-hit', type: 'circle', source: 'projects', filter: ['has', 'point_count'], paint: { 'circle-radius': 18, 'circle-opacity': 0 } });

  applyVisibility(opts.visibility || {});
  if (handlersBound) return;
  handlersBound = true;
  for (const l of ['proj-pins']) {
    map.on('click', l, (e) => { const f = e.features[0]; opts.onProjectClick?.(f.properties.id, f.geometry.coordinates); });
    map.on('mouseenter', l, (e) => { map.getCanvas().style.cursor = 'pointer'; opts.onProjectHover?.(e.features[0].properties.id); });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; opts.onProjectHover?.(null); });
  }
  for (const l of ['dev-center', 'devp-center', 'dev-fill']) {
    map.on('click', l, (e) => {
      if (draw) return;
      const hitProj = map.queryRenderedFeatures(e.point, { layers: ['proj-pins'] });
      if (hitProj.length) return;
      opts.onDevClick?.(e.features[0].properties.id, e.lngLat);
    });
    map.on('mouseenter', l, () => { if (!draw) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', 'metro-stations', (e) => {
    const p = e.features[0].properties;
    new (ML().Popup)({ closeButton: true, maxWidth: '260px' }).setLngLat(e.lngLat)
      .setHTML(`<div class="pop"><h4>Ⓜ ${esc(p.name)}</h4><div class="sub">${p.status === 'operativa' ? 'Estación operativa' : 'Estación en construcción/proyectada'} · Línea ${esc(JSON.parse(p.lines || '[]').join(', ') || 's/d')}</div><div class="tiny muted">Fuente: OpenStreetMap</div></div>`).addTo(map);
  });
  map.on('click', (e) => {
    if (draw) { addDrawPoint([e.lngLat.lng, e.lngLat.lat]); return; }
  });
  map.on('dblclick', (e) => { if (draw) { e.preventDefault(); finishDraw(); } });
  map.on('render', updateClusterMarkers);
}

// ------------------------------------------------------------------ clusters con recuento por estado
function donut(props) {
  const counts = Object.keys(STATUS).map((k) => [k, props[k] || 0]);
  const total = counts.reduce((s, [, c]) => s + c, 0) || props.point_count;
  const r = total >= 50 ? 26 : total >= 15 ? 22 : 18, r0 = Math.round(r * 0.58), w = r * 2;
  let html = `<svg width="${w}" height="${w}" viewBox="0 0 ${w} ${w}" class="cluster-marker" role="img" aria-label="${total} proyectos">`;
  let acc = 0;
  for (const [k, c] of counts) {
    if (!c) continue;
    const a0 = (acc / total) * 2 * Math.PI, a1 = ((acc + c) / total) * 2 * Math.PI;
    acc += c;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a, rr) => `${r + rr * Math.sin(a)} ${r - rr * Math.cos(a)}`;
    if (c === total) html += `<circle cx="${r}" cy="${r}" r="${(r + r0) / 2}" fill="none" stroke="${STATUS[k].color}" stroke-width="${r - r0}"/>`;
    else html += `<path d="M ${p(a0, r)} A ${r} ${r} 0 ${large} 1 ${p(a1, r)} L ${p(a1, r0)} A ${r0} ${r0} 0 ${large} 0 ${p(a0, r0)} Z" fill="${STATUS[k].color}"/>`;
  }
  html += `<circle cx="${r}" cy="${r}" r="${r0}" fill="${opts.dark ? '#1a1b1e' : '#fff'}"/><text x="${r}" y="${r}" dominant-baseline="central" text-anchor="middle" font-size="${r0 > 12 ? 12 : 11}" font-weight="700" fill="${opts.dark ? '#eee' : '#222'}">${total}</text></svg>`;
  return html;
}

function updateClusterMarkers() {
  if (!map.getSource('projects') || !map.isSourceLoaded('projects')) return;
  const visible = map.getLayoutProperty('proj-pins', 'visibility') !== 'none';
  const next = new Map();
  if (visible) {
    for (const f of map.querySourceFeatures('projects')) {
      const p = f.properties;
      if (!p.cluster) continue;
      const id = p.cluster_id;
      if (next.has(id)) continue;
      let m = clusterMarkers.get(id);
      if (!m) {
        const el = document.createElement('div');
        el.innerHTML = donut(p);
        el.title = Object.entries(STATUS).map(([k, s]) => `${s.label}: ${p[k] || 0}`).join('\n');
        el.addEventListener('click', async () => {
          const z = await map.getSource('projects').getClusterExpansionZoom(id);
          map.easeTo({ center: f.geometry.coordinates, zoom: z + 0.2 });
        });
        m = new (ML().Marker)({ element: el }).setLngLat(f.geometry.coordinates);
        clusterMarkers.set(id, m);
      }
      next.set(id, m);
      if (!onScreenClusters.has(id)) m.addTo(map);
    }
  }
  for (const [id, m] of onScreenClusters) if (!next.has(id)) m.remove();
  onScreenClusters = next;
}

// ------------------------------------------------------------------ datos
export function setProjects(fc) {
  for (const m of clusterMarkers.values()) m.remove();
  clusterMarkers.clear(); onScreenClusters.clear();
  setData('projects', fc);
}
export function setLayerData(id, fc) { setData(id, fc); }

export function setSelected(lonlat) {
  setData('selected', lonlat ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: lonlat } }] } : emptyFC());
}

export function setComps(center, radiusM, comps) {
  if (!center) { setData('comps', emptyFC()); setData('compsRadius', emptyFC()); return; }
  setData('compsRadius', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: circlePolygon(center[0], center[1], radiusM) }] });
  setData('comps', { type: 'FeatureCollection', features: comps.map((c) => ({ type: 'Feature', properties: { used: c.used, id: c.id }, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } })) });
}

export function applyVisibility(vis) {
  if (!map || !map.getLayer('proj-pins')) return;
  for (const l of LAYERS) {
    const on = vis[l.key] ?? l.on;
    const ids = l.poi ? [`poi-${l.poi}`, `poi-${l.poi}-labels`] : LAYER_IDS[l.key] || [];
    for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    if (l.key === 'projects') {
      if (map.getLayer('proj-cluster-hit')) map.setLayoutProperty('proj-cluster-hit', 'visibility', on ? 'visible' : 'none');
      if (!on) { for (const m of onScreenClusters.values()) m.remove(); onScreenClusters.clear(); }
    }
    if (l.key === 'devs' && map.getLayer('dev-center')) map.setLayoutProperty('dev-center', 'visibility', on ? 'visible' : 'none');
  }
}

export function flyTo(lonlat, zoom = 15) {
  map?.flyTo({ center: lonlat, zoom: Math.max(map.getZoom(), zoom), speed: 1.4, essential: true });
}

export function fitTo(bounds) { map?.fitBounds(bounds, { padding: 60, maxZoom: 15 }); }

let popup = null;
export function showPopup(lonlat, html) {
  popup?.remove();
  popup = new (ML().Popup)({ closeButton: true, maxWidth: '320px', offset: [0, -30], focusAfterOpen: false }).setLngLat(lonlat).setHTML(html).addTo(map);
  return popup;
}
export function closePopup() { popup?.remove(); popup = null; }

export function currentBounds() {
  const b = map?.getBounds();
  return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
}

export function onMove(fn) { map?.on('moveend', fn); }
export function onIdleOnce(fn) { map?.once('idle', fn); }

// ------------------------------------------------------------------ dibujar zona (filtro por polígono)
export function startDraw(onDone) {
  draw = { pts: [], onDone };
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = 'crosshair';
  renderDraw();
}
function addDrawPoint(p) { draw.pts.push(p); renderDraw(); }
function renderDraw() {
  const pts = draw?.pts || [];
  const feats = [];
  if (pts.length >= 3) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } });
  else if (pts.length === 2) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
  setData('draw', { type: 'FeatureCollection', features: feats });
}
export function finishDraw() {
  if (!draw) return;
  const { pts, onDone } = draw;
  draw = null;
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = '';
  if (pts.length >= 3) onDone({ type: 'Polygon', coordinates: [[...pts, pts[0]]] });
  else { setData('draw', emptyFC()); onDone(null); }
}
export function cancelDraw() {
  if (!draw) return;
  draw = null;
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = '';
  setData('draw', emptyFC());
}
export function clearDraw() { setData('draw', emptyFC()); }
export function isDrawing() { return !!draw; }
