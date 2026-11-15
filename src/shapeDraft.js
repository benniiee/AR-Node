// ── Drawing a building outline or a path, one tap at a time ──────────
// The rule the editor follows: a new point joins ONLY the selected point
// (or the last one when nothing is selected), and becomes the selected point,
// so taps chain on from it.
//
//   closed (a building outline): every corner has two neighbours, so the
//     ring is turned until the selected corner is the LAST one, and the new
//     corner is added after it. It then joins the selected corner; the
//     outline closes from it back to the first corner (the editor draws that
//     closing side dashed while drawing). The building keeps its shape.
//   open (a path): a path does not branch, so it only grows from its ends:
//     from the last point (append) or the first (prepend). A middle point
//     cannot be extended.

/**
 * Add `at` to a draft shape, joined to the point at index `anchor` (or the
 * last point when `anchor` is null).
 * @returns {{ points: Array, anchor: number|null } | null} null when the
 *   selected point cannot be extended (a middle point of a path).
 */
export function addJoined(points, anchor, at, { closed = true } = {}) {
    const pts = Array.isArray(points) ? points : [];
    if (anchor === null || anchor === undefined || pts.length === 0) {
        return { points: [...pts, at], anchor: anchor === null || anchor === undefined ? null : pts.length };
    }
    const k = Math.max(0, Math.min(pts.length - 1, anchor));
    if (closed) {
        // Turn the ring so the selected corner is last, then add after it.
        const turned = [...pts.slice(k + 1), ...pts.slice(0, k + 1)];
        return { points: [...turned, at], anchor: turned.length };
    }
    if (k === pts.length - 1) return { points: [...pts, at], anchor: pts.length };
    if (k === 0) return { points: [at, ...pts], anchor: 0 };
    return null;
}

/** Can the point at `index` be extended (always for outlines; ends only for paths)? */
export function canExtendFrom(points, index, { closed = true } = {}) {
    if (closed) return true;
    return index === 0 || index === (points?.length || 0) - 1;
}
