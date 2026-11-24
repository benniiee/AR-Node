import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoute, pathwayWaypoints, PATHWAY_STEP_M, segmentCrossesBorder } from './pathfinding.js';
import { fromLocalMeters, toLocalMeters } from './geo.js';

const LAT = 6.913;
const LNG = 122.061;
const ll = (e, n) => { const p = fromLocalMeters(LAT, LNG, e, n); return { lat: p.latitude, lng: p.longitude }; };
const at = (e, n) => fromLocalMeters(LAT, LNG, e, n);

test('a pathway becomes route points every few metres, corners and ends included', () => {
    // An L-shaped walkway: 30 m east, then 13 m north.
    const pts = pathwayWaypoints([{ id: 3, kind: 'walkway', status: 'existing', coordinates: [ll(0, 0), ll(30, 0), ll(30, 13)] }]);
    // 0, 6, 12, 18, 24, the corner at 30, then 6 m up and the end at 13 m.
    assert.equal(pts.length, 8);
    const metres = pts.map((p) => toLocalMeters(p.latitude, p.longitude, LAT, LNG));
    assert.ok(Math.hypot(...metres[0]) < 0.01, 'starts at the first point');
    assert.ok(metres.some(([e, n]) => Math.hypot(e - 30, n) < 0.01), 'the corner is a route point (a branch from it joins there)');
    for (let k = 1; k < metres.length; k += 1) {
        assert.ok(Math.hypot(metres[k][0] - metres[k - 1][0], metres[k][1] - metres[k - 1][1]) <= PATHWAY_STEP_M * 1.25 + 1e-6, 'no gap wider than a step and a quarter');
    }
    assert.ok(Math.hypot(metres.at(-1)[0] - 30, metres.at(-1)[1] - 13) < 0.01, 'ends at the last point');
    assert.ok(pts.every((p) => p.id < 0 && p.type === 'route' && p.floor_level === 0 && p.path_type === 'outside'));
    // A covered walkway is sheltered; planned and unfinished ones are not walkable yet.
    assert.equal(pathwayWaypoints([{ id: 4, kind: 'covered', status: 'existing', coordinates: [ll(0, 0), ll(10, 0)] }])[0].path_type, 'inside');
    assert.equal(pathwayWaypoints([{ id: 5, kind: 'road', status: 'planned', coordinates: [ll(0, 0), ll(10, 0)] }]).length, 0);
});

test('a route follows a pathway with no route nodes of its own', () => {
    // A walkway around a wall: the only way from the start to the office. The wall is a closed (thin)
    // loop reaching up to the walkway, so there is no end to turn round and no gap above it to cut
    // across: only the walkway goes round it.
    const wall = [{ group_id: 1, coordinates: [ll(20, -20), ll(20, 24), ll(20.5, 24), ll(20.5, -20), ll(20, -20)] }];
    const office = { id: 9, type: 'location', name: 'Office', latitude: at(40, 0).latitude, longitude: at(40, 0).longitude, floor_level: 0, elevation: 0, path_type: 'outside', building_id: null };
    const walk = { id: 7, kind: 'walkway', status: 'existing', coordinates: [ll(0, 0), ll(0, 25), ll(40, 25), ll(40, 0)] };
    const start = at(0, 0);

    const r = computeRoute([office], 9, start.latitude, start.longitude, 0, wall, { pathways: [walk] });
    assert.equal(r.success, true);
    // Along walkway 7's points (ids -2070000...) and round the wall, never through it.
    assert.ok(r.path.filter((p) => p.id <= -2070000 && p.id > -2080000).length >= 10, 'along the walkway');
    const steps = r.path.slice(1).map((p, i) => [r.path[i], p]);
    assert.ok(!steps.some(([a, b]) => a.type !== 'user' && segmentCrossesBorder(a, b, wall)), 'never through the wall');
});

test('a route keeps to the walkway when there is one, and goes straight where there is none', () => {
    // An L-shaped walkway: 30 m east, then 30 m north to a building's door point. Straight across the
    // grass is 42 m; along the walkway 60 m: still within the off-path factor, so it keeps to the walkway.
    const walk = { id: 8, kind: 'walkway', status: 'existing', coordinates: [ll(0, 0), ll(30, 0), ll(30, 30)] };
    const end = pathwayWaypoints([walk]).at(-1);
    // One real node far away on another floor: the router needs a non-empty map (the real one always has nodes).
    const far = [{ id: 99, type: 'route', latitude: at(500, 500).latitude, longitude: at(500, 500).longitude, floor_level: 5, elevation: 16, path_type: 'inside', building_id: null }];
    const r = computeRoute(far, end.id, at(0, 1).latitude, at(0, 1).longitude, 0, [], { pathways: [walk] });
    assert.equal(r.success, true);
    assert.ok(r.path.some((p) => p.id === -(2000000 + 8 * 10000 + 5)), 'round the corner of the walkway (its point at 30,0)');

    // No walkway: a straight walk across open ground (the street case), not a detour.
    const lone = { id: 9, type: 'location', name: 'Gate', latitude: at(40, 40).latitude, longitude: at(40, 40).longitude, floor_level: 0, elevation: 0, path_type: 'outside', building_id: null };
    const straight = computeRoute([lone], 9, at(0, 0).latitude, at(0, 0).longitude, 0, []);
    assert.equal(straight.success, true);
    assert.equal(straight.path.filter((p) => p.type !== 'user').length, 1, 'straight there');
});
