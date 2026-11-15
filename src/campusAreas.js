// Campus areas: named outlines an admin draws (Campus A, Campus B, ...).
//
// Membership is by position, the same test as App\Models\CampusArea::contains():
// a node is on the campus whose outline contains it; a building by its centre.
// Nothing is stored per node, so moving a node or redrawing an outline never
// leaves a stale campus behind.
import { polygonCentroid } from './campusGeometry.js';

/** Ray casting on lat/lng (exact enough at campus scale). */
export function pointInArea(lat, lng, polygon) {
    const ring = Array.isArray(polygon) ? polygon : [];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const yi = Number(ring[i].lat);
        const xi = Number(ring[i].lng);
        const yj = Number(ring[j].lat);
        const xj = Number(ring[j].lng);
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** The area containing this point (the first, by name, if outlines overlap), or null. */
export function areaAt(lat, lng, areas) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
    return (areas || []).find((a) => pointInArea(la, ln, a.polygon)) || null;
}

/** Campus of a node ({latitude, longitude}). */
export function nodeArea(node, areas) {
    return node ? areaAt(node.latitude, node.longitude, areas) : null;
}

/** Campus of a building: where its outline's centre falls. */
export function buildingArea(building, areas) {
    const ring = building?.polygon;
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const c = polygonCentroid(ring);
    return c ? areaAt(c.lat, c.lng, areas) : null;
}

/**
 * Filter for "show one campus". `filterId` is 'all', 'none' (outside every
 * area) or an area id. Returns a predicate over the area a thing belongs to.
 */
export function campusMatcher(filterId, areas) {
    if (filterId === 'all' || filterId === undefined || filterId === null) return () => true;
    if (filterId === 'none') return (area) => area === null;
    const id = String(filterId);
    if (!(areas || []).some((a) => String(a.id) === id)) return () => true; // the area was removed
    return (area) => area !== null && String(area.id) === id;
}
