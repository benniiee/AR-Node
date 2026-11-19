// Staircase geometry shared by routing, the 2D admin map, the admin editor's
// 3D preview, the AR view and the mobile route card.
//
// A staircase is no longer "one straight ramp at an angle". It is a chain of
// FLIGHTS joined by flat LANDINGS, and it has a DIRECTION (yaw):
//
//   straight   one flight                      ^
//   L-shaped   up, 90° turn at a landing, up   |_>
//   U-shaped   up, 180° turn at a landing, up  switchback
//
// Everything is described walking UP from the lower-floor node ("bottom"):
//   yaw_deg    compass bearing the FIRST flight heads (0 = north, 90 = east)
//   flights    [{ angle_deg, turn_deg }] — turn_deg is the turn at the landing
//              BEFORE that flight (clockwise / right = positive); the first
//              flight's turn is always 0
//   landing_m  depth of each flat landing
//
// The plan lives in a local frame: e = east, n = north, u = up, in metres,
// with the bottom of the stairs at the origin. Converters for three.js and
// Leaflet live with their callers (three.js: x = e, y = u, z = -n).
//
// This file must stay dependency-light and use explicit import extensions so
// it can be unit-tested with plain `node --test`.

import { toLocalMeters } from './geo.js';
import { floorOf } from './floors.js';

export const DEFAULT_STAIR_ANGLE = 45;
export const STAIR_ANGLE_MIN = 10;
export const STAIR_ANGLE_MAX = 80;
export const STAIR_WIDTH_M = 1.4;
export const STAIR_RISER_M = 0.18;
export const STAIR_MAX_FLIGHTS = 4;
export const STAIR_LANDING_MIN = 1.0;
export const STAIR_LANDING_MAX = 4.0;
export const STAIR_LANDING_DEFAULT = 1.4;
// Used only when two linked nodes share the same elevation value (the admin
// left it at 0): one floor is assumed to be this high.
export const ASSUMED_FLOOR_HEIGHT_M = 3;
// Gap between the two lanes of a U-shaped stair.
const LANE_GAP_M = 0.1;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function normalizeBearing(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return ((n % 360) + 360) % 360;
}

/** Compass bearing (0 = north, clockwise) of an east/north offset. */
export function bearingOf(east, north) {
    return normalizeBearing(deg(Math.atan2(east, north)));
}

function unit(bearing) {
    const r = rad(bearing);
    return { e: Math.sin(r), n: Math.cos(r) };
}

export function clampStairAngle(value, fallback = DEFAULT_STAIR_ANGLE) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, STAIR_ANGLE_MIN, STAIR_ANGLE_MAX);
}

export function clampLanding(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return STAIR_LANDING_DEFAULT;
    return clamp(n, STAIR_LANDING_MIN, STAIR_LANDING_MAX);
}

function clampTurn(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return clamp(n, -180, 180);
}

/** Always 1..4 clean flights. A missing/empty list is one straight flight. */
export function normalizeFlights(flights, fallbackAngle = DEFAULT_STAIR_ANGLE) {
    const list = Array.isArray(flights) ? flights.slice(0, STAIR_MAX_FLIGHTS) : [];
    if (list.length === 0) return [{ angle_deg: clampStairAngle(fallbackAngle), turn_deg: 0 }];
    return list.map((f, i) => ({
        angle_deg: clampStairAngle(f?.angle_deg, clampStairAngle(fallbackAngle)),
        turn_deg: i === 0 ? 0 : clampTurn(f?.turn_deg),
    }));
}

/** Vertical gap between two nodes, with the one-floor fallback. */
export function stairRise(a, b) {
    let rise = Math.abs((Number(b?.elevation) || 0) - (Number(a?.elevation) || 0));
    if (rise < 0.5) rise = Math.abs(floorOf(b) - floorOf(a)) * ASSUMED_FLOOR_HEIGHT_M;
    return rise;
}

// ── The plan ──────────────────────────────────────────────────────────

/**
 * Lay a staircase out from its bottom.
 *
 * @param {object} o
 * @param {number} o.rise      total height gained, metres
 * @param {number} [o.yawDeg]  compass bearing of the first flight
 * @param {Array}  [o.flights] [{ angle_deg, turn_deg }]
 * @param {number} [o.angleDeg] slope used when `flights` is empty
 * @param {number} [o.landingM]
 * @param {number} [o.widthM]
 * @returns {{
 *   segments: Array, start: {e,n,u}, end: {e,n,u}, rise: number,
 *   totalLength: number, flights: Array, yawDeg: number, landingM: number, widthM: number,
 *   bounds: {minE,maxE,minN,maxN,maxU}
 * }}
 */
export function planStairs({ rise, yawDeg = 0, flights, angleDeg = DEFAULT_STAIR_ANGLE, landingM = STAIR_LANDING_DEFAULT, widthM = STAIR_WIDTH_M } = {}) {
    const fl = normalizeFlights(flights, angleDeg);
    const total = Math.max(0.3, Number(rise) || 0);
    const eachRise = total / fl.length;
    const depth = clampLanding(landingM);
    const lane = widthM + LANE_GAP_M;

    let heading = normalizeBearing(yawDeg);
    let pos = { e: 0, n: 0, u: 0 };
    const segments = [];
    let walked = 0;

    fl.forEach((f, i) => {
        if (i > 0) {
            const t = f.turn_deg;
            const fwd = unit(heading);
            const right = unit(heading + 90);
            const uturn = Math.abs(t) >= 135;
            const sgn = t >= 0 ? 1 : -1;
            const boxW = uturn ? lane + widthM : widthM;
            const centre = {
                e: pos.e + fwd.e * (depth / 2) + (uturn ? right.e * sgn * (lane / 2) : 0),
                n: pos.n + fwd.n * (depth / 2) + (uturn ? right.n * sgn * (lane / 2) : 0),
                u: pos.u,
            };
            const nextHeading = normalizeBearing(heading + t);
            let start;
            if (uturn) {
                start = { e: pos.e + right.e * sgn * lane, n: pos.n + right.n * sgn * lane, u: pos.u };
            } else {
                const next = unit(nextHeading);
                const c = Math.abs(Math.cos(rad(t)));
                const s = Math.abs(Math.sin(rad(t)));
                const reach = Math.min(c > 1e-9 ? (depth / 2) / c : Infinity, s > 1e-9 ? (boxW / 2) / s : Infinity);
                start = { e: centre.e + next.e * reach, n: centre.n + next.n * reach, u: pos.u };
            }
            segments.push({
                kind: 'landing', index: i - 1, center: centre, yawDeg: heading,
                depth, width: boxW, turn_deg: t,
            });
            walked += Math.hypot(centre.e - pos.e, centre.n - pos.n) + Math.hypot(start.e - centre.e, start.n - centre.n);
            pos = start;
            heading = nextHeading;
        }
        const a = rad(f.angle_deg);
        const run = eachRise / Math.tan(a);
        const length = eachRise / Math.sin(a);
        const dir = unit(heading);
        const end = { e: pos.e + dir.e * run, n: pos.n + dir.n * run, u: pos.u + eachRise };
        segments.push({
            kind: 'flight', index: i, from: pos, to: end, yawDeg: heading,
            angle_deg: f.angle_deg, rise: eachRise, run, length,
            steps: Math.max(3, Math.round(eachRise / STAIR_RISER_M)),
        });
        walked += length;
        pos = end;
    });

    const pts = [{ e: 0, n: 0 }];
    for (const s of segments) {
        if (s.kind === 'flight') pts.push(s.to);
        else pts.push(s.center);
    }
    const bounds = {
        minE: Math.min(...pts.map((p) => p.e)) - widthM,
        maxE: Math.max(...pts.map((p) => p.e)) + widthM,
        minN: Math.min(...pts.map((p) => p.n)) - widthM,
        maxN: Math.max(...pts.map((p) => p.n)) + widthM,
        maxU: total,
    };

    return {
        segments, start: { e: 0, n: 0, u: 0 }, end: pos, rise: total,
        totalLength: walked, flights: fl, yawDeg: normalizeBearing(yawDeg),
        landingM: depth, widthM, bounds,
    };
}

/** Walked length of a staircase (independent of its direction). */
export function stairWalkLength(link, rise) {
    return planStairs({
        rise, yawDeg: 0, flights: link?.flights, angleDeg: link?.angle_deg, landingM: link?.landing_m,
    }).totalLength;
}

/**
 * Plan for a saved link between two nodes. The bottom is the lower-floor
 * node. When the link has no stored yaw (older links) the direction falls
 * back to the bearing bottom → top, and then to `fallbackYawDeg`.
 */
export function planFromLink(link, a, b, { fallbackYawDeg = 0 } = {}) {
    const [bottom, top] = floorOf(a) <= floorOf(b) ? [a, b] : [b, a];
    const rise = stairRise(bottom, top);
    const [te, tn] = toLocalMeters(top.latitude, top.longitude, bottom.latitude, bottom.longitude);
    const apart = Math.hypot(te, tn);
    let yaw = Number(link?.yaw_deg);
    let yawSource = 'set';
    if (!Number.isFinite(yaw) || link?.yaw_deg === null || link?.yaw_deg === undefined || link?.yaw_deg === '') {
        if (apart >= 0.3) { yaw = bearingOf(te, tn); yawSource = 'nodes'; } else { yaw = fallbackYawDeg; yawSource = 'default'; }
    }
    const plan = planStairs({
        rise, yawDeg: yaw, flights: link?.flights, angleDeg: link?.angle_deg, landingM: link?.landing_m,
    });
    return {
        plan, bottom, top, yawDeg: normalizeBearing(yaw), yawSource,
        topOffset: { e: te, n: tn },
        endGapM: Math.hypot(plan.end.e - te, plan.end.n - tn),
    };
}

/**
 * The yaw that makes the stairs END on the top node. Null when the two nodes
 * are stacked (no direction to read) or the shape ends where it starts.
 */
export function fitYaw({ rise, topOffset, flights, angleDeg, landingM }) {
    const reach = Math.hypot(topOffset?.e || 0, topOffset?.n || 0);
    if (reach < 0.3) return null;
    const flat = planStairs({ rise, yawDeg: 0, flights, angleDeg, landingM });
    if (Math.hypot(flat.end.e, flat.end.n) < 0.05) return null;
    const yaw = bearingOf(topOffset.e, topOffset.n) - bearingOf(flat.end.e, flat.end.n);
    return Math.round(normalizeBearing(yaw) * 10) / 10;
}

/**
 * The slope (degrees) that makes stairs of this shape reach the top node: their end lies as far
 * from the bottom as the top node does. A gentler slope runs further, so the answer is found by
 * halving the range. Clamped to STAIR_ANGLE_MIN..MAX (the top too far = the gentlest stairs, too
 * close = the steepest); null when the nodes are stacked (nothing to fit). Use with fitYaw().
 */
export function fitAngle({ rise, topOffset, flights, landingM }) {
    const reach = Math.hypot(topOffset?.e || 0, topOffset?.n || 0);
    if (reach < 0.3) return null;
    const span = (deg) => {
        const end = planStairs({ rise, yawDeg: 0, flights: normalizeFlights(flights, deg).map((f) => ({ ...f, angle_deg: deg })), angleDeg: deg, landingM }).end;
        return Math.hypot(end.e, end.n);
    };
    let lo = STAIR_ANGLE_MIN;
    let hi = STAIR_ANGLE_MAX;
    if (span(lo) <= reach) return lo;
    if (span(hi) >= reach) return hi;
    for (let i = 0; i < 40; i += 1) {
        const mid = (lo + hi) / 2;
        if (span(mid) > reach) lo = mid; else hi = mid;
    }
    return Math.round(((lo + hi) / 2) * 10) / 10;
}

// ── Shapes ────────────────────────────────────────────────────────────

export const STAIR_SHAPES = [
    { id: 'straight', label: 'Straight', flights: [{ turn_deg: 0 }] },
    { id: 'straight-landing', label: 'Straight + landing', flights: [{ turn_deg: 0 }, { turn_deg: 0 }] },
    { id: 'l-left', label: 'L, turns left', flights: [{ turn_deg: 0 }, { turn_deg: -90 }] },
    { id: 'l-right', label: 'L, turns right', flights: [{ turn_deg: 0 }, { turn_deg: 90 }] },
    { id: 'u-left', label: 'U, turns left', flights: [{ turn_deg: 0 }, { turn_deg: -180 }] },
    { id: 'u-right', label: 'U, turns right', flights: [{ turn_deg: 0 }, { turn_deg: 180 }] },
];

/** The preset id matching these flights, or 'custom'. Slope is ignored. */
export function shapeIdOf(flights) {
    const turns = normalizeFlights(flights).map((f) => Math.round(f.turn_deg));
    for (const shape of STAIR_SHAPES) {
        const want = shape.flights.map((f) => f.turn_deg);
        if (want.length === turns.length && want.every((t, i) => t === turns[i])) return shape.id;
    }
    return 'custom';
}

/** Flights for a preset, all at one slope. */
export function flightsForShape(shapeId, angleDeg = DEFAULT_STAIR_ANGLE) {
    const shape = STAIR_SHAPES.find((s) => s.id === shapeId) || STAIR_SHAPES[0];
    return shape.flights.map((f) => ({ angle_deg: clampStairAngle(angleDeg), turn_deg: f.turn_deg }));
}

/** Average slope, kept in the legacy `angle_deg` column for old clients. */
export function meanAngle(flights) {
    const fl = normalizeFlights(flights);
    return Math.round((fl.reduce((s, f) => s + f.angle_deg, 0) / fl.length) * 100) / 100;
}

export function shapeLabel(flights) {
    const id = shapeIdOf(flights);
    if (id === 'custom') return `${normalizeFlights(flights).length}-flight stairs`;
    return STAIR_SHAPES.find((s) => s.id === id).label;
}

// ── Words ─────────────────────────────────────────────────────────────

/** Turn as walked → short phrase. */
export function turnPhrase(turn) {
    const t = Number(turn) || 0;
    const a = Math.abs(t);
    const side = t > 0 ? 'right' : 'left';
    if (a < 20) return 'cross the landing straight ahead';
    if (a >= 135) return `make a U-turn to the ${side}`;
    return `turn ${side}`;
}

/** Turns at each landing in the order they are walked in this direction.
 *  Going down mirrors the turns: a right turn on the way up is a left on the way down. */
export function landingTurns(direction, flights) {
    const fl = normalizeFlights(flights);
    const turns = [];
    if (direction === 'down') {
        for (let i = fl.length - 1; i >= 1; i -= 1) turns.push(-fl[i].turn_deg);
    } else {
        for (let i = 1; i < fl.length; i += 1) turns.push(fl[i].turn_deg);
    }
    return turns;
}

/** One sentence for the route card, e.g.
 *  "Take the stairs up, turn right at the landing, then continue to floor 2." */
export function stairInstruction({ direction = 'up', flights, toLabel } = {}) {
    const first = `Take the stairs ${direction === 'down' ? 'down' : 'up'}`;
    const items = landingTurns(direction, flights).map((t, k) => `${turnPhrase(t)} at the ${k === 0 ? '' : 'next '}landing`);
    if (toLabel) items.push(`continue to ${toLabel}`);
    if (items.length === 0) return `${first}.`;
    if (items.length === 1) return `${first}, then ${items[0]}.`;
    return `${first}, ${items.slice(0, -1).join(', ')}, then ${items[items.length - 1]}.`;
}

// ── Footprint (2D map) ────────────────────────────────────────────────

function rect(center, bearing, depth, width) {
    const f = unit(bearing);
    const r = unit(bearing + 90);
    const hd = depth / 2;
    const hw = width / 2;
    return [
        [center.e - f.e * hd - r.e * hw, center.n - f.n * hd - r.n * hw],
        [center.e + f.e * hd - r.e * hw, center.n + f.n * hd - r.n * hw],
        [center.e + f.e * hd + r.e * hw, center.n + f.n * hd + r.n * hw],
        [center.e - f.e * hd + r.e * hw, center.n - f.n * hd + r.n * hw],
    ];
}

/** Outline of every flight and landing as [east, north] rings (metres from the bottom node). */
export function footprint(plan) {
    return plan.segments.map((s) => {
        if (s.kind === 'landing') {
            return { kind: 'landing', ring: rect(s.center, s.yawDeg, s.depth, s.width) };
        }
        const centre = { e: (s.from.e + s.to.e) / 2, n: (s.from.n + s.to.n) / 2 };
        return { kind: 'flight', ring: rect(centre, s.yawDeg, s.run, plan.widthM) };
    });
}

/**
 * Every step of the stairs for a 2.5D drawing: one tread per step and one
 * per landing, each a [east, north] ring with the height `u` it stands at
 * (metres above the bottom node), plus the riser (front face) under each
 * tread as its lower edge `riser: [[e, n], [e, n]]` from `u0` to `u`.
 * Treads come bottom to top in walking order.
 */
export function stairTreads(plan) {
    const out = [];
    for (const s of plan.segments) {
        if (s.kind === 'landing') {
            out.push({ kind: 'landing', ring: rect(s.center, s.yawDeg, s.depth, s.width), u: s.center.u, u0: s.center.u, riser: null });
            continue;
        }
        const n = Math.max(1, s.steps);
        const depth = s.run / n;
        const f = unit(s.yawDeg);
        const r = unit(s.yawDeg + 90);
        const hw = plan.widthM / 2;
        for (let k = 0; k < n; k += 1) {
            const mid = { e: s.from.e + f.e * depth * (k + 0.5), n: s.from.n + f.n * depth * (k + 0.5) };
            const back = { e: s.from.e + f.e * depth * k, n: s.from.n + f.n * depth * k };
            out.push({
                kind: 'tread',
                ring: rect(mid, s.yawDeg, depth, plan.widthM),
                u: s.from.u + (s.rise * (k + 1)) / n,
                u0: s.from.u + (s.rise * k) / n,
                riser: [[back.e - r.e * hw, back.n - r.n * hw], [back.e + r.e * hw, back.n + r.n * hw]],
                facingDeg: normalizeBearing(s.yawDeg + 180),
            });
        }
    }
    return out;
}

/**
 * The walking line up the stairs with heights: { e, n, u } points from the
 * bottom node (0, 0, 0) along every flight and landing to the top of the
 * last flight. For drawing a route that climbs the staircase in 2.5D.
 */
export function walkLine(plan) {
    const pts = [{ e: 0, n: 0, u: 0 }];
    const push = (p) => {
        const last = pts[pts.length - 1];
        if (Math.hypot(p.e - last.e, p.n - last.n) > 1e-6 || Math.abs(p.u - last.u) > 1e-6) pts.push({ e: p.e, n: p.n, u: p.u });
    };
    for (const s of plan.segments) {
        if (s.kind === 'landing') push(s.center);
        else { push(s.from); push(s.to); }
    }
    return pts;
}

/** Walking line (centre of the stairs) as [east, north] points. */
export function centreline(plan) {
    const pts = [[0, 0]];
    for (const s of plan.segments) {
        if (s.kind === 'landing') pts.push([s.center.e, s.center.n]);
        else pts.push([s.to.e, s.to.n]);
    }
    return pts;
}

/**
 * Everything the app needs about one staircase on a route, from the pair of
 * nodes it climbs. Used for `route.stairs[]` entries.
 */
export function describeStair(link, fromNode, toNode, toLabel) {
    const direction = floorOf(toNode) > floorOf(fromNode) ? 'up' : 'down';
    const { plan, yawDeg, yawSource } = planFromLink(link, fromNode, toNode);
    return {
        direction,
        yaw_deg: yawDeg,
        yaw_source: yawSource,
        flights: plan.flights,
        landing_m: plan.landingM,
        rise_m: Math.round(plan.rise * 100) / 100,
        shape: shapeLabel(plan.flights),
        shape_id: shapeIdOf(plan.flights),
        instruction: stairInstruction({ direction, flights: plan.flights, toLabel }),
    };
}
