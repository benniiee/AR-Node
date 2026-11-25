// Shade-aware routing: on a hot day, prefer exposed paths that lie in a
// building's shadow.
//
// Shadows come from the same sun position and building prisms the map draws
// (sunShadow.js), at the current time. An exposed (outside) walking edge costs
// more the more of it is in full sun:
//
//   factor = 1 + (penalty - 1) * sunnyShare
//
// `penalty` grows with the heat index: 1 (no effect) up to SHADE_FROM_C,
// rising to SHADE_MAX_PENALTY at SHADE_FULL_C, or with the UV index (sunburn)
// from UV_SHADE_FROM to UV_SHADE_FULL, whichever is stronger. Heat mode (above 40 °C) closes
// exposed paths altogether (weatherCost.js), so this is the step before it.
// Sheltered paths and the reported distance never change: only the cost the
// router minimises does.
import { sunPosition, shadowRings, buildingHeightM } from './sunShadow.js';
import { objectShadowRings } from './campusObjects.js';

/** Heat index (°C) where shade starts to matter: PAGASA "Caution". */
export const SHADE_FROM_C = 27;
/** Heat index (°C) where a sunny path costs the full penalty. */
export const SHADE_FULL_C = 38;
/** A path in full sun costs this many times its length at SHADE_FULL_C and above. */
export const SHADE_MAX_PENALTY = 1.6;

/** UV index where shade starts to matter for sunburn: WHO "high". */
export const UV_SHADE_FROM = 6;
/** UV index where a sunny path costs the full penalty: WHO "extreme". */
export const UV_SHADE_FULL = 11;

const ramp = (value, from, full) => (Number.isFinite(value) && value > from ? Math.min(1, (value - from) / (full - from)) : 0);

/**
 * Penalty for a fully sunny exposed edge (1 = none): the stronger of the heat index and the UV index
 * (sunburn). A clear, mild morning can still have a high UV; a hot, overcast afternoon a low one.
 */
export function shadePenaltyFor(heatIndexC, uvIndex = null) {
    const strength = Math.max(
        ramp(Number(heatIndexC), SHADE_FROM_C, SHADE_FULL_C),
        uvIndex === null || uvIndex === undefined ? 0 : ramp(Number(uvIndex), UV_SHADE_FROM, UV_SHADE_FULL),
    );
    return strength > 0 ? Math.round((1 + (SHADE_MAX_PENALTY - 1) * strength) * 1000) / 1000 : 1;
}

function inRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const yi = ring[i].lat;
        const xi = ring[i].lng;
        const yj = ring[j].lat;
        const xj = ring[j].lng;
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/**
 * Where the shadows of the buildings, trees and sheds are right now. Returns null when the sun is down
 * or too low to cast one (then there is no sun to avoid).
 *
 * @returns {null | { isShaded(lat:number, lng:number): boolean, sun: object }}
 */
export function shadeMap(buildings, date, lat, lng, objects = []) {
    const sun = sunPosition(date, lat, lng);
    const rings = [];
    const shapes = [];
    for (const b of buildings || []) {
        if (!b || b.status === 'planned' || !Array.isArray(b.polygon) || b.polygon.length < 3) continue;
        shapes.push(...shadowRings(b.polygon, buildingHeightM(b), sun));
    }
    // Trees and sheds: their crowns and roofs, moved away from the sun.
    shapes.push(...objectShadowRings(objects, sun));
    for (const ring of shapes) {
        let s = Infinity; let n = -Infinity; let w = Infinity; let e = -Infinity;
        for (const p of ring) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); }
        rings.push({ ring, s, n, w, e });
    }
    if (rings.length === 0 && sun.altitudeDeg < 2) return null;
    return {
        sun,
        isShaded(la, ln) {
            for (const r of rings) {
                if (la < r.s || la > r.n || ln < r.w || ln > r.e) continue;
                if (inRing(la, ln, r.ring)) return true;
            }
            return false;
        },
    };
}

/** Share of an edge (0..1) in full sun, from five evenly spaced samples. */
export function sunnyShare(a, b, shade) {
    if (!shade) return 0;
    let sunny = 0;
    const samples = 5;
    for (let k = 0; k < samples; k += 1) {
        const t = k / (samples - 1);
        const la = Number(a.latitude) + (Number(b.latitude) - Number(a.latitude)) * t;
        const ln = Number(a.longitude) + (Number(b.longitude) - Number(a.longitude)) * t;
        if (!shade.isShaded(la, ln)) sunny += 1;
    }
    return sunny / samples;
}

/**
 * Extra cost factor for walking edge a-b. Only exposed-to-exposed edges count:
 * an edge touching a sheltered node is mostly under cover already.
 */
export function edgeShadeFactor(a, b, shade, penalty) {
    if (!shade || !(penalty > 1)) return 1;
    if (a?.path_type !== 'outside' || b?.path_type !== 'outside') return 1;
    return 1 + (penalty - 1) * sunnyShare(a, b, shade);
}
