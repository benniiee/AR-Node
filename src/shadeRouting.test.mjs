import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadePenaltyFor, shadeMap, edgeShadeFactor, SHADE_MAX_PENALTY } from './shadeRouting.js';
import { computeRoute } from './pathfinding.js';

const LAT = 6.913;
const LNG = 122.061;
const dLat = (m) => m / 111320;
const dLng = (m) => m / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (eastM, northM) => ({ latitude: LAT + dLat(northM), longitude: LNG + dLng(eastM) });
const node = (id, east, north, extra = {}) => ({ id, type: 'route', floor_level: 0, elevation: 0, path_type: 'outside', ...at(east, north), ...extra });

test('the shade penalty grows with the heat index', () => {
    assert.equal(shadePenaltyFor(26), 1);
    assert.equal(shadePenaltyFor(27), 1);
    assert.ok(shadePenaltyFor(33) > 1 && shadePenaltyFor(33) < SHADE_MAX_PENALTY);
    assert.equal(shadePenaltyFor(45), SHADE_MAX_PENALTY);
    assert.equal(shadePenaltyFor(null), 1);
});

test('a high UV index asks for shade even on a mild day; the stronger reason wins', () => {
    assert.equal(shadePenaltyFor(26, 5), 1);                       // moderate UV, mild: no penalty
    assert.ok(shadePenaltyFor(26, 8) > 1);                         // very high UV alone is enough
    assert.equal(shadePenaltyFor(26, 12), SHADE_MAX_PENALTY);      // extreme UV: full penalty
    assert.equal(shadePenaltyFor(33, 0), shadePenaltyFor(33));     // night (UV 0): heat decides as before
    assert.equal(shadePenaltyFor(33, 11), SHADE_MAX_PENALTY);
});

test('a building shades the ground on the side away from the sun', () => {
    // 10 x 10 m, three storeys, at 3 pm local time: the afternoon sun is in the
    // west, so the shadow falls to the east.
    const building = { polygon: [
        { lat: LAT, lng: LNG }, { lat: LAT, lng: LNG + dLng(10) },
        { lat: LAT + dLat(10), lng: LNG + dLng(10) }, { lat: LAT + dLat(10), lng: LNG },
    ], floors: 3 };
    const map = shadeMap([building], new Date('2026-03-20T15:00:00+08:00'), LAT, LNG);
    const east = at(13, 5);
    const west = at(-3, 5);
    assert.equal(map.isShaded(east.latitude, east.longitude), true);
    assert.equal(map.isShaded(west.latitude, west.longitude), false);
    // Night: no sun, nothing to avoid.
    assert.equal(shadeMap([building], new Date('2026-03-20T23:00:00+08:00'), LAT, LNG), null);
});

test('only sunny exposed edges cost more', () => {
    const shadeAll = { isShaded: () => true };
    const sunAll = { isShaded: () => false };
    const a = node(1, 0, 0);
    const b = node(2, 0, 10);
    assert.equal(edgeShadeFactor(a, b, shadeAll, 1.6), 1);
    assert.equal(edgeShadeFactor(a, b, sunAll, 1.6), 1.6);
    assert.equal(edgeShadeFactor(a, { ...b, path_type: 'inside' }, sunAll, 1.6), 1);
    assert.equal(edgeShadeFactor(a, b, sunAll, 1), 1);
});

test('on a hot day the route takes the shaded way over the shorter sunny one', () => {
    // A wall splits the way north in two: the eastern side is shorter but in
    // full sun, the western side lies in a building's shadow.
    const nodes = [
        node(1, 15, 10), node(2, 15, 50),
        node(3, -18, 10), node(4, -18, 50),
        node(9, 0, 60, { type: 'location', name: 'Library' }),
    ];
    const ll = (e, n) => ({ lat: at(e, n).latitude, lng: at(e, n).longitude });
    const wall = [{ coordinates: [ll(-1, 5), ll(1, 55)] }];
    const shadedWest = { isShaded: (la, ln) => ln < LNG };
    const start = at(0, 0);
    const ids = (r) => r.path.map((p) => p.id).filter((x) => x !== null && x !== undefined);

    const normal = computeRoute(nodes, 9, start.latitude, start.longitude, 0, wall);
    // The east side: straight up beside the wall (round its north end) or by node 2, never the west.
    const east = (r) => !ids(r).includes(4) && r.path.some((p) => p.type !== 'user' && p.longitude > LNG);
    assert.ok(east(normal), `expected the sunny east side, got ${ids(normal)}`);

    const hot = computeRoute(nodes, 9, start.latitude, start.longitude, 0, wall, { shade: { map: shadedWest, penalty: 1.6 } });
    assert.ok(ids(hot).includes(4) && !ids(hot).includes(2), `expected the shaded west side, got ${ids(hot)}`);
    // The reported distance stays physical (the detour really is longer).
    assert.ok(hot.total_distance_meters > normal.total_distance_meters);
});
