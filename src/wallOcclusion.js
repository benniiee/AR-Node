// Wall occlusion for the 3D AR views.
//
// The admin map's "walls" (borders) are 2D polylines in lat/lng. Routing already
// refuses to cross them; this module lets the 3D view respect them too: a node
// or arrow that sits on the far side of a wall, seen from the camera, is not
// drawn. Walls have no authored height, so they are treated as blocking at any
// eye height (a ceiling-to-floor wall). Everything is plain XZ-plane maths in
// the same world frame as the scene (x = east, z = -north), no WebGL needed.
import { anchorENU } from './arMath.js';

/** Stop the sight line this far short of the target, so a node that sits ON a
 *  wall line (a doorway, say) is never hidden by the wall it stands in. */
export const WALL_TARGET_MARGIN_M = 0.35;

/**
 * Convert border polylines to world-frame segments.
 * @param {Array<{coordinates: Array<{lat:number,lng:number}>}>} borders
 * @param {{latitude:number,longitude:number}} anchor scene origin
 * @returns {Array<{ax:number,az:number,bx:number,bz:number}>}
 */
export function buildWallSegments(borders, anchor) {
    const segs = [];
    if (!borders || !anchor) return segs;
    for (const border of borders) {
        const pts = border?.coordinates;
        if (!pts || pts.length < 2) continue;
        const world = pts.map((c) => {
            const o = anchorENU(anchor, { latitude: c.lat ?? c.latitude, longitude: c.lng ?? c.longitude });
            return { x: o.x, z: o.z };
        });
        for (let i = 0; i + 1 < world.length; i += 1) {
            const a = world[i];
            const b = world[i + 1];
            if (![a.x, a.z, b.x, b.z].every(Number.isFinite)) continue;
            segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
        }
    }
    return segs;
}

/**
 * Segment/segment intersection in the XZ plane: where along the sight line
 * (0 = camera, 1 = target) it crosses the wall, or -1 when it does not.
 */
function crossAt(px, pz, qx, qz, s) {
    const d1x = qx - px;
    const d1z = qz - pz;
    const d2x = s.bx - s.ax;
    const d2z = s.bz - s.az;
    const cross = d1x * d2z - d1z * d2x;
    if (Math.abs(cross) < 1e-9) return -1; // parallel
    const t = ((s.ax - px) * d2z - (s.az - pz) * d2x) / cross;
    const u = ((s.ax - px) * d1z - (s.az - pz) * d1x) / cross;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/**
 * Is the straight line from the camera to (x, z) blocked by a wall?
 * Admin walls have no height and block at any eye height. A segment with a
 * `top` (world y, e.g. a building's roof line) blocks only when the sight line
 * passes below that top where it crosses, so a raised view can see over a low
 * building. Heights are used only when both camY and targetY are given.
 * @param {number} camX
 * @param {number} camZ
 * @param {number} x target world x
 * @param {number} z target world z
 * @param {Array<{ax:number,az:number,bx:number,bz:number,top?:number}>} segments
 * @param {number} [camY] camera world y
 * @param {number} [targetY] target world y
 */
export function isOccluded(camX, camZ, x, z, segments, camY, targetY) {
    if (!segments || segments.length === 0) return false;
    const dx = x - camX;
    const dz = z - camZ;
    const len = Math.hypot(dx, dz);
    if (!(len > WALL_TARGET_MARGIN_M)) return false;
    const k = (len - WALL_TARGET_MARGIN_M) / len;
    const qx = camX + dx * k;
    const qz = camZ + dz * k;
    const withHeight = Number.isFinite(camY) && Number.isFinite(targetY);
    for (const s of segments) {
        const t = crossAt(camX, camZ, qx, qz, s);
        if (t < 0) continue;
        if (!withHeight || !Number.isFinite(s.top)) return true;
        // t runs over the shortened line; the sight line's height there.
        const yAt = camY + (targetY - camY) * t * k;
        if (yAt < s.top) return true;
    }
    return false;
}
