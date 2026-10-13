// Caches the app itself so it opens instantly and works offline.
// Food database requests always go to the network.
const VERSION = "tally-v1";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.json", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];
const CDN = ["https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then(async (c) => {
      await c.addAll(SHELL);
      await Promise.all(CDN.map((u) => c.add(new Request(u, { mode: "cors" })).catch(() => {})));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const sameOrigin = url.origin === self.location.origin;
  const cacheable = sameOrigin || CDN.includes(url.href) || url.host.endsWith("fonts.googleapis.com") || url.host.endsWith("fonts.gstatic.com");
  if (!cacheable) return; // API calls: straight to network

  if (sameOrigin) {
    // network first for the app files so updates show up, cache as fallback offline
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      }))
    );
  }
});
