// Buildings and pathways: pure helpers shared by the admin map, the student
// map and the node form. No Leaflet / DOM here, so this file is unit-tested in
// plain Node (campusGeometry.test.mjs).
//
// Shapes are stored as [{lat, lng}, ...]. A building polygon is one outer ring
// (first point NOT repeated at the end); a pathway is an open polyline.

export const BUILDING_STATUSES = [
    { value: 'existing', label: 'Existing' },
    { value: 'under_construction', label: 'Under construction' },
    { value: 'planned', label: 'Planned' },
];

export const PATHWAY_KINDS = [
    { value: 'walkway', label: 'Walkway' },
    { value: 'covered', label: 'Covered walkway' },
    { value: 'road', label: 'Road' },
];

// Connectors people walk THROUGH (app/Models/Bridge.php KINDS). A new kind of connector
// (a skywalk, a tunnel) is one more entry here and in Bridge::KINDS.
export const BRIDGE_KINDS = [
    { value: 'bridge', label: 'Footbridge' },
];

// Highest deck floor the editor offers (= Bridge::MAX_DECK_FLOOR).
export const MAX_DECK_FLOOR = 5;

/** A storey's height when none is measured (Bridge::STOREY_M, like buildings on the maps). */
const STOREY_M = 3.2;

export const bridgeKindLabel = (kind) => BRIDGE_KINDS.find((k) => k.value === kind)?.label || 'Footbridge';

/** Deck height above the ground (m): the measured one, else deck_floor x 3.2 m (0 = at ground level). */
export function bridgeDeckHeightM(bridge) {
    const measured = Number(bridge?.deck_height_m);
    if (Number.isFinite(measured) && measured > 0) return measured;
    return Math.max(0, Number(bridge?.deck_floor) || 0) * STOREY_M;
}

/** "At ground level", "1 floor up", "2 floors up". */
export function deckLevelLabel(deckFloor) {
    const f = Math.max(0, Number(deckFloor) || 0);
    if (f === 0) return 'At ground level';
    return `${f} ${f === 1 ? 'floor' : 'floors'} up`;
}

export const statusLabel = (status) => BUILDING_STATUSES.find((s) => s.value === status)?.label || 'Existing';
export const kindLabel = (kind) => PATHWAY_KINDS.find((k) => k.value === kind)?.label || 'Walkway';

/** Centre of a polygon's area (falls back to the vertex average for slivers). */
export function polygonCentroid(points) {
    if (!Array.isArray(points) || points.length === 0) return null;
    // Work relative to the first vertex: products of raw lat/lng (~122 × 7)
    // cancel badly and lose the precision a 20 m building needs.
    const o = points[0];
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const ax = points[j].lng - o.lng;
        const ay = points[j].lat - o.lat;
        const bx = points[i].lng - o.lng;
        const by = points[i].lat - o.lat;
        const cross = ax * by - bx * ay;
        area += cross;
        cx += (ax + bx) * cross;
        cy += (ay + by) * cross;
    }
    if (Math.abs(area) < 1e-16) {
        const n = points.length;
        return {
            lat: points.reduce((s, p) => s + p.lat, 0) / n,
            lng: points.reduce((s, p) => s + p.lng, 0) / n,
        };
    }
    return { lat: o.lat + cy / (3 * area), lng: o.lng + cx / (3 * area) };
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(lat, lng, points) {
    if (!Array.isArray(points) || points.length < 3) return false;
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const a = points[i];
        const b = points[j];
        if ((a.lat > lat) !== (b.lat > lat)
            && lng < ((b.lng - a.lng) * (lat - a.lat)) / (b.lat - a.lat) + a.lng) {
            inside = !inside;
        }
    }
    return inside;
}

/** The building whose outline contains a point (smallest one if they overlap). */
export function buildingAt(buildings, lat, lng) {
    let best = null;
    let bestArea = Infinity;
    for (const b of buildings || []) {
        if (!pointInPolygon(lat, lng, b.polygon)) continue;
        const area = Math.abs(ringArea(b.polygon));
        if (area < bestArea) { best = b; bestArea = area; }
    }
    return best;
}

function ringArea(points) {
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        area += points[j].lng * points[i].lat - points[i].lng * points[j].lat;
    }
    return area / 2;
}

/** Floor levels a building has, ground first (0 = ground ... floors - 1). */
export function buildingFloors(building) {
    if (!building) return [];
    const floors = Math.max(1, Number(building.floors) || 1);
    const out = [];
    for (let f = 0; f <= floors - 1; f += 1) out.push(f);
    return out;
}

/** "1 floor", "4 floors". */
export function floorCountLabel(building) {
    if (!building) return '';
    const floors = Math.max(1, Number(building.floors) || 1);
    return `${floors} ${floors === 1 ? 'floor' : 'floors'}`;
}

/** Text a node gets in popups / search: "Main Library · Floor 2 of 4". */
export function nodePlaceLabel(node, buildingsById) {
    const building = node?.building_id != null ? buildingsById?.get(node.building_id) : null;
    if (!building) return '';
    const floor = Number(node.floor_level) || 0;
    const floors = Math.max(1, Number(building.floors) || 1);
    // Ground counts as floor 1 (see floors.js): level 1 reads "Floor 2 of 3".
    const where = floor < 0 ? `Basement ${Math.abs(floor)}` : floor === 0 ? 'Ground floor' : `Floor ${floor + 1}`;
    return `${building.name} · ${where} of ${floors}`;
}

/**
 * Stable fingerprint for an OSM shape copied out of the vector tiles: the
 * tile feature id when the archive has one, otherwise its rounded centre.
 * Stored as `osm_ref` so an adopted footprint is not offered again.
 */
export function osmRef(kind, featureId, points) {
    if (featureId !== undefined && featureId !== null && featureId !== 0) return `${kind}:${featureId}`;
    const c = polygonCentroid(points) || { lat: 0, lng: 0 };
    return `${kind}@${c.lat.toFixed(5)},${c.lng.toFixed(5)}`;
}

/** Distance in metres from a point to a polyline (flat-earth, campus scale). */
export function distanceToLineM(lat, lng, line) {
    if (!Array.isArray(line) || line.length === 0) return Infinity;
    const kLat = 111320;
    const kLng = 111320 * Math.cos((lat * Math.PI) / 180);
    const px = (p) => [(p.lng - lng) * kLng, (p.lat - lat) * kLat];
    let best = Infinity;
    for (let i = 0; i < line.length; i += 1) {
        const [ax, ay] = px(line[i]);
        if (i === 0 || line.length === 1) best = Math.min(best, Math.hypot(ax, ay));
        if (i === 0) continue;
        const [bx, by] = px(line[i - 1]);
        const dx = ax - bx;
        const dy = ay - by;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(bx * dx + by * dy) / len2));
        best = Math.min(best, Math.hypot(bx + t * dx, by + t * dy));
    }
    return best;
}

/**
 * A point guaranteed to be inside the polygon, as central as practical: the
 * area centre when it falls inside (convex shapes), otherwise the inside grid
 * point nearest to it. An L-shaped building's centre lies in its notch, so
 * placing a room "in the middle" must not use the plain centre.
 */
export function interiorPoint(points) {
    const c = polygonCentroid(points);
    if (!c) return null;
    if (pointInPolygon(c.lat, c.lng, points)) return c;
    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const [s, n, w, e] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
    let best = null;
    let bestD = Infinity;
    const STEPS = 24;
    for (let i = 1; i < STEPS; i += 1) {
        for (let j = 1; j < STEPS; j += 1) {
            const lat = s + ((n - s) * i) / STEPS;
            const lng = w + ((e - w) * j) / STEPS;
            if (!pointInPolygon(lat, lng, points)) continue;
            const d = (lat - c.lat) ** 2 + (lng - c.lng) ** 2;
            if (d < bestD) { bestD = d; best = { lat, lng }; }
        }
    }
    return best || points[0];
}
