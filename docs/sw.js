/* Service worker: la app siempre intenta la red primero (así las versiones nuevas
 * llegan al instante); la caché solo entra si no hay conexión. Los archivos grandes
 * del OCR y los íconos sí se sirven desde caché porque no cambian. */
const VERSION = 'mia-v1.5.0';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => null).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const heavy = url.pathname.includes('/vendor/') || url.pathname.includes('/icons/');
  if (heavy) {
    e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request).then((res) => {
      if (res.ok) caches.open(VERSION).then((cache) => cache.put(e.request, res.clone()));
      return res;
    })));
    return;
  }
  // Datos y shell: red primero, caché de respaldo.
  e.respondWith(fetch(e.request, { cache: 'no-store' }).then((res) => {
    if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
    return res;
  }).catch(() => caches.match(e.request)));
});
