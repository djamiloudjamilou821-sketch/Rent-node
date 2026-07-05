const CACHE_NAME = "rental-app-v1";

const urlsToCache = [
    "/",
    "/login",
    "/home",
    "/dashboard",
    "/renters",
    "/money",
    "/add",
    "/static/manifest.json"
];

// =========================
// INSTALL
// =========================
self.addEventListener("install", function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll(urlsToCache);
        })
    );
});

// =========================
// FETCH (offline support)
// =========================
self.addEventListener("fetch", function (event) {
    event.respondWith(
        caches.match(event.request).then(function (response) {
            return response || fetch(event.request);
        })
    );
});

// =========================
// ACTIVATE (clean old cache)
// =========================
self.addEventListener("activate", function (event) {
    event.waitUntil(
        caches.keys().then(function (cacheNames) {
            return Promise.all(
                cacheNames.map(function (cache) {
                    if (cache !== CACHE_NAME) {
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
});