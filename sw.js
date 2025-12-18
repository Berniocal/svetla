/* sw.js – robustní Service Worker pro GitHub Pages (berniocal.github.io)
   - Network-first pro HTML (aby se nevracely staré stránky)
   - Stale-while-revalidate pro statické soubory (CSS/JS/IMG…)
   - Rychlá aktivace (skipWaiting + clients.claim)
   - Cleanup starých cache
*/

'use strict';

// ✅ Tohle změň při každém nasazení nové verze
const APP_VERSION = '2025-12-18_03';

const CACHE_PREFIX = 'svetla';
const CACHE_HTML   = `${CACHE_PREFIX}-html-${APP_VERSION}`;
const CACHE_ASSETS = `${CACHE_PREFIX}-assets-${APP_VERSION}`;

// Co se určitě vyplatí mít offline vždy
// (Když máš app v podsložce /svetla/, tak "./" a "./index.html" sedí.)
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './sw.js',
  // přidej sem své ikony, pokud existují:
  './icons/icon-192.png',
  './icons/icon-512.png',
  // přidej sem video, pokud ho chceš offline:
  // './video.mp4',
];

// Jak dlouho držet dynamicky cachované soubory (jen orientačně)
const MAX_ASSET_ENTRIES = 120;

// ---------- Helpers ----------
function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isHTMLRequest(request) {
  return request.mode === 'navigate'
    || (request.headers.get('accept') || '').includes('text/html');
}

function isAssetRequest(request) {
  const dest = request.destination;
  return dest === 'script' || dest === 'style' || dest === 'image' || dest === 'font' || dest === 'audio' || dest === 'video';
}

// Jednoduché ořezávání cache (aby nerostla do nekonečna)
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const deleteCount = keys.length - maxEntries;
  for (let i = 0; i < deleteCount; i++) {
    await cache.delete(keys[i]);
  }
}

// ---------- Install ----------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Precache CORE
    const htmlCache = await caches.open(CACHE_HTML);
    const assetsCache = await caches.open(CACHE_ASSETS);

    // CORE_ASSETS: rozdělíme – HTML do html cache, ostatní do assets
    const htmlList = CORE_ASSETS.filter(p => p.endsWith('/') || p.endsWith('.html'));
    const assetList = CORE_ASSETS.filter(p => !htmlList.includes(p));

    // Pozor: addAll failne, když něco 404. Proto opatrně.
    await Promise.allSettled(htmlList.map(async (p) => {
      const req = new Request(p, { cache: 'reload' });
      const res = await fetch(req);
      if (res && res.ok) await htmlCache.put(req, res.clone());
    }));

    await Promise.allSettled(assetList.map(async (p) => {
      const req = new Request(p, { cache: 'reload' });
      const res = await fetch(req);
      if (res && res.ok) await assetsCache.put(req, res.clone());
    }));

    // ✅ okamžitě připrav novou verzi
    await self.skipWaiting();
  })());
});

// ---------- Activate ----------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // ✅ smaž staré cache
    const keys = await caches.keys();
    const allowed = new Set([CACHE_HTML, CACHE_ASSETS]);

    await Promise.all(keys.map(async (k) => {
      if (k.startsWith(CACHE_PREFIX) && !allowed.has(k)) {
        await caches.delete(k);
      }
    }));

    // ✅ vezmi kontrolu nad klienty hned
    await self.clients.claim();
  })());
});

// ---------- Fetch ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Neřeš non-GET
  if (req.method !== 'GET') return;

  // Neřeš cizí domény (Firebase CDN atd.)
  if (!isSameOrigin(url)) return;

  // 1) HTML: Network-first (nová verze > cache)
  if (isHTMLRequest(req)) {
    event.respondWith((async () => {
      const htmlCache = await caches.open(CACHE_HTML);

      try {
        // cache: 'no-store' pomáhá proti “stará stránka”
        const fresh = await fetch(new Request(req, { cache: 'no-store' }));
        if (fresh && fresh.ok) {
          // Ulož do HTML cache
          htmlCache.put(req, fresh.clone()).catch(()=>{});
        }
        return fresh;
      } catch {
        // offline fallback
        const cached = await htmlCache.match(req);
        if (cached) return cached;

        // fallback na index.html (pro SPA nebo když je požadavek na /svetla/něco)
        const fallback = await htmlCache.match('./index.html');
        if (fallback) return fallback;

        // poslední možnost
        return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // 2) Assety: Stale-while-revalidate
  if (isAssetRequest(req)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_ASSETS);
      const cached = await cache.match(req);

      const fetchPromise = (async () => {
        try {
          // normální fetch
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            cache.put(req, fresh.clone()).catch(()=>{});
            trimCache(CACHE_ASSETS, MAX_ASSET_ENTRIES).catch(()=>{});
          }
          return fresh;
        } catch {
          return null;
        }
      })();

      // vrať cached hned (rychlé), mezitím obnov pozadím
      if (cached) {
        fetchPromise.catch(()=>{});
        return cached;
      }

      // pokud není cached, zkus síť
      const fresh = await fetchPromise;
      if (fresh) return fresh;

      // nic -> fail
      return new Response('', { status: 504 });
    })());
    return;
  }

  // 3) Ostatní (např. JSON lokální): Network-first s fallbackem na cache
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_ASSETS);
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(()=>{});
      return fresh;
    } catch {
      const cached = await cache.match(req);
      if (cached) return cached;
      return new Response('', { status: 504 });
    }
  })());
});

// ---------- Volitelně: ruční “update now” z aplikace ----------
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
