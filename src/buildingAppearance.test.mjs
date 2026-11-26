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

    const odd = appearanceOf({ appearance: { roof: { style: 'dome', color: 'red' }, facade: 'glass', entrance: { sign: 'X'.repeat(200), canopy: 1 } } });
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
