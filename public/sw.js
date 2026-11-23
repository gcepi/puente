// Network-first: the app always loads fresh when online; the shell is cached
// only so "Add to Home Screen" works and a flaky connection still opens the page.
const CACHE = 'puente-v1';
const SHELL = ['/', '/styles.css', '/js/listen.js', '/js/common.js', '/js/player.js', '/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
