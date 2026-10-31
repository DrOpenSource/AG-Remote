// AG-Remote Service Worker (Cache static shell for offline PWA installation)
const CACHE_NAME = 'ag-remote-shell-v20';
// What the last tapped notification said, for an app window that opens fresh (see app.js).
const NOTICE_CACHE = 'ag-remote-notice';
const ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/manifest.json',
  '/e2e.js',
  '/relay-link.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/badge-96.png',
  '/fonts/ag-remote-sans.woff2'
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
          if (key !== CACHE_NAME && key !== NOTICE_CACHE) {
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
      .catch(() => caches.match(event.request).then(cached => cached || caches.match('/')))
  );
});

// Notifications from the PC (relay only). The payload is encrypted to this phone by the PC. It names
// the project and the kind of request ("wants to run a command"), never the command, file or
// question, because it can show on a locked screen. Every push must show a notification: browsers
// penalise silent ones.
const ASK_TEXT = {
  command: 'wants to run a command',
  'new-file': 'wants to create a file',
  'edit-file': 'wants to edit a file',
  question: 'has a question for you',
  browser: 'wants to use the browser',
  web: 'wants to open a web page',
  tool: 'wants to use a tool',
  other: 'needs your permission'
};

function describePush(data) {
  const title = typeof data.ws === 'string' && data.ws ? data.ws.slice(0, 60) : 'Antigravity';
  const body = data.kind === 'done'
    ? 'The agent finished its task.'
    : `The agent ${ASK_TEXT[data.ask] || ASK_TEXT.other}.`;
  return { title, body };
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const { title, body } = describePush(data);
  const at = Number.isFinite(data.at) ? data.at : Date.now();
  // One notification per project: a newer one replaces that project's last one, and "finished"
  // replaces an approval that is no longer pending. PCs before 0.2.6 send no `win`.
  const tag = typeof data.win === 'string' && data.win
    ? `ag-remote-${data.win}`
    : data.kind === 'done' ? 'ag-remote-done' : 'ag-remote-approval';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    renotify: true,
    timestamp: at,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/', notice: `${title}: ${body}`, at }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = new URL(data.url || '/', self.location.origin).href;
  const notice = { type: 'ag-notice', text: data.notice || '', at: Date.now() };
  event.waitUntil((async () => {
    // The app shows what was tapped while it reconnects. A window opened fresh reads it from the cache.
    if (notice.text) {
      try {
        const cache = await caches.open(NOTICE_CACHE);
        await cache.put('/__notice', new Response(JSON.stringify(notice)));
      } catch (_) {}
    }
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = open.find((c) => c.url.startsWith(url)) || open[0];
    if (existing) {
      if (notice.text) existing.postMessage(notice);
      return existing.focus();
    }
    return self.clients.openWindow(url);
  })());
});
