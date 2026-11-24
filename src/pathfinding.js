/**
 * Client-side pathfinding module.
 *
 * Algorithm:
 * 1. Build a graph by connecting nodes with a GABRIEL GRAPH edge rule instead
 *    of k-nearest-neighbors: two nodes A and B are connected only if no other
 *    node lies inside the circle whose diameter is the segment AB.
 *
 *    Why this matters: if a node C physically sits on the walkway between
 *    A and B, C falls inside that circle (this is Thales' theorem - any
 *    point that "sees" the segment AB at more than a 90 degree angle is
 *    inside the circle on that diameter, and a point roughly on the
 *    segment sees it at close to 180 degrees). So the A-B "shortcut" edge
 *    is automatically excluded, and only A-C and C-B remain. This is what
 *    the old k=3 KNN graph could not guarantee - each node picked its own
 *    3 nearest neighbors independently, which in dense clusters often
 *    produced connections that skipped past a node (or tangled together
 *    several nearby nodes with no clean edge leading further down the
 *    corridor), causing shortcut skips or ugly zig-zag detours.
 *
 *    The Gabriel graph is also guaranteed to stay a single connected
 *    component (it contains the Euclidean minimum spanning tree), so unlike
 *    a plain "connect everything in one chain" approach, it never needs to
 *    force a route through unrelated dead-end branches to keep nodes
 *    reachable - branches just hang off the corridor as extra edges that
 *    Dijkstra simply won't use unless they're actually on the way.
 *
 * 2. User connects to their nearby route nodes (nearest ones whose
 *    straight-line segment does not cut through a border).
 * 3. Dijkstra finds the shortest path from user to destination over that
 *    graph.
 * 4. Road snap: each path edge pulls in route nodes lying on its segment,
 *    so the route follows the road (no flying over uncounted nodes).
 */

import { toLocalMeters, fromLocalMeters } from './geo.js';
import { edgeRainFactor, isRoutable, noRouteMessage } from './weatherCost.js';
import { edgeShadeFactor } from './shadeRouting.js';
import { floorOf, floorAria } from './floors.js';
import { buildingAt, pointInPolygon } from './campusGeometry.js';
import { doorGapWalls, doorWaypoints, placedDoors, snapToOutline, DOOR_WIDTH_M, MAX_DOORS } from './doors.js';
import {
    DEFAULT_STAIR_ANGLE, STAIR_ANGLE_MIN, STAIR_ANGLE_MAX, clampStairAngle,
    stairRise, stairWalkLength, describeStair,
} from './stairGeometry.js';

// Staircase constants live in stairGeometry.js (one definition shared with the
// AR view and the admin editor); re-exported so existing imports keep working.
export { DEFAULT_STAIR_ANGLE, STAIR_ANGLE_MIN, STAIR_ANGLE_MAX, clampStairAngle };

// ── Multi-floor routing ────────────────────────────────────────────────
// Floors are never joined by guessing from coordinates. Normal walking
// edges only ever connect nodes on the SAME floor; the one way between
// floors is a staircase link (two nodes the admin marked as the two ends of
// one staircase). A link is an ordinary edge in the graph, so Dijkstra
// chooses the nearest staircase on its own.
/** Walked length of a staircase: every flight's incline (rise / sin(angle))
 *  plus the flat crossing of each landing, but never shorter than the
 *  straight-line distance between its two nodes. `link` carries the shape
 *  (flights, landing_m); without it the stairs are one straight flight at
 *  `angleDeg`, exactly as before. */
export function stairLength(a, b, angleDeg = DEFAULT_STAIR_ANGLE, link = null) {
    const spatial = haversineDistance(
        a.latitude, a.longitude, a.elevation || 0,
        b.latitude, b.longitude, b.elevation || 0,
    );
    const walked = stairWalkLength({ ...(link || {}), angle_deg: link?.angle_deg ?? angleDeg }, stairRise(a, b));
    return Math.max(spatial, walked);
}

function linkKey(aId, bId) {
    const x = String(aId); const y = String(bId);
    return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function linkLookup(links) {
    const map = new Map();
    for (const l of links || []) map.set(linkKey(l.node_a_id, l.node_b_id), l);
    return map;
}

// ── Haversine distance (meters), with a straight-line elevation term ─────
function haversineDistance(lat1, lng1, elev1, lat2, lng2, elev2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const horizontal = R * c;
    const elevDelta = (elev2 || 0) - (elev1 || 0);
    return Math.sqrt(horizontal ** 2 + elevDelta ** 2);
}

// ── Gabriel-graph edge test ────────────────────────────────────────────
// Edge (a, b) is kept only if no other node lies inside the circle whose
// diameter is segment a-b (i.e. no other node is closer to the midpoint of
// a-b than half of |ab|).
const GABRIEL_EPSILON_M = 0.05; // tolerance in meters for floating point / GPS noise

// A node only counts as "on the way" between a and b when both ends can walk
// straight to it. A node behind a wall (a room inside a building next to the
// path) is not on the way, so it must not delete the walkway edge outside:
// that left walkways with missing links and routes taking long detours.
function isGabrielEdge(a, b, nodes, abDist, borders = []) {
    const midLat = (a.latitude + b.latitude) / 2;
    const midLng = (a.longitude + b.longitude) / 2;
    const midElev = ((a.elevation || 0) + (b.elevation || 0)) / 2;
    const radius = abDist / 2;

    for (const n of nodes) {
        if (n.id === a.id || n.id === b.id) continue;
        const dMid = haversineDistance(
            midLat, midLng, midElev,
            n.latitude, n.longitude, n.elevation || 0
        );
        if (dMid < radius - GABRIEL_EPSILON_M) {
            // Hidden behind a wall from either end: not on the way.
            if (segmentCrossesBorder(a, n, borders) || segmentCrossesBorder(n, b, borders)) continue;
            return false; // n sits inside the circle -> n is "on the way", block the shortcut
        }
    }
    return true;
}

// ── Border exclusion ─────────────────────────────────────────────────
// A border group is one wall: an open polyline in click order, or a closed
// box when staff repeats the first point at the end. Edges that cross any
// wall segment are blocked; routing slips around either end (or around the
// box).

// Check if two line segments intersect
function segmentsIntersect(p1, p2, p3, p4) {
    const d1x = p2.lng - p1.lng, d1y = p2.lat - p1.lat;
    const d2x = p4.lng - p3.lng, d2y = p4.lat - p3.lat;
    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 1e-12) return false;

    const t = ((p3.lng - p1.lng) * d2y - (p3.lat - p1.lat) * d2x) / cross;
    const u = ((p3.lng - p1.lng) * d1y - (p3.lat - p1.lat) * d1x) / cross;

    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// Check if edge a→b crosses through any border wall (consecutive pairs
// only — a closed box is stored with its first point repeated, so its
// closing edge is included naturally).
export function segmentCrossesBorder(a, b, borders) {
    if (!borders || borders.length === 0) return false;

    const segA = { lat: a.latitude, lng: a.longitude };
    const segB = { lat: b.latitude, lng: b.longitude };
    // The step's floor: a's, or b's when a is a point without one (the user's GPS fix).
    const stepFloor = a?.floor_level !== undefined && a?.floor_level !== null ? floorOf(a) : floorOf(b);

    for (const border of borders) {
        const wall = border.coordinates;
        if (!wall || wall.length < 2) continue;
        // A wall of one floor only (a bridge deck's outline): other floors pass under or over it.
        if (border.floor !== undefined && border.floor !== null && border.floor !== stepFloor) continue;
        // A drawn wall (fence, road edge) under a raised bridge deck: a step along the deck passes over it.
        if (border.overDecks && border.overDecks.some((d) => d.floor === stepFloor
            && insidePolygon(segA, d.polygon) && insidePolygon(segB, d.polygon))) continue;
        // Building outline (see buildingBarriers): blocks walking ACROSS the
        // building, never going in or out of it. A step that starts or ends
        // inside it is an entrance / exit (doors are not mapped).
        if (border.polygon && (insidePolygon(segA, border.polygon) || insidePolygon(segB, border.polygon))) continue;

        for (let i = 0; i + 1 < wall.length; i++) {
            if (segmentsIntersect(segA, segB, wall[i], wall[i + 1])) return true;
        }
    }
    return false;
}

// "the ground floor", "floor 2", "basement 1" (ground counts as floor 1).
const floorPhrase = (f) => (f === 0 ? 'the ground floor' : floorAria(f).toLowerCase());

// Ray-casting point-in-polygon on {lat, lng} points.
function insidePolygon(p, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const a = polygon[i];
        const b = polygon[j];
        if ((a.lat > p.lat) !== (b.lat > p.lat)
            && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
    }
    return inside;
}

/**
 * Labelled buildings as routing obstacles: each outline becomes a closed wall
 * that routes go AROUND, unless the step enters or leaves that building.
 * Planned buildings are not built yet, so they block nothing.
 */
export function buildingBarriers(buildings) {
    const out = [];
    for (const b of buildings || []) {
        if (!b || b.status === 'planned' || !Array.isArray(b.polygon) || b.polygon.length < 3) continue;
        // With doors the outline is a real wall with gaps: in and out only
        // through a door (doorWaypoints gives the graph a node in each gap).
        if (placedDoors(b.polygon, b.doors).length > 0) {
            for (const wall of doorGapWalls(b.polygon, b.doors)) out.push({ coordinates: wall });
            continue;
        }
        out.push({ coordinates: [...b.polygon, b.polygon[0]], polygon: b.polygon });
    }
    return out;
}

/**
 * Bridges with doors as routing obstacles: on the deck's floor the outline is a wall with a gap
 * at each door, so routes get on and off the deck only through its doors (a door waypoint in each
 * gap, bridgeDoorWaypoints). The ground under a raised deck stays open. A bridge without doors
 * blocks nothing, as before. Planned bridges are not built yet.
 */
export function bridgeBarriers(bridges) {
    const out = [];
    for (const br of bridges || []) {
        if (!br || br.status === 'planned' || !Array.isArray(br.polygon) || br.polygon.length < 3) continue;
        if (placedDoors(br.polygon, br.doors).length === 0) continue;
        const floor = Math.trunc(Number(br.deck_floor) || 0);
        for (const wall of doorGapWalls(br.polygon, br.doors)) out.push({ coordinates: wall, floor });
    }
    return out;
}

/** A virtual route node in each bridge door's gap, on the deck's floor (like doorWaypoints for buildings). */
/**
 * A node on a closed bridge's deck (an admin closed it, say for an event): on the deck's floor and
 * inside its outline. Without these nodes the deck and both its staircases are out of routing.
 */
function onClosedDeck(node, closedBridges) {
    if (node?.building_id != null) return false;
    const p = { lat: Number(node.latitude), lng: Number(node.longitude) };
    return closedBridges.some((br) => floorOf(node) === Math.trunc(Number(br.deck_floor) || 0) && insidePolygon(p, br.polygon));
}

/** Metres between the virtual route nodes laid along a pathway. */
export const PATHWAY_STEP_M = 6;

/**
 * A pathway (road, walkway, covered walkway) is a route: virtual route nodes every PATHWAY_STEP_M along
 * each stretch of its line, every corner and both ends included (a route turns where the path turns, and
 * a branch drawn from a corner joins right there), on the ground floor. Not stored and never drawn as dots; the router and
 * GPS snapping join them to everything nearby like any route node. A covered walkway is sheltered in
 * rain. Planned or unfinished pathways are not walkable yet.
 */
export function pathwayWaypoints(pathways) {
    const out = [];
    for (const pw of pathways || []) {
        if (!pw || pw.status === 'planned' || pw.status === 'under_construction') continue;
        const line = (pw.coordinates || []).filter((c) => Number.isFinite(+c.lat) && Number.isFinite(+c.lng));
        if (line.length < 2) continue;
        const points = [];
        for (let i = 1; i < line.length; i += 1) {
            const a = line[i - 1];
            const [e, n] = toLocalMeters(+line[i].lat, +line[i].lng, +a.lat, +a.lng);
            const length = Math.hypot(e, n);
            if (length < 1e-6) continue;
            if (points.length === 0) points.push({ lat: +a.lat, lng: +a.lng });
            // Evenly along the stretch, none crowding its far corner (within a quarter step).
            for (let at = PATHWAY_STEP_M; at < length - PATHWAY_STEP_M * 0.25; at += PATHWAY_STEP_M) {
                const p = fromLocalMeters(+a.lat, +a.lng, (e * at) / length, (n * at) / length);
                points.push({ lat: p.latitude, lng: p.longitude });
            }
            // The corner (or the end) itself.
            points.push({ lat: +line[i].lat, lng: +line[i].lng });
        }
        if (points.length < 2) continue;
        points.forEach((p, k) => out.push({
            id: -(2000000 + Number(pw.id) * 10000 + k), type: 'route', name: null,
            latitude: p.lat, longitude: p.lng, elevation: 0, floor_level: 0,
            path_type: pw.kind === 'covered' ? 'inside' : 'outside', building_id: null, pathway_id: pw.id, pathway_k: k,
        }));
    }
    return out;
}

/**
 * Walking off the mapped paths (across open ground) costs this much more per metre than along a road
 * or walkway, so routes keep to them where there are any; where there are none (a street between
 * walls) every way is off-path alike and the straight one still wins. Only the choice: reported
 * distances stay real.
 */
export const OFF_PATH_FACTOR = 1.5;

/** Is a step between a and b off the mapped paths? (A wall's turning point, or two pathway points not next to each other.) */
function offPath(a, b) {
    if (a?.wall_end || b?.wall_end) return true;
    if (a?.pathway_id == null || b?.pathway_id == null) return false;
    return !(a.pathway_id === b.pathway_id && Math.abs(a.pathway_k - b.pathway_k) === 1);
}

/** Metres within which a wall's turning point links to every point in plain sight. */
const WALL_END_REACH_M = 60;

/** Metres past a wall's open end where a route turns round it. */
const WALL_END_STEP_M = 1.2;

/**
 * A virtual route node just past each open end of a drawn wall (a closed loop has none): the corner a
 * route turns round, e.g. from the street at the end of a campus wall into the road behind it. The
 * router only links points in straight lines that cross no wall, so without these it could not go
 * round a wall's end. Ground floor, open air; never stored or drawn.
 */
export function wallEndWaypoints(walls) {
    const out = [];
    (walls || []).forEach((w, gi) => {
        const c = (w?.coordinates || []).filter((p) => Number.isFinite(+p.lat) && Number.isFinite(+p.lng));
        if (c.length < 2) return;
        const first = c[0];
        const last = c[c.length - 1];
        if (+first.lat === +last.lat && +first.lng === +last.lng) return;
        const key = Number.isFinite(Number(w.group_id)) ? Number(w.group_id) : gi;
        [[first, c[1]], [last, c[c.length - 2]]].forEach(([end, prev], k) => {
            const [e, n] = toLocalMeters(+end.lat, +end.lng, +prev.lat, +prev.lng);
            const len = Math.hypot(e, n);
            if (len < 1e-6) return;
            const p = fromLocalMeters(+end.lat, +end.lng, (e / len) * WALL_END_STEP_M, (n / len) * WALL_END_STEP_M);
            out.push({
                id: -(3000000 + key * 10 + k), type: 'route', name: null, wall_end: true,
                latitude: p.latitude, longitude: p.longitude, elevation: 0, floor_level: 0, path_type: 'outside', building_id: null,
            });
        });
    });
    return out;
}

/**
 * Metres within which every route point in plain sight is a possible first step (beyond the nearest few).
 * Long enough for a whole street: at 60 m a pin past the bridge could not see the street's far end and
 * stepped sideways to a corner first. Walls still block, and the off-path cost keeps routes on walkways.
 */
const ENTRY_REACH_M = 150;

/** Metres from a wall within which a GPS fix may be on its wrong side (drift), so a route may start across it. */
const WALL_GPS_SLACK_M = 6;

/** Shortest distance in metres from (lat, lng) to any wall stretch in `borders`. */
function distanceToWalls(lat, lng, borders) {
    let best = Infinity;
    for (const b of borders || []) {
        const c = b?.coordinates || [];
        for (let i = 1; i < c.length; i += 1) {
            const [ax, ay] = toLocalMeters(+c[i - 1].lat, +c[i - 1].lng, lat, lng);
            const [bx, by] = toLocalMeters(+c[i].lat, +c[i].lng, lat, lng);
            const dx = bx - ax;
            const dy = by - ay;
            const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
            best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
        }
    }
    return best;
}

export function bridgeDoorWaypoints(bridges) {
    const out = [];
    for (const br of bridges || []) {
        if (!br || br.status === 'planned' || br.closed) continue;
        placedDoors(br.polygon, br.doors).forEach((d, i) => {
            out.push({
                id: -(1000000 + Number(br.id) * 100 + i + 1),
                type: 'route', is_door: true,
                name: `${br.short_name || br.name || 'Bridge'} entrance`,
                latitude: d.lat, longitude: d.lng, elevation: 0,
                floor_level: Math.trunc(Number(br.deck_floor) || 0),
                path_type: br.roofed ? 'inside' : 'outside', building_id: null,
            });
        });
    }
    return out;
}

/** A path's outside end within this distance of the outline counts as entering there. */
const ENTRANCE_REACH_M = 10;

/**
 * Where existing walking paths (and staircases) on one floor cross an outline: the spots a building
 * or a bridge deck is really entered, as points on the outline ({ lat, lng }), for "Find entrances".
 * walls: the drawn walls (not this outline). onlyInto: node ids; when given, only paths that lead
 * into one of them count (a raised bridge's staircase feet: the road under the deck is no entrance).
 */
export function suggestEntrances(polygon, nodes, { floor = 0, links = [], walls = [], onlyInto = null } = {}) {
    if (!Array.isArray(polygon) || polygon.length < 3) return [];
    const at = (n) => ({ lat: Number(n.latitude ?? n.lat), lng: Number(n.longitude ?? n.lng) });
    const inside = (n) => insidePolygon(at(n), polygon);
    const all = nodes || [];
    const byId = Object.fromEntries(all.map((n) => [String(n.id), n]));
    const pairs = buildWalkEdges(all.filter((n) => floorOf(n) === floor), walls).map((e) => [e.a, e.b]);
    // A staircase is entered where its plan line crosses the outline (its end on this floor inside, the other out).
    for (const l of links || []) {
        const a = byId[String(l.node_a_id)];
        const b = byId[String(l.node_b_id)];
        if (a && b && floorOf(a) !== floorOf(b) && (floorOf(a) === floor || floorOf(b) === floor)) pairs.push(floorOf(a) === floor ? [a, b] : [b, a]);
    }
    const out = [];
    for (const [a, b] of pairs) {
        if (inside(a) === inside(b)) continue;
        const [inner, outer] = inside(a) ? [a, b] : [b, a];
        if (onlyInto && !onlyInto.has(String(inner.id))) continue;
        // Only nearby steps: the graph also joins same-floor nodes of far structures through the air.
        if ((snapToOutline(polygon, at(outer).lat, at(outer).lng)?.distM ?? Infinity) > ENTRANCE_REACH_M) continue;
        // Bisect the step for where it crosses the outline.
        let lo = at(inner);
        let hi = at(outer);
        for (let i = 0; i < 30; i += 1) {
            const mid = { lat: (lo.lat + hi.lat) / 2, lng: (lo.lng + hi.lng) / 2 };
            if (insidePolygon(mid, polygon)) lo = mid; else hi = mid;
        }
        const s = snapToOutline(polygon, hi.lat, hi.lng);
        if (s && !out.some((d) => Math.hypot(...toLocalMeters(d.lat, d.lng, s.lat, s.lng)) < DOOR_WIDTH_M)) out.push({ lat: s.lat, lng: s.lng });
    }
    return out.slice(0, MAX_DOORS);
}

// ── Build graph: Gabriel graph over all nodes ─────────────────────────
// Stored weights are WALKING COSTS, not raw distances: in rain mode an
// exposed edge costs `distance * edgeRainFactor(...)` (src/weatherCost.js).
// With rainMultiplier <= 1 every weight stays
// a plain physical distance. buildWalkEdges() calls this with the defaults,
// so map matching always sees the real walkway geometry regardless of rain.
// `shade` ({ map, penalty } from shadeRouting.js) makes sunny exposed edges dearer on hot days.
function buildGraph(nodes, borders = [], rainMultiplier = 1, links = [], shade = null) {
    const adjacency = {};
    const byId = {};
    for (const node of nodes) {
        adjacency[String(node.id)] = {};
        byId[String(node.id)] = node;
    }

    // Walking edges stay on one floor: the Gabriel test only sees the nodes
    // of that floor, so a node directly above or below can never be "on the
    // way" and nothing connects floors by accident.
    const byFloor = new Map();
    for (const node of nodes) {
        const f = floorOf(node);
        if (!byFloor.has(f)) byFloor.set(f, []);
        byFloor.get(f).push(node);
    }

    for (const floorNodes of byFloor.values()) {
        for (let i = 0; i < floorNodes.length; i++) {
            for (let j = i + 1; j < floorNodes.length; j++) {
                const a = floorNodes[i];
                const b = floorNodes[j];
                const dist = haversineDistance(
                    a.latitude, a.longitude, a.elevation || 0,
                    b.latitude, b.longitude, b.elevation || 0
                );
                if (segmentCrossesBorder(a, b, borders)) continue;
                // A wall's turning point links to every point it can see nearby, not only Gabriel neighbours:
                // it is the corner a route turns at, and pruning its links forced a V through a third point.
                const corner = (a.wall_end || b.wall_end) && dist <= WALL_END_REACH_M;
                if (!corner && !isGabrielEdge(a, b, floorNodes, dist, borders)) continue;

                const cost = dist * edgeRainFactor(a.path_type, b.path_type, rainMultiplier)
                    * (shade ? edgeShadeFactor(a, b, shade.map, shade.penalty) : 1)
                    * (offPath(a, b) ? OFF_PATH_FACTOR : 1);
                adjacency[String(a.id)][String(b.id)] = cost;
                adjacency[String(b.id)][String(a.id)] = cost;
            }
        }
    }

    // Staircases: the only edges between floors. Skipped when either end is
    // missing from this graph (e.g. closed to routing in the rain).
    for (const link of links || []) {
        const a = byId[String(link.node_a_id)];
        const b = byId[String(link.node_b_id)];
        if (!a || !b || floorOf(a) === floorOf(b)) continue;
        const cost = stairLength(a, b, link.angle_deg, link)
            * edgeRainFactor(a.path_type, b.path_type, rainMultiplier);
        adjacency[String(a.id)][String(b.id)] = cost;
        adjacency[String(b.id)][String(a.id)] = cost;
    }
    return adjacency;
}

// ── Walkable edges, for map matching ───────────────────────────────────
// Same Gabriel + border rules the router uses, flattened to a list of
// segments so the user's GPS fix can be snapped onto the real walkway
// network (see mapMatch.js). Each undirected edge appears once.
export function buildWalkEdges(nodes, borders = []) {
    const byId = {};
    for (const n of nodes) byId[String(n.id)] = n;
    const adjacency = buildGraph(nodes, borders);
    const edges = [];
    for (const aId of Object.keys(adjacency)) {
        for (const bId of Object.keys(adjacency[aId])) {
            if (aId < bId) edges.push({ key: `${aId}|${bId}`, a: byId[aId], b: byId[bId] });
        }
    }

    return edges;
}

// ── Find nearby route nodes to a point ──────────────────────────────
// Returns the K nearest route nodes whose straight-line segment from the
// point does NOT cross a border. The user entry connects to all of them
// so Dijkstra can choose the access point with the shortest overall route.
// Entries that would cut through a building are skipped (they produced
// detours through far-away nodes on the wrong side of an obstacle).
//
// The DESTINATION competes as an entry too (`destinationId`). A destination
// is usually a 'location' node hanging off the walkway by a single edge, so
// when only route nodes were candidates the path always ran user → last route
// node → destination, even when the user stood nearer the destination than
// that node (it doubled back through a node they had already passed).
// Ranked by distance like everything else, so a far destination does not
// become a straight line across campus: it only wins when it is genuinely one
// of the closest ways in and Dijkstra finds the direct hop cheapest.
function findNearbyRouteNodes(nodes, lat, lng, elevation, borders = [], k = 5, floor = null, destinationId = null) {
    const userPoint = { latitude: lat, longitude: lng, elevation: elevation || 0 };
    // A known floor means the user can only step onto nodes of that floor.
    const pool = Number.isFinite(floor) ? nodes.filter((n) => floorOf(n) === floor) : nodes;
    const ranked = pool.map((node) => ({
        node,
        dist: haversineDistance(lat, lng, elevation || 0, node.latitude, node.longitude, node.elevation || 0),
    }));
    ranked.sort((a, b) => a.dist - b.dist);
    const destKey = destinationId === null || destinationId === undefined ? null : String(destinationId);
    const routeNodes = ranked.filter((e) => e.node.type === 'route' || (destKey !== null && String(e.node.id) === destKey));
    const candidates = routeNodes.length > 0 ? routeNodes : ranked;
    const valid = candidates.filter((e) => !segmentCrossesBorder(userPoint, e.node, borders));
    // Every entry is behind a wall. Right beside a wall that is GPS drift (the fix is on the wrong side
    // of it): start from the nearest entry anyway. Further away, never through a wall: no entry.
    if (valid.length === 0) return distanceToWalls(lat, lng, borders) <= WALL_GPS_SLACK_M ? candidates.slice(0, 1) : [];
    // The k nearest, and every other one in plain sight within ENTRY_REACH_M: on a street between walls
    // the way out (a wall's far end) is often not among the nearest few, and starting there is straight.
    return valid.filter((e, i) => i < k || e.dist <= ENTRY_REACH_M);
}

// ── Dijkstra: plain shortest path ─────────────────────────────────────
// (No hop-count tiebreak needed anymore - the Gabriel graph itself removes
// the shortcut edges that used to make that hack necessary.)
function dijkstra(adjacency, start, end) {
    const dist = {};
    const prev = {};

    for (const nodeId of Object.keys(adjacency)) {
        dist[nodeId] = Infinity;
        prev[nodeId] = null;
    }
    if (!(start in dist)) { dist[start] = Infinity; prev[start] = null; }
    if (!(end in dist)) { dist[end] = Infinity; prev[end] = null; }

    dist[start] = 0;
    const queue = [[start, 0]];

    while (queue.length > 0) {
        queue.sort((a, b) => a[1] - b[1]);
        const [current, curDist] = queue.shift();

        if (curDist > dist[current]) continue;

        if (current === end) {
            const path = [];
            let node = end;
            while (node !== null) {
                path.unshift(node);
                node = prev[node];
            }
            return path;
        }

        for (const [neighborId, edgeDist] of Object.entries(adjacency[current] || {})) {
            const newDist = dist[current] + edgeDist;
            if (newDist < (dist[neighborId] ?? Infinity)) {
                dist[neighborId] = newDist;
                prev[neighborId] = current;
                queue.push([neighborId, newDist]);
            }
        }
    }
    return null;
}

// ── Road snap: pull path edges onto nearby route nodes ───────────────
// A straight path edge (especially the user→entry chord, which is not a
// Gabriel edge) can fly right over a road node without including it: the
// drawn line then passes through an unhighlighted node and the distance is
// under-counted. For every consecutive pair, insert route nodes that are
// genuinely "on the way" so the path follows the road network.
const SNAP_RADIUS_M = 10; // node must lie within this distance of the edge
const SNAP_T_MIN = 0.03; // projection must fall strictly between endpoints
const SNAP_T_MAX = 0.97;
const SNAP_END_EXCL_M = 2; // ... and not basically on top of an endpoint
const SNAP_DETOUR_M = 4; // ... and add at most this much extra walking


function snapPathToRoad(path, nodes, userLat, userLng, userElevation, borders, userFloor = null) {
    const byId = {};
    for (const n of nodes) byId[String(n.id)] = n;
    const posOf = (id) => {
        if (id === '__user__') return { latitude: userLat, longitude: userLng, elevation: userElevation || 0 };
        return byId[String(id)] || null;
    };
    const inPath = new Set(path.map(String));

    const snapped = [path[0]];
    for (let i = 0; i < path.length - 1; i++) {
        const aId = path[i];
        const bId = path[i + 1];
        const a = posOf(aId);
        const b = posOf(bId);
        if (!a || !b) {
            snapped.push(bId);
            continue;
        }
        // A staircase hop changes floor: nothing lies "on the way" of it.
        const floorA = aId === '__user__' ? userFloor : floorOf(a);
        const floorB = bId === '__user__' ? userFloor : floorOf(b);
        if (Number.isFinite(floorA) && Number.isFinite(floorB) && floorA !== floorB) {
            snapped.push(bId);
            continue;
        }
        const hopLen = haversineDistance(
            a.latitude, a.longitude, a.elevation || 0,
            b.latitude, b.longitude, b.elevation || 0
        );
        if (hopLen <= 0) {
            snapped.push(bId);
            continue;
        }
        const [ax, ay] = toLocalMeters(a.latitude, a.longitude, a.latitude, a.longitude);
        const [bx, by] = toLocalMeters(b.latitude, b.longitude, a.latitude, a.longitude);
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const endExcl = Math.min(SNAP_END_EXCL_M, 0.25 * hopLen);
        const found = [];

        for (const n of nodes) {
            // A wall's turning point is a corner to go round, not road to follow: never snapped in.
            if (n.type !== 'route' || n.wall_end) continue;
            if (inPath.has(String(n.id))) continue;
            // Only nodes of the floor this hop is on.
            if (Number.isFinite(floorB) && floorOf(n) !== floorB) continue;
            const [cx, cy] = toLocalMeters(n.latitude, n.longitude, a.latitude, a.longitude);
            const t = ((cx - ax) * dx + (cy - ay) * dy) / len2;
            if (t < SNAP_T_MIN || t > SNAP_T_MAX) continue;
            const px = ax + t * dx;
            const py = ay + t * dy;
            const perp = Math.sqrt((cx - px) ** 2 + (cy - py) ** 2);
            if (perp > SNAP_RADIUS_M) continue;
            const dA = haversineDistance(a.latitude, a.longitude, a.elevation || 0, n.latitude, n.longitude, n.elevation || 0);
            const dB = haversineDistance(n.latitude, n.longitude, n.elevation || 0, b.latitude, b.longitude, b.elevation || 0);
            if (dA < endExcl || dB < endExcl) continue;
            if (dA + dB - hopLen > SNAP_DETOUR_M) continue;
            const aLike = { latitude: a.latitude, longitude: a.longitude, elevation: a.elevation || 0 };
            if (segmentCrossesBorder(aLike, n, borders)) continue;
            if (segmentCrossesBorder(n, b, borders)) continue;
            found.push({ id: String(n.id), t });
        }

        found.sort((x, y) => x.t - y.t);
        // In order along the hop, each kept only while the WHOLE hop stays within SNAP_DETOUR_M of its
        // straight length: points on both sides of a long hop each pass on their own, but together zig-zag.
        const d3 = (p, q) => haversineDistance(p.latitude, p.longitude, p.elevation || 0, q.latitude, q.longitude, q.elevation || 0);
        let last = a;
        let walked = 0;
        for (const f of found) {
            const n = byId[f.id];
            if (walked + d3(last, n) + d3(n, b) - hopLen > SNAP_DETOUR_M) continue;
            walked += d3(last, n);
            last = n;
            snapped.push(f.id);
            inPath.add(f.id);
        }
        snapped.push(bId);
    }
    return snapped;
}

// ── Main: compute a route ────────────────────────────────────────────
// options.rainMultiplier — rain penalty for exposed edges (1 = dry). Mirrors
//   the server; see weatherCost.js.
// options.userFloor — the floor the user is standing on (a number). Routing
//   starts from that floor and reaches other floors only through staircase
//   links. null keeps the older "any floor" behaviour.
// options.links — staircase links [{ node_a_id, node_b_id, angle_deg, yaw_deg, flights, landing_m }].
// options.rainNow — it is currently raining, so exposed (outside) paths are
//   RED and therefore NOT routable: they are removed from the graph before
//   routing, and a destination that only sits on closed paths reports
//   noRouteMessage() (saying rain or heat) instead of a route that would walk someone into rain.
// options.heatNow — heat mode is on (heat index above 40 °C by default):
//   exposed paths close exactly as they do in the rain.
export function computeRoute(nodes, destinationId, userLat, userLng, userElevation = 0, wallBorders = [], options = {}) {
    // options.buildings: labelled buildings, walked around (not through),
    // entered through their doors (virtual route nodes in each door gap).
    // options.bridges: bridges with doors are entered only through them, on the deck's floor.
    const overDecks = (options.bridges || [])
        .filter((br) => br && br.status !== 'planned' && Number(br.deck_floor) > 0 && Array.isArray(br.polygon) && br.polygon.length >= 3)
        .map((br) => ({ floor: Math.trunc(Number(br.deck_floor)), polygon: br.polygon }));
    const walls = overDecks.length ? (wallBorders || []).map((w) => ({ ...w, overDecks })) : (wallBorders || []);
    const borders = [...walls, ...buildingBarriers(options.buildings), ...bridgeBarriers(options.bridges)];
    // options.pathways: every pathway is walkable along its line (pathwayWaypoints).
    const doorNodes = [
        ...doorWaypoints(options.buildings), ...bridgeDoorWaypoints(options.bridges), ...pathwayWaypoints(options.pathways),
        // Routes turn round the open ends of drawn walls.
        ...wallEndWaypoints(wallBorders),
    ];
    const allNodes = nodes;
    const closedBridges = (options.bridges || []).filter((br) => br?.closed && Array.isArray(br.polygon) && br.polygon.length >= 3);
    if (closedBridges.length && nodes) nodes = nodes.filter((n) => !onClosedDeck(n, closedBridges));
    // Visitors have no stored nodes at all, only the outdoor network: the virtual nodes are their map.
    if (doorNodes.length) nodes = [...(nodes || []), ...doorNodes];
    if (!nodes || nodes.length === 0) {
        return { success: false, message: 'No nodes on the map yet.' };
    }
    const destination = nodes.find((n) => String(n.id) === String(destinationId));
    if (!destination) {
        return { success: false, message: 'Destination node not found.' };
    }
    // options.closedBuildingIds: buildings closed right now (openingHours.js): their doors are shut, so
    // routes do not pass through them. Except the one the route goes to (you may still go and wait) and
    // the one you stand in (you can always get out).
    const closed = new Set((options.closedBuildingIds || []).map(String));
    if (closed.size) {
        closed.delete(String(destination.building_id));
        // A destination on a pathway inside the outline (a building with no doors or rooms yet) is that building's too.
        const target = buildingAt(options.buildings || [], Number(destination.latitude), Number(destination.longitude));
        if (target) closed.delete(String(target.id));
        const here = buildingAt(options.buildings || [], userLat, userLng);
        if (here) closed.delete(String(here.id));
        if (closed.size) nodes = nodes.filter((n) => n.building_id == null || !closed.has(String(n.building_id)));
        // Shut doors: the whole outline is a wall (a straight line through two lined-up door gaps no longer passes).
        for (const b of options.buildings || []) {
            if (closed.has(String(b?.id)) && Array.isArray(b.polygon) && b.polygon.length >= 3) {
                borders.push({ coordinates: [...b.polygon, b.polygon[0]] });
            }
        }
    }

    const rainMultiplier = Number.isFinite(Number(options.rainMultiplier)) ? Number(options.rainMultiplier) : 1;
    // Rain falling now or heat mode: either one closes the exposed paths.
    const rainNow = Boolean(options.rainNow || options.heatNow);
    const closedMessage = noRouteMessage({ rain: Boolean(options.rainNow), heat: Boolean(options.heatNow) });
    const links = Array.isArray(options.links) ? options.links : [];
    const userFloor = Number.isFinite(options.userFloor) ? Math.trunc(options.userFloor) : null;
    const destFloor = floorOf(destination);

    // While it is raining, exposed paths are closed to routing. Sheltered
    // paths (anything but the literal 'outside') are untouched.
    if (rainNow && !isRoutable(destination.path_type, { raining_now: true })) {
        return { success: false, message: closedMessage };
    }
    const routableNodes = rainNow
        ? nodes.filter((n) => isRoutable(n.path_type, { raining_now: true }))
        : nodes;
    if (routableNodes.length === 0) {
        return { success: false, message: closedMessage };
    }

    // options.shade — { map, penalty }: on a hot day, sunny exposed edges cost more (shadeRouting.js).
    const shade = options.shade && options.shade.map && options.shade.penalty > 1 ? options.shade : null;
    const graph = buildGraph(routableNodes, borders, rainMultiplier, links, shade);

    // Standing on an upper floor, the user's own height is that floor's, not
    // the ground's, so entry distances are measured flat.
    let startElevation = userElevation;
    if (userFloor !== null) {
        const here = routableNodes.filter((n) => floorOf(n) === userFloor);
        if (here.length > 0) {
            startElevation = here.reduce((sum, n) => sum + (Number(n.elevation) || 0), 0) / here.length;
        }
    }
    const nearbyEntries = findNearbyRouteNodes(routableNodes, userLat, userLng, startElevation, borders, 5, userFloor, destination.id);
    if (nearbyEntries.length === 0) {
        const onThisFloor = routableNodes.some((n) => userFloor === null || floorOf(n) === userFloor);
        return {
            success: false,
            walled_in: onThisFloor,
            message: onThisFloor
                ? 'A wall stands between you and every path nearby. Move your pin onto a walkway or road, or to the right side of the wall.'
                : userFloor !== null
                ? `No route nodes on ${userFloor === 0 ? 'the ground floor' : floorAria(userFloor).toLowerCase()} yet.`
                : 'No route nodes available.',
        };
    }

    // Connect user to the nearby route nodes so Dijkstra can pick the
    // entry point that yields the shortest overall route to the destination.
    // (Entries whose straight line from the user cuts through a border are
    // already excluded, so the path can no longer start on the wrong side
    // of a building and detour through far-away nodes.)
    // The user stands outside, so an entry into a sheltered node is an
    // "entrance" and takes half the rain penalty — same rule as the server.
    graph['__user__'] = {};
    // The first step from where you stand costs like any other: rain, sun on a hot day, and (when it
    // ends on the outdoor network) walking off the paths to get onto it.
    const here = { latitude: userLat, longitude: userLng, path_type: 'outside' };
    for (const entry of nearbyEntries) {
        const ontoNetwork = entry.node.pathway_id != null || entry.node.wall_end;
        graph['__user__'][entry.node.id] = entry.dist
            * edgeRainFactor('outside', entry.node.path_type, rainMultiplier)
            * (shade ? edgeShadeFactor(here, entry.node, shade.map, shade.penalty) : 1)
            * (ontoNetwork ? OFF_PATH_FACTOR : 1);
    }
    let path = dijkstra(graph, '__user__', String(destination.id));

    if (path === null) {
        const needsStairs = userFloor !== null && userFloor !== destFloor;
        // Was a closed bridge the only way? Then say which one and why, not "no walking path".
        let bridgeMessage = null;
        if (closedBridges.length) {
            const open = (options.bridges || []).map((br) => ({ ...br, closed: false }));
            const through = computeRoute(allNodes, destinationId, userLat, userLng, userElevation, wallBorders, { ...options, bridges: open });
            const used = through.success ? closedBridges.find((br) => through.path.some((p) => onClosedDeck(p, [br]))) : null;
            if (used) {
                const reason = String(used.closed_reason || '').trim();
                bridgeMessage = `${used.name || 'The bridge'} is closed${reason ? `: ${reason}` : ''}.`;
            }
        }
        // Was a closed building (opening hours or an announcement) the only way through? Name it.
        let buildingMessage = null;
        if (!bridgeMessage && closed.size) {
            const through = computeRoute(allNodes, destinationId, userLat, userLng, userElevation, wallBorders, { ...options, closedBuildingIds: [] });
            const crossed = through.success
                ? (options.buildings || []).find((b) => closed.has(String(b.id)) && through.path.some((p) => String(p.building_id) === String(b.id)
                    || (Array.isArray(b.polygon) && b.polygon.length >= 3 && pointInPolygon(Number(p.latitude), Number(p.longitude), b.polygon))))
                : null;
            if (crossed) buildingMessage = `The only way there goes through ${crossed.short_name || crossed.name || 'a building'}, which is closed right now.`;
        }
        return {
            success: false,
            closed_bridge: Boolean(bridgeMessage),
            closed_building: Boolean(buildingMessage),
            message: bridgeMessage || buildingMessage || (rainNow
                ? closedMessage
                : needsStairs
                    ? `No staircase connects ${floorPhrase(userFloor)} to ${floorPhrase(destFloor)} yet.`
                    : 'No walking path from where you are to there. Place your pin on a campus path and try again.'),
            needs_stairs: needsStairs,
        };
    }

    // Pull long edges back onto the road network so the drawn line no
    // longer flies over uncounted route nodes (and the distance is honest).
    // Snap only against ROUTABLE nodes: re-inserting a closed (red) node
    // would undo the exclusion above.
    path = snapPathToRoad(path, routableNodes, userLat, userLng, startElevation, borders, userFloor);

    const linkByPair = linkLookup(links);
    const pathNodes = [];
    let accumulated = 0;
    for (let i = 0; i < path.length; i++) {
        const nodeId = path[i];
        if (nodeId === '__user__') {
            pathNodes.push({
                id: null, name: 'Your Location', type: 'user',
                latitude: userLat, longitude: userLng, elevation: startElevation,
                floor_level: userFloor,
                step_distance_m: 0, accumulated_distance_m: 0,
            });
        } else {
            const node = nodes.find((n) => String(n.id) === String(nodeId));
            if (node) {
                let stepDist = 0;
                if (i > 0) {
                    const prevId = path[i - 1];
                    let prevLat, prevLng, prevElev;
                    if (prevId === '__user__') {
                        prevLat = userLat; prevLng = userLng; prevElev = userElevation;
                    } else {
                        const prev = nodes.find((n) => String(n.id) === String(prevId));
                        prevLat = prev.latitude; prevLng = prev.longitude; prevElev = prev.elevation || 0;
                    }
                    stepDist = haversineDistance(prevLat, prevLng, prevElev || 0, node.latitude, node.longitude, node.elevation || 0);
                    // A floor change is a staircase: its walked length is
                    // the incline, the same figure Dijkstra costed.
                    if (prevId !== '__user__') {
                        const prevNode = nodes.find((n) => String(n.id) === String(prevId));
                        if (prevNode && floorOf(prevNode) !== floorOf(node)) {
                            const link = linkByPair.get(linkKey(prevNode.id, node.id));
                            stepDist = stairLength(prevNode, node, link?.angle_deg, link);
                        }
                    }
                    accumulated += stepDist;
                }
                pathNodes.push({
                    id: node.id, name: node.name, type: node.type,
                    building_id: node.building_id ?? null,
                    ...(node.is_door ? { is_door: true } : {}),
                    latitude: node.latitude, longitude: node.longitude, elevation: node.elevation,
                    floor_level: node.floor_level, path_type: node.path_type,
                    step_distance_m: Math.round(stepDist * 10) / 10,
                    accumulated_distance_m: Math.round(accumulated * 10) / 10,
                });
            }
        }
    }

    // Staircases the route climbs or descends, in walking order. `to_index`
    // is the index in `path` of the node on the far side (first node of the
    // new floor); `from_index` is the node at the foot of the stairs.
    const stairs = [];
    for (let i = 1; i < pathNodes.length; i++) {
        const prev = pathNodes[i - 1];
        const cur = pathNodes[i];
        if (prev.type === 'user' || cur.type === 'user') continue;
        const fa = floorOf(prev);
        const fb = floorOf(cur);
        if (fa === fb) continue;
        const link = linkByPair.get(linkKey(prev.id, cur.id));
        const angle = clampStairAngle(link?.angle_deg);
        // Shape of this staircase: direction (yaw), flights, landing and a
        // spoken instruction, so the AR view and the route card can draw and
        // describe the real thing instead of a single ramp.
        const shape = describeStair(link, prev, cur, floorAria(fb).toLowerCase());
        stairs.push({
            from_index: i - 1, to_index: i,
            from_id: prev.id, to_id: cur.id,
            from_floor: fa, to_floor: fb,
            angle_deg: angle,
            length_m: Math.round(cur.step_distance_m * 10) / 10,
            ...shape,
        });
        prev.stairs_to_next = { to_floor: fb, direction: fb > fa ? 'up' : 'down', angle_deg: angle };
    }

    return {
        success: true, path: pathNodes,
        total_distance_meters: Math.round(accumulated * 10) / 10,
        node_count: pathNodes.length,
        start_floor: userFloor,
        end_floor: destFloor,
        stairs,
    };
}
