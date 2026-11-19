import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoute, bridgeBarriers, bridgeDoorWaypoints, segmentCrossesBorder } from './pathfinding.js';
import { fromLocalMeters } from './geo.js';

const LAT = 6.913;
const LNG = 122.061;
const at = (e, n) => fromLocalMeters(LAT, LNG, e, n);
const ll = (e, n) => { const p = at(e, n); return { lat: p.latitude, lng: p.longitude }; };
// A deck 40 m long (east-west) and 4 m wide, one floor up, with a door at its east end.
const deck = [ll(0, 0), ll(40, 0), ll(40, 4), ll(0, 4)];
const bridge = { id: 7, name: 'Footbridge', status: 'existing', deck_floor: 1, roofed: true, polygon: deck, doors: [ll(40, 2)] };
const node = (id, e, n, floor, extra = {}) => ({ id, type: 'route', floor_level: floor, elevation: 0, path_type: 'outside', ...at(e, n), ...extra });

test('bridge doors make the deck outline a wall with a gap, on the deck floor only', () => {
    const walls = bridgeBarriers([bridge]);
    assert.ok(walls.length > 0 && walls.every((w) => w.floor === 1));
    // Across the long side on the deck floor: blocked. The same step on the ground: open.
    const inside = node(1, 20, 2, 1);
    const north = node(2, 20, 8, 1);
    assert.equal(segmentCrossesBorder(inside, north, walls), true);
    assert.equal(segmentCrossesBorder({ ...inside, floor_level: 0 }, { ...north, floor_level: 0 }, walls), false);
    // Without doors a bridge blocks nothing.
    assert.equal(bridgeBarriers([{ ...bridge, doors: [] }]).length, 0);
    const [door] = bridgeDoorWaypoints([bridge]);
    assert.equal(door.floor_level, 1);
    assert.equal(door.path_type, 'inside');
    assert.ok(door.id < -1000000);
});

test('with a door, a route leaves the deck through it, not sideways into a building next to it', () => {
    // Deck nodes, and a first-floor node of a building just north of the deck's middle.
    const nodes = [
        node(1, 5, 2, 1, { path_type: 'inside' }), node(2, 20, 2, 1, { path_type: 'inside' }), node(3, 35, 2, 1, { path_type: 'inside' }),
        node(4, 20, 9, 1, { name: 'Upstairs office', type: 'location' }),
        node(5, 46, 2, 1), node(6, 46, 9, 1),
    ];
    const start = at(5, 2);
    const open = computeRoute(nodes, 4, start.latitude, start.longitude, 0, [], { userFloor: 1 });
    assert.equal(open.success, true);
    assert.ok(!open.path.some((p) => p.id === 5), 'no doors: straight across the side');

    const viaDoor = computeRoute(nodes, 4, start.latitude, start.longitude, 0, [], { userFloor: 1, bridges: [bridge] });
    assert.equal(viaDoor.success, true);
    assert.ok(viaDoor.path.some((p) => p.is_door), 'through the east door');
    assert.ok(viaDoor.path.some((p) => p.id === 5));
});

test('a raised deck passes over a ground wall under it (a road edge); the ground does not', () => {
    // A wall running north-south under the deck's middle, as drawn along a road.
    const wall = [{ group_id: 1, coordinates: [ll(20, -10), ll(20, 14)] }];
    const nodes = [node(1, 5, 2, 1, { path_type: 'inside' }), node(2, 35, 2, 1, { path_type: 'inside', type: 'location' }),
        node(3, 5, -6, 0), node(4, 35, -6, 0, { type: 'location' })];
    const start = at(5, 2);
    const onDeck = computeRoute(nodes, 2, start.latitude, start.longitude, 0, wall, { userFloor: 1, bridges: [{ ...bridge, doors: [] }] });
    assert.equal(onDeck.success, true);
    const below = at(5, -6);
    const ground = computeRoute(nodes, 4, below.latitude, below.longitude, 0, wall, { userFloor: 0, bridges: [{ ...bridge, doors: [] }] });
    assert.equal(ground.success, false);
});
