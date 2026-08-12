/* The House That AI Built — offline support.
   App shell is network-first (so edits show as soon as you're online). Slides are
   cache-first, and all 43 are precached in the background after activate so a
   dead conference Wi-Fi cannot black the projector. Bump VERSION to drop old caches. */
const VERSION = 'v20';
const CACHE = 'rehearsal-' + VERSION;
const SHELL = ['./', './index.html', './app.js', './data.js', './present.js', './manifest.webmanifest', './icon.svg'];
const SLIDE_COUNT = 43;

function slideUrls() {
  const out = [];
  for (let i = 1; i <= SLIDE_COUNT; i++) out.push('./slides/' + String(i).padStart(2, '0') + '.jpg');
  return out;
}

function precacheSlides() {
  caches.open(CACHE).then(c => {
    slideUrls().forEach(u => {
      c.match(u).then(hit => {
        if (hit) return;
        fetch(u).then(res => { if (res && res.ok) c.put(u, res); }).catch(() => {});
      }).catch(() => {});
    });
  }).catch(() => {});
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
  precacheSlides();
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
