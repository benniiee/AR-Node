import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestEntrances } from './pathfinding.js';
import { snapToOutline } from './doors.js';
import { fromLocalMeters } from './geo.js';

const LAT = 6.913;
const LNG = 122.061;
const at = (e, n) => fromLocalMeters(LAT, LNG, e, n);
const ll = (e, n) => { const p = at(e, n); return { lat: p.latitude, lng: p.longitude }; };
const node = (id, e, n, floor = 0) => ({ id, type: 'route', floor_level: floor, elevation: 0, path_type: 'outside', ...at(e, n) });

test('an entrance goes where a path crosses a building outline, on the outline', () => {
    const box = [ll(0, 0), ll(20, 0), ll(20, 10), ll(0, 10)];
    // A path from the south into the building's middle; a path running past it to the east.
    const nodes = [node(1, 10, -6), node(2, 10, 5), node(3, 30, -6), node(4, 30, 16)];
    const found = suggestEntrances(box, nodes);
    assert.equal(found.length, 1);
    assert.ok(snapToOutline(box, found[0].lat, found[0].lng).distM < 0.05, 'on the outline');
    const p = snapToOutline([ll(9, 0), ll(11, 0), ll(11, 0.1), ll(9, 0.1)], found[0].lat, found[0].lng);
    assert.ok(p.distM < 0.2, 'on the south wall, where the path comes in');
});

test('a raised deck: only ground paths into a staircase foot count, not the road under it', () => {
    // A deck 40 m long; the stair foot (node 2) inside its west end; a road crossing under the middle.
    const deck = [ll(0, 0), ll(40, 0), ll(40, 4), ll(0, 4)];
    const nodes = [node(1, -5, 2), node(2, 2, 2), node(3, 3, 2, 1), node(4, 20, -15), node(5, 20, 19)];
    const links = [{ node_a_id: 2, node_b_id: 3 }];
    const ground = suggestEntrances(deck, nodes, { floor: 0, links, onlyInto: new Set(['2']) });
    assert.equal(ground.length, 1);
    assert.ok(ground[0].lng < at(1, 0).longitude, 'at the west end');
    // On the deck floor nothing comes in from outside.
    assert.equal(suggestEntrances(deck, nodes, { floor: 1, links }).length, 0);
});

test('far same-floor nodes (another building upstairs) are not entrances', () => {
    const deck = [ll(0, 0), ll(40, 0), ll(40, 4), ll(0, 4)];
    const nodes = [node(1, 10, 2, 1), node(2, 30, 2, 1), node(3, 20, 60, 1)];
    assert.equal(suggestEntrances(deck, nodes, { floor: 1 }).length, 0);
});
