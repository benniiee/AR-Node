import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    treeModel, trunkTopM, crownFootprint, bordersWithGates, snapGateToWall, objectShadowRings, objectDefaults, parkingLayout,
    toObjectFrame, fromObjectFrame, resizeFrom, rotateTo, rotateHandleAt, crownWidthTo,
    crownFromFrame, heightHandleAt, heightTo,
} from './campusObjects.js';
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
    for (const form of ['round', 'spreading', 'canopy', 'tall', 'palm', 'banana']) {
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

test('a parking lot is painted with 2.5 m stalls, in two rows once it is wide enough', () => {
    const lot = (extra) => ({ kind: 'parking', latitude: O.lat, longitude: O.lng, width_m: 16, length_m: 20, ...extra });
    assert.equal(parkingLayout(lot()).stalls, 16, 'two rows of 8 (20 m / 2.5 m)');
    assert.equal(parkingLayout(lot({ width_m: 10 })).stalls, 8, 'narrower: one row');
    assert.equal(parkingLayout(lot()).lines.length, 2 * (8 + 1) + 2, 'a line between every stall, plus each row\'s open end');
    assert.equal(parkingLayout(lot()).outline.length, 4);
    assert.equal(objectShadowRings([lot()], { altitudeDeg: 60, azimuthDeg: 90 }).length, 0, 'flat: no shade');
});

test('the transform frame resizes from the opposite side and rotates like a design tool', () => {
    const lot = { kind: 'parking', latitude: O.lat, longitude: O.lng, width_m: 16, length_m: 20, rotation_deg: 30 };
    const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
    // The frame round-trips.
    const p = fromObjectFrame(lot, 3, -4);
    const back = toObjectFrame(lot, p.lat, p.lng);
    assert.ok(near(back.x, 3) && near(back.y, -4));
    // Front-right corner (+8, +10) dragged to (+10, +14): 18 x 24, the back-left corner (-8, -10) stays put.
    const to = fromObjectFrame(lot, 10, 14);
    const r = resizeFrom(lot, 1, 1, to.lat, to.lng);
    assert.ok(near(r.width_m, 18) && near(r.length_m, 24));
    const moved = { ...lot, ...r };
    const fixed = toObjectFrame(lot, ...Object.values(fromObjectFrame(moved, -r.width_m / 2, -r.length_m / 2)));
    assert.ok(near(fixed.x, -8, 0.1) && near(fixed.y, -10, 0.1), 'the opposite corner did not move');
    // An edge handle changes one side only.
    const side = fromObjectFrame(lot, 12, 3);
    const e = resizeFrom(lot, 1, 0, side.lat, side.lng);
    assert.ok(near(e.width_m, 20) && e.length_m === 20);
    // Dragging past the opposite side never flips it: it stops at the minimum.
    const past = fromObjectFrame(lot, -30, 0);
    assert.equal(resizeFrom(lot, 1, 0, past.lat, past.lng).width_m, 1);
    // Rotate: the handle starts behind the back edge, so dropping it there keeps the facing.
    const h = rotateHandleAt(lot);
    assert.equal(rotateTo(lot, h.lat, h.lng), 30);
    // Straight south of the middle: facing north (0); 3 degrees off snaps to it.
    const south = fromObjectFrame({ ...lot, rotation_deg: 0 }, 0.5, -10);
    assert.equal(rotateTo(lot, south.lat, south.lng), 0);
    // A tree's crown handle: twice the distance from the trunk.
    const east = fromObjectFrame({ latitude: O.lat, longitude: O.lng }, 4, 0);
    assert.ok(near(crownWidthTo({ latitude: O.lat, longitude: O.lng }, east.lat, east.lng), 8));
});

test('a banana plant has two or three stems, each with a fan of big leaves', () => {
    const m = treeModel(tree({ form: 'banana', height_m: 5, width_m: 5 }));
    assert.ok(m.stems.length >= 2 && m.stems.length <= 3, 'clumped stems');
    assert.ok(m.fronds.length >= 12, 'big leaves on every stem');
    assert.ok(m.fronds.every((f) => f.wide > 0 && m.stems.some((s) => s.te === f.e && s.tn === f.n)), 'each leaf grows from the top of a stem');
    assert.ok(m.stems.slice(1).every((s) => Math.hypot(s.te, s.tn) > Math.hypot(s.e, s.n)), 'the outer stems lean out');
    assert.ok(m.crownTop <= 5 + 1e-9 && m.trunkH < 5, 'leaves reach about its height, above the stems');
    assert.deepEqual(treeModel(tree({ form: 'banana' })), treeModel(tree({ form: 'banana' })), 'same seed, same plant');
});

test('a tree turns with its rotation, and its frame resizes the crown and sets the height', () => {
    const lean = (deg) => treeModel(tree({ form: 'canopy', height_m: 10, width_m: 14, rotation_deg: deg }));
    const a = lean(0);
    const b = lean(90);
    // A quarter turn clockwise: what pointed north now points east.
    assert.ok(Math.abs(b.puffs[0].e - a.puffs[0].n) < 1e-9 && Math.abs(b.puffs[0].n + a.puffs[0].e) < 1e-9);
    const t = tree({ width_m: 6, height_m: 8, rotation_deg: 30 });
    const corner = fromObjectFrame(t, 5, 5);
    assert.equal(crownFromFrame(t, corner.lat, corner.lng), 10, 'a corner 5 m out: a 10 m crown');
    const h = heightHandleAt(t);
    assert.equal(heightTo(t, h.lat, h.lng), 8, 'the height handle sits where the height is');
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

test('a tree trunk always reaches up into its crown, for every form', () => {
    for (const form of ['round', 'spreading', 'tall']) {
        for (let seed = 1; seed <= 40; seed += 1) {
            for (const [h, w] of [[4, 3], [6, 5], [9, 8], [12, 4]]) {
                const m = treeModel({ form, seed, height_m: h, width_m: w });
                const top = trunkTopM(m);
                // Inside a clump (well within it: the 3D clumps are faceted and a little squashed).
                const inside = m.puffs.some((p) => Math.hypot(p.e, p.n, (p.u - top) / 0.85) < p.r * 0.8);
                assert.ok(inside, `${form} seed ${seed} ${h}x${w}: the trunk top at ${top.toFixed(2)} m is not inside the crown`);
                assert.ok(top < m.crownTop, `${form} seed ${seed}: the trunk pokes out of the top`);
            }
        }
    }
    // Palms and shade trees end at their fronds and limbs.
    for (const form of ['palm', 'canopy']) {
        const m = treeModel({ form, seed: 3, height_m: 8, width_m: 6 });
        assert.equal(trunkTopM(m), m.trunkH);
    }
});
