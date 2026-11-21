import test from 'node:test';
import assert from 'node:assert/strict';
import { convexHull, clipToConvex, subtractConvex, segmentInside, cutStairwells } from './planarGeometry.js';

const area = (poly) => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p.x * q.z - q.x * p.z; }, 0)) / 2;

test('convexHull keeps the outer corners only', () => {
    const hull = convexHull([{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }, { x: 1, z: 1 }, { x: 1, z: 0 }]);
    assert.equal(hull.length, 4);
    assert.equal(area(hull), 4);
});

test('clipToConvex: the part of a deck over a staircase', () => {
    const deck = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 3 }, { x: 0, z: 3 }];
    // Stairs half under the deck's end, half beyond it.
    const stairs = convexHull([{ x: 8, z: 1 }, { x: 12, z: 1 }, { x: 12, z: 2 }, { x: 8, z: 2 }]);
    const well = clipToConvex(deck, stairs);
    assert.ok(Math.abs(area(well) - 2) < 1e-9);       // 2 m x 1 m under the deck
    assert.ok(well.every((p) => p.x <= 10 + 1e-9));
    // Stairs away from the deck: no stairwell.
    assert.equal(clipToConvex(deck, convexHull([{ x: 20, z: 0 }, { x: 22, z: 0 }, { x: 21, z: 2 }])).length, 0);
    // An L-shaped (concave) deck is clipped correctly too.
    const ell = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 1 }, { x: 1, z: 1 }, { x: 1, z: 4 }, { x: 0, z: 4 }];
    assert.ok(Math.abs(area(clipToConvex(ell, convexHull([{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }]))) - 7) < 1e-9);
});

test('subtractConvex cuts a hole out as non-overlapping pieces, even one crossing the edge', () => {
    const sq = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
    const total = (pieces) => pieces.reduce((s, p) => s + area(p), 0);
    const deck = sq(0, 0, 10, 10);
    assert.ok(Math.abs(total(subtractConvex(deck, sq(4, 4, 6, 6))) - 96) < 1e-9);
    // Stairs running out past the deck's edge: only the part over the deck is cut.
    assert.ok(Math.abs(total(subtractConvex(deck, sq(8, 4, 12, 6))) - 96) < 1e-9);
    // Clockwise hole, nowhere near: the deck is whole.
    assert.ok(Math.abs(total(subtractConvex(deck, [...sq(20, 20, 22, 22)].reverse())) - 100) < 1e-9);
    // L-shaped (concave) deck with a hole in its corner.
    const ell = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 1 }, { x: 1, z: 1 }, { x: 1, z: 4 }, { x: 0, z: 4 }];
    assert.ok(Math.abs(total(subtractConvex(ell, sq(0, 0, 1, 1))) - 6) < 1e-9);
});

test('segmentInside keeps only the parts over a concave deck', () => {
    const ell = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 1 }, { x: 1, z: 1 }, { x: 1, z: 4 }, { x: 0, z: 4 }];
    // Diagonal across the L's notch: in, out over the notch, back in.
    const parts = segmentInside({ x: 0.5, z: 3 }, { x: 3, z: 0.5 }, ell);
    assert.equal(parts.length, 2);
    assert.ok(Math.abs(parts[0][1].x - 1) < 1e-9 && Math.abs(parts[1][0].z - 1) < 1e-9);
    assert.equal(segmentInside({ x: 5, z: 5 }, { x: 6, z: 6 }, ell).length, 0);
    // Running out past the edge: cut at the edge.
    const [[from, to]] = segmentInside({ x: 0.5, z: 0.5 }, { x: 0.5, z: 9 }, ell);
    assert.ok(from.z === 0.5 && Math.abs(to.z - 4) < 1e-9);
});

test('cutStairwells: two openings side by side leave no wall between them', () => {
    const sq = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
    const deck = sq(0, 0, 10, 4);
    // A flight and its landing, sharing the edge x = 5, the landing reaching the deck's edge z = 4.
    const { pieces, outline, wellEdges } = cutStairwells(deck, [sq(2, 1, 5, 2.5), sq(5, 1, 6.5, 4)]);
    const total = pieces.reduce((s, p) => s + area(p), 0);
    assert.ok(Math.abs(total - (40 - 4.5 - 4.5)) < 0.3, `deck left: ${total}`);
    assert.ok(!wellEdges.some(([p, q]) => Math.abs(p.x - 5) < 0.05 && Math.abs(q.x - 5) < 0.05 && Math.min(p.z, q.z) < 2.4), 'no wall on the shared edge');
    // The deck's far edge is open over the landing.
    const far = outline.filter(([p, q]) => Math.abs(p.z - 4) < 1e-9 && Math.abs(q.z - 4) < 1e-9);
    assert.equal(far.length, 2);
});
