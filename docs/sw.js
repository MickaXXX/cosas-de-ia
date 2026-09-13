/* Service worker.
 *
 * La app tiene que abrirse al instante aunque la señal esté mala, y aun así
 * recibir las versiones nuevas. Por eso:
 *   · Shell (html, js, css, íconos, OCR): se sirve de caché y se revalida detrás.
 *     Si el archivo cambió, se avisa a la app para que ofrezca recargar.
 *   · Datos (docs/data/*.json): se sirve lo guardado de inmediato y se actualiza
 *     en segundo plano (stale-while-revalidate). Nunca se espera a la red para
 *     pintar la pantalla.
 * Antes se pedía todo por red primero y con conexión lenta la app se quedaba
 * colgada sin mostrar nada.
 */
const VERSION = 'mia-v1.6.0';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => null).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** Avisa a las pestañas abiertas. */
async function avisar(msg) {
  const cs = await self.clients.matchAll({ type: 'window' });
  for (const c of cs) c.postMessage(msg);
}

/** ¿Cambió el archivo respecto a lo que hay en caché? */
function distinto(a, b) {
  if (!a || !b) return true;
  const et = (r) => r.headers.get('etag') || r.headers.get('last-modified') || '';
  const len = (r) => r.headers.get('content-length') || '';
  return et(a) !== et(b) || len(a) !== len(b);
}

async function revalidar(req, cache, esShell) {
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (!res || !res.ok) return;
    const viejo = await cache.match(req);
    const cambio = distinto(res.clone(), viejo);
    await cache.put(req, res.clone());
    if (esShell && viejo && cambio) avisar({ type: 'shell-updated' });
  } catch { /* sin red: se sigue usando la caché */ }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const esDatos = url.pathname.includes('/data/');
  const req = esDatos ? new Request(url.origin + url.pathname) : e.request;   // ignora ?fresh=1
  const exigeRed = url.searchParams.has('fresh');                            // botón "Actualizar"

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (exigeRed) {
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res && res.ok) { cache.put(req, res.clone()); return res; }
      } catch { /* sin red: se responde con la caché */ }
    }
    const hit = await cache.match(req);
    if (hit) {
      e.waitUntil(revalidar(req, cache, !esDatos));       // se actualiza detrás
      return hit;
    }
    try {
      const res = await fetch(e.request);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const alt = await cache.match(req, { ignoreSearch: true });
      if (alt) return alt;
      throw err;
    }
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});
