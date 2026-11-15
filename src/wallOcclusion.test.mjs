import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOccluded } from './wallOcclusion.js';

// A wall along x = 5 from z = -10 to z = 10, between the camera at the origin
// and a target at x = 10.
const wall = { ax: 5, az: -10, bx: 5, bz: 10 };

test('an admin wall (no height) blocks the sight line at any eye height', () => {
    assert.equal(isOccluded(0, 0, 10, 0, [wall]), true);
    assert.equal(isOccluded(0, 0, 10, 0, [wall], 50, 0), true);
});

test('nothing in the way: not occluded', () => {
    assert.equal(isOccluded(0, 0, -10, 0, [wall]), false);
    assert.equal(isOccluded(0, 0, 10, 0, []), false);
});

test('a building wall blocks only below its roof line', () => {
    const building = { ...wall, top: 1.4 };
    // Eye level (0) to a node on the ground (-1.6): passes under the roof line.
    assert.equal(isOccluded(0, 0, 10, 0, [building], 0, -1.6), true);
    // A raised view (20 m) sees over a one-storey building.
    assert.equal(isOccluded(0, 0, 10, 0, [building], 20, -1.6), false);
});

test('without heights a building wall blocks like any wall', () => {
    assert.equal(isOccluded(0, 0, 10, 0, [{ ...wall, top: 1.4 }]), true);
});

test('a target standing on the wall line (a doorway) is not hidden by it', () => {
    assert.equal(isOccluded(0, 0, 5, 0, [wall]), false);
});
