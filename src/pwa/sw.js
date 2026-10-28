// AG-Remote Service Worker (Cache static shell for offline PWA installation)
const CACHE_NAME = 'ag-remote-shell-v7';
const ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/manifest.json',
  '/e2e.js',
  '/relay-link.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-only for all API, WS, and pairing requests
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/pair')) {
    return;
  }

  // Network-first for static PWA shell assets with cache fallback for offline
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});

// Notifications from the PC (relay only). The payload is encrypted to this phone by the PC; it says
// what happened and in which workspace, never the code or the command. Every push must show a
// notification: browsers penalise silent ones.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const done = data.kind === 'done';
  const where = data.ws ? `${data.ws}: ` : '';
  event.waitUntil(self.registration.showNotification(done ? 'Antigravity finished' : 'Antigravity needs your approval', {
    body: done ? `${where}the agent finished its task.` : `${where}tap to review and approve.`,
    tag: done ? 'ag-remote-done' : 'ag-remote-approval',
    renotify: true,
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = open.find((c) => c.url.startsWith(url)) || open[0];
    if (existing) return existing.focus();
    return self.clients.openWindow(url);
  })());
});
