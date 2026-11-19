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
