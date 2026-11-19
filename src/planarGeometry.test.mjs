import test from 'node:test';
import assert from 'node:assert/strict';
import { convexHull, clipToConvex } from './planarGeometry.js';

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
