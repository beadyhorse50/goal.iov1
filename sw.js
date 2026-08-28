/* goal.io service worker.

   The previous version was cache-first for everything with a fixed cache name.
   That works offline and is completely wrong for shipping: the cache is only
   ever repopulated when this file itself changes, so a player who has opened
   the game once keeps that build forever. Every update after their first visit
   is invisible to them. It also cost real time during development — edits to
   the renderer simply never reached the page.

   Strategy now depends on what is being fetched:

     code and markup   network-first with a short timeout, falling back to cache
                       -> an update lands as soon as the player has any signal,
                          and the game still opens with no signal at all
     icons, manifest   cache-first, they effectively never change
     everything else   stale-while-revalidate

   Bump VERSION on release. Old caches are deleted on activate.
*/
var VERSION = "v13";
var CACHE = "goalio-" + VERSION;

/* Every file the game needs to boot. Missing one here does not break the site
   online — it breaks it OFFLINE, which is much easier to ship by accident. */
var ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./js/res.js",
  "./config/config.bundle.js",
  "./js/core.js",
  "./js/config.js",
  "./js/sim.js",
  "./js/anim.js",
  "./js/audio.js",
  "./js/render.js",
  "./js/gl.js",
  "./js/post.gl.js",
  "./js/kit.js",
  "./js/gltf.js",
  "./js/render.gl.js",
  "./js/skin.gl.js",
  "./assets/models/Defender.glb",
  "./assets/models/Forward.glb",
  "./assets/models/Goalkeeper.glb",
  "./js/fx.js",
  "./js/game.js",
  "./icon-192.png",
  "./icon-512.png"
];

var CODE = /\.(?:js|html|webmanifest)$|\/$/;
var IMMUTABLE = /\.(?:png|jpg|webp|woff2?)$/;

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (a) {
        /* cache: "reload" so a stale HTTP cache entry cannot poison the install */
        return fetch(new Request(a, { cache: "reload" }))
          .then(function (r) { return r.ok ? c.put(a, r) : null; })
          .catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* let the page force an update without a hard reload */
self.addEventListener("message", function (e) {
  if (e.data === "skipWaiting") self.skipWaiting();
});

function putCopy(req, res) {
  if (!res || !res.ok) return res;
  var copy = res.clone();
  caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
  return res;
}

/* Race the network against a timer. Without the timeout a flaky connection is
   worse than no connection at all — the request hangs and the game does not
   start, when a perfectly good cached copy was sitting right there. */
function networkFirst(req, ms) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      caches.match(req).then(function (hit) {
        if (hit && !settled) { settled = true; resolve(hit); }
      });
    }, ms);

    fetch(req).then(function (res) {
      clearTimeout(timer);
      if (settled) { putCopy(req, res); return; }
      settled = true;
      resolve(putCopy(req, res));
    }).catch(function () {
      clearTimeout(timer);
      if (settled) return;
      caches.match(req).then(function (hit) {
        settled = true;
        resolve(hit || caches.match("./index.html"));
      });
    });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;          // leave third parties alone

  if (IMMUTABLE.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (r) { return putCopy(req, r); });
      })
    );
    return;
  }

  if (req.mode === "navigate" || CODE.test(url.pathname)) {
    e.respondWith(networkFirst(req, 1800));
    return;
  }

  /* stale-while-revalidate for anything else */
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (r) { return putCopy(req, r); }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
