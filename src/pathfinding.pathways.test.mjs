import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoute, pathwayWaypoints, PATHWAY_STEP_M } from './pathfinding.js';
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
    // A walkway around a wall: the only way from the start to the office.
    const wall = [{ group_id: 1, coordinates: [ll(20, -20), ll(20, 15)] }];
    const office = { id: 9, type: 'location', name: 'Office', latitude: at(40, 0).latitude, longitude: at(40, 0).longitude, floor_level: 0, elevation: 0, path_type: 'outside', building_id: null };
    const walk = { id: 7, kind: 'walkway', status: 'existing', coordinates: [ll(0, 0), ll(0, 25), ll(40, 25), ll(40, 0)] };
    const start = at(0, 0);

    const r = computeRoute([office], 9, start.latitude, start.longitude, 0, wall, { pathways: [walk] });
    assert.equal(r.success, true);
    // Walkway 7's points (ids -2070000...), all the way round the wall.
    assert.ok(r.path.filter((p) => p.id <= -2070000 && p.id > -2080000).length >= 10, 'along the walkway');
});
