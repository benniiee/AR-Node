import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearanceOf, roofLayers, offsetRing, isSimpleRing, roofColorOf, SIGN_MAX, STYLE_PRESETS, DEFAULT_SLOPED_ROOF } from './buildingAppearance.js';

const rect = (w, l) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: l }, { x: 0, y: l }];
// An L like CCS: a 40 x 12 wing and a 12 x 30 wing.
const L = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 12 }, { x: 12, y: 12 }, { x: 12, y: 30 }, { x: 0, y: 30 }];
const area = (r) => Math.abs(r.reduce((s, p, i) => s + p.x * r[(i + 1) % r.length].y - r[(i + 1) % r.length].x * p.y, 0)) / 2;

test('a look is always complete and safe to draw', () => {
    const plain = appearanceOf({});
    assert.equal(plain.roof.style, 'flat');
    assert.equal(plain.walls.color, null);
    assert.equal(plain.facade, 'windows');
    assert.equal(plain.entrance.canopy, false);

    const odd = appearanceOf({ appearance: { roof: { style: 'dome', color: 'red' }, facade: 'lattice', entrance: { sign: 'X'.repeat(200), canopy: 1 } } });
    assert.equal(odd.roof.style, 'flat', 'unknown style: flat');
    assert.equal(odd.roof.color, null, 'not a #rrggbb colour: the map colour');
    assert.equal(odd.facade, 'windows');
    assert.equal(odd.entrance.sign.length, SIGN_MAX);
    assert.equal(odd.entrance.canopy, true);

    assert.equal(roofColorOf(appearanceOf({ appearance: { roof: { style: 'hip' } } })), DEFAULT_SLOPED_ROOF, 'a sloped roof without a colour is maroon');
    for (const preset of STYLE_PRESETS) assert.deepEqual(appearanceOf({ appearance: preset.appearance }).roof, preset.appearance.roof);
});

test('a sloped roof climbs from an eave past the walls to a ridge inside the outline', () => {
    const { rings, rise } = roofLayers(rect(12, 40), 'hip');
    assert.equal(rings.length, 2);
    const [eave, top] = rings;
    assert.ok(area(eave.pts) > 12 * 40, 'the eave reaches past the walls');
    assert.ok(area(top.pts) < 12 * 40 * 0.15, 'the top is close to a ridge');
    assert.ok(top.h > 2 && top.h === rise && rise <= 6);
    // A flat roof is the outline itself.
    assert.deepEqual(roofLayers(rect(12, 40), 'flat').rings, [{ pts: rect(12, 40), h: 0 }]);
});

test('a gable roofs to a thin ridge along the long side, a shed to a high edge', () => {
    const gable = roofLayers(rect(30, 12), 'gable');
    assert.equal(gable.rings.length, 2);
    const [eave, ridge] = gable.rings;
    assert.ok(area(eave.pts) > 30 * 12, 'the eave reaches past the walls');
    assert.ok(area(ridge.pts) < 30 * 12 * 0.15, 'the ridge is a thin sliver');
    assert.ok(ridge.h === gable.rise && ridge.h > 1.5 && ridge.h <= 6);
    // The ridge runs along the 30 m side: it is long, not square.
    const span = (pts) => Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    const depth = (pts) => Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
    assert.ok(span(ridge.pts) > 25 && depth(ridge.pts) < 3, 'the ridge follows the long axis');

    const shed = roofLayers(rect(30, 12), 'shed');
    assert.equal(shed.rings.length, 2);
    assert.ok(shed.rings[1].h > gable.rise, 'one slope across the whole depth is steeper than a gable');
    assert.ok(span(shed.rings[1].pts) > 25, 'its high edge runs the length too');
    // Both stay drawable on an L, whichever way it is wound.
    for (const outline of [L, [...L].reverse()]) {
        for (const style of ['gable', 'shed']) {
            for (const r of roofLayers(outline, style).rings) {
                assert.equal(r.pts.length, L.length, style);
                assert.ok(isSimpleRing(r.pts), style);
            }
        }
    }
});

test('a curved roof rises steeply at the eave and levels off at the top', () => {
    const { rings } = roofLayers(rect(14, 50), 'curved');
    assert.ok(rings.length >= 4);
    const heights = rings.map((r) => r.h);
    for (let k = 1; k < heights.length; k += 1) assert.ok(heights[k] > heights[k - 1], 'it keeps rising');
    const first = heights[2] - heights[1];
    const last = heights.at(-1) - heights.at(-2);
    assert.ok(first > last, 'steeper at the eave than at the top');
});

test('an L-shaped building gets a roof that never crosses itself, whichever way it is drawn', () => {
    for (const outline of [L, [...L].reverse()]) {
        for (const style of ['hip', 'curved']) {
            const { rings } = roofLayers(outline, style);
            assert.ok(rings.length >= 2, style);
            for (const r of rings) {
                assert.equal(r.pts.length, L.length, 'every ring keeps one corner per corner of the outline');
                assert.ok(isSimpleRing(r.pts));
            }
        }
    }
    assert.equal(offsetRing(rect(10, 10), 6), null, 'moved in past its middle: no ring');
});

test('individually placed items are normalized, clamped and safe to draw', () => {
    const withItems = appearanceOf({
        appearance: {
            items: [
                { id: 'w1', type: 'window_standard', edge: 1, t: 0.4, floor: 2, width_m: 1.8, height_m: 1.4, awning: true, accent: '#2F6FB3' },
                { id: 'bad', type: 'flying_saucer', edge: 0, t: 0.5 },
                { id: 'p1', type: 'pillar_square', edge: 0, t: 1.5, width_m: 99, height_m: 0.1, color: 'not-hex' },
            ],
        },
    });
    assert.equal(withItems.items.length, 2, 'unknown item types are dropped');
    assert.equal(withItems.items[0].type, 'window_standard');
    assert.equal(withItems.items[0].accent, '#2f6fb3');
    assert.equal(withItems.items[0].awning, true);
    assert.equal(withItems.items[1].t, 1, 't is clamped to [0, 1]');
    assert.equal(withItems.items[1].width_m, 2.5, 'width is clamped to maxWidth');
    assert.equal(withItems.items[1].height_m, 1, 'height is clamped to minHeight');
    assert.equal(withItems.items[1].color, null, 'bad hex falls back to null');
});
