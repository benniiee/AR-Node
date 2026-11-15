import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addJoined, canExtendFrom } from './shapeDraft.js';

// Corners named by letter so the order is easy to read.
const P = (s) => s.split('').map((c) => ({ id: c }));
const ids = (r) => r.points.map((p) => p.id).join('');
/** Each point's neighbours in a ring (or a line), as "X:neighbours". */
const neighbours = (pts, closed) => pts.map((p, i) => {
    const n = [];
    if (i > 0 || closed) n.push(pts[(i - 1 + pts.length) % pts.length].id);
    if (i < pts.length - 1 || closed) n.push(pts[(i + 1) % pts.length].id);
    return `${p.id}:${n.sort().join('')}`;
});
const solidNeighbours = (pts) => neighbours(pts, false); // the closing side is drawn dashed

test('nothing selected: a tap adds after the last corner, as before', () => {
    const r = addJoined(P('ABCD'), null, { id: 'X' });
    assert.equal(ids(r), 'ABCDX');
    assert.equal(r.anchor, null);
});

test('outline: the new corner joins only the selected corner (solid sides)', () => {
    // Select B (index 1) in ABCD and tap X.
    const r = addJoined(P('ABCD'), 1, { id: 'X' });
    assert.equal(ids(r), 'CDABX');
    assert.equal(r.anchor, 4);
    const sides = solidNeighbours(r.points);
    assert.ok(sides.includes('X:B'), sides.join(' '));
    // Same building: every original side but B-C is kept.
    const ring = neighbours(r.points, true);
    assert.ok(ring.includes('A:BD') && ring.includes('D:AC'), ring.join(' '));
});

test('outline: taps keep chaining from the newest corner', () => {
    let r = addJoined(P('ABCD'), 1, { id: 'X' });
    r = addJoined(r.points, r.anchor, { id: 'Y' });
    r = addJoined(r.points, r.anchor, { id: 'Z' });
    assert.equal(ids(r), 'CDABXYZ');
    const sides = solidNeighbours(r.points);
    assert.ok(sides.includes('X:BY') && sides.includes('Y:XZ') && sides.includes('Z:Y'), sides.join(' '));
});

test('outline: selecting the last or the first corner', () => {
    assert.equal(ids(addJoined(P('ABCD'), 3, { id: 'X' })), 'ABCDX');
    const first = addJoined(P('ABCD'), 0, { id: 'X' });
    assert.equal(ids(first), 'BCDAX');
    assert.ok(solidNeighbours(first.points).includes('X:A'));
});

test('outline: one or two corners so far', () => {
    assert.equal(ids(addJoined(P('A'), 0, { id: 'X' })), 'AX');
    assert.equal(ids(addJoined(P('AB'), 0, { id: 'X' })), 'BAX');
    assert.equal(ids(addJoined([], null, { id: 'X' })), 'X');
});

test('path: grows only from its ends', () => {
    assert.equal(ids(addJoined(P('ABCD'), 3, { id: 'X' }, { closed: false })), 'ABCDX');
    const start = addJoined(P('ABCD'), 0, { id: 'X' }, { closed: false });
    assert.equal(ids(start), 'XABCD');
    assert.equal(start.anchor, 0);
    assert.equal(addJoined(P('ABCD'), 1, { id: 'X' }, { closed: false }), null);
    assert.equal(canExtendFrom(P('ABCD'), 1, { closed: false }), false);
    assert.equal(canExtendFrom(P('ABCD'), 1, { closed: true }), true);
});

test('an out-of-range selection is clamped, never lost', () => {
    assert.equal(ids(addJoined(P('ABC'), 9, { id: 'X' })), 'ABCX');
});
