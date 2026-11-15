import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceAlongRoute } from './routeProgress.js';

// Positions are plain metres along one line so distances are easy to read.
const stop = (x, floor = 0, extra = {}) => ({ x, floor_level: floor, ...extra });
const dist = (u, p) => Math.abs(u.x - p.x);

// Ground floor to the foot of the stairs (x = 10), up to floor 2 (floor_level 1)
// right above it, then to the room at x = 14 on floor 2.
const path = [
    { type: 'user', x: 0, floor_level: 0 },
    stop(5), stop(10), stop(10.5, 1), stop(14, 1, { name: 'LR1' }),
];

test('standing on the ground floor under the floor-2 room is not arriving', () => {
    let r = { idx: 1 };
    for (let k = 0; k < 3; k += 1) r = advanceAlongRoute(path, r.idx, { x: 13 }, 0, dist);
    assert.equal(r.arrived, false);
    // It waits at the first floor-2 stop: the stairs come first.
    assert.equal(r.idx, 3);
});

test('on floor 2, next to the room, the walker has arrived', () => {
    let r = { idx: 3 };
    for (let k = 0; k < 3; k += 1) r = advanceAlongRoute(path, r.idx, { x: 13 }, 1, dist);
    assert.equal(r.idx, 4);
    assert.equal(r.arrived, true);
});

test('far from the room on its floor is not arriving either', () => {
    const r = advanceAlongRoute(path, 4, { x: 40 }, 1, dist);
    assert.equal(r.arrived, false);
});

test('a one-floor route still arrives by distance alone', () => {
    const flat = [{ type: 'user', x: 0 }, stop(5), stop(9, 0, { name: 'Lab' })];
    let r = { idx: 1 };
    for (let k = 0; k < 3; k += 1) r = advanceAlongRoute(flat, r.idx, { x: 8 }, 0, dist);
    assert.equal(r.arrived, true);
});

test('unknown floor keeps the distance-only rule', () => {
    let r = { idx: 1 };
    for (let k = 0; k < 4; k += 1) r = advanceAlongRoute(path, r.idx, { x: 13 }, null, dist);
    assert.equal(r.arrived, true);
});
