/**
 * The sky over the 2D map: which weather it shows, and a seeded deck of clouds that each
 * have their own shape (no two clouds share a seed, so none of them is the same as the rest).
 * Pure JS, no three.js, so node --test can cover it; src/components/CloudField3D.jsx does the
 * drawing and places each cloud on the map's own bounding box (lat / lng).
 */

import { heatModeActive } from './weatherCost.js';

/**
 * Clouds over the campus box: fifteen to twenty, a scattered cumulus field rather than a few big
 * blobs. The deck never grows or shrinks: a cloud that drifts off the west edge re-enters over the
 * east edge, so this many are always in the box (or just outside it, on their way in).
 */
export const CLOUD_COUNT = 18;

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
 * One cloud's body: overlapping spheres all sitting on y = 0 so the underside is flat.
 *
 * Six balanced silhouettes are drawn from the seed, so a sky of clouds has rich variety
 * without thin or stringy streaks:
 *
 * - `dome`    heaped round cumulus with a soft central crown
 * - `broad`   wide, full-bodied cumulus plateau spread across both x and y
 * - `clover`  radial rosette of 3–4 rounded lobes around a central core
 * - `cluster` 2–3 touching mounds offset in both x and y, bridged into one mass
 * - `tower`   sturdy wide base with a tall, multi-tiered rising crown
 * - `puff`    compact, plump cluster of rounded lobes in a tight diamond/triangle
 *
 * Coordinates are cloud-local: x right, y up from the flat base, z toward the viewer.
 * The renderer squashes y (the map's 2.5D north-lift projection) and scales the whole
 * shape to the cloud's real width in metres.
 *
 * @param {number} seed
 * @returns {{ lobes: Array<{ x: number, y: number, z: number, r: number }>, span: number,
 *             height: number, aspect: number, profile: 'dome'|'broad'|'clover'|'cluster'|'tower'|'puff' }}
 */
export function cloudShape(seed) {
    const rand = seededRandom(seed);
    const lobes = [];
    // A puff's centre; never below its own radius, so the underside stays flat on the map.
    const put = (x, r, z = 0, centreY = r) => {
        lobes.push({ x, y: Math.max(r, centreY) + (rand() - 0.5) * 0.03, z, r });
    };
    // A radius with a little life in it, so no two lobes in a cloud are twins.
    const vary = (v, amount = 0.14) => v * (1 - amount + rand() * amount * 2);

    // Seen from above - looking down on a cumulus field - clouds are rounded, wide, and
    // balanced across both x and y, heaped in the middle rather than thin or stretched.
    const roll = rand();
    const profile = roll < 0.25 ? 'dome'
        : roll < 0.45 ? 'broad'
            : roll < 0.65 ? 'clover'
                : roll < 0.80 ? 'cluster'
                    : roll < 0.90 ? 'tower'
                        : 'puff';

    if (profile === 'dome') {
        // Heaped round cumulus, wider at the base and smoothly mounded in the middle.
        const base = vary(0.35);
        put(-0.46, base * 0.92, 0.02 + rand() * 0.08);
        put(0, base, 0);
        put(0.46, base * 0.9, 0.03 + rand() * 0.08);
        put(-0.26, base * 0.78, 0.14, base * 0.9);
        put(0.24, base * 0.74, 0.12, base * 1.05);
        put((rand() - 0.5) * 0.24, base * 0.56, 0.2, base * 1.7);
        put(-0.14, base * 0.68, 0.08, base * 0.75);
        put(0.32, base * 0.64, 0.08, base * 0.88);
        put(-0.34, base * 0.58, 0.16, base * 1.1);
        if (rand() > 0.35) {
            put((rand() - 0.5) * 0.42, base * 0.36, 0.24, base * 2.05);
            put((rand() - 0.5) * 0.28, base * 0.44, 0.18, base * 1.45);
        }
    } else if (profile === 'broad') {
        // Wide, balanced cumulus plateau: full across both x and y, never thin or stringy.
        const base = vary(0.32);
        put(-0.68, base * 0.86, 0.04 + rand() * 0.06, base * 0.86);
        put(-0.24, base * 0.98, 0.02, base * 0.98);
        put(0.24, base * 0.96, 0.02, base * 0.96);
        put(0.68, base * 0.84, 0.04 + rand() * 0.06, base * 0.84);
        // Upper-mid tier filling out the y breadth so it reads wide and balanced.
        put(-0.42, base * 0.74, 0.12, base * 1.15);
        put(0.0, base * 0.8, 0.16, base * 1.25);
        put(0.42, base * 0.72, 0.12, base * 1.12);
        // Soft low crown puffs.
        put(-0.16 + (rand() - 0.5) * 0.14, base * 0.54, 0.2, base * 1.35);
        put(0.18 + (rand() - 0.5) * 0.14, base * 0.52, 0.18, base * 1.3);
    } else if (profile === 'clover') {
        // Radial rosette: 3 or 4 wide lobes around a central core for an organic, balanced footprint.
        const core = vary(0.36);
        const petals = 3 + (rand() > 0.45 ? 1 : 0);
        const offsetAngle = rand() * Math.PI * 2;
        put((rand() - 0.5) * 0.08, core, 0.14, core * 1.35);
        put((rand() - 0.5) * 0.14, core * 0.72, 0.22, core * 1.75);
        for (let i = 0; i < petals; i += 1) {
            const angle = offsetAngle + (i * Math.PI * 2) / petals + (rand() - 0.5) * 0.35;
            const dist = core * (1.05 + rand() * 0.35);
            const r = core * (0.74 + rand() * 0.22);
            const px = Math.cos(angle) * dist * 1.15;
            const py = core * 1.25 + Math.sin(angle) * dist * 0.55;
            put(px, r, 0.04 + rand() * 0.12, py);
        }
        // Bridge lobes at the base so the underside stays full and cohesive.
        put(-0.32, core * 0.78, 0.03, core * 0.78);
        put(0.32, core * 0.76, 0.03, core * 0.76);
    } else if (profile === 'tower') {
        // Sturdy wide base with a rising, multi-tiered crown.
        const base = vary(0.34);
        put(-0.44, base * 0.9, 0.02 + rand() * 0.06);
        put(0, base, 0);
        put(0.44, base * 0.88, 0.02 + rand() * 0.06);
        put(-0.24, base * 0.78, 0.14, base * 1.0);
        put(0.22, base * 0.76, 0.12, base * 1.15);
        put((rand() - 0.5) * 0.28, base * 0.56, 0.2, base * 2.35);
        put(-0.1, base * 0.62, 0.1, base * 1.35);
        put(0.3, base * 0.56, 0.16, base * 1.6);
        if (rand() > 0.35) {
            put((rand() - 0.5) * 0.34, base * 0.38, 0.26, base * 3.25);
            put((rand() - 0.5) * 0.22, base * 0.46, 0.22, base * 2.15);
        }
    } else if (profile === 'cluster') {
        // Two or three rounded mounds offset in both x and y, bridged into one cohesive mass.
        const groups = 2 + (rand() > 0.45 ? 1 : 0);
        const base = vary(0.28, 0.16);
        for (let g = 0; g < groups; g += 1) {
            const cx = -0.48 + (g * 0.96) / Math.max(1, groups - 1) + (rand() - 0.5) * 0.14;
            const cy = base * (0.95 + (g % 2 === 0 ? 0.1 : 0.65) + rand() * 0.35);
            const r = base * (0.85 + rand() * 0.28);
            put(cx, r, 0.04 + rand() * 0.14, cy);
            put(cx + (rand() - 0.5) * 0.22, r * 0.78, 0.12 + rand() * 0.1, cy + r * 0.55);
        }
        // Central connecting lobes so the mounds read as one wide cloud rather than separate blobs.
        put(-0.18, base * 0.92, 0.06, base * 0.92);
        put(0.18, base * 0.9, 0.06, base * 0.9);
        put(0, base * 0.72, 0.18, base * 1.65);
    } else {
        // Compact, plump puff: rounded diamond/triangle rather than a flat line.
        const base = vary(0.32, 0.16);
        put(-0.3, base * 0.86, 0.04, base * 0.86);
        put(0.3, base * 0.84, 0.04, base * 0.84);
        put(0, base * 0.96, 0.08, base * 1.1);
        put(-0.14 + (rand() - 0.5) * 0.1, base * 0.72, 0.16, base * 1.45);
        put(0.16 + (rand() - 0.5) * 0.1, base * 0.66, 0.14, base * 1.35);
    }

    // Rest the whole body on the map: the lowest puff's underside is the cloud's ground line, so a
    // cluster drawn a little higher than the rest still touches the map instead of hovering.
    const lift = Math.min(...lobes.map((lobe) => lobe.y - lobe.r));
    if (lift) {
        for (const lobe of lobes) {
            lobe.y -= lift;
        }
    }

    let span = 0;
    let height = 0;
    for (const lobe of lobes) {
        span = Math.max(span, Math.abs(lobe.x) + lobe.r);
        height = Math.max(height, lobe.y + lobe.r);
    }
    const full = span * 2;
    return { lobes, span: full, height, aspect: height / (full || 1), profile };
}

/**
 * The deck of clouds a map gets: each at its own depth, with its own real-world width in metres
 * and its own wind speed, and a shape seed that no other cloud in the deck shares.
 *
 * These are only the traits: where each cloud sits is the map's business, because the
 * position is a latitude/longitude inside the campus box, so the cloud stays over that piece
 * of campus when the map is panned or zoomed - and its width is in metres, so a zoom step
 * makes it grow exactly as much as the buildings under it.
 *
 * A cloud drifts straight west at its own speed (a light breeze, not a gale) and keeps its
 * latitude: no bobbing, no diagonal drift.
 *
 * @param {number} seed any 32-bit seed
 * @returns {Array<{ seed: number, depth: number, widthM: number, speedMps: number }>}
 */
export function cloudDeck(seed = 1) {
    const rand = seededRandom(seed);
    const clouds = [];
    for (let i = 0; i < CLOUD_COUNT; i += 1) {
        clouds.push({
            // A different seed per cloud, guaranteed distinct: the whole point of the deck.
            seed: (Math.floor(rand() * 4294967295) ^ ((seed + i * 2654435761) >>> 0)) >>> 0 || i + 1,
            depth: 0.2 + rand() * 0.8,
            // Width in real metres, like the buildings' heights: the campus is about 550 m across, so
            // clouds span a balanced mix from 26-44 m puffs to 46-76 m wide cumulus bodies.
            widthM: rand() < 0.45 ? 26 + rand() * 18 : 46 + rand() * 30,
            // A light breeze: a cloud takes a couple of minutes to cross the campus.
            speedMps: 1.6 + rand() * 2.4,
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
