// ── Building doors ───────────────────────────────────────────────────
// A labelled building is a wall for routing. Its doors are the gaps in that
// wall: a route may only go in or out of the building through one of them.
// A building with no doors keeps the older rule (it can be entered anywhere),
// so buildings that have not been given doors yet still route.
//
// A door is stored as one point ON the outline ({ lat, lng, width_m? }). Everything
// else (which edge it is on, its gap, its frame in 3D) is derived here, so
// the 2D map, the 3D views and the router read doors the same way.
import { toLocalMeters, fromLocalMeters } from './geo.js';

/** Clear width of a door gap in the wall, metres (doors saved without a width). */
export const DOOR_WIDTH_M = 2;
/** Allowed door widths, metres: a narrow single door up to a wide entrance. */
export const MIN_DOOR_WIDTH_M = 0.8;
export const MAX_DOOR_WIDTH_M = 6;

/** A door's width in metres: its own, clamped, or the default. */
export function doorWidth(door) {
    const w = Number(door?.width_m);
    return Number.isFinite(w) && w > 0 ? Math.min(MAX_DOOR_WIDTH_M, Math.max(MIN_DOOR_WIDTH_M, w)) : DOOR_WIDTH_M;
}
/** Door height drawn in 3D, metres. */
export const DOOR_HEIGHT_M = 2.2;
/** A tap within this distance of the outline snaps onto it. */
export const DOOR_SNAP_M = 6;
/** Most doors one building may have. */
export const MAX_DOORS = 20;

const ringOf = (polygon) => (Array.isArray(polygon) ? polygon.filter((p) => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng)) : []);

/**
 * The point on the outline closest to (lat, lng).
 * @returns {{ lat: number, lng: number, edge: number, t: number, distM: number } | null}
 */
export function snapToOutline(polygon, lat, lng) {
    const ring = ringOf(polygon);
    if (ring.length < 3) return null;
    const ref = ring[0];
    const pts = ring.map((p) => toLocalMeters(+p.lat, +p.lng, +ref.lat, +ref.lng));
    const [px, py] = toLocalMeters(lat, lng, +ref.lat, +ref.lng);
    let best = null;
    for (let i = 0; i < pts.length; i += 1) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-9) continue;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const qx = ax + t * dx;
        const qy = ay + t * dy;
        const distM = Math.hypot(px - qx, py - qy);
        if (!best || distM < best.distM) best = { edge: i, t, distM, x: qx, y: qy };
    }
    if (!best) return null;
    const p = fromLocalMeters(+ref.lat, +ref.lng, best.x, best.y);
    return { lat: p.latitude, lng: p.longitude, edge: best.edge, t: best.t, distM: best.distM };
}

/** Doors that really sit on this outline (within DOOR_SNAP_M), snapped onto it. */
export function placedDoors(polygon, doors) {
    const out = [];
    for (const d of Array.isArray(doors) ? doors : []) {
        if (!d || !Number.isFinite(+d.lat) || !Number.isFinite(+d.lng)) continue;
        const s = snapToOutline(polygon, +d.lat, +d.lng);
        if (s && s.distM <= DOOR_SNAP_M) out.push({ ...s, width: doorWidth(d) });
    }
    return out.slice(0, MAX_DOORS);
}

/**
 * A door as a short piece of its wall: the two jambs `a`, `b` (its width
 * apart, along the edge), its centre, width, and the edge's outward
 * direction in compass degrees (for 3D).
 */
export function doorFrames(polygon, doors) {
    const ring = ringOf(polygon);
    if (ring.length < 3) return [];
    const ref = ring[0];
    const pts = ring.map((p) => toLocalMeters(+p.lat, +p.lng, +ref.lat, +ref.lng));
    // Signed area: >0 counter-clockwise, so the outward normal is (dy, -dx).
    let area = 0;
    for (let i = 0; i < pts.length; i += 1) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        area += x1 * y2 - x2 * y1;
    }
    const ccw = area > 0;
    return placedDoors(ring, doors).map((d) => {
        const [ax, ay] = pts[d.edge];
        const [bx, by] = pts[(d.edge + 1) % pts.length];
        const len = Math.hypot(bx - ax, by - ay);
        const half = Math.min(d.width / 2, len / 2);
        const ux = (bx - ax) / len;
        const uy = (by - ay) / len;
        const cx = ax + d.t * (bx - ax);
        const cy = ay + d.t * (by - ay);
        // Keep the whole door on its edge.
        const along = Math.max(half, Math.min(len - half, d.t * len));
        const sx = ax + ux * along;
        const sy = ay + uy * along;
        const toLatLng = (x, y) => { const p = fromLocalMeters(+ref.lat, +ref.lng, x, y); return { lat: p.latitude, lng: p.longitude }; };
        const [nx, ny] = ccw ? [uy, -ux] : [-uy, ux];
        return {
            center: toLatLng(cx, cy),
            a: toLatLng(sx - ux * half, sy - uy * half),
            b: toLatLng(sx + ux * half, sy + uy * half),
            edge: d.edge,
            width: half * 2,
            normalDeg: ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360,
        };
    });
}

/**
 * The outline as wall segments with a door-wide gap at every door, each
 * one a two-point polyline [{lat,lng},{lat,lng}] for segmentCrossesBorder.
 */
export function doorGapWalls(polygon, doors) {
    const ring = ringOf(polygon);
    if (ring.length < 3) return [];
    const ref = ring[0];
    const pts = ring.map((p) => toLocalMeters(+p.lat, +p.lng, +ref.lat, +ref.lng));
    const gaps = new Map();
    for (const d of placedDoors(ring, doors)) {
        const [ax, ay] = pts[d.edge];
        const [bx, by] = pts[(d.edge + 1) % pts.length];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const half = d.width / 2 / len;
        if (!gaps.has(d.edge)) gaps.set(d.edge, []);
        gaps.get(d.edge).push([Math.max(0, d.t - half), Math.min(1, d.t + half)]);
    }
    const toLatLng = (x, y) => { const p = fromLocalMeters(+ref.lat, +ref.lng, x, y); return { lat: p.latitude, lng: p.longitude }; };
    const walls = [];
    for (let i = 0; i < pts.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const cuts = (gaps.get(i) || []).sort((x, y) => x[0] - y[0]);
        if (!cuts.length) { walls.push([{ lat: +a.lat, lng: +a.lng }, { lat: +b.lat, lng: +b.lng }]); continue; }
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const at = (t) => toLatLng(ax + t * (bx - ax), ay + t * (by - ay));
        let from = 0;
        for (const [s, e] of cuts) {
            if (s > from + 1e-6) walls.push([at(from), at(s)]);
            from = Math.max(from, e);
        }
        if (from < 1 - 1e-6) walls.push([at(from), at(1)]);
    }
    return walls;
}

/**
 * Doors as routing waypoints: a virtual route node at each door (ground
 * floor), so the walking graph has a way through each gap. Ids are negative
 * so they never collide with real nodes; `is_door` marks them in a route.
 */
export function doorWaypoints(buildings) {
    const out = [];
    for (const b of buildings || []) {
        if (!b || b.status === 'planned') continue;
        placedDoors(b.polygon, b.doors).forEach((d, i) => {
            out.push({
                id: -(Number(b.id) * 100 + i + 1),
                type: 'route', is_door: true,
                name: `${b.short_name || b.name || 'Building'} entrance`,
                latitude: d.lat, longitude: d.lng, elevation: 0,
                floor_level: 0, path_type: 'inside', building_id: b.id,
            });
        });
    }
    return out;
}
