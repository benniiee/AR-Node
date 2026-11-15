// Map matching: snap a noisy GPS fix onto the nearest edge of the walkable
// graph (the same Gabriel graph the router uses), so the "you are here" dot,
// the route start and the AR camera sit on a real path instead of drifting
// through a building.
//
// Rules of thumb baked in below:
//  • Only snap when the fix is plausibly ON the network: within a gate that
//    grows with the reported GPS accuracy (clamped 10–25 m). Farther away
//    the user is probably on grass / a plaza / indoors, so the raw fix wins.
//  • Hysteresis: where two parallel edges are nearly equally close, keep the
//    one we were already on, so the dot doesn't flicker between them.
//  • Accuracy is passed through untouched: snapping does not make the
//    underlying fix any more certain, it only makes it plausible.
import { toLocalMeters, fromLocalMeters } from './geo.js';
import { buildWalkEdges, segmentCrossesBorder } from './pathfinding.js';

export const MAP_MATCH_MIN_GATE_M = 10;
export const MAP_MATCH_MAX_GATE_M = 25;
export const MAP_MATCH_HYSTERESIS_M = 3;

let cache = { nodes: null, borders: null, edges: [] };

// Edges are O(n^3) to build (Gabriel test), so cache by array identity —
// the nodes/borders arrays only change when the map data reloads.
export function getWalkEdges(nodes, borders) {
    if (cache.nodes !== nodes || cache.borders !== borders) {
        const usable = (nodes || []).filter(
            (n) => Number.isFinite(n.latitude) && Number.isFinite(n.longitude),
        );
        cache = { nodes, borders, edges: buildWalkEdges(usable, borders || []) };
    }

    return cache.edges;
}

/**
 * Closest point on segment A→B to the origin, in a local metre frame.
 * Exported for tests.
 */
export function closestOnSegment(ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;

    return { px, py, t, dist: Math.hypot(px, py) };
}

/**
 * @param {{latitude:number, longitude:number, accuracy?:number}} fix
 * @param {Array} nodes
 * @param {Array} borders
 * @param {{prevEdgeKey?: string|null}} [opts]
 * @returns {{latitude:number, longitude:number, snapped:boolean, edgeKey:string|null, offsetM:number}}
 */
export function snapToWalkGraph(fix, nodes, borders, opts = {}) {
    if (!fix || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) {
        return { latitude: fix?.latitude, longitude: fix?.longitude, snapped: false, edgeKey: null, offsetM: 0 };
    }
    const miss = { latitude: fix.latitude, longitude: fix.longitude, snapped: false, edgeKey: null, offsetM: 0 };
    const edges = getWalkEdges(nodes, borders);
    if (edges.length === 0) return miss;

    const acc = Number.isFinite(fix.accuracy) ? fix.accuracy : 15;
    const gate = Math.min(MAP_MATCH_MAX_GATE_M, Math.max(MAP_MATCH_MIN_GATE_M, acc * 1.5));

    // Every edge within the gate, nearest first.
    const near = [];
    for (const e of edges) {
        const [ax, ay] = toLocalMeters(e.a.latitude, e.a.longitude, fix.latitude, fix.longitude);
        const [bx, by] = toLocalMeters(e.b.latitude, e.b.longitude, fix.latitude, fix.longitude);
        const c = closestOnSegment(ax, ay, bx, by);
        if (c.dist <= gate) near.push({ ...c, key: e.key });
    }
    near.sort((p, q) => p.dist - q.dist);

    // A snap that has to pass through a building wall means the user is
    // almost certainly NOT on that walkway (e.g. the path on the far side of
    // a building) — the router rejects such edges for the same reason.
    const reachable = (c) => {
        if (!borders || borders.length === 0) return true;
        const p = fromLocalMeters(fix.latitude, fix.longitude, c.px, c.py);

        return !segmentCrossesBorder(fix, p, borders);
    };
    const best = near.find(reachable);
    if (!best) return miss;
    const prev = opts.prevEdgeKey ? near.find((c) => c.key === opts.prevEdgeKey) : null;

    // Stay on the previous edge unless the new one is clearly closer.
    const pick = prev && prev.dist <= best.dist + MAP_MATCH_HYSTERESIS_M && reachable(prev) ? prev : best;

    // pick.px/py are east/north offsets of the snap point FROM the fix.
    const ll = fromLocalMeters(fix.latitude, fix.longitude, pick.px, pick.py);

    return { ...ll, snapped: true, edgeKey: pick.key, offsetM: pick.dist };
}
