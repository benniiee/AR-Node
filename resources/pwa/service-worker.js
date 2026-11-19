/*
 * ARNode navigation app (/map) service worker: lets the installed app open and
 * navigate without a connection.
 *
 * SOURCE FILE. `npm run build` copies it to public/sw.js and fills in the two
 * placeholders below (vite.config.js, mapServiceWorker plugin): the exact list
 * of files the /map page loads, including the 3D and AR chunks that load later,
 * and a version that changes whenever the build does (so phones update).
 * Edit this file, never public/sw.js.
 *
 * What is cached and how:
 *   /map (the page)              network first, saved copy when offline
 *   /admin/assets/* (the code)   saved at install, cache first (names are hashed)
 *   /<TILE_FILE>.pmtiles         whole file saved at install (src/campusMap.js picks it); offline, the map's
 *                                byte-range requests are answered from it
 *   /storage/data/*.json         network first (the app also keeps its own copy)
 *   /api/*                       never cached: sign-in and live data stay live
 */
const VERSION = '__ARNODE_VERSION__';
const PRECACHE = self.__ARNODE_PRECACHE__;

const SHELL_CACHE = `arnode-shell-${VERSION}`;
const RUNTIME_CACHE = 'arnode-runtime';
const APP_URL = '/map';
// The campus base map archive (TILE_FILE in src/campusMap.js), filled in by the build.
const TILES_URL = '__ARNODE_TILES__';

// Same-origin files the app needs besides the built code.
const SHELL_EXTRAS = [
    APP_URL, '/map-manifest.json', '/favicon.ico',
    '/pwa/icon-192.png', '/pwa/icon-512.png',
    '/pwa/favicon-16x16.png', '/pwa/favicon-32x32.png', '/pwa/apple-touch-icon.png',
];

// ngrok's free plan shows a "You are about to visit" page to browsers; this header skips it,
// so the app never saves that page in place of its own. Harmless on any other host.
const SKIP_TUNNEL_WARNING = { 'ngrok-skip-browser-warning': '1' };

const sameOriginRequest = (url) => new Request(url, { headers: SKIP_TUNNEL_WARNING, credentials: 'same-origin', cache: 'no-cache' });

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // The code and the page must all be saved, or the install fails and retries next visit.
        await Promise.all([...PRECACHE, ...SHELL_EXTRAS].map(async (url) => {
            const res = await fetch(sameOriginRequest(url));
            if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
            await cache.put(url, res);
        }));
        // Best effort: a missing base map file must not stop the rest of the app working offline.
        try {
            const res = await fetch(sameOriginRequest(TILES_URL));
            if (res.ok) await cache.put(TILES_URL, res);
        } catch { /* offline map tiles stay unavailable until the next install attempt */ }
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith('arnode-shell-') && n !== SHELL_CACHE).map((n) => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    if (url.origin === self.location.origin) {
        if (url.pathname.startsWith('/api/')) return;
        if (req.mode === 'navigate') {
            event.respondWith(networkFirst(sameOriginRequest(url.href), APP_URL, SHELL_CACHE));
            return;
        }
        if (url.pathname === TILES_URL) {
            event.respondWith(campusTiles(req));
            return;
        }
        if (url.pathname.startsWith('/admin/assets/') || url.pathname.startsWith('/pwa/') || url.pathname === '/map-manifest.json') {
            event.respondWith(cacheFirst(req));
            return;
        }
        if (url.pathname.startsWith('/storage/data/')) {
            event.respondWith(networkFirst(req, null, RUNTIME_CACHE));
        }
    }
});

/** Fresh from the network when possible (and saved), the saved copy otherwise. */
async function networkFirst(req, fallbackKey, cacheName) {
    try {
        const res = await fetch(req);
        if (res.ok) {
            const cache = await caches.open(cacheName);
            await cache.put(fallbackKey || req, res.clone());
        }
        return res;
    } catch (err) {
        const saved = await caches.match(fallbackKey || req, { ignoreSearch: true });
        if (saved) return saved;
        throw err;
    }
}

/** The saved copy when there is one (hashed files never change), the network otherwise. */
async function cacheFirst(req) {
    const saved = await caches.match(req);
    if (saved) return saved;
    const res = await fetch(req);
    if (res.ok) {
        const cache = await caches.open(RUNTIME_CACHE);
        await cache.put(req, res.clone());
    }
    return res;
}

/**
 * The campus base map is one small file read in byte ranges. Online: straight from the
 * server. Offline: the requested range is cut out of the copy saved at install.
 */
async function campusTiles(req) {
    try {
        const res = await fetch(req);
        if (res.ok || res.status === 206) return res;
    } catch {
        // Offline: fall through to the saved copy.
    }
    const saved = await caches.match(TILES_URL);
    if (!saved) return Response.error();
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
    if (!range) return saved;
    const bytes = await saved.arrayBuffer();
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
    return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
        },
    });
}
