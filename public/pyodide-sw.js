/**
 * Cache-first for the Pyodide runtime and its wheels.
 *
 * Without this, "cached after first use" (see pyodide-worker.ts) only holds
 * inside one tab's lifetime: `pyodide`/`installed` are JS-heap state, so a
 * page reload always re-triggers loadPyodide() and micropip.install() from
 * scratch. Those then fall on the browser's ordinary HTTP disk cache, which
 * is opportunistic — cleared by the user, evicted under storage pressure (an
 * app that itself hoards GBs in OPFS makes that pressure worse, not better),
 * and entirely absent in private browsing. This cache is deliberate and
 * origin-scoped instead.
 *
 * Only content-addressed URLs are cached forever:
 *  - jsdelivr's pyodide assets are already version-pinned in the path
 *    (.../pyodide/v314.0.3/...), so the same URL always means the same bytes.
 *  - PyPI wheel files are served from an immutable per-release path
 *    (.../packages/.../pm4py-2.7.23.4-py3-none-any.whl).
 * The PyPI *resolution* endpoint (pypi.org/pypi/<pkg>/json) is deliberately
 * left uncached — it answers "what's the latest version", which does change,
 * and it is small next to the wheels it points at.
 */

const CACHE_NAME = 'pyodide-assets-v1';

const CACHEABLE = [
  /^https:\/\/cdn\.jsdelivr\.net\/pyodide\//,
  /^https:\/\/files\.pythonhosted\.org\/packages\//,
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!CACHEABLE.some((re) => re.test(request.url))) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
  );
});
