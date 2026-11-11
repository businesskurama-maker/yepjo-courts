/* YEPJO service worker — application shell only.
 *
 * What is cached: the HTML shell, the built JS/CSS/font files and the icons
 * (all same-origin, all public). What is never cached: anything from Supabase
 * (bookings, chat, profiles, availability, photos) — those requests are
 * cross-origin and this worker does not touch them, so private data never
 * lands in a shared offline cache and always needs a live connection.
 */
const VERSION = 'yepjo-shell-v1';
const SHELL = ['/', '/offline.html', '/manifest.webmanifest', '/logo.webp', '/favicon.png', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page tells us which built assets it loaded so the shell works offline next time.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    const urls = data.urls.filter((u) => new URL(u, self.location.origin).origin === self.location.origin);
    event.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(urls.map((u) => c.add(u)))));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // Supabase etc.: straight to the network

  // Page navigations: fresh from the network, else the cached shell, else the offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(VERSION).then((c) => c.put('/', copy));
          return res;
        })
        .catch(async () => (await caches.match('/')) || (await caches.match('/offline.html')) || Response.error()),
    );
    return;
  }

  // Fingerprinted build assets never change: cache first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      })),
    );
    return;
  }

  // Icons, logo, manifest: network first, cached copy when offline.
  event.respondWith(fetch(req).catch(() => caches.match(req).then((hit) => hit || Response.error())));
});
