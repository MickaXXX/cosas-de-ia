/* Geometría sobre WGS84 sin dependencias.
 * Distancias en metros con haversine (radio medio terrestre IUGG). Para distancias
 * cortas a líneas se proyecta localmente (equirectangular): error < 0,5% en Santiago
 * para tramos de pocos kilómetros, suficiente para "distancia a la línea de Metro". */

export const EARTH_R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversine(lon1, lat1, lon2, lat2) {
  const p1 = rad(lat1), p2 = rad(lat2);
  const dp = p2 - p1, dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function destination(lon, lat, bearingDeg, distM) {
  const d = distM / EARTH_R, b = rad(bearingDeg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(l2), deg(p2)];
}

/** Polígono circular (GeoJSON) de radio en metros, para dibujar radios de influencia. */
export function circlePolygon(lon, lat, radiusM, steps = 72) {
  const ring = [];
  for (let i = 0; i <= steps; i++) ring.push(destination(lon, lat, (i * 360) / steps, radiusM));
  ring[steps] = ring[0];
  return { type: 'Polygon', coordinates: [ring] };
}

/** Banda alrededor de una línea (para radios de líneas de Metro futuras): unión de círculos
 *  en los vértices, suficiente como "zona de estudio" visual. */
export function bufferPoints(coords, radiusM, every = 400) {
  const out = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const [a, b] = [coords[i], coords[i + 1]];
    const len = haversine(a[0], a[1], b[0], b[1]);
    const n = Math.max(1, Math.ceil(len / every));
    for (let j = 0; j < n; j++) out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  if (coords.length) out.push(coords[coords.length - 1]);
  return out.map(([x, y]) => circlePolygon(x, y, radiusM, 24));
}

function project(lon, lat, lat0) {
  return [rad(lon) * EARTH_R * Math.cos(rad(lat0)), rad(lat) * EARTH_R];
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distancia (m) de un punto a una LineString o MultiLineString. */
export function distanceToLine(lon, lat, geometry) {
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
  const p = project(lon, lat, lat);
  let best = Infinity;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = project(line[i][0], line[i][1], lat), b = project(line[i + 1][0], line[i + 1][1], lat);
      best = Math.min(best, segDist(p, a, b));
    }
  }
  return best;
}

/** Distancia (m) de un punto a cualquier geometría GeoJSON (al borde si es polígono y está fuera). */
export function distanceToGeometry(lon, lat, g) {
  if (!g) return Infinity;
  if (g.type === 'Point') return haversine(lon, lat, g.coordinates[0], g.coordinates[1]);
  if (g.type === 'LineString' || g.type === 'MultiLineString') return distanceToLine(lon, lat, g);
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
    if (pointInGeometry([lon, lat], g)) return 0;
    const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
    return distanceToLine(lon, lat, { type: 'MultiLineString', coordinates: rings });
  }
  return Infinity;
}

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInGeometry(pt, g) {
  if (!g) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some((rings) => pointInRing(pt, rings[0]) && !rings.slice(1).some((h) => pointInRing(pt, h)));
}

/** Elemento más cercano de una colección de features GeoJSON. */
export function nearest(lon, lat, features, filter = () => true) {
  let best = null, dist = Infinity;
  for (const f of features || []) {
    if (!filter(f)) continue;
    const d = distanceToGeometry(lon, lat, f.geometry);
    if (d < dist) { dist = d; best = f; }
  }
  return best ? { feature: best, distance: dist } : null;
}

/** Features dentro de un radio, ordenadas por distancia. */
export function within(lon, lat, features, radiusM, filter = () => true) {
  const out = [];
  for (const f of features || []) {
    if (!filter(f)) continue;
    const d = distanceToGeometry(lon, lat, f.geometry);
    if (d <= radiusM) out.push({ feature: f, distance: d });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/** Tiempo a pie aproximado: distancia en línea recta × factor de desvío urbano / velocidad.
 *  Se muestra como estimación ("≈"), no como ruta real. */
export function walkMinutes(distM, detour = 1.3, speedMps = 1.3) {
  return (distM * detour) / speedMps / 60;
}
