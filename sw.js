// Offline shell: app files + Firebase SDK modules + fonts are cached after first load.
// Stale-while-revalidate, so updates published to hosting reach users on the next open.
const CACHE = 'syndic-shell-v4';
const SHELL = ['./', 'index.html', 'cloud.js', 'i18n-fr.js', 'privacy.html', 'delete-account.html', 'firebase-config.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'maskable-512.png'];
const EXTRA_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const sameOrigin = u.origin === self.location.origin;
  if (!sameOrigin && !(EXTRA_HOSTS.includes(u.hostname) && (u.hostname !== 'www.gstatic.com' || u.pathname.startsWith('/firebasejs/')))) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(r, { ignoreSearch: false });
    const net = fetch(r).then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(r, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    if (res) return res;
    if (r.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
    return Response.error();
  }));
});
