// Harbor mobile service worker.
//
// The previous version was cache-first over everything with a hardcoded version
// string, so it precached /index.html on first install and then served that copy
// forever. The cached document referenced a content-hashed bundle that therefore
// also never changed, which meant the installed app could NEVER be updated: new
// builds, new icons and bug fixes were all invisible on the device, and deleting
// the home-screen icon did not help, because a service worker is registered per
// ORIGIN and survives that. Live-caught 2026-08-02 when two shipped fixes had no
// effect on Pat's phone and looked to him like nothing had been done.
//
// The rules that prevent a repeat:
//   1. HTML and navigations are NETWORK-FIRST. The document chooses which bundle
//      to load, so a stale document is a permanently stale app. Cache is only a
//      fallback for a genuinely offline device.
//   2. Only /assets/* is cache-first, and only because Vite content-hashes those
//      filenames: a changed file is a changed URL, so a stale hit cannot happen.
//   3. Anything live (/ws, /health, /icons, /artifact) is never intercepted.
//   4. skipWaiting plus clients.claim, so a fix lands on the next launch rather
//      than after an indeterminate number of app closes.

const VERSION = 'harbor-web-v2';
const ASSETS = `${VERSION}-assets`;
const SHELL = `${VERSION}-shell`;

self.addEventListener('install', (event) => {
  // Deliberately NO precache of '/' or '/index.html'. Precaching the document is
  // precisely what froze the previous version.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter((k) => k !== ASSETS && k !== SHELL);
    // Drops every cache that is not ours, which includes the harbor-web-v1
    // cache still holding a frozen index.html on an already-installed device.
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();

    // An upgrading device has ALREADY rendered the frozen document by the time
    // this runs, so without a reload the user sees the old app once more and
    // concludes nothing was fixed. Reload only when we actually evicted a stale
    // cache, so a clean install never navigates itself and no loop is possible.
    if (stale.length === 0) return;
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      try { await client.navigate(client.url); } catch { /* not navigable, next launch is fresh anyway */ }
    }
  })());
});

// Lets the page force an update without anyone reinstalling anything.
self.addEventListener('message', (event) => {
  if (event.data === 'harbor:skip-waiting') self.skipWaiting();
});

const NEVER_CACHE = ['/ws', '/health', '/icons/', '/artifact'];
// How long a launch waits for the network before it opens the saved shell.
const DOC_WAIT_MS = 3500;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((p) => url.pathname.startsWith(p))) return;

  // Content-hashed build output: safe to serve from cache, because a new build
  // produces a new filename rather than new bytes behind an old name.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const hit = await caches.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      // Saving is optional: a full or refused cache never costs the response.
      // The copy is taken NOW: once the response is handed back the page starts
      // reading its body, and a clone taken later fails, saving nothing.
      if (res.ok) {
        const copy = res.clone();
        event.waitUntil(caches.open(ASSETS).then((cache) => cache.put(request, copy)).catch(() => {}));
      }
      return res;
    })());
    return;
  }

  // Everything else, and navigations above all: network first. The cache is a
  // fallback for being offline, never a source of truth.
  //
  // A FALLBACK THAT NEVER FIRES IS NOT ONE (2026-10-21 review, finding 15). The
  // cached shell was used only when fetch THREW, but the usual way the server is
  // unreachable is a restart behind `tailscale serve`, which ANSWERS with a 502:
  // a resolved fetch, so the phone showed the proxy's error page instead of its
  // cached app. And a dead tunnel made the launch wait as long as the OS let a
  // request hang. Now a document gets the network for DOC_WAIT_MS; a 5xx, an
  // error or no answer in time serves the saved shell (whose own client retries
  // the connection). 4xx answers (authentication, origin refusals) still go
  // straight to the page.
  //
  // ONLY A DOCUMENT THAT WAS SERVED IS SAVED (2026-10-21, second Sol review,
  // P0). The first version let a late network answer replace the saved shell
  // after the old one had been served: the browser never loaded that new page,
  // so its hashed bundle was never fetched or cached, and the next offline
  // launch got a page whose code could not load, a blank screen. A late answer
  // is now dropped; the next launch fetches it properly. And saving is
  // optional: a refused cache write never costs a good response.
  const isDoc = request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
  if (isDoc) {
    event.respondWith((async () => {
      const network = fetch(request, { cache: 'no-store' });
      const saved = () => caches.match('/index.html');
      const keep = (res) => {
        if (res.ok) {
          const copy = res.clone(); // now, before the page reads the body
          event.waitUntil(caches.open(SHELL).then((cache) => cache.put('/index.html', copy)).catch(() => {}));
        }
        return res;
      };
      let timer;
      const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), DOC_WAIT_MS); });
      try {
        const first = await Promise.race([network, late]);
        if (first === 'late') {
          const hit = await saved();
          if (hit) { network.catch(() => {}); return hit; }
          return keep(await network);
        }
        if (first.status >= 500) return (await saved()) || first;
        return keep(first);
      } catch (error) {
        const hit = await saved();
        if (hit) return hit;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })());
    return;
  }
  event.respondWith((async () => {
    try {
      return await fetch(request, { cache: 'no-store' });
    } catch (error) {
      const hit = await caches.match(request);
      if (hit) return hit;
      throw error;
    }
  })());
});
