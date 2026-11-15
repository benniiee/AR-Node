import assert from 'node:assert/strict';
import {
    fetchWithFallback, loadMapData, downloadOfflineData, loadSavedWeather, readOfflineMeta,
    isValidMap, isWeatherObject, describeAge,
    STATIC_MAP_PATH, STATIC_WEATHER_PATH, API_MAP_PATH, API_WEATHER_PATH,
} from './offlineData.js';
import { weatherFromSnapshot } from './weatherCost.js';

const node = (id, extra = {}) => ({ id, name: `N${id}`, latitude: 6.9131, longitude: 122.0621, path_type: 'outside', ...extra });
const MAP = { version: 7, nodes: [node(1), node(2)], links: [{ id: 1 }], borders: [] };
const NOW = Date.parse('2026-11-04T10:00:00+08:00');
const WEATHER = (minutesAgo, extra = {}) => ({
    status: 'ok', rain_mode: true, raining_now: false, rain_multiplier: 1.4, rain_probability: 30,
    fetched_at: new Date(NOW - minutesAgo * 60000).toISOString(), ...extra,
});

/** fake fetch: routes maps a path to {body}, {status}, or {throws}; records every call */
function fakeFetch(routes) {
    const calls = [];
    const impl = async (url) => {
        calls.push(url);
        const hit = Object.entries(routes).find(([path]) => url.endsWith(path))?.[1];
        if (!hit || hit.throws) throw new TypeError(hit?.throws || 'Failed to fetch');
        return { ok: (hit.status ?? 200) < 400, status: hit.status ?? 200, json: async () => hit.body };
    };
    impl.calls = calls;

    return impl;
}
function fakeStore(initial = {}) {
    const data = new Map(Object.entries(initial));

    return { data, get: async (k) => data.get(k), set: async (k, v) => { data.set(k, structuredClone(v)); }, del: async (k) => { data.delete(k); } };
}

// ---- validation
assert.equal(isValidMap(MAP), true);
assert.equal(isValidMap({ nodes: [] }), false);
assert.equal(isValidMap({ nodes: [{ id: 1, latitude: null, longitude: 2 }] }), false);
assert.equal(isValidMap({ nodes: [{ latitude: 1, longitude: 2 }] }), false);
assert.equal(isValidMap(null), false);
assert.equal(isWeatherObject(WEATHER(5)), true);
assert.equal(isWeatherObject({ status: 'unavailable', rain_mode: false }), true);
assert.equal(isWeatherObject([]), false);
assert.equal(isWeatherObject('x'), false);

// ---- static first, API second
let f = fakeFetch({ [STATIC_MAP_PATH]: { body: MAP }, [API_MAP_PATH]: { body: { nodes: [] } } });
let r = await fetchWithFallback({ fetchImpl: f, staticPath: STATIC_MAP_PATH, apiPath: API_MAP_PATH, validateStatic: isValidMap });
assert.equal(r.via, 'static'); assert.deepEqual(f.calls, [STATIC_MAP_PATH]);       // the API is never touched

f = fakeFetch({ [STATIC_MAP_PATH]: { status: 404 }, [API_MAP_PATH]: { body: MAP } });
r = await fetchWithFallback({ fetchImpl: f, staticPath: STATIC_MAP_PATH, apiPath: API_MAP_PATH, validateStatic: isValidMap });
assert.equal(r.via, 'api');

f = fakeFetch({ [STATIC_MAP_PATH]: { body: { nodes: [] } }, [API_MAP_PATH]: { body: MAP } });   // empty static file is not trusted
r = await fetchWithFallback({ fetchImpl: f, staticPath: STATIC_MAP_PATH, apiPath: API_MAP_PATH, validateStatic: isValidMap });
assert.equal(r.via, 'api');

f = fakeFetch({});
await assert.rejects(
    fetchWithFallback({ fetchImpl: f, base: 'https://x', staticPath: STATIC_MAP_PATH, apiPath: API_MAP_PATH }),
    /Cannot reach https:\/\/x\/api\/map-data/,                                       // the API error is the one reported
);
f = fakeFetch({ [STATIC_MAP_PATH]: { throws: 'down' }, [API_MAP_PATH]: { status: 500 } });
await assert.rejects(fetchWithFallback({ fetchImpl: f, staticPath: STATIC_MAP_PATH, apiPath: API_MAP_PATH }), /HTTP 500/);

// ---- loadMapData: network, else the saved copy
let store = fakeStore({ map: { data: MAP, savedAt: NOW - 3600e3 } });
let m = await loadMapData({ fetchImpl: fakeFetch({ [STATIC_MAP_PATH]: { body: MAP } }), store });
assert.equal(m.source, 'network');
m = await loadMapData({ fetchImpl: fakeFetch({}), store });
assert.equal(m.source, 'offline'); assert.equal(m.savedAt, NOW - 3600e3); assert.equal(m.data.nodes.length, 2);
await assert.rejects(loadMapData({ fetchImpl: fakeFetch({}), store: fakeStore() }), /Cannot reach/);   // nothing saved: the real error
await assert.rejects(loadMapData({ fetchImpl: fakeFetch({}), store: fakeStore({ map: { data: { nodes: [] }, savedAt: 1 } }) }), /Cannot reach/);
await assert.rejects(loadMapData({ fetchImpl: fakeFetch({}), store: null }), /Cannot reach/);        // no storage at all

// ---- the download button
store = fakeStore();
let d = await downloadOfflineData({
    fetchImpl: fakeFetch({ [STATIC_MAP_PATH]: { body: MAP }, [STATIC_WEATHER_PATH]: { body: WEATHER(12) } }), store, now: () => NOW,
});
assert.equal(d.nodes, 2); assert.equal(d.links, 1); assert.equal(d.version, 7); assert.equal(d.weatherSaved, true);
assert.equal(d.weatherAgeMinutes, 12); assert.equal(d.savedAt, NOW); assert.equal(d.map.nodes.length, 2);
assert.equal((await store.get('map')).savedAt, NOW);
assert.equal((await loadSavedWeather(store)).rain_probability, 30);
assert.deepEqual(await readOfflineMeta(store), { savedAt: NOW, nodes: 2, links: 1, version: 7, weatherSaved: true });

// weather unavailable: the map is still saved
store = fakeStore();
d = await downloadOfflineData({ fetchImpl: fakeFetch({ [STATIC_MAP_PATH]: { body: MAP } }), store, now: () => NOW });
assert.equal(d.weatherSaved, false); assert.equal(d.weatherAgeMinutes, null);
assert.equal(await loadSavedWeather(store), null);

// static files missing: the API answers instead
store = fakeStore();
d = await downloadOfflineData({
    fetchImpl: fakeFetch({ [API_MAP_PATH]: { body: MAP }, [API_WEATHER_PATH]: { body: WEATHER(2) } }), store, now: () => NOW,
});
assert.equal(d.nodes, 2); assert.equal(d.weatherSaved, true);

// a bad answer never overwrites a good saved copy
store = fakeStore({ map: { data: MAP, savedAt: 111 }, meta: { savedAt: 111, nodes: 2 } });
await assert.rejects(
    downloadOfflineData({ fetchImpl: fakeFetch({ [STATIC_MAP_PATH]: { body: { nodes: [] } }, [API_MAP_PATH]: { body: { nodes: [] } } }), store, now: () => NOW }),
    /empty or incomplete/,
);
assert.equal((await store.get('map')).savedAt, 111);                                // old copy intact
await assert.rejects(downloadOfflineData({ fetchImpl: fakeFetch({}), store, now: () => NOW }), /Could not download the map/);
assert.equal((await store.get('map')).savedAt, 111);
await assert.rejects(downloadOfflineData({ fetchImpl: fakeFetch({ [STATIC_MAP_PATH]: { body: MAP } }), store: null }), /cannot store offline data/);

// ---- helpers
assert.equal(await readOfflineMeta(fakeStore()), null);
assert.equal(await readOfflineMeta(null), null);
assert.equal(describeAge(NOW - 20e3, NOW), 'just now');
assert.equal(describeAge(NOW - 5 * 60e3, NOW), '5 min ago');
assert.equal(describeAge(NOW - 3 * 3600e3, NOW), '3 h ago');
assert.equal(describeAge(NOW - 72 * 3600e3, NOW), '3 days ago');
assert.equal(describeAge(NOW + 5000, NOW), 'just now');

// ---- a static weather.json is judged by its age (the file cannot expire itself)
let w = weatherFromSnapshot(WEATHER(10), NOW);
assert.equal(w.status, 'ok'); assert.equal(w.age_minutes, 10); assert.equal(w.rain_multiplier, 1.4);
w = weatherFromSnapshot(WEATHER(30), NOW); assert.equal(w.status, 'ok');
w = weatherFromSnapshot(WEATHER(45), NOW);
assert.equal(w.status, 'cached'); assert.equal(w.rain_multiplier, 1.4); assert.equal(w.rain_mode, true);   // still trusted, age shown
w = weatherFromSnapshot(WEATHER(60), NOW); assert.equal(w.status, 'cached');
w = weatherFromSnapshot(WEATHER(61, { raining_now: true }), NOW);
assert.equal(w.status, 'stale'); assert.equal(w.rain_mode, false); assert.equal(w.raining_now, false); assert.equal(w.rain_multiplier, 1);
w = weatherFromSnapshot(WEATHER(5, { fetched_at: 'nope' }), NOW);
assert.equal(w.status, 'unavailable'); assert.equal(w.rain_multiplier, 1); assert.equal(w.age_minutes, null);
w = weatherFromSnapshot({ ...WEATHER(5), status: 'forced' }, NOW); assert.equal(w.status, 'forced');

console.log('offlineData tests passed');

// mapSignature: same map re-downloaded = same signature; any change = a new one.
{
    const { mapSignature } = await import('./offlineData.js');
    const a = { hash: 'h1', version: 10, nodes: [{}, {}], links: [], borders: [], buildings: [{}], pathways: [] };
    assert.equal(mapSignature(a), mapSignature(JSON.parse(JSON.stringify(a))));
    assert.notEqual(mapSignature(a), mapSignature({ ...a, hash: 'h2' }));
    assert.notEqual(mapSignature(a), mapSignature({ ...a, hash: undefined, nodes: [{}] }));
    assert.equal(mapSignature(null), '');
}
