/**
 * Weather-aware routing rules, shared by the 2D screen and the phone's router
 * (src/pathfinding.js). Routes are computed only on the phone.
 */

/**
 * Cost multiplier for walking an edge between two nodes of the given path
 * types. Only the literal value 'outside' counts as exposed.
 *
 * | Edge                | Factor                   |
 * |---------------------|--------------------------|
 * | outside -> outside  | multiplier               |
 * | outside -> inside   | 1 + (multiplier - 1) / 2 |
 * | inside -> inside    | 1                        |
 * | multiplier <= 1     | always 1                 |
 *
 * @param {string|null} typeA path_type of one endpoint
 * @param {string|null} typeB path_type of the other endpoint
 * @param {number} multiplier rain penalty from the weather state (1 = dry)
 * @returns {number}
 */
export function edgeRainFactor(typeA, typeB, multiplier) {
    const m = Number(multiplier);
    // Invalid or absent weather is always a no-op: weather may never break
    // routing, so anything unparseable degrades to "dry".
    if (!Number.isFinite(m) || m <= 1) return 1;

    const exposedA = typeA === 'outside';
    const exposedB = typeB === 'outside';

    if (exposedA && exposedB) return m;
    if (exposedA || exposedB) return 1 + (m - 1) / 2; // entrance: half the penalty
    return 1;
}

/** The three statuses a node can show on the map. */
export const NODE_STATUS = {
    /** Routable, normal conditions. */
    WHITE: 'white',
    /** Warning: rain is likely soon, so this exposed path may get wet. */
    YELLOW: 'yellow',
    /** Closed: it is raining on this exposed path, or heat mode is on. Not routable. */
    RED: 'red',
};

/**
 * Heat mode right now. The server turns it on from the heat index NOW (heat_mode). A predicted
 * hour above the limit (heat_forecast) closes paths only once that hour has begun, until the next
 * update replaces it: a prediction never closes paths ahead of time. Old weather never does.
 */
export function heatModeActive(weather, nowMs = Date.now()) {
    if (!weather || weather.status === 'stale' || weather.status === 'unavailable') return false;
    if (weather.heat_mode) return true;
    const limit = Number(weather.heat_mode_c) || 40;
    return (weather.heat_forecast || []).some((f) => Date.parse(f.at) <= nowMs && Number(f.heat_index_c) > limit);
}

/** Exposed paths are closed right now: it is raining, or heat mode is on (heatModeActive). */
export function exposedPathsClosed(weather, nowMs = Date.now()) {
    return Boolean(weather?.raining_now || heatModeActive(weather, nowMs));
}

/**
 * Status of ONE node for the CURRENT weather. Exposure comes from the node's
 * existing path_type — no per-node column, because one forecast point covers
 * the whole campus. Sheltered paths are never affected by rain.
 *
 * @param {string|null} pathType node.path_type ('outside' | 'inside' | legacy 'covered')
 * @param {{ raining_now?: boolean, rain_mode?: boolean, heat_mode?: boolean }|null} weather
 * @returns {'white'|'yellow'|'red'}
 */
export function nodeRainStatus(pathType, weather) {
    if (pathType !== 'outside') return NODE_STATUS.WHITE;
    if (!weather) return NODE_STATUS.WHITE;
    if (exposedPathsClosed(weather)) return NODE_STATUS.RED;
    if (weather.rain_mode) return NODE_STATUS.YELLOW;

    return NODE_STATUS.WHITE;
}

/**
 * Chance of rain (0-100, rounded) for display, or null when unknown. With the campus
 * model active this is the model's 20-minute probability; otherwise the provider's.
 */
export function rainRiskOf(weather) {
    const raw = weather?.rain_probability;
    // Number(null) is 0, which would show an unknown chance as "0%".
    if (raw === null || raw === undefined || raw === '') return null;

    const p = Number(raw);

    return Number.isFinite(p) ? Math.round(Math.min(100, Math.max(0, p))) : null;
}

/**
 * What the rain does to routing right now, in one word (WeatherService::rainEffect on the server):
 *   'closed'  — it is raining now: outdoor paths are closed;
 *   'covered' — outdoor paths cost more (the multiplier is above 1), so covered ones win when close;
 *   'watch'   — rain mode is on as a warning only: routes are unchanged;
 *   'off'     — dry: normal routing.
 */
export function rainEffectOf(weather) {
    if (!weather) return 'off';
    if (weather.raining_now) return 'closed';
    if (rainMultiplierOf(weather) > 1) return 'covered';
    return weather.rain_mode ? 'watch' : 'off';
}

/** Short and long words for each rain effect, the same on the phone and in the admin console. */
export const RAIN_EFFECTS = {
    closed: { short: 'Outdoor paths closed', detail: 'It is raining now: routes use covered paths only.' },
    covered: { short: 'Covered paths preferred', detail: 'Rain is likely: outdoor paths cost more, so a covered way wins when it is close.' },
    watch: { short: 'Watch only', detail: 'Rain is possible soon. A warning only: routes are unchanged.' },
    off: { short: 'Off', detail: 'Dry: normal routing.' },
};

/**
 * Plain-words status for a node's popup. Sheltered paths are never affected; exposed
 * ones are Open, Rain possible (cost goes up, still routable) or Closed (raining now, or
 * heat mode).
 */
export function nodeRainLabel(pathType, weather) {
    if (pathType !== 'outside') return 'Open · sheltered';

    const status = nodeRainStatus(pathType, weather);
    if (status === NODE_STATUS.RED) {
        if (weather?.raining_now) return 'Closed: raining now';
        const limit = Number(weather?.heat_mode_c);

        return `Closed: extreme heat${Number.isFinite(limit) ? ` (above ${limit} °C)` : ''}`;
    }
    if (status === NODE_STATUS.YELLOW) {
        const risk = rainRiskOf(weather);
        const minutes = Number(weather?.probability_horizon_minutes);
        const when = Number.isFinite(minutes) && minutes > 0 ? ` in the next ${minutes} min` : '';

        const effect = rainEffectOf(weather) === 'covered' ? 'covered paths preferred' : 'still routed as usual';

        return risk === null ? `Rain possible · ${effect}` : `Rain possible · ${risk}%${when} · ${effect}`;
    }

    return 'Open';
}

/** Same staleness limit as the server (config weather.max_stale_minutes). */
export const WEATHER_MAX_STALE_MINUTES = 60;

/**
 * Offline behaviour: when /api/weather cannot be reached, keep using the last good state with
 * its age instead of snapping to "no weather". Past the staleness limit this returns null and
 * the caller falls back to the no-weather state (routing unpenalised). Never throws.
 *
 * @param {object|null} lastGood last successful /api/weather response
 * @param {number} nowMs current time in ms
 * @param {number} maxStaleMinutes
 * @returns {object|null} the cached state with status 'cached' and age_minutes, or null
 */
export function cachedWeather(lastGood, nowMs = Date.now(), maxStaleMinutes = WEATHER_MAX_STALE_MINUTES) {
    if (!lastGood || lastGood.status === 'unavailable' || lastGood.status === 'stale') return null;

    const fetched = Date.parse(lastGood.fetched_at);
    if (!Number.isFinite(fetched)) return null;

    const age = Math.max(0, Math.round((nowMs - fetched) / 60000));
    if (age > maxStaleMinutes) return null;

    return { ...lastGood, status: 'cached', age_minutes: age };
}

/** A static weather file up to this old still counts as live; older is shown as "N min ago". */
export const WEATHER_FRESH_MINUTES = 30;

/**
 * Judge a static weather.json by its age. The server refreshes it every 10 minutes but a file
 * cannot mark itself stale the way /api/weather does, so the phone does it: fresh (<= 30 min) keeps
 * the server's status, 30-60 min becomes 'cached' (chip shows the age, penalty still applies), and
 * past the 60-minute limit it turns into a harmless 'stale' state that never changes routing
 * (no penalty, no closed paths).
 */
export function weatherFromSnapshot(
    snapshot,
    nowMs = Date.now(),
    freshMinutes = WEATHER_FRESH_MINUTES,
    maxStaleMinutes = WEATHER_MAX_STALE_MINUTES,
) {
    const harmless = { raining_now: false, rain_mode: false, rain_multiplier: 1, heat_mode: false };
    const fetched = Date.parse(snapshot?.fetched_at);

    if (!Number.isFinite(fetched)) return { ...snapshot, ...harmless, status: 'unavailable', age_minutes: null };

    const age = Math.max(0, Math.round((nowMs - fetched) / 60000));
    if (age > maxStaleMinutes) return { ...snapshot, ...harmless, status: 'stale', age_minutes: age };

    return { ...snapshot, status: age > freshMinutes ? 'cached' : snapshot.status, age_minutes: age };
}

/** Red paths are not routable: no edge may touch them while it is raining or in heat mode. */
export function isRoutable(pathType, weather) {
    return nodeRainStatus(pathType, weather) !== NODE_STATUS.RED;
}

/**
 * The rain penalty the CLIENT should route with. The server owns the real
 * configured value (sent in /api/weather); anything unparseable
 * degrades to 1 so weather can never break routing.
 */
export function rainMultiplierOf(weather) {
    const m = Number(weather?.rain_multiplier);

    return Number.isFinite(m) && m > 1 ? m : 1;
}

/** Shown when every way to a destination is currently closed by rain or heat, saying which. */
export function noRouteMessage({ rain = false, heat = false } = {}) {
    // Same pattern as a closed bridge: what is closed, then why.
    if (rain) return 'Open-air paths are closed: it is raining.';
    if (heat) return 'Open-air paths are closed: it is too hot right now.';
    return 'No route there right now.';
}
