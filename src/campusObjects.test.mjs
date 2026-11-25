import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treeModel, crownFootprint, bordersWithGates, snapGateToWall, objectShadowRings, objectDefaults } from './campusObjects.js';
import { shadeMap } from './shadeRouting.js';
import { computeRoute, segmentCrossesBorder } from './pathfinding.js';
import { fromLocalMeters } from './geo.js';

const O = { lat: 6.913, lng: 122.061 };
const at = (e, n) => { const p = fromLocalMeters(O.lat, O.lng, e, n); return { lat: p.latitude, lng: p.longitude }; };
const tree = (extra = {}) => ({ kind: 'tree', latitude: O.lat, longitude: O.lng, height_m: 8, width_m: 6, form: 'round', seed: 1234, ...extra });

test('a tree looks the same every time from the same seed, and different from another seed', () => {
    assert.deepEqual(treeModel(tree()), treeModel(tree()));
    assert.notDeepEqual(treeModel(tree()).puffs, treeModel(tree({ seed: 99 })).puffs);
    const m = treeModel(tree());
    assert.ok(m.crownTop <= 8 * 1.15 && m.crownTop > m.crownBase && m.crownBase > 0, 'the crown sits up the trunk, about the tree\'s height');
    for (const form of ['round', 'spreading', 'canopy', 'tall', 'palm']) {
        assert.ok(crownFootprint(tree({ form })).length >= 8, `${form} has a crown outline`);
    }
    assert.equal(treeModel(tree({ form: 'palm' })).fronds.length >= 7, true, 'a palm has fronds');
    assert.ok(objectDefaults('shed').width_m > 0 && objectDefaults('tree').seed > 0);
});

test('a wide shade tree has limbs and a crown wider than tall, leaning out to one side', () => {
    const m = treeModel(tree({ form: 'canopy', height_m: 10, width_m: 14 }));
    assert.ok(m.limbs.length >= 5, 'heavy limbs out to its clumps');
    assert.ok(m.crownTop <= 10 * 1.1, 'about the tree\'s height');
    const squat = treeModel(tree({ form: 'canopy', height_m: 6, width_m: 20 }));
    assert.ok(m.crownBase >= 2 - 1e-9 && squat.crownBase >= 2 - 1e-9, 'leaves hang low, but people still walk under them');
    const xs = m.puffs.map((p) => p.e);
    const ns = m.puffs.map((p) => p.n);
    assert.ok(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ns) - Math.min(...ns)) > m.crownTop - m.crownBase, 'wider than tall');
    // Lopsided: the crown reaches further on one side of the trunk than on the other.
    const mid = { e: xs.reduce((a, b) => a + b, 0) / xs.length, n: ns.reduce((a, b) => a + b, 0) / ns.length };
    assert.ok(Math.hypot(mid.e, mid.n) > 1, 'the crown leans out');
    assert.deepEqual(treeModel(tree({ form: 'round' })).limbs, [], 'other trees have no separate limbs');
});

test('a tree shades the ground away from the sun, and only while the sun is up', () => {
    const noon = new Date('2026-03-20T04:00:00Z'); // about midday in Zamboanga (UTC+8)
    const morning = new Date('2026-03-20T00:30:00Z'); // about 8:30 am: sun in the east, shadows to the west
    const night = new Date('2026-03-20T14:00:00Z');
    const map = shadeMap([], morning, O.lat, O.lng, [tree()]);
    const west = at(-8, 0);
    const east = at(8, 0);
    assert.equal(map.isShaded(west.lat, west.lng), true, 'shade falls west of the tree in the morning');
    assert.equal(map.isShaded(east.lat, east.lng), false);
    assert.ok(shadeMap([], noon, O.lat, O.lng, [tree()]).isShaded(O.lat, O.lng), 'right under the crown at midday');
    assert.deepEqual(objectShadowRings([tree()], { altitudeDeg: -10, azimuthDeg: 0 }), [], 'no shadow at night');
    assert.equal(shadeMap([], night, O.lat, O.lng, [tree()]), null);
});

test('a gate opens its wall: the wall is cut there, and a route goes through instead of round', () => {
    // A 60 m wall running east-west, with a gate in the middle.
    const wall = { group_id: 1, coordinates: [at(-30, 0), at(30, 0)] };
    const gate = { kind: 'gate', latitude: at(0, 0.5).lat, longitude: at(0, 0.5).lng, width_m: 4, rotation_deg: 90 };
    const cut = bordersWithGates([wall], [gate]);
    assert.equal(cut.length, 2, 'two stretches either side of the opening');
    const south = { latitude: at(0, -5).lat, longitude: at(0, -5).lng };
    const north = { latitude: at(0, 5).lat, longitude: at(0, 5).lng };
    assert.equal(segmentCrossesBorder(south, north, [wall]), true, 'without the gate the wall is in the way');
    assert.equal(segmentCrossesBorder(south, north, cut), false, 'through the gate it is open');
    assert.deepEqual(bordersWithGates([wall], []), [wall], 'no gates: walls unchanged');
    const farGate = { ...gate, latitude: at(0, 20).lat };
    assert.equal(bordersWithGates([wall], [farGate]).length, 1, 'a gate away from every wall cuts nothing');

    const nodes = [
        { id: 1, type: 'route', latitude: north.latitude, longitude: north.longitude, floor_level: 0, path_type: 'outside', building_id: null },
    ];
    const r = computeRoute(nodes, 1, south.latitude, south.longitude, 0, cut, {});
    assert.equal(r.success, true);
    assert.ok(r.total_distance_meters < 12, `straight through the gate (${Math.round(r.total_distance_meters)} m), not round the wall`);
});

test('a gate dropped near a wall snaps onto it, facing along it', () => {
    const wall = { group_id: 1, coordinates: [at(-30, 0), at(30, 0)] };
    const near = at(5, 3);
    const s = snapGateToWall([wall], near.lat, near.lng);
    assert.ok(Math.abs(s.latitude - O.lat) < 1e-6, 'moved onto the wall');
    assert.ok(Math.abs(s.rotation_deg - 90) < 1, 'faces along the east-west wall');
    assert.equal(snapGateToWall([wall], at(0, 40).lat, at(0, 40).lng), null, 'no wall near: nothing to snap to');
});
