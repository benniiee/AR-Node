// Direction arrows for the 2D route line - the flat counterpart of the 3D
// view's marching chevrons. Plain Leaflet divIcons, one per stretch of path,
// each rotated to the heading of the segment it sits on (0 deg = north, the
// map never rotates). Used by the 2D screen and the 3D view's mini-map so
// both draw the same cue.
import L from 'leaflet';
import { toLocalMeters } from './geo.js';

// A chevron drawn twice: a dark under-stroke keeps it readable on the white
// route line and on any tile colour, the white stroke on top is the arrow itself.
const CHEVRON = '<svg width="20" height="20" viewBox="-10 -10 20 20" aria-hidden="true">'
    + '<path d="M-5.5 3.5 L0 -3.5 L5.5 3.5" fill="none" stroke="rgba(0,0,0,0.55)" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M-5.5 3.5 L0 -3.5 L5.5 3.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';

function arrowIcon(bearing) {
    return L.divIcon({
        className: '',
        html: `<div style="width:20px;height:20px;transform:rotate(${bearing.toFixed(1)}deg);pointer-events:none;">${CHEVRON}</div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
    });
}

/**
 * Points along a path at a fixed spacing, each with the heading of its segment.
 * Pure maths (no Leaflet), so it can be tested on its own.
 * @param {Array<[number, number]>} latlngs path as [lat, lng] pairs
 * @param {number} spacingM metres between arrows
 * @returns {Array<{ lat: number, lng: number, bearing: number }>}
 */
export function sampleRouteArrows(latlngs, spacingM) {
    if (!Array.isArray(latlngs) || latlngs.length < 2 || !(spacingM > 0)) return [];
    const [refLat, refLng] = latlngs[0];
    const pts = latlngs.map(([lat, lng]) => toLocalMeters(lat, lng, refLat, refLng));
    const out = [];
    // First arrow half a step in; the last stays clear of the destination dot.
    let next = spacingM / 2;
    let walked = 0;
    let total = 0;
    for (let i = 1; i < pts.length; i += 1) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const stopAt = total - Math.min(spacingM * 0.6, total * 0.5);
    for (let i = 1; i < pts.length; i += 1) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len === 0) continue;
        const bearing = ((Math.atan2(x1 - x0, y1 - y0) * 180) / Math.PI + 360) % 360;
        while (next <= walked + len && next <= stopAt) {
            const t = (next - walked) / len;
            const [lat0, lng0] = latlngs[i - 1];
            const [lat1, lng1] = latlngs[i];
            out.push({ lat: lat0 + (lat1 - lat0) * t, lng: lng0 + (lng1 - lng0) * t, bearing });
            next += spacingM;
        }
        walked += len;
    }
    return out;
}

/** Roughly 46 screen pixels between arrows, whatever the zoom. */
export function arrowSpacingMeters(zoom, lat) {
    const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / (2 ** zoom);
    return Math.max(4, metersPerPixel * 46);
}

/** Non-interactive arrow markers for a route, ready to add to any layer group. */
export function routeArrowMarkers(latlngs, zoom) {
    if (!latlngs || latlngs.length < 2) return [];
    const spacing = arrowSpacingMeters(zoom, latlngs[0][0]);
    return sampleRouteArrows(latlngs, spacing).map((a) => L.marker([a.lat, a.lng], {
        icon: arrowIcon(a.bearing), interactive: false, keyboard: false, zIndexOffset: 500,
    }));
}
