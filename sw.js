const CACHE = "barvy-v7"; // pokaždé zvyš číslo

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll([
      "./",
      "./index.html",
      "./manifest.json",
      "./video.mp4",
      "./icon-192.png",
      "./icon-512.png"
    ]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
