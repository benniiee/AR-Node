import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, TUNNEL_HEADERS } from './mobileApi.js';
import { cachedWeather, weatherFromSnapshot } from './weatherCost.js';
import {
    API_WEATHER_PATH, STATIC_WEATHER_PATH, fetchWithFallback, isWeatherObject, loadSavedWeather,
} from './offlineData.js';
import { offlineStore } from './offlineStore.js';

/**
 * Campus weather state for the 2D screen.
 *
 * Polls OUR OWN server every 5 minutes — never the forecast provider. It
 * reads the static file storage/app/public/data/weather.json (rewritten by
 * Laravel every 10 minutes; the web server just hands over the file) and
 * falls back to /api/weather when that file is not reachable.
 *
 * Failure is silent by design. While offline the hook uses the last good
 * state in memory, or the one the automatic sync saved (useAutoSync), with its age
 * (status 'cached'), for up to the 60-minute staleness limit, then falls back
 * to a no-weather state (rain_mode off, multiplier 1), which leaves routing
 * completely normal. Weather may never block navigation.
 */

// Kept in sync with the PHP state shape (App\Services\WeatherService).
export const NO_WEATHER = Object.freeze({
    status: 'unavailable',
    rain_probability: null,
    probability_source: null,
    raining_now: false,
    rain_mode: false,
    rain_multiplier: 1,
    heat_mode: false,
    rain_penalty: null,
    probability_horizon_minutes: null,
    condition: 'unknown',
    weather_code: null,
    temperature_c: null,
    attribution: null,
});

const POLL_MS = 5 * 60 * 1000;

export function useWeather() {
    const [weather, setWeather] = useState(NO_WEATHER);
    const lastGood = useRef(null);

    useEffect(() => {
        let alive = true;

        const load = async () => {
            try {
                const { data, via } = await fetchWithFallback({
                    base: API_BASE,
                    headers: TUNNEL_HEADERS,
                    staticPath: STATIC_WEATHER_PATH,
                    apiPath: API_WEATHER_PATH,
                    validateStatic: isWeatherObject,
                });
                // /api/weather judges its own age; a static file cannot, so the phone does.
                const state = via === 'static' ? weatherFromSnapshot(data) : data;
                if (state.status === 'ok') lastGood.current = state;
                if (alive) setWeather({ ...NO_WEATHER, ...state });
            } catch {
                // Offline: the last good state (memory, else the saved download) with its age,
                // until it is too old to trust; then "no weather" rather than a stale claim.
                let saved = lastGood.current;
                if (!saved) saved = await loadSavedWeather(offlineStore).catch(() => null);
                const cached = cachedWeather(saved);
                if (alive) setWeather(cached ? { ...NO_WEATHER, ...cached } : NO_WEATHER);
            }
        };

        load();
        const timer = window.setInterval(load, POLL_MS);

        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, []);

    // A fresh state the server sent back (a rain report's reply): shown now, not at the next poll.
    const apply = useCallback((state) => {
        if (!isWeatherObject(state)) return;
        if (state.status === 'ok') lastGood.current = state;
        setWeather({ ...NO_WEATHER, ...state });
    }, []);

    return [weather, apply];
}
