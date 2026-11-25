import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrowsAlong, startBearing, bearingDeg, pointAhead } from './routeArrows.js';
import { fromLocalMeters } from './geo.js';

const O = [6.913, 122.061];
const at = (e, n) => { const p = fromLocalMeters(O[0], O[1], e, n); return [p.latitude, p.longitude]; };

test('chevrons sit every few metres along the route, pointing the way it goes', () => {
    // 30 m north, then 30 m east.
    const line = [at(0, 0), at(0, 30), at(30, 30)];
    const arrows = arrowsAlong(line, 10, 5);
    assert.equal(arrows.length, 6, 'at 5, 15, 25, 35, 45 and 55 m');
    assert.ok(Math.abs(arrows[0].bearing - 0) < 1, 'first stretch points north');
    assert.ok(Math.abs(arrows.at(-1).bearing - 90) < 1, 'last stretch points east');
    assert.deepEqual(arrowsAlong([at(0, 0)], 10), [], 'no line, no chevrons');
});

test('the arrow at your position points to where the route goes next, not to its end', () => {
    // East for 6 m, then north for 50 m: the first steps go east.
    const line = [at(0, 0), at(6, 0), at(6, 50)];
    assert.ok(Math.abs(startBearing(line, 4) - 90) < 1, 'east first');
    assert.ok(startBearing(line, 30) < 45, 'looking further ahead turns it towards the north');
    assert.equal(startBearing([at(0, 0)]), null);
    assert.ok(Math.abs(bearingDeg(at(0, 0), at(-5, 0)) - 270) < 1, 'west is 270');
    assert.deepEqual(pointAhead(line, 1000), line.at(-1), 'past the end: the end');
});
