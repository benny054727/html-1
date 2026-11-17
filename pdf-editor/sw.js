/* עורך MY PDF – offline support.
   The app shell is stored on install; everything else from this site is stored the first time it is used.
   Pages are fetched from the network first so updates arrive; files with a version in their address come from the store. */
const VERSION = 'mypdf-v23';
const SHELL = [
  './', 'index.html', 'app.css?v=23', 'app.js?v=23', 'manifest.webmanifest',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js',
  'vendor/fonts/heebo-hebrew-400-normal.woff2', 'vendor/fonts/heebo-latin-400-normal.woff2',
  'vendor/fonts/heebo-hebrew-500-normal.woff2', 'vendor/fonts/heebo-latin-500-normal.woff2',
  'vendor/fonts/heebo-hebrew-700-normal.woff2', 'vendor/fonts/heebo-latin-700-normal.woff2',
  'vendor/fonts/tinos-latin-700-normal.woff2', 'vendor/fonts/arimo-latin-700-normal.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put('index.html', copy));
      return res;
    }).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
