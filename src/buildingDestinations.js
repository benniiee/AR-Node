// ── Buildings as destinations (/map) ─────────────────────────────────
// A student can pick a whole building ("College of Computing Studies") as
// well as a room inside it. A building destination has the id "b:<id>" in
// the destination list. Its route ends at the building's way in:
//   - its doors when it has some (the nearest one, by route length), else
//   - its ground-floor nodes (rooms or route nodes inside), else
//   - the network node nearest the building (callers pass the pathways'
//     points too: most of the outdoor network is pathways, not nodes).
import { doorWaypoints, snapToOutline } from './doors.js';
import { interiorPoint, buildingAt } from './campusGeometry.js';
import { floorOf } from './floors.js';
import { toLocalMeters } from './geo.js';

const PREFIX = 'b:';

/** "b:2" for building 2. */
export const buildingDestinationId = (id) => `${PREFIX}${id}`;

/** The building id in a destination id, or null for a node destination. */
export function parseBuildingDestination(destId) {
    const s = String(destId ?? '');
    if (!s.startsWith(PREFIX)) return null;
    const id = Number(s.slice(PREFIX.length));
    return Number.isFinite(id) ? id : null;
}

/**
 * The building as an entry of the destination list (same shape as a
 * location node, so the list can sort, search and group it the same way).
 */
export function buildingDestination(b) {
    const c = interiorPoint(b.polygon) || b.polygon[0];
    return {
        id: buildingDestinationId(b.id), type: 'building', is_building: true,
        name: b.name || b.short_name || 'Building', short_name: b.short_name || null,
        building_id: b.id, floor_level: 0, campus: b.campus === 'B' ? 'B' : 'A',
        latitude: c.lat, longitude: c.lng,
    };
}

/** Buildings students can be routed to: built ones with an outline. */
export function routableBuildings(buildings) {
    return (buildings || []).filter((b) => b && b.status !== 'planned' && Array.isArray(b.polygon) && b.polygon.length >= 3);
}

/**
 * Node ids a route to building `b` may end at (see the top of this file),
 * nearest first. Door ids are the virtual door nodes computeRoute adds.
 */
export function buildingTargets(b, nodes, { limit = 4 } = {}) {
    const c = interiorPoint(b.polygon) || b.polygon[0];
    const dist = (n) => Math.hypot(...toLocalMeters(n.latitude, n.longitude, c.lat, c.lng));
    const doors = doorWaypoints([b]);
    if (doors.length) return doors.map((d) => d.id);
    const inside = (nodes || []).filter((n) => floorOf(n) === 0
        && (n.building_id === b.id || buildingAt([b], n.latitude, n.longitude)));
    if (inside.length) return inside.sort((x, y) => dist(x) - dist(y)).slice(0, limit).map((n) => n.id);
    // Nearest to the building's WALLS, not its centre: beside a long building, the walkway along its side
    // is the way in, not a point that happens to be level with its middle.
    const toWall = (n) => snapToOutline(b.polygon, n.latitude, n.longitude)?.distM ?? dist(n);
    const ground = (nodes || []).filter((n) => floorOf(n) === 0);
    return ground.sort((x, y) => toWall(x) - toWall(y)).slice(0, 1).map((n) => n.id);
}

/**
 * Route to a building: try each target with `route(targetId)` (a
 * computeRoute call) and keep the shortest success, or the first failure.
 */
export function routeToBuilding(b, nodes, route) {
    let best = null;
    let firstFail = null;
    for (const id of buildingTargets(b, nodes)) {
        const r = route(id);
        if (r?.success) {
            if (!best || r.total_distance_meters < best.total_distance_meters) best = r;
        } else if (!firstFail) firstFail = r;
    }
    return best || firstFail || { success: false, message: 'No walking path from where you are to this building. Place your pin on a campus path and try again.' };
}
