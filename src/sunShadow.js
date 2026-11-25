// Sun position and building shadows, computed on the phone (no network, no
// library): the same simplified astronomical formulas SunCalc uses, accurate
// to well under a degree, which is far finer than a map shadow needs.
//
// Pure functions only (no Leaflet / DOM), unit-tested in sunShadow.test.mjs.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

/** Storey height used to turn a floor count into metres. */
export const STOREY_M = 3.2;
/** Below this sun height shadows would stretch across the whole campus. */
export const MIN_SUN_ALTITUDE_DEG = 2;
/**
 * Longest shadow drawn, as a multiple of the building's height. The sun
 * reaches 30 degrees early in the morning and late in the afternoon; below
 * that a true shadow (h / tan(alt)) grows to 3-6 x the height and swamps the
 * map. Capping at the 30-degree length keeps midday shadows physically exact
 * and long shadows readable.
 */
export const MAX_SHADOW_FACTOR = 1.75;

const toDays = (date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;

/**
 * Where the sun is in the sky.
 * @returns {{ altitudeDeg: number, azimuthDeg: number }} altitude above the
 *   horizon (negative = below it) and compass azimuth (0 = north, 90 = east).
 */
export function sunPosition(date, lat, lng) {
    const d = toDays(date);
    const M = RAD * (357.5291 + 0.98560028 * d);
    const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + RAD * 102.9372 + Math.PI;
    const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
    const ra = Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L));
    const phi = RAD * lat;
    const H = RAD * (280.16 + 360.9856235 * d) + RAD * lng - ra;

    const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    // Measured from south towards west; turned into a north-based compass bearing.
    const fromSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    const azimuthDeg = ((fromSouth / RAD) + 180 + 360) % 360;

    return { altitudeDeg: altitude / RAD, azimuthDeg };
}

/**
 * Building height in metres: the measured `height_m` when someone entered it,
 * otherwise an estimate from the floor count (ground floor included).
 */
export function buildingHeightM(building) {
    const measured = Number(building?.height_m);
    if (Number.isFinite(measured) && measured > 0) return measured;
    const floors = Math.max(1, Number(building?.floors) || 1);
    return floors * STOREY_M;
}

// ── 2.5D extrusion ──────────────────────────────────────────────────
// The map look of OSM / bboxfinder: the roof is drawn lifted towards the top
// of the screen (north, the map never rotates) by a share of the height, and
// the walls between footprint and roof that face the viewer are filled in.

/** Share of the real height used for the on-screen lift (oblique view). */
export const EXTRUDE_FACTOR = 0.45;

/** North offset (metres) of the drawn roof above the footprint. */
export function roofLiftM(heightM) {
    return Math.max(0, heightM) * EXTRUDE_FACTOR;
}

/**
 * Walls that face the viewer. The viewer looks towards `viewDeg` (0 = north,
 * the 2D map's fixed view; the tilted 3D map passes the walking heading), so
 * the roof is lifted that way and the walls whose outward normal points back
 * at the viewer are the ones seen. Each carries its outward normal as a
 * compass bearing, for sun shading.
 *
 * @returns {Array<{ a: {lat:number,lng:number}, b: {lat:number,lng:number}, normalDeg: number }>}
 */
export function visibleWalls(polygon, viewDeg = 0) {
    if (!Array.isArray(polygon) || polygon.length < 3) return [];
    const ring = ccw(polygon);
    const k = Math.cos(ring[0].lat * RAD);
    const walls = [];
    for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const east = (b.lng - a.lng) * k;
        const north = b.lat - a.lat;
        // Outward normal of a counter-clockwise ring edge: (north, -east).
        const nE = north;
        const nN = -east;
        // Faces away from the viewer (or edge-on): not seen.
        if (nE * Math.sin(viewDeg * RAD) + nN * Math.cos(viewDeg * RAD) >= -1e-12) continue;
        const normalDeg = ((Math.atan2(nE, nN) / RAD) + 360) % 360;
        walls.push({ a, b, normalDeg });
    }
    return walls;
}

/**
 * How lit a wall is (0 = in its own shade, 1 = facing the sun square on).
 * Night and a sun below the horizon give the ambient minimum.
 */
export function wallLight(normalDeg, sun) {
    const AMBIENT = 0.18;
    if (!sun || sun.altitudeDeg <= 0) return AMBIENT;
    const facing = Math.cos((normalDeg - sun.azimuthDeg) * RAD); // -1..1
    // A high sun grazes vertical walls: less direct light.
    const steep = Math.cos(Math.min(85, sun.altitudeDeg) * RAD);
    return AMBIENT + (1 - AMBIENT) * Math.max(0, facing) * (0.35 + 0.65 * steep);
}

/**
 * Ground offset (east, north metres) of a roof corner's shadow, or null when
 * the sun is down / too low to cast a sensible one.
 */
export function shadowOffsetM(heightM, sun) {
    if (!sun || sun.altitudeDeg < MIN_SUN_ALTITUDE_DEG) return null;
    const length = Math.min(MAX_SHADOW_FACTOR * heightM, heightM / Math.tan(sun.altitudeDeg * RAD));
    // Shadows fall directly away from the sun.
    const away = (sun.azimuthDeg + 180) * RAD;
    return { east: length * Math.sin(away), north: length * Math.cos(away), length };
}

const signedArea = (ring) => {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        a += ring[j].lng * ring[i].lat - ring[i].lng * ring[j].lat;
    }
    return a / 2;
};
const ccw = (ring) => (signedArea(ring) < 0 ? [...ring].reverse() : ring);

/**
 * The shadow of a prism (footprint extruded to `heightM`) as rings whose union
 * is the exact shadow: the footprint, the roof's shadow, and one quad per wall.
 * All rings are counter-clockwise, so drawn as ONE path with the non-zero fill
 * rule they paint a single even shade with no darker overlaps.
 *
 * @param {Array<{lat:number,lng:number}>} polygon
 * @returns {Array<Array<{lat:number,lng:number}>>} empty when there is no shadow
 */
export function shadowRings(polygon, heightM, sun) {
    if (!Array.isArray(polygon) || polygon.length < 3) return [];
    const off = shadowOffsetM(heightM, sun);
    if (!off) return [];

    const lat0 = polygon[0].lat;
    const dLat = off.north / 111320;
    const dLng = off.east / (111320 * Math.cos(lat0 * RAD));
    const shift = (p) => ({ lat: p.lat + dLat, lng: p.lng + dLng });

    const rings = [ccw(polygon), ccw(polygon.map(shift))];
    for (let i = 0; i < polygon.length; i += 1) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const quad = [a, b, shift(b), shift(a)];
        // A wall parallel to the light casts a zero-width quad; skip it.
        if (Math.abs(signedArea(quad)) > 1e-14) rings.push(ccw(quad));
    }
    return rings;
}

/**
 * Penumbra: a real shadow is darkest and sharpest where it meets the wall and
 * fades and blurs towards its tip (the sun is a disc, not a point, and sky
 * light fills the far end in). Drawn as stacked copies of the shadow at
 * decreasing lengths, each `opacity` strong: near the wall every copy
 * overlaps (darkest), at the tip only the full-length one remains.
 *
 * Per-copy opacity is solved so the stack reaches `baseOpacity` at the wall:
 * 1 - (1 - a)^n = base  =>  a = 1 - (1 - base)^(1/n).
 *
 * @returns {Array<{ fraction: number, opacity: number }>} longest first
 */
// Steps bunched towards the tip: the body of the shadow is one even shade and
// only its end softens (a penumbra is an edge effect, not a gradient across the
// whole shadow), and small steps keep the stack from showing as stripes.
export const PENUMBRA_FRACTIONS = [1, 0.96, 0.92, 0.87, 0.81, 0.74, 0.62];

export function penumbraLayers(baseOpacity, fractions = PENUMBRA_FRACTIONS) {
    if (!(baseOpacity > 0)) return [];
    const a = 1 - (1 - Math.min(0.95, baseOpacity)) ** (1 / fractions.length);
    return fractions.map((fraction) => ({ fraction, opacity: a }));
}

/**
 * Shadow colour: shade is lit by blue sky, so it reads cool, not grey. At a low
 * sun (golden hour) the sky light is weaker and warmer: the tint softens.
 */
export function shadowColor(sun) {
    if (!sun) return '#1c2333';
    return sun.altitudeDeg < 12 ? '#2a2630' : '#1c2333';
}

/**
 * Shadow strength (0..1) for a given sun height: soft at dawn and dusk,
 * fullest around midday, gone at night.
 */
export function shadowOpacity(sun) {
    if (!sun || sun.altitudeDeg < MIN_SUN_ALTITUDE_DEG) return 0;
    const t = Math.min(1, (sun.altitudeDeg - MIN_SUN_ALTITUDE_DEG) / 18);
    return 0.16 + 0.16 * t;
}

// ── Roof detail ─────────────────────────────────────────────────────

/** Width of the parapet rim around a flat roof, metres. */
export const PARAPET_W = 0.45;
/** Height of that rim above the roof surface, metres (casts the roof shadow). */
export const PARAPET_H = 0.7;

/**
 * The polygon moved `meters` inwards on every side (mitred corners), or null
 * when the shape is too thin to keep a roof inside its rim. Works in local
 * metres, so the inset is the same on every side whatever the latitude.
 */
export function insetPolygon(points, meters) {
    if (!Array.isArray(points) || points.length < 3) return null;
    const ring = ccw(points);
    const lat0 = ring[0].lat;
    const lng0 = ring[0].lng;
    const kx = 111320 * Math.cos(lat0 * RAD);
    const ky = 111320;
    const P = ring.map((p) => [(p.lng - lng0) * kx, (p.lat - lat0) * ky]);
    const n = P.length;

    // Each edge shifted inwards (left normal of a counter-clockwise ring).
    const lines = [];
    for (let i = 0; i < n; i += 1) {
        const a = P[i];
        const b = P[(i + 1) % n];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-6) return null;
        const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        lines.push({ p: [a[0] - d[1] * meters, a[1] + d[0] * meters], d });
    }
    const out = [];
    for (let i = 0; i < n; i += 1) {
        const L1 = lines[(i - 1 + n) % n];
        const L2 = lines[i];
        const cross = L1.d[0] * L2.d[1] - L1.d[1] * L2.d[0];
        let v;
        if (Math.abs(cross) < 1e-9) {
            v = L2.p; // straight continuation
        } else {
            const t = ((L2.p[0] - L1.p[0]) * L2.d[1] - (L2.p[1] - L1.p[1]) * L2.d[0]) / cross;
            v = [L1.p[0] + L1.d[0] * t, L1.p[1] + L1.d[1] * t];
            // A very sharp corner would spike; keep the mitre short.
            if (Math.hypot(v[0] - P[i][0], v[1] - P[i][1]) > meters * 4) v = L2.p;
        }
        out.push({ lat: lat0 + v[1] / ky, lng: lng0 + v[0] / kx });
    }
    // Too thin: the inset ring turned inside out.
    return signedArea(out) > 0 && Math.abs(signedArea(out)) < Math.abs(signedArea(ring)) ? out : null;
}

/**
 * Strips of roof in the shade of the parapet: along every rim edge that faces
 * the sun, the rim's shadow (PARAPET_H / tan(altitude), capped) falls inwards
 * across the roof. Returns quads in lat/lng; empty when the sun is down.
 */
export function parapetShadowQuads(innerRoof, sun) {
    if (!Array.isArray(innerRoof) || innerRoof.length < 3 || !sun || sun.altitudeDeg < MIN_SUN_ALTITUDE_DEG) return [];
    // Same cap rule as building shadows (MAX_SHADOW_FACTOR x height).
    const len = Math.min(PARAPET_H * MAX_SHADOW_FACTOR, PARAPET_H / Math.tan(sun.altitudeDeg * RAD));
    const away = (sun.azimuthDeg + 180) * RAD;
    const lat0 = innerRoof[0].lat;
    const dLat = (len * Math.cos(away)) / 111320;
    const dLng = (len * Math.sin(away)) / (111320 * Math.cos(lat0 * RAD));
    const quads = [];
    for (const w of edgesWithNormals(innerRoof)) {
        // The rim beyond this roof edge faces inwards with the opposite normal:
        // it blocks the sun when the roof edge's outward normal faces the sun.
        if (Math.cos((w.normalDeg - sun.azimuthDeg) * RAD) <= 0.05) continue;
        const strip = ccw([w.a, w.b, { lat: w.b.lat + dLat, lng: w.b.lng + dLng }, { lat: w.a.lat + dLat, lng: w.a.lng + dLng }]);
        // The strip is slanted along the light, so its ends overhang the
        // neighbouring rims; the roof edges cut it (L/U shapes included).
        const clipped = clipToConvex(innerRoof, strip);
        if (clipped.length >= 3) quads.push(clipped);
    }
    return quads;
}

/**
 * Part of `subject` (any simple polygon, concave allowed) inside the convex,
 * counter-clockwise polygon `clip` (Sutherland-Hodgman). Local metres, so the
 * inside test is not skewed by longitude scaling.
 */
export function clipToConvex(subject, clip) {
    if (!Array.isArray(subject) || subject.length < 3 || !Array.isArray(clip) || clip.length < 3) return [];
    const lat0 = clip[0].lat;
    const lng0 = clip[0].lng;
    const kx = 111320 * Math.cos(lat0 * RAD);
    const toXY = (p) => [(p.lng - lng0) * kx, (p.lat - lat0) * 111320];
    const C = ccw(clip).map(toXY);
    let out = subject.map(toXY);
    for (let i = 0; i < C.length && out.length; i += 1) {
        const c1 = C[i];
        const c2 = C[(i + 1) % C.length];
        const side = (p) => (c2[0] - c1[0]) * (p[1] - c1[1]) - (c2[1] - c1[1]) * (p[0] - c1[0]);
        const cut = (p, q) => {
            const sp = side(p);
            const t = sp / (sp - side(q));
            return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        };
        const input = out;
        out = [];
        for (let j = 0; j < input.length; j += 1) {
            const cur = input[j];
            const prev = input[(j - 1 + input.length) % input.length];
            const curIn = side(cur) >= -1e-9;
            const prevIn = side(prev) >= -1e-9;
            if (curIn) {
                if (!prevIn) out.push(cut(prev, cur));
                out.push(cur);
            } else if (prevIn) {
                out.push(cut(prev, cur));
            }
        }
    }
    return out.map(([x, y]) => ({ lat: lat0 + y / 111320, lng: lng0 + x / kx }));
}

/** Every edge of a ring with its outward normal as a compass bearing. */
export function edgesWithNormals(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return [];
    const ring = ccw(polygon);
    const k = Math.cos(ring[0].lat * RAD);
    return ring.map((a, i) => {
        const b = ring[(i + 1) % ring.length];
        const east = (b.lng - a.lng) * k;
        const north = b.lat - a.lat;
        return { a, b, normalDeg: ((Math.atan2(north, -east) / RAD) + 360) % 360 };
    });
}

/**
 * Brightness of a flat roof (0..1): a horizontal surface catches light in
 * proportion to the sun's height (Lambert), plus sky light.
 */
export function roofLight(sun) {
    if (!sun || sun.altitudeDeg <= 0) return 0.35;
    return 0.55 + 0.45 * Math.sin(Math.min(90, sun.altitudeDeg) * RAD);
}

const GOLDEN = [245, 158, 94];
const NIGHT = [30, 42, 90];

/**
 * The map's sky tint for the sun's height (degrees above the horizon), laid over the satellite
 * tiles with a multiply blend: none in daylight, a light warm tint from 10 degrees down to sunset,
 * then deepening navy through twilight to full night at -12 degrees (nautical dusk).
 * @returns {{ color: string, opacity: number }}
 */
export function skyTint(altitudeDeg) {
    const alt = Number(altitudeDeg);
    if (!Number.isFinite(alt) || alt >= 10) return { color: '#000000', opacity: 0 };
    const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    if (alt >= 0) return { color: hex(GOLDEN), opacity: 0.18 * (1 - alt / 10) };
    const t = Math.min(1, -alt / 12);
    return { color: hex(GOLDEN.map((g, i) => g + (NIGHT[i] - g) * t)), opacity: 0.18 + (0.6 - 0.18) * t };
}

/**
 * Is the wall stretch a-b (or a tree, bench or shed at a = b) behind a building, as the north-up 2.5D map
 * is looked at (from the south)? True when a building stands straight south of its middle AND close
 * enough that the two overlap on screen: within the building's roof lift (its walls are drawn rising
 * north by that much), plus `reachM` for the thing's own size towards the building (a tree's crown).
 * That building is between it and the viewer, so it is drawn under it. A building further south does
 * not count: they never overlap, and counting it put a tree beside MSA behind MSA because CCS stands
 * further south.
 */
export function wallBehindBuilding(a, b, buildings, reachM = 0) {
    const lat = (+a.lat + +b.lat) / 2;
    const lng = (+a.lng + +b.lng) / 2;
    return (buildings || []).some((bd) => {
        const ring = bd?.status !== 'planned' && Array.isArray(bd?.polygon) ? bd.polygon : [];
        const coverM = roofLiftM(buildingHeightM(bd)) + Math.max(0, reachM) + 1;
        // Where the line running south from the wall's middle crosses the outline, near enough.
        return ring.some((p, i) => {
            const q = ring[(i + 1) % ring.length];
            if ((+p.lng > lng) === (+q.lng > lng)) return false;
            const crossLat = +p.lat + ((lng - +p.lng) / (+q.lng - +p.lng)) * (+q.lat - +p.lat);
            return crossLat < lat && (lat - crossLat) * 111320 <= coverM;
        });
    });
}
