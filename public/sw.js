// Versioned atomic app shell. VERSION is the single coherence knob — bump it
// whenever any shell asset changes; install precaches the whole module graph
// all-or-nothing, so a client never mixes app.js@v2 with board.js@v1 (a
// mid-load drop or deploy just keeps the old coherent set). /api/, /login,
// /logout and non-GET requests are never intercepted — live data stays live,
// SSE untouched.
const VERSION = '2026-07-22.1'; // bump on every deploy that touches ASSETS
const SHELL = 'kk-shell-' + VERSION;
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/js/api.js',
  '/js/board.js',
  '/js/chips.js',
  '/js/deps.js',
  '/js/drawer.js',
  '/js/manager.js',
  '/js/markdown.js',
  '/js/modals.js',
  '/js/sse.js',
  '/js/state.js',
  '/js/util.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      // atomic: one failed fetch rejects the whole install, old set survives
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('kk-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/logout') return;

  if (ASSETS.includes(url.pathname)) {
    // shell: stale-while-revalidate — serve the coherent cached set now,
    // refresh it in the background for the next load
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const refresh = fetch(e.request)
        .then((res) => {
          if (res.ok && res.type === 'basic') cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await refresh) || Response.error();
    })());
  } else {
    // other statics (icons, logo): cache-first, lazily filled
    e.respondWith((async () => {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      const res = await fetch(e.request);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    })());
  }
});
