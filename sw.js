// ============================================================================
// sw.js — Service worker. Precaches the whole app shell, so after one visit
// the site opens instantly and boots with no network at all.
//
// Every precache path is RELATIVE, because this repo is published to a GitHub
// Pages subpath (https://user.github.io/courtpiece/) and an absolute '/js/…'
// would point at the root of the whole account. A worker's scope is its own
// directory, so relative URLs resolve against that and the same file works
// from a subpath, from the domain root, and from a folder on a phone.
//
// WHAT "OFFLINE" HONESTLY MEANS HERE
//   The shell loads offline. A GAME does not. PeerJS has to reach a signalling
//   broker on the public internet to introduce two browsers to each other, and
//   even once introduced the data channel may fall back to a relay. So this
//   buys an instant cold start, a working home screen on a bad train, and the
//   ability to read the rules — not a game of Court Piece in a tunnel. Saying
//   otherwise in the manifest would be a lie the first four players to try it
//   would catch.
// ============================================================================

// Bump this to throw away every older cache on the next activate.
//
// The version is in the NAME rather than being a flag, and that is the whole
// safety property: a new generation is built to one side and swapped in whole,
// so it cannot half-apply. Re-installing over a live cache would rewrite SHELL
// entry by entry, and a page loading during that window could pull a new
// main.js against an old ui.js and die on a missing export — a blank screen,
// with no way back except a reload the player has no reason to try.
//
// So the rule is: change what modules import from each other -> bump this.
// Everything else usually heals itself, because same-origin assets are
// stale-while-revalidate and a redeploy lands on the second load.
//
// v1: first release.
const CACHE = 'courtpiece-v1';

// The same-origin shell, relative to the worker's scope.
//
// This must list EVERY module in the import graph, not just the entry point.
// The browser resolves `import` one file at a time over the network, so one
// missing module is a dead app offline even with everything else cached, and
// the failure looks like nothing at all — a blank page and a console error
// nobody on a phone will ever see. Add new js/ files here as they are written.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/main.js',
  './js/ui.js',
  './js/state.js',
  './js/rules.js',
  './js/cards.js',
  './js/trick.js',
  './js/net.js',
  './js/intents.js',
  './js/guards.js',
  './js/bot.js',
  './js/util.js',
  './js/config.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
];

// Cross-origin things worth having offline. Just the PeerJS bundle: the font
// files are fetched lazily on first use and cached by the handler below, since
// which ones a browser actually wants depends on the browser.
const EXTERNAL = [
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // The shell is all-or-nothing on purpose: a generation missing one module
    // is worse than no generation at all, so addAll's rejection failing the
    // install is the behaviour we want.
    await cache.addAll(SHELL);
    // The CDN is best-effort. unpkg having a bad minute must not leave the
    // player with no service worker; the app falls back to fetching PeerJS
    // over the network, which is what it would have done anyway.
    await Promise.allSettled(EXTERNAL.map((url) =>
      fetch(url, { mode: 'cors' }).then((r) => r.ok && cache.put(url, r.clone()))
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // The optional server's liveness probe must always reflect the live server.
  // A cached "yes" is the worst answer this app can give itself: it would
  // replay the first success forever, make a switched-off box look reachable,
  // and strand everyone in server mode. Returning without calling respondWith
  // hands it to the network untouched, so a real failure fails.
  //
  // Dead code today — SERVER_HEALTH is blank in js/config.js and there is no
  // server. It stays because the cost is one string comparison and the cost of
  // forgetting it later is a bug nobody would think to look for in here.
  if (url.pathname.endsWith('/health')) return;

  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const isCDN = url.hostname === 'unpkg.com';

  // Fonts and the version-pinned PeerJS URL are immutable — the bytes behind
  // those exact URLs will never change — so cache-first with no revalidation
  // is not a trade-off, it is just correct.
  if (isFont || isCDN) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // Opaque responses are the normal case for fonts (no CORS headers on
        // the file itself). They are useless to read and perfectly good to
        // replay, which is all this needs.
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (_) {
        return Response.error();
      }
    })());
    return;
  }

  // Our own files: stale-while-revalidate. Serve the cache for an instant,
  // offline-capable load, then refresh in the background so the NEXT load has
  // the redeploy.
  //
  // Navigations go through the same path deliberately. Network-first for the
  // HTML while the modules came from cache would serve a new index.html
  // against an old js/ — a half-updated app, which is the one state this file
  // works hardest to make impossible. One cache generation, in step.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req)
        || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);

      const fresh = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      });

      if (cached) {
        // Keep the worker alive until the background refresh finishes, and
        // swallow its failure — there is already a good response to return,
        // and an unhandled rejection here would show up as a console error on
        // every offline load.
        event.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      try {
        return await fresh;
      } catch (_) {
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
  }

  // Everything else falls through to the network with no respondWith and no
  // cache entry: the PeerJS broker, the WebRTC signalling, and the gc.zgo.at
  // visitor beacon.
  //
  // The beacon depends on exactly that, and it is why the hostname checks
  // above are an allow-list rather than "anything cross-origin". A beacon
  // answered from cache records nothing while looking like it worked. It must
  // never appear in SHELL or EXTERNAL either. Offline loads going uncounted is
  // the right trade: an undercount is a smaller lie than a replayed hit.
});
