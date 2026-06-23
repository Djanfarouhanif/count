// Service Worker — permet d'ouvrir l'app sans connexion (cache de la page).
// Les DONNÉES (/api/data) ne sont PAS mises en cache ici : c'est l'app qui gère
// le hors-ligne via localStorage et la synchronisation.
const CACHE = "monbudget-v1";
const SHELL = ["/", "/index.html", "/style.css", "/script.js", "/manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;          // laisse passer les PUT (sauvegarde)
  if (url.pathname.startsWith("/api/")) return;     // données : réseau direct (géré par l'app)

  // App shell : réseau d'abord (toujours à jour), secours cache (hors-ligne)
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("/index.html")))
  );
});
