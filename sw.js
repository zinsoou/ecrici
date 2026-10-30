/* Offline cache. Bump VERSION whenever you upload a new index.html. */
const VERSION = "ecrici-v17";
const FILES = ["./", "index.html", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "config.js", "hosted.js"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/rest/") || url.pathname.startsWith("/auth/") || url.hostname.endsWith("supabase.co")) return;   // never cache account data
  if (url.pathname.endsWith("admin.html")) return;
  if (url.origin !== location.origin) {           // fonts: try network, fall back to cache
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(VERSION).then(c => c.put(req, cp)); return r; }).catch(() => caches.match(req)));
    return;
  }
  e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(VERSION).then(c => c.put(req, cp)); return r; })
    .catch(() => caches.match(req).then(m => m || caches.match("index.html"))));
});
