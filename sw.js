// ═══════════════════════════════════════════════════════
// SpeedGuard Malawi — Service Worker
// Version: 2.3 — M1 corridor tile pre-cache on first install
//
// HOW IT WORKS (in plain English):
// Think of this like a smart receptionist.
//
// First visit (online):
//   - Receptionist memorises everything in the office
//     (caches the app files, map tiles, Leaflet library)
//   - Then quietly downloads the entire M1 road corridor
//     in the background so the map works offline next time
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
//   ✅ M1 map tiles (zoom 10–13) pre-cached on first install
//
// WHAT NEEDS SIGNAL:
//   📡 Map tiles outside the pre-cached corridor
//   📡 Live driver tracking
//   📡 Community trap reports from Supabase
//   📡 Weather data
// ═══════════════════════════════════════════════════════

var CACHE_NAME = 'speedguard-mw-v2.3';
var TILE_CACHE = 'speedguard-tiles-v1';

// Core app files — always cache these on install
var CORE_FILES = [
  './',
  './index.html',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// ═══════════════════════════════════════════════════════
// M1 CORRIDOR TILE PRE-CACHE
//
// The 65 waypoints below trace the full M1 highway from
// the Tanzania border (Kasumulu, km 0) to the Mozambique
// border (Marka, km 1140).
//
// On first install we compute which OSM tiles cover this
// corridor at zoom 10–13 and download them in the
// background. About 800–1000 tiles, ~10MB.
//
// The driver in Karonga gets a working map on day one,
// not a grey rectangle while tiles trickle in.
// ═══════════════════════════════════════════════════════

var M1_ROUTE = [
  [-9.62,33.94],[-9.78,33.95],[-9.93,33.97],[-9.93,33.98],
  [-10.12,34.01],[-10.35,34.12],[-10.57,34.23],[-10.75,34.31],
  [-10.90,34.36],[-11.00,34.26],[-11.15,34.12],[-11.28,34.08],
  [-11.35,34.03],[-11.46,34.02],[-11.57,33.98],[-11.82,33.90],
  [-12.00,33.75],[-12.16,33.61],[-12.45,33.45],[-13.00,33.47],
  [-13.02,33.47],[-13.20,33.54],[-13.42,33.66],[-13.66,33.93],
  [-13.75,33.82],[-13.85,33.81],[-13.97,33.79],[-14.01,33.83],
  [-14.06,33.86],[-14.11,33.91],[-14.18,33.95],[-14.25,34.00],
  [-14.32,34.06],[-14.39,34.11],[-14.46,34.17],[-14.51,34.21],
  [-14.57,34.28],[-14.63,34.33],[-14.68,34.38],[-14.74,34.42],
  [-14.82,34.45],[-14.90,34.52],[-14.98,34.70],[-15.05,34.95],
  [-15.05,34.96],[-15.11,35.02],[-15.16,35.06],[-15.28,34.98],
  [-15.35,34.92],[-15.42,34.90],[-15.50,34.96],[-15.55,34.98],
  [-15.67,35.00],[-15.78,34.997],[-15.90,34.95],[-16.05,34.93],
  [-16.10,34.90],[-16.40,34.85],[-16.75,34.90],[-16.95,35.05],
  [-17.08,35.10],[-17.12,35.14]
];

// Convert lat/lng to OSM tile x/y at a given zoom level
function latLngToTile(lat, lng, zoom) {
  var n = Math.pow(2, zoom);
  var x = Math.floor((lng + 180) / 360 * n);
  var lr = lat * Math.PI / 180;
  var y = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
  return [x, y];
}

// Interpolate M1_ROUTE so no gap between waypoints exceeds stepDeg
function interpolateRoute(stepDeg) {
  var pts = [];
  for (var i = 0; i < M1_ROUTE.length; i++) {
    pts.push(M1_ROUTE[i]);
    if (i < M1_ROUTE.length - 1) {
      var la0 = M1_ROUTE[i][0],   lo0 = M1_ROUTE[i][1];
      var la1 = M1_ROUTE[i+1][0], lo1 = M1_ROUTE[i+1][1];
      var d = Math.sqrt((la1-la0)*(la1-la0) + (lo1-lo0)*(lo1-lo0));
      var steps = Math.ceil(d / stepDeg);
      for (var s = 1; s < steps; s++) {
        pts.push([la0 + (la1-la0)*s/steps, lo0 + (lo1-lo0)*s/steps]);
      }
    }
  }
  return pts;
}

// Build the full list of tile URLs for the M1 corridor
function buildM1TileUrls() {
  var seen = {};
  var urls = [];

  function addTile(z, x, y) {
    var key = z + '_' + x + '_' + y;
    if (!seen[key]) {
      seen[key] = 1;
      urls.push('https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png');
    }
  }

  function addPoint(lat, lng, zoom, bx, by) {
    var xy = latLngToTile(lat, lng, zoom);
    for (var dx = -bx; dx <= bx; dx++) {
      for (var dy = -by; dy <= by; dy++) {
        addTile(zoom, xy[0] + dx, xy[1] + dy);
      }
    }
  }

  // Zoom 10 & 11: sparse waypoints, 1-tile buffer each side (3×3 neighbourhood)
  // Tiles are large (76km and 38km per tile) so 65 waypoints gives full coverage.
  M1_ROUTE.forEach(function(pt) { addPoint(pt[0], pt[1], 10, 1, 1); });
  M1_ROUTE.forEach(function(pt) { addPoint(pt[0], pt[1], 11, 1, 1); });

  // Zoom 12: denser interpolation (every ~4km), centre tile only
  // Tile size ~10km — need interpolation to close gaps between waypoints.
  interpolateRoute(0.04).forEach(function(pt) { addPoint(pt[0], pt[1], 12, 0, 0); });

  // Zoom 13: very dense interpolation (every ~2km), centre tile only
  // Tile size ~5km — this gives the detailed road-level view offline.
  interpolateRoute(0.02).forEach(function(pt) { addPoint(pt[0], pt[1], 13, 0, 0); });

  return urls;
}

// Fetch tiles in small batches — polite to OSM servers, works on slow connections
function batchFetch(cache, urls, batchSize, delayMs) {
  var remaining = urls.slice();
  var fetched = 0;
  var skipped = 0;

  function nextBatch() {
    if (!remaining.length) {
      console.log('[SW] Tile pre-cache complete: ' + fetched + ' fetched, ' + skipped + ' already cached');
      return Promise.resolve();
    }
    var batch = remaining.splice(0, batchSize);
    var promises = batch.map(function(url) {
      return cache.match(url).then(function(hit) {
        if (hit) { skipped++; return; }
        return fetch(url).then(function(resp) {
          if (resp && resp.status === 200) {
            fetched++;
            return cache.put(url, resp);
          }
        }).catch(function() {}); // network failure — skip this tile silently
      });
    });
    return Promise.all(promises).then(function() {
      return new Promise(function(resolve) {
        setTimeout(function() { nextBatch().then(resolve); }, delayMs);
      });
    });
  }

  return nextBatch();
}

// Kick off background tile pre-cache — called from install, non-blocking
function preCacheM1Tiles() {
  caches.open(TILE_CACHE).then(function(cache) {
    var urls = buildM1TileUrls();
    console.log('[SW] Starting M1 tile pre-cache: ' + urls.length + ' tiles to check');
    // 4 tiles per batch, 150ms between batches → polite to OSM, ~30s total on fast connection
    return batchFetch(cache, urls, 4, 150);
  }).catch(function(err) {
    console.warn('[SW] Tile pre-cache failed:', err);
  });
}

// ── INSTALL: cache core files immediately ──
self.addEventListener('install', function(event) {
  console.log('[SW] Installing SpeedGuard v2.3');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CORE_FILES).catch(function(err) {
        console.warn('[SW] Cache addAll partial failure:', err);
      });
    }).then(function() {
      // Tile pre-cache runs in background — NOT inside waitUntil
      // so it never delays SW activation. Runs after skipWaiting.
      setTimeout(preCacheM1Tiles, 2000);
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE: clean up old caches ──
self.addEventListener('activate', function(event) {
  console.log('[SW] Activating SpeedGuard v2.3');
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) {
          return key !== CACHE_NAME && key !== TILE_CACHE;
        }).map(function(key) {
          console.log('[SW] Deleting old cache:', key);
          return caches.delete(key);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── FETCH: intercept all network requests ──
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // STRATEGY 1: Map tiles — cache first, network fallback
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
  event.respondWith(networkFirstWithCache(event.request));
});

// ── STRATEGY IMPLEMENTATIONS ──

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

function networkFirstWithCache(request) {
  return caches.open(CACHE_NAME).then(function(cache) {
    return fetch(request).then(function(response) {
      if (response && response.status === 200 && request.method === 'GET') {
        cache.put(request, response.clone());
      }
      return response;
    }).catch(function() {
      return cache.match(request).then(function(cached) {
        if (cached) return cached;
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
// Serves cached tile instantly (including pre-cached M1 corridor), updates in background
function tileStrategy(request) {
  return caches.open(TILE_CACHE).then(function(cache) {
    return cache.match(request).then(function(cached) {
      var networkFetch = fetch(request).then(function(response) {
        if (response && response.status === 200) {
          cache.put(request, response.clone());
          trimTileCache(cache, 1500); // raised to 1500 to accommodate pre-cached tiles
        }
        return response;
      }).catch(function() {
        return null;
      });
      return cached || networkFetch.then(function(r) {
        return r || new Response('', {status: 503});
      });
    });
  });
}

function networkOnly(request) {
  return fetch(request).catch(function() {
    return new Response(JSON.stringify({error: 'offline'}), {
      status: 503,
      headers: {'Content-Type': 'application/json'}
    });
  });
}

// Trim tile cache — keeps newest tiles, removes oldest when over limit
function trimTileCache(cache, maxTiles) {
  cache.keys().then(function(keys) {
    if (keys.length > maxTiles) {
      var toDelete = keys.slice(0, keys.length - maxTiles);
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
    + 'GPS tracking, speed alerts, and all official speed traps still work.<br>'
    + 'The M1 map corridor is pre-cached — you\'ll see the road even offline.<br><br>'
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

// ═══════════════════════════════════════════════════════
// PUSH NOTIFICATION HANDLER
// ═══════════════════════════════════════════════════════
var SUPA_URL = 'https://mgoxhsnmjbzjuevwryxy.supabase.co';
var SUPA_KEY = 'sb_publishable_6GSg9fQ2tCMJ9vZTaOFcCQ_SYviH_KR';

self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}

  function showNote(title, body, url) {
    return self.registration.showNotification(title, {
      body:     body,
      icon:     './icon-192.png',
      badge:    './icon-96.png',
      tag:      'speedguard-trap',
      renotify: true,
      vibrate:  [200, 100, 200, 100, 200],
      data:     { url: url || './' },
      actions:  [{ action: 'open', title: '🗺️ View Map' }]
    });
  }

  if (!data.title) {
    event.waitUntil(
      fetch(SUPA_URL + '/rest/v1/sg_notifications?select=title,body&order=created_at.desc&limit=1', {
        headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY }
      })
      .then(function(r) { return r.json(); })
      .then(function(rows) {
        var n = rows && rows[0];
        return showNote(
          n ? n.title : '⚠️ SpeedGuard Malawi',
          n ? n.body  : 'New verified trap on M1 — open the app',
          './'
        );
      })
      .catch(function() {
        return showNote('⚠️ SpeedGuard Malawi', 'New verified trap on M1 — open the app', './');
      })
    );
    return;
  }

  event.waitUntil(showNote(data.title, data.body || 'Speed trap alert', data.url));
});

// ── Handle notification click ──
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url : './';

  event.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.includes('speedguardmw') || client.url.includes('index.html')) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
