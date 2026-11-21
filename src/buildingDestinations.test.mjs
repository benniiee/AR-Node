import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildingDestination, buildingDestinationId, parseBuildingDestination, buildingTargets, routeToBuilding } from './buildingDestinations.js';
import { computeRoute, pathwayWaypoints } from './pathfinding.js';
import { fromLocalMeters } from './geo.js';

const LAT = 6.913;
const LNG = 122.061;
const at = (e, n) => fromLocalMeters(LAT, LNG, e, n);
const ll = (e, n) => { const p = at(e, n); return { lat: p.latitude, lng: p.longitude }; };
const polygon = [ll(-15, 20), ll(15, 20), ll(15, 50), ll(-15, 50)];
const node = (id, e, n, extra = {}) => ({ id, type: 'route', floor_level: 0, elevation: 0, path_type: 'outside', ...at(e, n), ...extra });

test('building destination ids round-trip and never look like node ids', () => {
    assert.equal(buildingDestinationId(7), 'b:7');
    assert.equal(parseBuildingDestination('b:7'), 7);
    assert.equal(parseBuildingDestination('7'), null);
    const d = buildingDestination({ id: 7, name: 'College of Computing Studies', short_name: 'CCS', polygon, campus: 'B' });
    assert.equal(d.is_building, true);
    assert.equal(d.campus, 'B');
    assert.equal(d.building_id, 7);
});

test('a building with doors is routed to its nearest door', () => {
    const b = { id: 1, status: 'existing', short_name: 'CCS', polygon, doors: [ll(0, 20), ll(0, 50)] };
    const nodes = [node(1, 0, 10), node(2, 0, 60)];
    assert.equal(buildingTargets(b, nodes).length, 2);
    const start = at(0, 0);
    const r = routeToBuilding(b, nodes, (id) => computeRoute(nodes, id, start.latitude, start.longitude, 0, [], { buildings: [b] }));
    assert.equal(r.success, true);
    const end = r.path[r.path.length - 1];
    assert.equal(end.is_door, true);
    // The south door (near the start), not the north one.
    assert.ok(Math.abs(end.latitude - at(0, 20).latitude) < 1e-6);
});

test('without doors the route ends on the building ground floor, else at the nearest node', () => {
    const b = { id: 1, status: 'existing', polygon };
    const inside = node(5, 0, 30, { building_id: 1, path_type: 'inside' });
    const upstairs = node(6, 0, 35, { building_id: 1, floor_level: 1 });
    assert.deepEqual(buildingTargets(b, [node(1, 0, 10), inside, upstairs]), [5]);
    assert.deepEqual(buildingTargets(b, [node(1, 0, 10), node(2, 0, 90)]), [1]);
    // No doors or nodes: the walkway beside it wins over a far node (the bridge stairs, in the real case).
    const walkway = pathwayWaypoints([{ id: 3, kind: 'walkway', status: 'existing', coordinates: [ll(-20, 10), ll(20, 10)] }]);
    const [nearest] = buildingTargets(b, [node(1, 0, 90), ...walkway]);
    assert.ok(nearest < 0, 'a walkway point, not node 1');
});
