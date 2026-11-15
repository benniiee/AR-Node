import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapToOutline, doorGapWalls, doorFrames, doorWaypoints, doorWidth, DOOR_WIDTH_M, MIN_DOOR_WIDTH_M, MAX_DOOR_WIDTH_M } from './doors.js';
import { computeRoute } from './pathfinding.js';
import { toLocalMeters, fromLocalMeters } from './geo.js';

// A 30 x 30 m building, its south wall 20 m north of the origin.
const LAT = 6.913;
const LNG = 122.061;
const at = (eastM, northM) => fromLocalMeters(LAT, LNG, eastM, northM);
const ll = (e, n) => { const p = at(e, n); return { lat: p.latitude, lng: p.longitude }; };
const polygon = [ll(-15, 20), ll(15, 20), ll(15, 50), ll(-15, 50)];
const meters = (p) => toLocalMeters(p.lat, p.lng, LAT, LNG);
const near = (a, b, tol = 0.05) => Math.abs(a - b) < tol;

test('a tap near the outline snaps onto the nearest edge', () => {
    const tap = at(3, 18);
    const s = snapToOutline(polygon, tap.latitude, tap.longitude);
    const [e, n] = meters(s);
    assert.equal(s.edge, 0);
    assert.ok(near(n, 20) && near(e, 3), `${e}, ${n}`);
    assert.ok(near(s.distM, 2, 0.1));
});

test('each door cuts a door-wide gap out of its wall', () => {
    const door = ll(0, 20);
    const walls = doorGapWalls(polygon, [door]);
    assert.equal(walls.length, 5); // south wall split in two, three whole walls
    const south = walls.filter((w) => near(meters(w[0])[1], 20) && near(meters(w[1])[1], 20));
    assert.equal(south.length, 2);
    const ends = south.flatMap((w) => w.map((p) => meters(p)[0])).sort((a, b) => a - b);
    assert.ok(near(ends[2] - ends[1], DOOR_WIDTH_M, 0.05), `gap ${ends[2] - ends[1]}`);
});

test('door frames sit on their wall and face outwards', () => {
    const [south] = doorFrames(polygon, [ll(0, 20)]);
    assert.ok(near(south.normalDeg, 180, 0.5), `normal ${south.normalDeg}`);
    const [north] = doorFrames(polygon, [ll(0, 50)]);
    assert.ok(north.normalDeg < 0.5 || north.normalDeg > 359.5, `normal ${north.normalDeg}`);
    // A door too far from the outline is ignored.
    assert.equal(doorFrames(polygon, [ll(0, 0)]).length, 0);
});

test('door waypoints are ground-floor route nodes with ids that cannot clash', () => {
    const [w] = doorWaypoints([{ id: 7, polygon, doors: [ll(0, 20)] }]);
    assert.equal(w.is_door, true);
    assert.ok(w.id < 0);
    assert.equal(w.floor_level, 0);
});

// Outside the south wall, a room inside near the north wall.
const node = (id, east, north, extra = {}) => ({ id, type: 'route', floor_level: 0, elevation: 0, path_type: 'outside', ...at(east, north), ...extra });
const room = node(9, 0, 40, { type: 'location', name: 'Lab', path_type: 'inside', building_id: 1 });
const campus = [
    node(1, 0, 10),
    node(2, -25, 20), node(3, -25, 50), node(4, 0, 60),
    room,
];
const ids = (r) => r.path.map((p) => p.id).filter((x) => x !== null && x !== undefined);
const start = at(0, 0);

test('a building without doors can still be entered from any side', () => {
    const r = computeRoute(campus, 9, start.latitude, start.longitude, 0, [], { buildings: [{ id: 1, status: 'existing', polygon }] });
    assert.equal(r.success, true);
    assert.deepEqual(ids(r), [1, 9]);
});

test('with a door the route goes in through it, not through the wall', () => {
    const building = { id: 1, status: 'existing', short_name: 'CCS', polygon, doors: [ll(0, 50)] };
    const r = computeRoute(campus, 9, start.latitude, start.longitude, 0, [], { buildings: [building] });
    assert.equal(r.success, true);
    // Around the west side to the north door, then in.
    const door = r.path.find((p) => p.is_door);
    assert.ok(door, 'route uses the door');
    const [, n] = toLocalMeters(door.latitude, door.longitude, LAT, LNG);
    assert.ok(near(n, 50, 0.1));
    assert.ok(ids(r).includes(3));

    // A south door: straight in.
    const south = computeRoute(campus, 9, start.latitude, start.longitude, 0, [], { buildings: [{ ...building, doors: [ll(0, 20)] }] });
    assert.equal(south.success, true);
    assert.equal(south.path.filter((p) => p.is_door).length, 1);
    assert.ok(!ids(south).includes(3));
});

test('a door keeps its own width (clamped), and the wall gap matches it', () => {
    const narrow = { ...ll(0, 20), width_m: 1 };
    const [frame] = doorFrames(polygon, [narrow]);
    assert.ok(near(frame.width, 1, 0.01), `width ${frame.width}`);
    const south = doorGapWalls(polygon, [narrow]).filter((w) => near(meters(w[0])[1], 20) && near(meters(w[1])[1], 20));
    const ends = south.flatMap((w) => w.map((p) => meters(p)[0])).sort((a, b) => a - b);
    assert.ok(near(ends[2] - ends[1], 1, 0.05), `gap ${ends[2] - ends[1]}`);
    // Out-of-range widths are clamped; a missing width is the default.
    assert.equal(doorWidth({ width_m: 99 }), MAX_DOOR_WIDTH_M);
    assert.equal(doorWidth({ width_m: 0.1 }), MIN_DOOR_WIDTH_M);
    assert.equal(doorWidth({}), DOOR_WIDTH_M);
});
