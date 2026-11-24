import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundedRoadLine, roadStrip, ROAD_WIDTH_M } from './holoRibbon.js';

test('the AR road is one width all along, rounds its corners, and its paint runs in metres along the walk', () => {
    // 10 m ahead (-z), then 10 m to the right (+x), on the ground.
    const line = roundedRoadLine([{ x: 0, y: -1.6, z: 0 }, { x: 0, y: -1.6, z: -10 }, { x: 10, y: -1.6, z: -10 }]);
    assert.ok(line.length > 40, 'sampled every quarter metre');
    assert.ok(!line.some((p) => Math.hypot(p.x, p.z + 10) < 0.3), 'the corner is cut by a curve, not walked to its point');

    const strip = roadStrip(line, ROAD_WIDTH_M / 2);
    assert.equal(strip.positions.length, line.length * 6, 'two vertices per point');
    for (let i = 0; i < line.length; i += 1) {
        const [lx, ly, lz, rx, ry, rz] = strip.positions.slice(i * 6, i * 6 + 6);
        assert.ok(Math.abs(Math.hypot(lx - rx, lz - rz) - ROAD_WIDTH_M) < 1e-6, `width at point ${i}`);
        assert.equal(ly, ry, 'level across');
    }
    const along = strip.uvs.filter((_, k) => k % 4 === 1);
    assert.ok(along.every((v, i) => i === 0 || v > along[i - 1]), 'v grows along the walk');
    assert.ok(along.at(-1) > 19 && along.at(-1) < 20, 'two 8.5 m straights and the curve between them: a little under 20 m');
    assert.equal(roadStrip([line[0]], 0.8), null, 'one point: nothing to draw');
});
