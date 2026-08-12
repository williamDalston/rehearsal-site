/* The House That AI Built — offline support.
   App shell is network-first (so edits show as soon as you're online), slides and
   the icon are cache-first (fast, and available offline once viewed). Bump VERSION
   to force every client to drop the old cache. */
const VERSION = 'v17';
const CACHE = 'rehearsal-' + VERSION;
const SHELL = ['./', './index.html', './app.js', './data.js', './present.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => { /* a missing shell file must not block install */ })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const cacheFirst = /\/slides\//.test(url.pathname) || /\.(?:jpg|jpeg|png|svg|webp)$/i.test(url.pathname);

  if (cacheFirst) {
    e.respondWith(
      caches.match(req).then(hit => {
        if (hit) return hit;
        return fetch(req).then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        }).catch(() => new Response('', { status: 503, statusText: 'Offline' }));
      })
    );
    return;
  }

  // App shell / navigations: network-first, fall back to cache when offline.
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
