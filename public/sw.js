const CACHE = 'puente-shell-v2';
// Only public files are stored. Conversation audio, captions, credentials and API responses stay out.
const FILES = [
  '/', '/styles.css', '/js/listen.js', '/js/common.js', '/js/player.js', '/icon.svg', '/manifest.webmanifest',
  '/solo-offline.html', '/solo.webmanifest', '/solo-icon-192.png', '/solo-icon-512.png', '/solo-touch-icon.png',
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete('puente-v1').then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  let fallback;
  if (request.mode === 'navigate' && /^\/solo\/?$/.test(url.pathname)) fallback = '/solo-offline.html';
  else if (request.mode === 'navigate' && /^\/j\/\d{3}$/.test(url.pathname)) fallback = '/';
  else if (!url.search && FILES.includes(url.pathname)) fallback = url.pathname;
  else return;

  event.respondWith(fetch(request).catch(async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(fallback)) || Response.error();
  }));
});
