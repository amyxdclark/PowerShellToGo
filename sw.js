/* ============================================================
   PowerShell To Go – sw.js
   Service Worker: Cache-first strategy for offline PWA support
   ============================================================ */

const CACHE_NAME = 'pstogo-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg',
];

/* ── Install: precache app shell ─────────────────────────────*/
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Precaching app shell');
        return cache.addAll(PRECACHE_URLS);
      })
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: stale-while-revalidate strategy ───────────────────
self.addEventListener('fetch', event => {
  // Only handle GET requests for same-origin or precached assets
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Let browser handle chrome-extension and non-http requests
  if (!url.protocol.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) {
          // Serve from cache; revalidate in background
          const fetchPromise = fetch(event.request)
            .then(networkResponse => {
              if (networkResponse && networkResponse.status === 200) {
                const cloned = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
              }
              return networkResponse;
            })
            .catch(() => { /* offline – ignore */ });

          // Return cached immediately (stale-while-revalidate)
          return cached;
        }

        // Not in cache – fetch from network and cache it
        return fetch(event.request)
          .then(networkResponse => {
            if (!networkResponse || networkResponse.status !== 200 || networkResponse.type === 'opaque') {
              return networkResponse;
            }
            const cloned = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
            return networkResponse;
          })
          .catch(() => {
            // Offline fallback: serve index.html for navigation requests
            if (event.request.mode === 'navigate') {
              return caches.match('./index.html');
            }
            return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
          });
      })
  );
});

// ── Message handler: force update ────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
