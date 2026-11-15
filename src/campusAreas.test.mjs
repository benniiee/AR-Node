import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointInArea, areaAt, nodeArea, buildingArea, campusMatcher } from './campusAreas.js';

const square = (lat0, lng0, size = 0.002) => [
    { lat: lat0, lng: lng0 }, { lat: lat0, lng: lng0 + size },
    { lat: lat0 + size, lng: lng0 + size }, { lat: lat0 + size, lng: lng0 },
];
const A = { id: 1, name: 'Campus A', polygon: square(6.909, 122.070) };
const B = { id: 2, name: 'Campus B', polygon: square(6.920, 122.080) };
const areas = [A, B];

test('a point inside an outline belongs to that campus', () => {
    assert.equal(pointInArea(6.910, 122.071, A.polygon), true);
    assert.equal(pointInArea(6.915, 122.071, A.polygon), false);
    assert.equal(areaAt(6.921, 122.081, areas), B);
    assert.equal(areaAt(6.950, 122.100, areas), null);
    assert.equal(areaAt('x', 122.07, areas), null);
});

test('nodes go by their position and buildings by their centre', () => {
    assert.equal(nodeArea({ latitude: 6.910, longitude: 122.071 }, areas), A);
    const building = { polygon: square(6.9095, 122.0705, 0.0005) };
    assert.equal(buildingArea(building, areas), A);
    assert.equal(buildingArea({ polygon: [] }, areas), null);
});

test('the campus filter keeps one campus, everything, or what is on none', () => {
    assert.equal(campusMatcher('all', areas)(B), true);
    assert.equal(campusMatcher(1, areas)(A), true);
    assert.equal(campusMatcher(1, areas)(B), false);
    assert.equal(campusMatcher(1, areas)(null), false);
    assert.equal(campusMatcher('none', areas)(null), true);
    assert.equal(campusMatcher('none', areas)(A), false);
    assert.equal(campusMatcher(99, areas)(B), true); // a removed area shows everything
});
