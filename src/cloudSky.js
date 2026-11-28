/**
 * The sky over the 2D map: which weather it shows, and a seeded deck of clouds that each
 * have their own shape (no two clouds share a seed, so none of them is the same as the rest).
 * Pure JS, no three.js, so node --test can cover it; src/components/CloudField3D.jsx does the
 * drawing and places each cloud on the map's own bounding box (lat / lng).
 */

import { heatModeActive } from './weatherCost.js';

/** Clouds per screen: enough to feel alive, few enough to leave the map readable. */
export const CLOUD_COUNT = 6;

/**
 * What the sky shows for a weather state.
 *
 * - `rain`     raining now: dark clouds with rain pouring from their base
 * - `heat`     heat mode is on: the sun burns through (routing's own rule, weatherCost.js)
 * - `overcast` rain likely soon: grey, heavier clouds, still dry
 * - `clear`    everything else, including unknown or stale weather (never invent a storm)
 *
 * @param {{ status?: string, raining_now?: boolean, rain_mode?: boolean, heat_mode?: boolean,
 *           heat_mode_c?: number, heat_forecast?: Array<{ at: string, heat_index_c: number }> }|null} weather
 * @param {number} nowMs
 * @returns {'rain'|'heat'|'overcast'|'clear'}
 */
export function cloudSkyMode(weather, nowMs = Date.now()) {
    if (!weather || weather.status === 'unavailable' || weather.status === 'stale') {
        return 'clear';
    }
    if (weather.raining_now) {
        return 'rain';
    }
    if (heatModeActive(weather, nowMs)) {
        return 'heat';
    }
    if (weather.rain_mode) {
        return 'overcast';
    }
    return 'clear';
}

/**
 * Deterministic 32-bit random generator (mulberry32): the same seed always draws the same
 * cloud, and neighbouring seeds draw different ones.
 *
 * @param {number} seed
 * @returns {() => number} a number in [0, 1)
 */
export function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * One cloud's body: overlapping spheres of varying radius (the reference art's puffy
 * cumulus), all sitting on y = 0 so the underside is flat, with a lumpy top and the
 * occasional detached bubble.
 *
 * Coordinates are cloud-local: x right, y up from the flat base, z toward the viewer.
 * The renderer squashes y (the map's 2.5D north-lift projection) and scales the whole
 * shape to the cloud's real width in metres.
 *
 * @param {number} seed
 * @returns {{ lobes: Array<{ x: number, y: number, z: number, r: number }>, span: number, height: number }}
 */
export function cloudShape(seed) {
    const rand = seededRandom(seed);
    const lobes = [];
    const put = (x, r, z = 0, y = r) => {
        lobes.push({ x, y: y + (rand() - 0.5) * 0.04, z, r });
    };

    // The dome: the tallest puff. Its offset decides the cloud's lean, so two clouds
    // with the same seed cannot mirror each other by accident.
    const mainR = 0.46 + rand() * 0.16;
    put((rand() - 0.5) * 0.22, mainR, 0, mainR * (1 + rand() * 0.1));

    // Shoulders either side, shrinking outward: the classic cumulus silhouette.
    const sides = 2 + Math.floor(rand() * 2);
    for (const side of [-1, 1]) {
        let x = mainR * 0.5;
        for (let i = 0; i < sides; i += 1) {
            const r = Math.max(mainR * 0.36, mainR * (0.82 - i * 0.15 - rand() * 0.06));
            x += r * 0.68;
            put(side * x, r);
            x += r * 0.22;
        }
    }

    // A front row, so the outline is lumpy rather than one clean dome.
    for (let i = 0; i < 2; i += 1) {
        const r = mainR * (0.38 + rand() * 0.18);
        put((rand() - 0.5) * mainR * 1.5, r, 0.3 + rand() * 0.25, r * 0.98);
    }

    // The detached little bubble the reference art sometimes carries above the top.
    if (rand() > 0.45) {
        put((rand() - 0.5) * mainR * 2, mainR * (0.22 + rand() * 0.12), 0.15, mainR * (1.65 + rand() * 0.4));
    }

    let span = 0;
    let height = 0;
    for (const lobe of lobes) {
        span = Math.max(span, Math.abs(lobe.x) + lobe.r);
        height = Math.max(height, lobe.y + lobe.r);
    }
    return { lobes, span: span * 2, height };
}

/**
 * The deck of clouds a map gets: each at its own depth, with its own real-world width and
 * its own wind speed, and a shape seed that no other cloud in the deck shares.
 *
 * These are only the traits: where each cloud sits is the map's business, because the
 * position is a latitude/longitude inside the map's (padded) bounding box, so the cloud
 * stays over that piece of campus when the map is panned or zoomed.
 *
 * @param {number} seed any 32-bit seed
 * @returns {Array<{ seed: number, depth: number, widthFrac: number, speedMps: number,
 *                   phase: number, bob: number }>}
 */
export function cloudDeck(seed = 1) {
    const rand = seededRandom(seed);
    const clouds = [];
    for (let i = 0; i < CLOUD_COUNT; i += 1) {
        clouds.push({
            // A different seed per cloud, guaranteed distinct: the whole point of the deck.
            seed: (Math.floor(rand() * 4294967295) ^ ((seed + i * 2654435761) >>> 0)) >>> 0 || i + 1,
            depth: 0.2 + rand() * 0.8,
            // Width as a fraction of the map's width: the campus view is only a couple of
            // hundred metres across, where a literal cloud would fill the whole screen.
            widthFrac: 0.15 + rand() * 0.15,
            // Drifting west at a believable light-wind speed.
            speedMps: 4 + rand() * 9,
            phase: rand() * Math.PI * 2,
            bob: 0.05 + rand() * 0.07,
        });
    }
    // A deck must never draw the same cloud twice, whatever the seeds collided on.
    clouds.forEach((cloud, index) => {
        while (clouds.slice(0, index).some((other) => other.seed === cloud.seed)) {
            cloud.seed = (cloud.seed + 7919) >>> 0;
        }
    });
    return clouds;
}
