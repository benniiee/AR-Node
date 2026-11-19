/**
 * Heat index ("feels like" from heat and humidity) and PAGASA categories, for the chip.
 *
 * Twin of app/Services/HeatIndex.php and ml/heat_common.py: the US National Weather
 * Service procedure (Rothfusz regression plus the low/high humidity adjustments),
 * https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml.
 * src/heatIndex.test.mjs checks it against tests/fixtures/heat_index_grid.json, the same
 * grid PHPUnit uses. Plain JS, no imports.
 */

/** PAGASA lower bounds in deg C (config/weather.php heat_categories), ascending. */
export const HEAT_CATEGORIES = [
    { key: 'caution', min: 27, label: 'Caution' },
    { key: 'extreme_caution', min: 33, label: 'Extreme caution' },
    { key: 'danger', min: 42, label: 'Danger' },
    { key: 'extreme_danger', min: 52, label: 'Extreme danger' },
];

/** NWS heat index in deg F from air temperature (deg F) and relative humidity (%). */
export function heatIndexF(t, rh) {
    const simple = 0.5 * (t + 61 + (t - 68) * 1.2 + rh * 0.094);
    if (simple < 80) return simple;
    let hi = -42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh
        - 0.00683783 * t * t - 0.05481717 * rh * rh + 0.00122874 * t * t * rh
        + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
    if (rh < 13 && t >= 80 && t <= 112) {
        hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17);
    } else if (rh > 85 && t >= 80 && t <= 87) {
        hi += ((rh - 85) / 10) * ((87 - t) / 5);
    }
    return hi;
}

/** NWS heat index in deg C from air temperature (deg C) and relative humidity (%). */
export function heatIndexC(tC, rh) {
    return (heatIndexF(tC * 9 / 5 + 32, rh) - 32) * 5 / 9;
}

/** PAGASA category key ('none' below Caution). */
export function heatCategory(hiC) {
    let key = 'none';
    for (const c of HEAT_CATEGORIES) {
        if (hiC >= c.min) key = c.key;
    }
    return key;
}

/** Human label for a category key; null for 'none' or unknown keys. */
export function heatLabel(key) {
    return HEAT_CATEGORIES.find((c) => c.key === key)?.label ?? null;
}

/** Extreme caution or worse: worth a warning tone and a plain reminder. */
export function isHeatWarning(key) {
    return key === 'extreme_caution' || key === 'danger' || key === 'extreme_danger';
}

/**
 * "2 pm" from the server's campus-time ISO string ("2026-04-10T14:00:00+08:00").
 * Read from the string itself, so a phone set to another time zone still shows campus time.
 */
export function campusHourLabel(iso) {
    const m = /T(\d{2}):/.exec(String(iso || ''));
    if (!m) return null;
    const h = Number(m[1]);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${h < 12 ? 'am' : 'pm'}`;
}

/**
 * Heat summary for the weather chip, or null when the state has no heat index.
 *
 * @returns {{ now: number, key: string, label: string|null, warning: boolean,
 *            short: string, outlook: string|null, peak: object|null, hotRisk: string|null }}
 */
export function heatSummary(weather) {
    const now = Number(weather?.heat_index_c);
    if (weather?.heat_index_c === null || weather?.heat_index_c === undefined || !Number.isFinite(now)) return null;
    const key = weather.heat_category || heatCategory(now);
    const label = heatLabel(key);
    const items = Array.isArray(weather.heat_forecast)
        ? weather.heat_forecast.filter((i) => Number.isFinite(Number(i?.heat_index_c)))
        : [];
    const peak = items.reduce((best, i) => (!best || Number(i.heat_index_c) > Number(best.heat_index_c) ? i : best), null);
    const rounded = Math.round(now);
    const short = `Feels like ${rounded}°C${label ? `, ${label}` : ''}`;

    let outlook = null;
    if (peak) {
        const peakC = Math.round(Number(peak.heat_index_c));
        const when = campusHourLabel(peak.at);
        const last = items[items.length - 1];
        if (peakC >= rounded + 1 && when) {
            outlook = `${peakC}°C expected at ${when}`;
        } else if (Math.round(Number(last.heat_index_c)) <= rounded - 1 && campusHourLabel(last.at)) {
            outlook = `easing to ${Math.round(Number(last.heat_index_c))}°C by ${campusHourLabel(last.at)}`;
        } else {
            outlook = 'about the same for the next 3 hours';
        }
    }

    // The heat model's hot-hour chance (hot_alert) can flag an hour its own estimate keeps under the limit:
    // a warning only, paths still close on the heat index (weatherCost.js heatModeActive).
    const limit = Number(weather.heat_mode_c) || 40;
    const flagged = items.find((i) => i.hot_alert === true && Number(i.heat_index_c) <= limit && campusHourLabel(i.at));
    const hotRisk = flagged ? `could reach ${Math.round(limit)}°C by ${campusHourLabel(flagged.at)}` : null;

    return { now, key, label, warning: isHeatWarning(key) || Boolean(hotRisk), short, outlook, peak, hotRisk };
}
