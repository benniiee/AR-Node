// How a building looks outside (Building Studio): its roof, walls, front and entrance, shared by the
// Studio, the 2.5D map and the 3D views. Stored as buildings.appearance (BuildingController validates
// the same lists); null = the plain look every building had before.

export const ROOF_STYLES = [
    { value: 'flat', label: 'Flat' },
    { value: 'hip', label: 'Sloped' },
    { value: 'curved', label: 'Curved' },
];

export const FACADES = [
    { value: 'windows', label: 'Windows' },
    { value: 'arches', label: 'Arches' },
    { value: 'pillars', label: 'Pillars' },
];

/** Colours seen on campus (WMSU Campus B photos): roofs, walls and the accents on them. */
export const ROOF_COLORS = [
    { value: '#7a2430', label: 'Maroon' },
    { value: '#b3262e', label: 'Red' },
    { value: '#8b4a32', label: 'Rusty' },
    { value: '#6f757c', label: 'Grey' },
    { value: '#2f5f8a', label: 'Blue' },
    { value: '#d6d2c8', label: 'Concrete' },
];
export const WALL_COLORS = [
    { value: '#f1eee7', label: 'White' },
    { value: '#ecdfb8', label: 'Cream' },
    { value: '#dcc58f', label: 'Yellow' },
    { value: '#d8c3a5', label: 'Beige' },
    { value: '#c9c6bf', label: 'Grey' },
    { value: '#e7a483', label: 'Salmon' },
];
export const ACCENT_COLORS = [
    { value: '#7a2430', label: 'Maroon' },
    { value: '#e3957a', label: 'Salmon' },
    { value: '#6b4834', label: 'Brown' },
    { value: '#2f6fb3', label: 'Blue' },
    { value: '#1f2937', label: 'Charcoal' },
];

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** One bay of a building's front (a window or an arch), metres along the wall. */
export const BAY_M = 3.5;
/** Same as Building::SIGN_MAX. */
export const SIGN_MAX = 60;

/** What the map draws when a colour is not chosen. */
export const DEFAULT_WALL = '#d8d3c8';
export const DEFAULT_FLAT_ROOF = '#d6d2c8';
export const DEFAULT_SLOPED_ROOF = '#7a2430';
export const DEFAULT_CANOPY = '#7a2430';

/**
 * A building's look, complete and safe to draw: unknown styles fall back to the defaults, bad colours
 * to null (the map's own colour), the sign is cut to SIGN_MAX.
 *
 * @returns {{ roof: {style: string, color: string|null}, walls: {color: string|null, accent: string|null},
 *   facade: string, entrance: {canopy: boolean, color: string, sign: string, ramp: boolean} }}
 */
export function appearanceOf(building) {
    const a = building?.appearance || {};
    const pick = (v, list, fallback) => (list.some((o) => o.value === v) ? v : fallback);
    const hex = (v, fallback = null) => (typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : fallback);
    return {
        roof: { style: pick(a.roof?.style, ROOF_STYLES, 'flat'), color: hex(a.roof?.color) },
        walls: { color: hex(a.walls?.color), accent: hex(a.walls?.accent) },
        facade: pick(a.facade, FACADES, 'windows'),
        entrance: {
            canopy: Boolean(a.entrance?.canopy),
            color: hex(a.entrance?.color, DEFAULT_CANOPY),
            sign: typeof a.entrance?.sign === 'string' ? a.entrance.sign.slice(0, SIGN_MAX) : '',
            ramp: Boolean(a.entrance?.ramp),
        },
    };
}

/** The colour the roof is drawn in. */
export const roofColorOf = (look) => look.roof.color || (look.roof.style === 'flat' ? DEFAULT_FLAT_ROOF : DEFAULT_SLOPED_ROOF);

/** Ready-made looks, from buildings on campus: one tap in the Studio. */
export const STYLE_PRESETS = [
    {
        name: 'Maroon bands & pillars', hint: 'like CCS',
        appearance: { roof: { style: 'curved', color: '#7a2430' }, walls: { color: '#f1eee7', accent: '#7a2430' }, facade: 'pillars', entrance: { canopy: true, color: '#7a2430', sign: '', ramp: true } },
    },
    {
        name: 'Cream with a maroon roof', hint: 'like the College of Medicine',
        appearance: { roof: { style: 'hip', color: '#7a2430' }, walls: { color: '#ecdfb8', accent: '#7a2430' }, facade: 'arches', entrance: { canopy: true, color: '#7a2430', sign: '', ramp: true } },
    },
    {
        name: 'Cream arches, rusty roof', hint: 'like CAIS',
        appearance: { roof: { style: 'hip', color: '#8b4a32' }, walls: { color: '#dcc58f', accent: null }, facade: 'arches', entrance: { canopy: false, color: '#7a2430', sign: '', ramp: false } },
    },
    {
        name: 'White with a red roof', hint: 'like the new building by CCS',
        appearance: { roof: { style: 'hip', color: '#b3262e' }, walls: { color: '#f1eee7', accent: '#2f6fb3' }, facade: 'windows', entrance: { canopy: false, color: '#7a2430', sign: '', ramp: false } },
    },
];

// ── Roof shapes ─────────────────────────────────────────────────────
// Rings in metres ({x: east, y: north}) at heights above the top of the walls. A sloped roof is the
// outline moved inwards to a ridge; a curved one climbs to it along a quarter circle. Works for any
// outline (L-shapes included): each ring is the outline moved in by the same distance on every side.

const area2 = (ring) => ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return s + p.x * q.y - q.x * p.y;
}, 0);
const perimeter = (ring) => ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return s + Math.hypot(q.x - p.x, q.y - p.y);
}, 0);

function segmentsCross(a, b, c, d) {
    const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = side(c, d, a);
    const d2 = side(c, d, b);
    const d3 = side(a, b, c);
    const d4 = side(a, b, d);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** True when no two non-neighbouring sides of the ring cross. */
export function isSimpleRing(ring) {
    const n = ring.length;
    for (let i = 0; i < n; i += 1) {
        for (let j = i + 2; j < n; j += 1) {
            if (i === 0 && j === n - 1) continue;
            if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return false;
        }
    }
    return true;
}

/**
 * The counter-clockwise ring moved `d` metres inwards on every side (negative: outwards), the corners
 * where the moved sides meet. Null when it turned inside out or crossed itself (moved too far).
 */
export function offsetRing(ring, d) {
    const n = ring.length;
    const lines = [];
    for (let i = 0; i < n; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-6) return null;
        const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
        // Inwards of a counter-clockwise ring is the left of each side.
        lines.push({ p: { x: a.x - dir.y * d, y: a.y + dir.x * d }, dir });
    }
    const out = [];
    for (let i = 0; i < n; i += 1) {
        const L1 = lines[(i - 1 + n) % n];
        const L2 = lines[i];
        const cross = L1.dir.x * L2.dir.y - L1.dir.y * L2.dir.x;
        if (Math.abs(cross) < 1e-9) { out.push(L2.p); continue; }
        const t = ((L2.p.x - L1.p.x) * L2.dir.y - (L2.p.y - L1.p.y) * L2.dir.x) / cross;
        out.push({ x: L1.p.x + L1.dir.x * t, y: L1.p.y + L1.dir.y * t });
    }
    const before = area2(ring);
    const after = area2(out);
    if (!(after > 0) || (d > 0 ? after >= before : after <= before) || !isSimpleRing(out)) return null;
    // Moved past its middle, a side flips round (a square turned through itself still looks valid otherwise).
    for (let i = 0; i < n; i += 1) {
        const p = out[i];
        const q = out[(i + 1) % n];
        if ((q.x - p.x) * lines[i].dir.x + (q.y - p.y) * lines[i].dir.y < -1e-9) return null;
    }
    return out;
}

/** How far the outline can move in before it collapses (to within ~2 %). */
function maxInset(ring) {
    let lo = 0;
    let hi = (2.2 * Math.abs(area2(ring)) / 2) / Math.max(1e-6, perimeter(ring));
    for (let k = 0; k < 14; k += 1) {
        const mid = (lo + hi) / 2;
        if (offsetRing(ring, mid)) lo = mid; else hi = mid;
    }
    return lo;
}

const EAVE_M = 0.5;
const HIP_SLOPE = 0.5;
const CURVE_RISE = 0.7;
const MAX_RISE_M = 6;

/**
 * The roof of an outline (metres, either winding) in `style`: rings from the eave up to the top, each
 * with its height `h` above the top of the walls. The eave reaches EAVE_M past the walls on a sloped
 * or curved roof. Faces join ring k to ring k+1 side by side (same corner order); the last ring is the
 * flat top. A flat roof (or an outline too odd to slope) is the outline itself.
 *
 * @returns {{ rings: Array<{ pts: Array<{x:number,y:number}>, h: number }>, rise: number }}
 */
export function roofLayers(outline, style = 'flat') {
    const ring = area2(outline) < 0 ? [...outline].reverse() : outline;
    const flat = { rings: [{ pts: ring, h: 0 }], rise: 0 };
    if (style === 'flat' || ring.length < 3) return flat;
    const depth = maxInset(ring) * 0.94;
    if (!(depth > 0.5)) return flat;
    const eave = offsetRing(ring, -EAVE_M) || ring;
    if (style === 'curved') {
        const rise = Math.min(MAX_RISE_M, depth * CURVE_RISE);
        const rings = [{ pts: eave, h: -0.15 }];
        for (const t of [0.2, 0.45, 0.7, 1]) {
            const pts = offsetRing(ring, depth * t);
            if (!pts) break;
            // A quarter circle: steep at the eave, level at the top.
            rings.push({ pts, h: rise * Math.sqrt(1 - (1 - t) ** 2) });
        }
        return rings.length > 1 ? { rings, rise } : flat;
    }
    const top = offsetRing(ring, depth);
    if (!top) return flat;
    const rise = Math.min(MAX_RISE_M, depth * HIP_SLOPE);
    return { rings: [{ pts: eave, h: -0.15 }, { pts: top, h: rise }], rise };
}
