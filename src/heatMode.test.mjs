import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoute } from './pathfinding.js';
import { nodeRainStatus, nodeRainLabel, isRoutable, weatherFromSnapshot, heatModeActive, noRouteMessage, NODE_STATUS } from './weatherCost.js';

// Heat mode (heat index above 40 °C now, decided by the server, or a predicted hot hour that has
// begun) closes exposed paths exactly as rain falling does.
const LAT = 6.913;
const LNG = 122.061;
const dLat = (m) => m / 111320;
const dLng = (m) => m / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (eastM, northM) => ({ latitude: LAT + dLat(northM), longitude: LNG + dLng(eastM) });
const node = (id, east, north, pathType, extra = {}) => ({ id, type: 'route', floor_level: 0, elevation: 0, path_type: pathType, ...at(east, north), ...extra });
const ids = (r) => r.path.map((p) => p.id).filter((x) => x !== undefined && x !== null);

// A short exposed way straight north, and a longer covered walkway to the east.
const nodes = [
    node(1, 0, 10, 'outside'), node(2, 0, 30, 'outside'),
    node(3, 20, 10, 'inside'), node(4, 20, 30, 'inside'),
    node(9, 5, 42, 'inside', { type: 'location', name: 'Library' }),
];
const hot = { heat_mode: true, heat_mode_c: 40, raining_now: false };

test('heat mode closes exposed nodes and leaves sheltered ones open', () => {
    assert.equal(nodeRainStatus('outside', hot), NODE_STATUS.RED);
    assert.equal(nodeRainStatus('inside', hot), NODE_STATUS.WHITE);
    assert.equal(isRoutable('outside', hot), false);
    assert.equal(nodeRainLabel('outside', hot), 'Closed: extreme heat (above 40 °C)');
    assert.equal(nodeRainLabel('outside', { ...hot, raining_now: true }), 'Closed: raining now');
    assert.equal(nodeRainStatus('outside', { heat_mode: false }), NODE_STATUS.WHITE);
});

test('a heat-mode route avoids the exposed shortcut', () => {
    const start = at(0, 0);
    const normal = computeRoute(nodes, 9, start.latitude, start.longitude, 0, []);
    assert.equal(normal.success, true);
    assert.ok(ids(normal).includes(2), `expected the exposed shortcut, got ${ids(normal)}`);

    const heat = computeRoute(nodes, 9, start.latitude, start.longitude, 0, [], { heatNow: true });
    assert.equal(heat.success, true);
    assert.ok(!ids(heat).some((id) => id === 1 || id === 2), `expected no exposed nodes, got ${ids(heat)}`);
});

test('an exposed destination has no route in heat mode', () => {
    const start = at(0, 0);
    const r = computeRoute(nodes, 2, start.latitude, start.longitude, 0, [], { heatNow: true });
    assert.equal(r.success, false);
    assert.equal(r.message, noRouteMessage({ heat: true }));
    assert.match(r.message, /dangerously hot/);
    const wet = computeRoute(nodes, 2, start.latitude, start.longitude, 0, [], { rainNow: true });
    assert.match(wet.message, /raining/);
});

test('a hot prediction closes paths only once its hour has begun', () => {
    // 12:20: now 37.6 C (server: heat mode off); 40.4 C predicted for 1 pm.
    const w = { status: 'ok', heat_mode: false, heat_mode_c: 40, heat_forecast: [
        { hours_ahead: 1, at: '2026-11-14T13:00:00+08:00', heat_index_c: 40.4 },
        { hours_ahead: 2, at: '2026-11-14T14:00:00+08:00', heat_index_c: 39.7 },
    ] };
    assert.equal(heatModeActive(w, Date.parse('2026-11-14T12:20:00+08:00')), false);
    assert.equal(heatModeActive(w, Date.parse('2026-11-14T13:00:00+08:00')), true);   // 1 pm arrived, no update yet
    assert.equal(heatModeActive({ ...w, status: 'stale' }, Date.parse('2026-11-14T13:05:00+08:00')), false);
    assert.equal(heatModeActive({ ...w, heat_mode: true }, Date.parse('2026-11-14T12:20:00+08:00')), true);
});

test('an old weather file never keeps heat mode on', () => {
    const old = weatherFromSnapshot({ status: 'ok', heat_mode: true, fetched_at: new Date(Date.now() - 3 * 3600000).toISOString() });
    assert.equal(old.heat_mode, false);
});
