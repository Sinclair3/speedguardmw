// ═══════════════════════════════════════════════════════
// SpeedGuard Malawi — Service Worker
// Version: 2.1 — bump this string to force cache refresh
// 
// HOW IT WORKS (in plain English):
// Think of this like a smart receptionist.
// 
// First visit (online):
//   - Receptionist memorises everything in the office
//     (caches the app files, map tiles, Leaflet library)
// 
// Later visit (offline / bad signal):
//   - You ask for something → receptionist checks memory
//   - If they have it → served instantly from cache
//   - If not → tries network, caches if it gets a response
//   - If network fails too → serves offline fallback
// 
// WHAT WORKS OFFLINE:
//   ✅ Full app UI (HTML, CSS, JS)
//   ✅ Leaflet map library
//   ✅ All 12 official speed trap markers
//   ✅ Speed alerts and voice warnings
//   ✅ GPS tracking and speed display
//   ✅ Night mode, fuel station list
//   ✅ SOS button (WhatsApp opens if signal returns)
// 
// WHAT NEEDS SIGNAL:
//   📡 Map tiles (roads background) — cached tiles show,
//      new tiles show grey until signal returns
//   📡 Live driver tracking
//   📡 Community trap reports from Supabase
//   📡 Weather data
// ═══════════════════════════════════════════════════════

var CACHE_NAME = 'speedguard-mw-v2.1';
var TILE_CACHE = 'speedguard-tiles-v1';

// Core app files — always cache these on install
var CORE_FILES = [
  './',
  './index.html',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// ── INSTALL: cache core files immediately ──
self.addEventListener('install', function(event) {
  console.log('[SW] Installing SpeedGuard v2.1');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CORE_FILES).catch(function(err) {
        // If one file fails, don't block the whole install
        console.warn('[SW] Cache addAll partial failure:', err);
      });
    }).then(function() {
      // Take over immediately without waiting for old SW to die
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE: clean up old caches ──
self.addEventListener('activate', function(event) {
  console.log('[SW] Activating SpeedGuard v2.1');
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) {
          // Delete old versions but keep tile cache
          return key !== CACHE_NAME && key !== TILE_CACHE;
        }).map(function(key) {
          console.log('[SW] Deleting old cache:', key);
          return caches.delete(key);
        })
      );
    }).then(function() {
      // Take control of all tabs immediately
      return self.clients.claim();
    })
  );
});

// ── FETCH: intercept all network requests ──
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // STRATEGY 1: Map tiles — cache first, network fallback
  // OpenStreetMap tiles are big and change rarely
  if (url.includes('tile.openstreetmap.org')) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  // STRATEGY 2: CDN assets (Leaflet) — cache first
  if (url.includes('unpkg.com') || url.includes('cdnjs.cloudflare.com')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // STRATEGY 3: Supabase / weather API — network only
  // These must be live — don't cache API responses
  if (url.includes('supabase.co') || url.includes('open-meteo.com')) {
    event.respondWith(networkOnly(event.request));
    return;
  }

  // STRATEGY 4: Firebase (realtime) — network only
  if (url.includes('firebase') || url.includes('gstatic.com')) {
    event.respondWith(networkOnly(event.request));
    return;
  }

  // STRATEGY 5: App shell (HTML, CSS, JS) — network first, cache fallback
  // Always try to get the freshest version, fall back to cache if offline
  event.respondWith(networkFirstWithCache(event.request));
});

// ── STRATEGY IMPLEMENTATIONS ──

// Cache first — check cache, only hit network if not cached
function cacheFirst(request) {
  return caches.open(CACHE_NAME).then(function(cache) {
    return cache.match(request).then(function(cached) {
      if (cached) return cached;
      return fetch(request).then(function(response) {
        if (response && response.status === 200) {
          cache.put(request, response.clone());
        }
        return response;
      }).catch(function() {
        return new Response('Offline — resource not cached.', {status: 503});
      });
    });
  });
}

// Network first — try network, cache result, fall back to cache
function networkFirstWithCache(request) {
  return caches.open(CACHE_NAME).then(function(cache) {
    return fetch(request).then(function(response) {
      // Cache successful GET responses
      if (response && response.status === 200 && request.method === 'GET') {
        cache.put(request, response.clone());
      }
      return response;
    }).catch(function() {
      // Network failed — try cache
      return cache.match(request).then(function(cached) {
        if (cached) return cached;
        // Nothing in cache either — return the main app shell
        return cache.match('./index.html').then(function(shell) {
          return shell || new Response(offlinePage(), {
            headers: {'Content-Type': 'text/html'}
          });
        });
      });
    });
  });
}

// Tile cache strategy — stale-while-revalidate
// Serves cached tile instantly, updates cache in background
function tileStrategy(request) {
  return caches.open(TILE_CACHE).then(function(cache) {
    return cache.match(request).then(function(cached) {
      // Always try network to get fresh tile
      var networkFetch = fetch(request).then(function(response) {
        if (response && response.status === 200) {
          // Limit tile cache size — delete oldest if over 500 tiles
          cache.put(request, response.clone());
          trimTileCache(cache, 500);
        }
        return response;
      }).catch(function() {
        return null; // Network failed silently
      });

      // Return cached immediately if available, else wait for network
      return cached || networkFetch.then(function(r) {
        return r || new Response('', {status: 503});
      });
    });
  });
}

// Network only — no caching (for live APIs)
function networkOnly(request) {
  return fetch(request).catch(function() {
    return new Response(JSON.stringify({error: 'offline'}), {
      status: 503,
      headers: {'Content-Type': 'application/json'}
    });
  });
}

// Trim tile cache to maxTiles entries (LRU approximation)
function trimTileCache(cache, maxTiles) {
  cache.keys().then(function(keys) {
    if (keys.length > maxTiles) {
      // Delete oldest 50 tiles
      var toDelete = keys.slice(0, 50);
      toDelete.forEach(function(key) { cache.delete(key); });
    }
  });
}

// Minimal offline fallback page
function offlinePage() {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>SpeedGuard — Offline</title>'
    + '<style>body{background:#0a0f14;color:#fff;font-family:-apple-system,sans-serif;'
    + 'display:flex;flex-direction:column;align-items:center;justify-content:center;'
    + 'min-height:100vh;text-align:center;padding:24px}'
    + 'h1{font-size:28px;font-weight:800;margin-bottom:8px}'
    + 'h1 span{color:#27ae60}'
    + 'p{color:rgba(255,255,255,.5);font-size:14px;line-height:1.7;max-width:320px}'
    + '.icon{font-size:60px;margin-bottom:16px}'
    + '.btn{padding:13px 28px;border-radius:12px;background:#27ae60;color:#fff;'
    + 'border:none;font-size:15px;font-weight:700;cursor:pointer;margin-top:20px}'
    + '</style></head><body>'
    + '<div class="icon">📡</div>'
    + '<h1>SpeedGuard <span>Offline</span></h1>'
    + '<p>No internet connection detected.<br>'
    + 'GPS tracking, speed alerts, and all official speed traps still work.<br><br>'
    + 'Live driver tracking and community traps need a signal.</p>'
    + '<button class="btn" onclick="location.reload()">↻ Try Again</button>'
    + '</body></html>';
}

// ── BACKGROUND SYNC: notify app when back online ──
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
