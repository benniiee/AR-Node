import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RouteService, shouldReroute, REROUTE_MOVE_M } from './routeService.js';
import { computeRoute } from './pathfinding.js';
import { fromLocalMeters } from './geo.js';

const O = { lat: 6.913, lng: 122.061 };
const at = (e, n) => { const p = fromLocalMeters(O.lat, O.lng, e, n); return { latitude: p.latitude, longitude: p.longitude }; };
const node = (id, e, n, extra = {}) => ({ id, type: 'route', floor_level: 0, elevation: 0, path_type: 'outside', ...at(e, n), ...extra });
const nodes = [node(1, 0, 10), node(2, 0, 40), node(9, 0, 70, { type: 'location', name: 'Library' })];
const map = { nodes, walls: [], links: [], buildings: [], bridges: [], pathways: [], objects: [] };
const req = { ...(({ latitude, longitude }) => ({ lat: latitude, lng: longitude }))(at(0, 0)), destId: 9, buildingId: null, userFloor: 0, rainMultiplier: 1, rainNow: false, heatNow: false, closedBuildingIds: [], shade: null };

test('a route is worked out again only when something changed or you moved a couple of metres', () => {
    const mapKey = {};
    const last = { key: 'library|0', mapKey, ...O };
    const moved = (m) => ({ key: 'library|0', mapKey, ...(({ latitude, longitude }) => ({ lat: latitude, lng: longitude }))(at(m, 0)) });
    assert.equal(shouldReroute(null, moved(0)), true, 'the first one');
    assert.equal(shouldReroute(last, moved(REROUTE_MOVE_M / 2)), false, 'GPS jitter keeps the route');
    assert.equal(shouldReroute(last, moved(REROUTE_MOVE_M + 0.5)), true, 'walked on: a new route');
    assert.equal(shouldReroute(last, { ...moved(0), key: 'cashier|0' }), true, 'another destination');
    assert.equal(shouldReroute(last, { ...moved(0), mapKey: {} }), true, 'the map changed');
});

test('without a worker the route is worked out in the page, the same as computeRoute', async () => {
    const service = new RouteService(() => { throw new Error('no workers here'); });
    service.setMap(map);
    const result = await service.route(req);
    const direct = computeRoute(nodes, 9, req.lat, req.lng, 0, [], { links: [], buildings: [], bridges: [], pathways: [], closedBuildingIds: [] });
    assert.equal(result.success, true);
    assert.deepEqual(result.path.map((p) => p.id), direct.path.map((p) => p.id));
    // Sent back from a worker by structured cloning: it must be plain data.
    assert.deepEqual(structuredClone(result), result);
});

test('only the newest request counts: an older one still waiting gets null', async () => {
    const service = new RouteService(() => { throw new Error('no workers here'); });
    service.setMap(map);
    const first = service.route(req);
    const second = service.route({ ...req, destId: 2 });
    assert.equal(await first, null);
    assert.equal((await second).path.at(-1).id, 2);
    const third = service.route(req);
    service.cancel();
    assert.equal(await third, null, 'cancelled (the destination was cleared)');
});
