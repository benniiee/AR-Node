// Direction on the 2D maps: small chevrons along the (blue) route pointing towards the destination, and a
// large raised arrow at your position pointing the way to walk from here. Before, the map showed the line
// but not which way to start along it; the direction card is only in the 3D and AR views.
// The geometry lives here (testable without a browser); campusLayers.js draws it.
import { toLocalMeters } from './geo.js';

/** Bearing in degrees (0 = north, clockwise) from a to b, both [lat, lng]. */
export function bearingDeg(a, b) {
    const [e, n] = toLocalMeters(b[0], b[1], a[0], a[1]);
    return ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
}

const lengthM = (a, b) => Math.hypot(...toLocalMeters(b[0], b[1], a[0], a[1]));

/**
 * Points every `everyM` metres along a polyline of [lat, lng] (the first `startM` metres left clear),
 * each with the bearing of the stretch it sits on: where the chevrons go.
 *
 * @returns {Array<{ lat: number, lng: number, bearing: number }>}
 */
export function arrowsAlong(latlngs, everyM = 14, startM = 6) {
    const out = [];
    let next = startM;
    let walked = 0;
    for (let i = 1; i < (latlngs || []).length; i += 1) {
        const a = latlngs[i - 1];
        const b = latlngs[i];
        const len = lengthM(a, b);
        if (len < 1e-6) continue;
        while (next <= walked + len) {
            const t = (next - walked) / len;
            out.push({ lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t, bearing: bearingDeg(a, b) });
            next += everyM;
        }
        walked += len;
    }
    return out;
}

/** The point `aheadM` metres along the polyline from its start (its end if shorter), as [lat, lng]. */
export function pointAhead(latlngs, aheadM) {
    let walked = 0;
    for (let i = 1; i < (latlngs || []).length; i += 1) {
        const a = latlngs[i - 1];
        const b = latlngs[i];
        const len = lengthM(a, b);
        if (walked + len >= aheadM && len > 0) {
            const t = (aheadM - walked) / len;
            return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        }
        walked += len;
    }
    return latlngs?.length ? latlngs[latlngs.length - 1] : null;
}

/** Which way to start walking from the route's first point: towards the point a few metres ahead. */
export function startBearing(latlngs, aheadM = 8) {
    if (!latlngs || latlngs.length < 2) return null;
    const ahead = pointAhead(latlngs, aheadM);
    return ahead && lengthM(latlngs[0], ahead) > 0.5 ? bearingDeg(latlngs[0], ahead) : null;
}
