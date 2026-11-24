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

test('a raised deck passes over a ground wall under it (a road edge); the ground goes round its end', () => {
    // A wall running north-south under the deck's middle, as drawn along a road.
    const wall = [{ group_id: 1, coordinates: [ll(20, -10), ll(20, 14)] }];
    const nodes = [node(1, 5, 2, 1, { path_type: 'inside' }), node(2, 35, 2, 1, { path_type: 'inside', type: 'location' }),
        node(3, 5, -6, 0), node(4, 35, -6, 0, { type: 'location' })];
    const start = at(5, 2);
    const onDeck = computeRoute(nodes, 2, start.latitude, start.longitude, 0, wall, { userFloor: 1, bridges: [{ ...bridge, doors: [] }] });
    assert.equal(onDeck.success, true);
    const below = at(5, -6);
    const ground = computeRoute(nodes, 4, below.latitude, below.longitude, 0, wall, { userFloor: 0, bridges: [{ ...bridge, doors: [] }] });
    // On the ground the wall still blocks: the route turns round its open end, never through it.
    assert.equal(ground.success, true);
    assert.ok(ground.path.some((p) => p.id <= -3000000 && p.id > -4000000), 'round the end of the wall (its turning point)');
    const steps = ground.path.slice(1).map((p, i) => [ground.path[i], p]);
    assert.ok(!steps.some(([a, b]) => a.type !== 'user' && segmentCrossesBorder(a, b, wall)), 'never through it');
});

test('a closed bridge is not crossed: another way if there is one, else a message with the reason', () => {
    // A road wall north-south at x = 20 that the ground cannot cross; the deck (floor 1) spans it,
    // with a staircase down at each end. A gap in the wall far to the north is the long way round.
    const wall = [{ group_id: 1, coordinates: [ll(20, -30), ll(20, 40)] }];
    const deckNodes = [node(10, 3, 2, 1, { path_type: 'inside' }), node(11, 20, 2, 1, { path_type: 'inside' }), node(12, 37, 2, 1, { path_type: 'inside' })];
    const feet = [node(20, 3, -6, 0), node(21, 37, -6, 0, { type: 'location', name: 'Campus A office' })];
    const links = [{ node_a_id: 20, node_b_id: 10 }, { node_a_id: 21, node_b_id: 12 }];
    const footbridge = { ...bridge, doors: [], name: 'Footbridge' };
    const start = at(3, -6);
    const route = (bridges, extra = [], walls = wall) => computeRoute([...deckNodes, ...feet, ...extra], 21, start.latitude, start.longitude, 0, walls, { userFloor: 0, links, bridges });
    // The far side walled all round (a closed loop has no end to go round): only the bridge reaches it.
    const enclosed = [{ group_id: 2, coordinates: [ll(20, -30), ll(20, 40), ll(60, 40), ll(60, -30), ll(20, -30)] }];

    assert.equal(route([footbridge], [], enclosed).success, true, 'open: over the bridge');
    const closed = { ...footbridge, closed: true, closed_reason: 'Campus A event until 5 PM' };
    const blocked = route([closed], [], enclosed);
    assert.equal(blocked.success, false);
    assert.equal(blocked.closed_bridge, true);
    assert.equal(blocked.message, 'Footbridge is closed: Campus A event until 5 PM.');

    // With a way round the end of the wall, the route takes it and never touches the deck.
    const round = [node(30, 3, 45, 0), node(31, 20, 45, 0), node(32, 37, 45, 0), node(33, 3, 20, 0), node(34, 37, 20, 0)];
    const detour = route([closed], round);
    assert.equal(detour.success, true);
    assert.ok(!detour.path.some((p) => [10, 11, 12].includes(p.id)), 'not over the closed deck');
});
