// Network first, so the office is always current; the last copy opens offline. Live data is never cached.
const CACHE = 'clawd-mifflin-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.includes('/api/') || url.hostname.endsWith('workers.dev')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && (url.origin === location.origin || url.hostname === 'cdn.jsdelivr.net')) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((hit) => hit || Response.error())));
});
