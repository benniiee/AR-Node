import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoute, buildingBarriers, segmentCrossesBorder, buildWalkEdges } from './pathfinding.js';

// A 30 m building sits between the walker and a destination due north. Route
// nodes run straight through it (the old shortcut) and around its west side.
const LAT = 6.913;
const LNG = 122.061;
const dLat = (m) => m / 111320;
const dLng = (m) => m / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (eastM, northM) => ({ latitude: LAT + dLat(northM), longitude: LNG + dLng(eastM) });
const building = {
    id: 1, status: 'existing',
    polygon: [
        { lat: LAT + dLat(20), lng: LNG + dLng(-15) }, { lat: LAT + dLat(20), lng: LNG + dLng(15) },
        { lat: LAT + dLat(50), lng: LNG + dLng(15) }, { lat: LAT + dLat(50), lng: LNG + dLng(-15) },
    ],
};
const node = (id, east, north, extra = {}) => ({ id, type: 'route', floor_level: 0, elevation: 0, path_type: 'outside', ...at(east, north), ...extra });
const nodes = [
    node(1, 0, 10),
    node(2, -25, 20), node(3, -25, 35), node(4, -25, 50),
    node(5, 0, 60),
    node(9, 0, 70, { type: 'location', name: 'Library' }),
];
const ids = (r) => r.path.map((p) => p.id).filter((x) => x !== undefined && x !== null && x !== '__user__');

test('without buildings the route cuts straight through the block', () => {
    const r = computeRoute(nodes, 9, at(0, 0).latitude, at(0, 0).longitude, 0, []);
    assert.equal(r.success, true);
    assert.ok(!ids(r).includes(3), `expected the shortcut, got ${ids(r)}`);
});

test('with the building as an obstacle the route walks around it', () => {
    const r = computeRoute(nodes, 9, at(0, 0).latitude, at(0, 0).longitude, 0, [], { buildings: [building] });
    assert.equal(r.success, true);
    assert.ok(ids(r).includes(3), `expected the detour via the west side, got ${ids(r)}`);
});

test('entering the building that holds the destination is allowed', () => {
    const inside = [...nodes, node(20, 0, 35, { type: 'location', name: 'Dean\'s Office', path_type: 'inside' })];
    const r = computeRoute(inside, 20, at(0, 0).latitude, at(0, 0).longitude, 0, [], { buildings: [building] });
    assert.equal(r.success, true, r.message);
});

test('a step that starts or ends inside a building is never blocked by it', () => {
    const [barrier] = buildingBarriers([building]);
    assert.equal(segmentCrossesBorder(at(0, 0), at(0, 70), [barrier]), true, 'across: blocked');
    assert.equal(segmentCrossesBorder(at(0, 0), at(0, 35), [barrier]), false, 'into it: allowed');
    assert.deepEqual(buildingBarriers([{ ...building, status: 'planned' }]), []);
});

// A student outside routes to a department's room upstairs: outdoor route
// nodes (admin) lead to the building's ground floor (department staff), then
// up the department's staircase. Without the staircase the floor is cut off.
test('outside to an upstairs room goes in at ground level and up the staircase', () => {
    const inside = { path_type: 'inside', building_id: 1 };
    const campus = [
        node(1, 0, 10),
        node(20, 0, 30, inside),
        node(21, 0, 32, { ...inside, floor_level: 1 }),
        node(22, 5, 40, { ...inside, floor_level: 1, type: 'location', name: 'Lecture room 2' }),
    ];
    const stairs = [{ id: 1, node_a_id: 20, node_b_id: 21, angle_deg: 37 }];
    const start = at(0, 0);

    const r = computeRoute(campus, 22, start.latitude, start.longitude, 0, [], { buildings: [building], links: stairs, userFloor: 0 });
    assert.equal(r.success, true);
    assert.deepEqual(ids(r), [1, 20, 21, 22]);

    const cutOff = computeRoute(campus, 22, start.latitude, start.longitude, 0, [], { buildings: [building], links: [], userFloor: 0 });
    assert.equal(cutOff.success, false);
    assert.equal(cutOff.needs_stairs, true);
});

test('a room behind a wall never removes the walkway link outside it', () => {
    // Walkway west-east along the south wall of a building with one door on its
    // far (north) side. The room just inside sits in the walkway's Gabriel
    // circle, but neither end can walk to it, so the walkway stays linked.
    const ll = (e, n) => ({ lat: at(e, n).latitude, lng: at(e, n).longitude });
    const walled = { id: 2, status: 'existing', polygon: [ll(-10, 3), ll(10, 3), ll(10, 20), ll(-10, 20)], doors: [ll(0, 20)] };
    const walk = [node(1, -20, 0), node(2, 20, 0), node(3, 0, 6, { path_type: 'inside', building_id: 2 })];
    const keys = buildWalkEdges(walk, buildingBarriers([walled])).map((e) => e.key);
    assert.ok(keys.includes('1|2'), `walkway link missing: ${keys}`);
    assert.ok(!keys.some((k) => k.split('|').includes('3')), 'no link through the wall to the room');
});

test('an admin wall blocks the direct link, so the route walks around its end', () => {
    // Moved here from the removed server router tests (PathBorderTest): walls are routed on the phone.
    const ll = (e, n) => ({ lat: at(e, n).latitude, lng: at(e, n).longitude });
    const wall = [{ group_id: 1, coordinates: [ll(-15, 35), ll(15, 35)] }];
    assert.ok(!buildWalkEdges(nodes, wall).some((e) => e.key === '1|5'), 'no link through the wall');
    const r = computeRoute(nodes, 9, at(0, 0).latitude, at(0, 0).longitude, 0, wall);
    assert.equal(r.success, true, r.message);
    assert.ok(ids(r).includes(3), `expected the way around the wall's west end, got ${ids(r)}`);
});
