// Offline copy of the campus data: nodes + staircases + borders (map.json) and
// the latest rain status (weather.json).
//
// Laravel writes both as static files in storage/app/public/data/ (served at
// /storage/data/...). The phone reads those first - one file read on the
// server, no PHP, no database - and falls back to /api/map-data and
// /api/weather when the static file is missing or unreachable (for example the
// app is served from a different origin without CORS on /storage).
//
// "Download for offline" saves both files in the phone's IndexedDB. The app
// then uses the saved copy whenever the network fails. Nothing here imports
// the browser build tooling, so it is unit-tested in plain Node with a fake
// fetch and a fake store.

export const STATIC_MAP_PATH = '/storage/data/map.json';
export const STATIC_WEATHER_PATH = '/storage/data/weather.json';
export const API_MAP_PATH = '/api/map-data';
export const API_WEATHER_PATH = '/api/weather';

const KEY_MAP = 'map';
const KEY_WEATHER = 'weather';
const KEY_META = 'meta';

// ---------------------------------------------------------------- validation

/** A map worth saving or trusting: at least one node, every node has an id and coordinates. */
export function isValidMap(data) {
    return Boolean(data)
        && Array.isArray(data.nodes)
        && data.nodes.length > 0
        && data.nodes.every((n) => n
            && n.id !== undefined && n.id !== null
            && n.latitude !== null && n.latitude !== undefined && Number.isFinite(Number(n.latitude))
            && n.longitude !== null && n.longitude !== undefined && Number.isFinite(Number(n.longitude)));
}

/** Any weather state object (the server's own states, including 'unavailable', are all accepted). */
export function isWeatherObject(data) {
    return Boolean(data) && typeof data === 'object' && !Array.isArray(data) && 'rain_mode' in data;
}

// ------------------------------------------------------------------- fetching

async function fetchJson(fetchImpl, url, headers) {
    let res;
    try {
        res = await fetchImpl(url, { headers });
    } catch (err) {
        throw new Error(`Cannot reach ${url} (${err.message}). Is the backend running and is this device on the same Wi-Fi as it?`);
    }
    if (!res.ok) throw new Error(`Request failed (HTTP ${res.status}) at ${url}`);

    return res.json();
}

/**
 * Static file first, API second. The static answer is only accepted when
 * `validateStatic` says it is complete; the API answer is accepted as is (it is
 * the source of truth), and its error is the one reported when both fail.
 *
 * @returns {Promise<{data: object, via: 'static'|'api'}>}
 */
export async function fetchWithFallback({
    fetchImpl = (...a) => fetch(...a), base = '', headers = {}, staticPath, apiPath, validateStatic = () => true,
}) {
    try {
        const data = await fetchJson(fetchImpl, `${base}${staticPath}`, headers);
        if (validateStatic(data)) return { data, via: 'static' };
    } catch {
        // fall through to the API
    }

    const data = await fetchJson(fetchImpl, `${base}${apiPath}`, headers);
    if (!data || typeof data !== 'object') throw new Error(`Unexpected answer from ${base}${apiPath}`);

    return { data, via: 'api' };
}

// ---------------------------------------------------------------- store access

async function safeGet(store, key) {
    if (!store) return null;
    try {
        return (await store.get(key)) ?? null;
    } catch {
        return null;
    }
}

/**
 * Load the map: the network if it answers, otherwise the saved copy.
 *
 * @returns {Promise<{data: object, source: 'network'|'offline', savedAt?: number}>}
 */
export async function loadMapData({ fetchImpl, base = '', headers = {}, store = null } = {}) {
    try {
        const { data, via } = await fetchWithFallback({
            fetchImpl, base, headers, staticPath: STATIC_MAP_PATH, apiPath: API_MAP_PATH, validateStatic: isValidMap,
        });

        return { data, source: 'network', via };
    } catch (err) {
        const saved = await safeGet(store, KEY_MAP);
        if (saved && isValidMap(saved.data)) return { data: saved.data, source: 'offline', savedAt: saved.savedAt };

        throw err;
    }
}

/** The weather state saved by the last offline download, or null. */
export async function loadSavedWeather(store) {
    const saved = await safeGet(store, KEY_WEATHER);

    return saved && isWeatherObject(saved.data) ? saved.data : null;
}

/** {savedAt, nodes, links, version, weatherSaved} for the button label, or null when nothing is saved. */
export async function readOfflineMeta(store) {
    const meta = await safeGet(store, KEY_META);

    return meta && Number.isFinite(meta.savedAt) ? meta : null;
}

// -------------------------------------------------------------------- download

/**
 * The "Download latest data for offline" action.
 *
 * Both files are fetched in parallel. The map is required; the rain status is
 * saved when available (it is only trusted for 60 minutes anyway). A bad or
 * empty answer never overwrites a good saved copy: validation happens before
 * anything is written.
 *
 * @returns {Promise<{nodes: number, links: number, version: *, savedAt: number, weatherSaved: boolean, weatherAgeMinutes: number|null, map: object}>}
 */
export async function downloadOfflineData({
    fetchImpl, base = '', headers = {}, store = null, now = () => Date.now(),
} = {}) {
    const [mapRes, weatherRes] = await Promise.allSettled([
        fetchWithFallback({ fetchImpl, base, headers, staticPath: STATIC_MAP_PATH, apiPath: API_MAP_PATH, validateStatic: isValidMap }),
        fetchWithFallback({ fetchImpl, base, headers, staticPath: STATIC_WEATHER_PATH, apiPath: API_WEATHER_PATH, validateStatic: isWeatherObject }),
    ]);

    if (mapRes.status !== 'fulfilled') {
        throw new Error(`Could not download the map. ${mapRes.reason.message}`);
    }

    const map = mapRes.value.data;
    if (!isValidMap(map)) {
        throw new Error('The server sent an empty or incomplete map, so your saved copy was kept.');
    }
    if (!store) {
        throw new Error('This browser cannot store offline data (private browsing?).');
    }

    const savedAt = now();
    const weather = weatherRes.status === 'fulfilled' && isWeatherObject(weatherRes.value.data)
        ? weatherRes.value.data
        : null;

    await store.set(KEY_MAP, { data: map, savedAt });
    if (weather) await store.set(KEY_WEATHER, { data: weather, savedAt });

    const fetched = weather ? Date.parse(weather.fetched_at) : NaN;
    const result = {
        nodes: map.nodes.length,
        links: Array.isArray(map.links) ? map.links.length : 0,
        version: map.version ?? null,
        savedAt,
        weatherSaved: weather !== null,
        weatherAgeMinutes: Number.isFinite(fetched) ? Math.max(0, Math.round((savedAt - fetched) / 60000)) : null,
        map,
    };

    await store.set(KEY_META, {
        savedAt, nodes: result.nodes, links: result.links, version: result.version, weatherSaved: result.weatherSaved,
    });

    return result;
}

// -------------------------------------------------------------------- display

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function describeAge(savedAt, nowMs = Date.now()) {
    const seconds = Math.max(0, Math.round((nowMs - savedAt) / 1000));
    if (seconds < 60) return 'just now';

    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;

    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;

    return `${Math.round(hours / 24)} days ago`;
}

// ------------------------------------------------------------- change check

/**
 * Fingerprint of a map payload, to tell whether an automatic sync brought
 * anything new. The static map.json carries a content `hash` (it changes when a
 * node is deleted, which `version` alone misses); the API payload has only
 * `version`, so the counts are added for that case.
 */
export function mapSignature(map) {
    if (!map || typeof map !== 'object') return '';
    const count = (k) => (Array.isArray(map[k]) ? map[k].length : 0);
    return [map.hash ?? '', map.version ?? '', count('nodes'), count('links'), count('borders'), count('buildings'), count('pathways')].join(':');
}

/**
 * Forget the saved copy (map, weather, meta). Called on student sign-out: the
 * full map must not stay readable on a shared phone for the next visitor.
 */
export async function clearOfflineData(store) {
    if (!store) return;
    for (const key of [KEY_MAP, KEY_WEATHER, KEY_META]) {
        try { await store.del(key); } catch { /* best effort */ }
    }
}
