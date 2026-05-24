/**
 * Service Worker — two-cache architecture for atomic deploy invalidation.
 *
 * ## Two caches
 *
 * BUILD_CACHE (`pantry-host-{hash}`):
 *   HTML shells, Rex JS/CSS bundles, fonts, manifest.
 *   Versioned per deploy. Entire cache deleted when a new build deploys.
 *   The build hash comes from the SW registration URL (?v=abc123).
 *
 * ASSETS_CACHE (`pantry-host-uploads`):
 *   Uploaded recipe images (/uploads/uuid.jpg).
 *   Immortal — never purged on deploy. UUID filenames are immutable.
 *
 * ## How deploys work
 *
 * 1. Rex build generates a new build_id (8-char hash in bundle filenames)
 * 2. _document.tsx injects <meta name="build-hash" content="abc123">
 * 3. _app.tsx registers /sw.js?v=abc123
 * 4. Browser detects URL change → downloads new SW → triggers install
 * 5. Install: pre-cache shell pages into new BUILD_CACHE
 * 6. Activate: delete all caches EXCEPT current BUILD_CACHE and ASSETS_CACHE
 * 7. Result: stale HTML + old bundles gone, uploaded images preserved
 *
 * ## Caching strategies
 *
 * | Request type            | Cache           | Strategy                          |
 * |-------------------------|-----------------|-----------------------------------|
 * | Shell pages (install)   | BUILD_CACHE     | Pre-cache individually            |
 * | /_rex/ bundles          | BUILD_CACHE     | Cache-first (immutable)           |
 * | /uploads/ images        | ASSETS_CACHE    | Cache-first (immortal)            |
 * | /api/wikibooks          | ASSETS_CACHE    | Cache-first (static dataset)      |
 * | HTML navigation         | BUILD_CACHE     | Network-first + timeout           |
 * | Other same-origin       | BUILD_CACHE     | Stale-while-revalidate (.ok only) |
 * | recipes.cooklang.org    | COOKLANG_CACHE  | Cache-first 24h TTL + revalidate  |
 * | recipe-api.com          | COOKLANG_CACHE  | Cache-first 24h TTL + revalidate  |
 * | pixabay.com/api/        | COOKLANG_CACHE  | Cache-first 24h TTL + revalidate  |
 * | cdn.pixabay.com + /get/ | PIXABAY_CACHE   | Cache-first 1y TTL (immutable)    |
 * | feed.pantryhost.app     | FEED_CACHE      | Per-endpoint TTL + stale-on-err   |
 * | Other cross-origin      | —               | Ignored (passthrough)             |
 */

const BUILD_HASH = new URL(self.location).searchParams.get('v') || 'dev';
const BUILD_CACHE = `pantry-host-${BUILD_HASH}`;
const ASSETS_CACHE = 'pantry-host-uploads';
const COOKLANG_CACHE = 'pantry-host-cooklang-v1';
const COOKLANG_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PIXABAY_CACHE = 'pantry-host-pixabay-v1';
// Pixabay photo URLs are immutable — the bytes never change. We use a
// 1-year TTL as a finite stand-in for "never expire"; the browser's
// CacheStorage quota manager handles LRU eviction under storage pressure.
const PIXABAY_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
// Per-endpoint TTLs for feed.pantryhost.app. /api/recipes doubles the
// server's Cache-Control: 30s header; /api/handles changes only when a
// new publisher appears; OSM-backed /api/markets is very slow-moving
// and Overpass has tight rate limits.
const FEED_CACHE = 'pantry-host-feed-v1';
const FEED_RECIPES_TTL_MS = 60 * 1000;                  // 1 minute
const FEED_HANDLES_TTL_MS = 5 * 60 * 1000;              // 5 minutes
const FEED_MARKETS_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // 7 days

// Caches that must survive a deploy activation (non-build-versioned).
const IMMORTAL_CACHES = new Set([ASSETS_CACHE, COOKLANG_CACHE, PIXABAY_CACHE, FEED_CACHE]);

const SHELL_PAGES = ['/', '/list', '/recipes', '/ingredients', '/cookware', '/kitchens', '/menus', '/recipes/export'];

const NETWORK_TIMEOUT = 1500;

function fetchWithTimeout(request) {
  return Promise.race([
    fetch(request),
    new Promise((_, reject) => setTimeout(() => reject(new Error('SW timeout')), NETWORK_TIMEOUT)),
  ]);
}

// --- Lifecycle ---

self.addEventListener('install', (event) => {
  // Pre-cache shell pages into the new versioned build cache.
  // Individual fetch+put so we can reject redirected responses — when
  // first-boot setup is incomplete, the server redirects every shell
  // path (/, /recipes, …) to /setup, and caching that redirect chain
  // poisons the SW for the rest of the day. Falling back to a plain
  // failed-fetch on redirect is safer: the cache stays empty for that
  // path and the next online navigation re-tries.
  event.waitUntil(
    caches.open(BUILD_CACHE).then((cache) =>
      Promise.all(
        SHELL_PAGES.map((page) =>
          fetch(page, { redirect: 'follow' })
            .then((res) => {
              if (!res.ok || res.redirected) return;
              return cache.put(page, res);
            })
            .catch((err) => console.warn('[SW] Failed to pre-cache', page, err))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Delete all caches EXCEPT the current build cache and the immortal uploads cache.
  // This atomically purges stale HTML + old bundles from previous deploys.
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n !== BUILD_CACHE && !IMMORTAL_CACHES.has(n))
          .map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
     .then(() =>
       // Notify all open tabs/PWA windows that a new build is active so
       // they can reload and pick up fresh HTML + JS bundles. Without
       // this, homescreen PWAs stay stuck on stale assets forever.
       self.clients.matchAll({ type: 'window' }).then((clients) =>
         clients.forEach((client) => client.postMessage({ type: 'SW_UPDATED', build: BUILD_HASH }))
       )
     )
  );
});

// --- Federated recipe source cache helpers ---

function isCooklangFederation(url) {
  return url.hostname === 'recipes.cooklang.org';
}

// Third-party JSON APIs we cache in the 24h TTL bucket (ok-gated).
function isCachedRecipeSource(url) {
  if (isCooklangFederation(url)) return true;
  if (url.hostname === 'recipe-api.com') return true;
  return false;
}

// Pixabay API JSON responses get the same 1-year TTL as Pixabay images.
function isPixabayApi(url) {
  return url.hostname === 'pixabay.com' && url.pathname.startsWith('/api');
}

/**
 * Pixabay photo URLs. Separate bucket, longer TTL, no revalidate —
 * photos are immutable. Matches both `cdn.pixabay.com` and
 * `pixabay.com/get/…` since Pixabay serves image bytes from both.
 */
function isPixabayImage(url) {
  if (url.hostname === 'cdn.pixabay.com') return true;
  if (url.hostname === 'pixabay.com' && url.pathname.startsWith('/get/')) return true;
  return false;
}

/**
 * feed.pantryhost.app JSON endpoints we cache. Returns the TTL for the
 * matched endpoint, or 0 if not cacheable. /api/recipe-url and
 * /api/fetch-recipe intentionally don't match — they proxy arbitrary
 * third-party URLs and have their own freshness concerns.
 */
function feedApiTtl(url) {
  if (url.hostname !== 'feed.pantryhost.app') return 0;
  if (url.pathname === '/api/recipes') return FEED_RECIPES_TTL_MS;
  if (url.pathname === '/api/handles') return FEED_HANDLES_TTL_MS;
  if (url.pathname === '/api/markets') return FEED_MARKETS_TTL_MS;
  return 0;
}

/**
 * Clone a response and stamp it with an X-Cached-At header so we can
 * compute age when reading it back out of the cache.
 */
async function stampResponse(response) {
  const buf = await response.clone().arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set('X-Cached-At', String(Date.now()));
  return new Response(buf, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function ageOf(cachedResponse) {
  const stamped = Number(cachedResponse.headers.get('X-Cached-At') || 0);
  if (!stamped) return Infinity;
  return Date.now() - stamped;
}

async function revalidateCooklang(request, cache) {
  try {
    const fresh = await fetch(request);
    if (fresh.ok) await cache.put(request, await stampResponse(fresh));
  } catch {
    /* background revalidate errors are swallowed */
  }
}

/**
 * Cache-first with TTL and graceful degradation:
 *   - fresh hit (< TTL)  → return cached, kick off background revalidate
 *   - stale hit (>= TTL) → try network; on OK store + return, on fail return stale
 *   - miss               → network; on OK store + return, on fail throw
 * Response.ok is required before storing so a 429 or 5xx can never get
 * trapped in the cache.
 */
async function cooklangHandler(request) {
  const cache = await caches.open(COOKLANG_CACHE);
  const cached = await cache.match(request);

  if (cached && ageOf(cached) < COOKLANG_TTL_MS) {
    revalidateCooklang(request, cache);
    return cached;
  }

  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      await cache.put(request, await stampResponse(fresh));
      return fresh;
    }
    if (cached) return cached; // prefer stale over 429/5xx
    return fresh;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

/**
 * Pixabay image cache handler. Cache-first, 30-day TTL, no revalidate.
 */
/**
 * feed.pantryhost.app JSON cache handler. Cache-first with per-endpoint
 * TTL, background revalidate on fresh hit, stale-over-error so a Fly
 * hiccup doesn't empty the feed page.
 */
async function feedHandler(request, ttl) {
  const cache = await caches.open(FEED_CACHE);
  const cached = await cache.match(request);

  if (cached && ageOf(cached) < ttl) {
    fetch(request)
      .then(async (fresh) => {
        if (fresh.ok) await cache.put(request, await stampResponse(fresh));
      })
      .catch(() => { /* swallow background errors */ });
    return cached;
  }

  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      await cache.put(request, await stampResponse(fresh));
      return fresh;
    }
    if (cached) return cached;
    return fresh;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function pixabayHandler(request) {
  const cache = await caches.open(PIXABAY_CACHE);
  const cached = await cache.match(request);
  if (cached && ageOf(cached) < PIXABAY_TTL_MS) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      await cache.put(request, await stampResponse(fresh));
      return fresh;
    }
    if (cached) return cached;
    return fresh;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

/** True for any URL owned by the first-boot installer SPA + its supporting
 *  endpoints. We deliberately leave the generic `/api/` namespace alone —
 *  things like `/api/wikibooks` and `/api/plu` benefit from the SW's
 *  caching, and only the installer-specific endpoints need pass-through. */
function isInstallerPath(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  return (
    p === '/setup' ||
    p.startsWith('/setup/') ||
    p.startsWith('/_setup/') ||
    p === '/api/setup-status' ||
    p === '/api/setup-complete' ||
    p.startsWith('/api/tailscale/')
  );
}

// --- Fetch ---

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // The Cache API only supports GET requests — any cache.put of a POST/PUT/
  // DELETE request throws "Request method 'X' is unsupported". Today the
  // only same-origin non-GET is not caught by any of the handlers below, but
  // any future same-origin mutation endpoint would hit the generic
  // stale-while-revalidate handler at the bottom and throw. Let non-GETs
  // pass through to the network unconditionally.
  if (request.method !== 'GET') return;

  // Installer-owned paths: pass straight through to the network. The SW is
  // scoped to the whole origin (sw.js lives at `/sw.js`), so by default it
  // would intercept first-boot installer navigations and serve stale cached
  // shells from before setup was reset. Skipping these paths leaves the
  // installer to talk to the server directly while the SW keeps doing its
  // job for the main app.
  if (isInstallerPath(url)) return;

  // Federated recipe sources (Cooklang + recipe-api.com): dedicated TTL cache.
  if (isCachedRecipeSource(url)) {
    event.respondWith(cooklangHandler(request));
    return;
  }

  // Pixabay API JSON + photo bytes: both use 1-year TTL cache.
  if (isPixabayApi(url) || isPixabayImage(url)) {
    event.respondWith(pixabayHandler(request));
    return;
  }

  // feed.pantryhost.app JSON endpoints: per-endpoint TTL cache.
  const feedTtl = feedApiTtl(url);
  if (feedTtl > 0) {
    event.respondWith(feedHandler(request, feedTtl));
    return;
  }

  // Only handle same-origin — GraphQL (port 4001) is cross-origin
  if (url.origin !== self.location.origin) return;

  // --- Uploaded images: immortal cache ---
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      caches.open(ASSETS_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // --- Wikibooks API: cache-first (static dataset, never changes) ---
  if (url.pathname.startsWith('/api/wikibooks')) {
    event.respondWith(
      caches.open(ASSETS_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // --- Rex bundles: cache-first (immutable hashed filenames) ---
  if (url.pathname.startsWith('/_rex/')) {
    event.respondWith(
      caches.open(BUILD_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // --- HTML navigation: network-first with fallback ---
  if (request.mode === 'navigate') {
    event.respondWith(
      fetchWithTimeout(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(BUILD_CACHE).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.open(BUILD_CACHE).then((cache) =>
            cache.match(request).then((cached) => cached ?? cache.match('/'))
          )
        )
    );
    return;
  }

  // --- Other same-origin: stale-while-revalidate (don't cache errors) ---
  event.respondWith(
    caches.open(BUILD_CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const networkFetch = fetchWithTimeout(request).then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        });
        return cached ?? networkFetch;
      })
    )
  );
});
