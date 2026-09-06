/* Service worker: app offline + datos con "red primero, caché de respaldo". */
const VERSION = 'mia-v1.0.0';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  // Auto-limpieza: elimina cachés de versiones anteriores.
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/data/')) {
    // Datos: red primero; si falla, caché.
    e.respondWith(fetch(e.request).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request)));
    return;
  }
  // Shell: caché primero, actualizando en segundo plano.
  e.respondWith(caches.match(e.request).then((cached) => {
    const net = fetch(e.request).then((res) => { if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone())); return res; }).catch(() => cached);
    return cached || net;
  }));
});
