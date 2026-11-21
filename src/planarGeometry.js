// Flat-plane polygon helpers on {x, z} points (the 3D views' ground plane). No three.js or
// DOM here, so they are unit-tested in plain Node (planarGeometry.test.mjs).

/** Convex hull of points {x, z} (monotone chain), counter-clockwise in x/z. */
export function convexHull(points) {
    const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i -= 1) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The part of polygon `subject` inside the CONVEX polygon `clip` (Sutherland-Hodgman), both [{x, z}]. */
export function clipToConvex(subject, clip) {
    if (clip.length < 3) return [];
    const area = clip.reduce((sum, p, i) => { const q = clip[(i + 1) % clip.length]; return sum + p.x * q.z - q.x * p.z; }, 0);
    const sign = area >= 0 ? 1 : -1;
    const inside = (p, a, b) => sign * ((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x)) >= 0;
    const meet = (p, q, a, b) => {
        const d = (p.x - q.x) * (a.z - b.z) - (p.z - q.z) * (a.x - b.x);
        if (Math.abs(d) < 1e-12) return q;
        const t = ((p.x - a.x) * (a.z - b.z) - (p.z - a.z) * (a.x - b.x)) / d;
        return { x: p.x + t * (q.x - p.x), z: p.z + t * (q.z - p.z) };
    };
    let out = subject;
    for (let i = 0; i < clip.length && out.length; i += 1) {
        const a = clip[i];
        const b = clip[(i + 1) % clip.length];
        const input = out;
        out = [];
        for (let k = 0; k < input.length; k += 1) {
            const cur = input[k];
            const prev = input[(k + input.length - 1) % input.length];
            if (inside(cur, a, b)) {
                if (!inside(prev, a, b)) out.push(meet(prev, cur, a, b));
                out.push(cur);
            } else if (inside(prev, a, b)) {
                out.push(meet(prev, cur, a, b));
            }
        }
    }
    return out;
}

/** Signed area of polygon {x, z} (positive counter-clockwise in x/z). */
function signedArea(poly) {
    return poly.reduce((sum, p, i) => { const q = poly[(i + 1) % poly.length]; return sum + p.x * q.z - q.x * p.z; }, 0) / 2;
}

/** The part of `poly` on the left of the line a -> b (x/z, counter-clockwise sense), Sutherland-Hodgman. */
function clipLeftOf(poly, a, b) {
    const side = (p) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
    const out = [];
    poly.forEach((cur, k) => {
        const prev = poly[(k + poly.length - 1) % poly.length];
        const sc = side(cur);
        const sp = side(prev);
        if ((sc >= 0) !== (sp >= 0)) {
            const t = sp / (sp - sc);
            out.push({ x: prev.x + t * (cur.x - prev.x), z: prev.z + t * (cur.z - prev.z) });
        }
        if (sc >= 0) out.push(cur);
    });
    return out;
}

/**
 * Polygon `subject` with the CONVEX polygon `hole` cut out, as pieces [[{x, z}]] whose union is the rest
 * (a stairwell cut through a bridge deck). Piece i lies inside the hole's edges before i and outside
 * edge i, so the pieces never overlap. Draw them without outlines: the cuts between them would show.
 */
export function subtractConvex(subject, hole) {
    if (hole.length < 3) return [subject];
    const ccw = signedArea(hole) >= 0 ? hole : [...hole].reverse();
    const pieces = [];
    for (let i = 0; i < ccw.length; i += 1) {
        let piece = clipLeftOf(subject, ccw[(i + 1) % ccw.length], ccw[i]);
        for (let k = 0; k < i && piece.length; k += 1) piece = clipLeftOf(piece, ccw[k], ccw[k + 1]);
        if (piece.length >= 3 && Math.abs(signedArea(piece)) > 1e-6) pieces.push(piece);
    }
    return pieces;
}

/** Whether {x, z} is inside polygon `ring` (ray casting; any winding, concave too). */
function insideRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const a = ring[i];
        const b = ring[j];
        if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
}

/**
 * The parts of segment a -> b inside polygon `ring` (concave too), as [[{x, z}, {x, z}]]: where a
 * stairwell's edge runs over the deck, so its wall and outline are drawn there and nowhere else.
 */
export function segmentInside(a, b, ring) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const ts = [0, 1];
    for (let i = 0; i < ring.length; i += 1) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        const ex = q.x - p.x;
        const ez = q.z - p.z;
        const d = dx * ez - dz * ex;
        if (Math.abs(d) < 1e-12) continue;
        const t = ((p.x - a.x) * ez - (p.z - a.z) * ex) / d;
        const u = ((p.x - a.x) * dz - (p.z - a.z) * dx) / d;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    const at = (t) => ({ x: a.x + dx * t, z: a.z + dz * t });
    const parts = [];
    for (let k = 1; k < ts.length; k += 1) {
        const [t0, t1] = [ts[k - 1], ts[k]];
        if (t1 - t0 < 1e-9 || !insideRing(at((t0 + t1) / 2), ring)) continue;
        const last = parts[parts.length - 1];
        if (last && Math.abs(last.t1 - t0) < 1e-9) last.t1 = t1;
        else parts.push({ t0, t1 });
    }
    return parts.map(({ t0, t1 }) => [at(t0), at(t1)]);
}

/** Convex polygon `poly` grown by about `m` (each corner pushed out from the centre). */
function grow(poly, m) {
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
    const cz = poly.reduce((s, p) => s + p.z, 0) / poly.length;
    return poly.map((p) => {
        const d = Math.hypot(p.x - cx, p.z - cz) || 1;
        return { x: p.x + ((p.x - cx) / d) * m, z: p.z + ((p.z - cz) / d) * m };
    });
}

/**
 * A deck with its stairwells cut out. `holes`: convex openings (one per flight and landing, so an
 * L-shaped staircase does not cut its whole convex hull); `subjects`: what to cut, the deck `ring`
 * or its triangles (convex: exact pieces). Neighbouring openings are grown by 2 cm so the edge they
 * share counts as open. Returns the solid `pieces` to fill, the deck's `outline` where it still has
 * an edge, and the `wellEdges` where an opening's edge runs over the deck: all segments [[p, q]].
 */
export function cutStairwells(ring, holes, subjects = [ring]) {
    const open = holes.map((h) => grow(h, 0.02));
    const pieces = open.reduce((parts, h) => parts.flatMap((p) => subtractConvex(p, h)), subjects);
    const outside = (a, c, skip) => open.reduce((parts, h, k) => (k === skip ? parts : parts.flatMap(([p, q]) => {
        const [cut] = segmentInside(p, q, h);
        return cut ? [[p, cut[0]], [cut[1], q]].filter(([m, n]) => Math.hypot(n.x - m.x, n.z - m.z) > 0.01) : [[p, q]];
    })), [[a, c]]);
    const outline = ring.flatMap((a, i) => outside(a, ring[(i + 1) % ring.length], -1));
    const wellEdges = open.flatMap((h, k) => h.flatMap((a, i) => segmentInside(a, h[(i + 1) % h.length], ring).flatMap(([p, q]) => outside(p, q, k))));
    return { pieces, outline, wellEdges };
}
