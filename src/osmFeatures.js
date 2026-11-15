// OpenStreetMap shapes inside the campus box, read straight out of the same
// PMTiles archive the base map draws (no extra download, works offline once
// the archive is cached).
//
// The archive's `buildings` layer has outlines but no names, and its `roads`
// layer has the road/footpath network. The admin map offers these shapes as
// "adopt this one" candidates: tapping a footprint copies its outline into a
// new labelled building; tapping a road copies its line into a pathway.
//
// pmtiles, @mapbox/vector-tile and pbf are the libraries protomaps-leaflet
// already ships with (campusMap.js imports pmtiles the same way); nothing new
// is installed.
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { openCampusArchive, CAMPUS_BOUNDS } from './campusMap.js';
import { osmRef, polygonCentroid } from './campusGeometry.js';

const lon2tile = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2tile = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

const toPoints = (ring) => ring.map(([lng, lat]) => ({ lat, lng }));
const openRing = (pts) => {
    const a = pts[0];
    const b = pts[pts.length - 1];
    return pts.length > 1 && a.lat === b.lat && a.lng === b.lng ? pts.slice(0, -1) : pts;
};
const inCampus = (p) => p
    && p.lat >= CAMPUS_BOUNDS[0][0] && p.lat <= CAMPUS_BOUNDS[1][0]
    && p.lng >= CAMPUS_BOUNDS[0][1] && p.lng <= CAMPUS_BOUNDS[1][1];
const roughSize = (pts) => {
    let s = 0;
    for (let i = 1; i < pts.length; i += 1) s += Math.hypot(pts[i].lat - pts[i - 1].lat, pts[i].lng - pts[i - 1].lng);
    return s;
};

let cache = null;

/**
 * @returns {Promise<{buildings: Array<{ref: string, polygon: Array<{lat:number,lng:number}>}>,
 *                    roads: Array<{ref: string, name: string|null, kind: string, coordinates: Array<{lat:number,lng:number}>}>}>}
 */
export function loadOsmFeatures() {
    if (!cache) cache = readArchive().catch((err) => { cache = null; throw err; });
    return cache;
}

async function readArchive() {
    const archive = openCampusArchive();
    const header = await archive.getHeader();
    // Deepest zoom = most detailed outlines.
    const z = header.maxZoom;
    const [[south, west], [north, east]] = CAMPUS_BOUNDS;

    // Shapes crossing a tile edge arrive once per tile, clipped. Keep the
    // biggest piece per fingerprint (the admin can still reshape it).
    const buildings = new Map();
    const roads = new Map();

    for (let x = lon2tile(west, z); x <= lon2tile(east, z); x += 1) {
        for (let y = lat2tile(north, z); y <= lat2tile(south, z); y += 1) {
            const tile = await archive.getZxy(z, x, y);
            if (!tile?.data) continue;
            const vt = new VectorTile(new Pbf(new Uint8Array(tile.data)));

            const bLayer = vt.layers.buildings;
            for (let i = 0; bLayer && i < bLayer.length; i += 1) {
                const f = bLayer.feature(i);
                const g = f.toGeoJSON(x, y, z).geometry;
                const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];
                rings.forEach((ring, k) => {
                    const polygon = openRing(toPoints(ring));
                    if (polygon.length < 3 || !inCampus(polygonCentroid(polygon))) return;
                    const ref = osmRef('building', f.id != null ? `${f.id}${k ? `-${k}` : ''}` : null, polygon);
                    const prev = buildings.get(ref);
                    if (!prev || roughSize(polygon) > roughSize(prev.polygon)) buildings.set(ref, { ref, polygon });
                });
            }

            const rLayer = vt.layers.roads;
            for (let i = 0; rLayer && i < rLayer.length; i += 1) {
                const f = rLayer.feature(i);
                const g = f.toGeoJSON(x, y, z).geometry;
                const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
                const kind = String(f.properties.kind || '');
                lines.forEach((line, k) => {
                    const coordinates = toPoints(line).filter(inCampus);
                    if (coordinates.length < 2) return;
                    const ref = osmRef('road', f.id != null ? `${f.id}-${k}` : null, coordinates);
                    const prev = roads.get(ref);
                    if (!prev || roughSize(coordinates) > roughSize(prev.coordinates)) {
                        roads.set(ref, {
                            ref,
                            name: typeof f.properties.name === 'string' ? f.properties.name : null,
                            // OSM footpaths become walkways; everything else is a road.
                            kind: kind === 'path' ? 'walkway' : 'road',
                            coordinates,
                        });
                    }
                });
            }
        }
    }

    return { buildings: [...buildings.values()], roads: [...roads.values()] };
}
