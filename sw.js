/* DasherDex offline helper.
   - The app page: always tries the internet first, so updates show up right away. With no signal, the last saved copy opens.
   - Scanner, fonts and Firebase code from the CDN: saved after the first use, so scanning works with no signal.
   - Your cards and sync (Firestore) are never cached here; they sync on their own when you're back online. */
const PAGE = "dasherdex-page-v1";
const LIBS = "dasherdex-libs-v1";
const LIB_HOSTS = ["cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com", "tessdata.projectnaptha.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(PAGE).then(c => c.addAll(["./", "./manifest.webmanifest"]).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== PAGE && k !== LIBS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  /* the app itself */
  if (req.mode === "navigate" && url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(PAGE).then(c => c.put("./", cp)); }
      return res;
    }).catch(() => caches.match("./").then(r => r || caches.match(req))));
    return;
  }
  /* same-site icons and the manifest: fresh when online, saved copy when not */
  if (url.origin === location.origin && /\.(png|svg|webmanifest|ico|jpg)$/.test(url.pathname)) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(PAGE).then(c => c.put(req, cp)); }
      return res;
    }).catch(() => caches.match(req)));
    return;
  }
  /* scanner, fonts and libraries: versioned files that never change, so the saved copy is used first */
  if (LIB_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque") { const cp = res.clone(); caches.open(LIBS).then(c => c.put(req, cp)); }
      return res;
    })));
  }
});
