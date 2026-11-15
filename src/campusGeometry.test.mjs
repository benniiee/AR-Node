import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    polygonCentroid, pointInPolygon, buildingAt, buildingFloors, floorCountLabel,
    nodePlaceLabel, osmRef, distanceToLineM,
} from './campusGeometry.js';

const square = (lat, lng, d) => [
    { lat, lng }, { lat, lng: lng + d }, { lat: lat + d, lng: lng + d }, { lat: lat + d, lng },
];

test('centroid of a square is its middle', () => {
    const c = polygonCentroid(square(6.913, 122.061, 0.0002));
    assert.ok(Math.abs(c.lat - 6.9131) < 1e-9);
    assert.ok(Math.abs(c.lng - 122.0611) < 1e-9);
});

test('point in polygon', () => {
    const sq = square(6.913, 122.061, 0.0002);
    assert.equal(pointInPolygon(6.9131, 122.0611, sq), true);
    assert.equal(pointInPolygon(6.9135, 122.0611, sq), false);
    assert.equal(pointInPolygon(6.9131, 122.0611, sq.slice(0, 2)), false);
});

test('buildingAt picks the smallest building containing the point', () => {
    const campus = { id: 1, polygon: square(6.912, 122.060, 0.003) };
    const lib = { id: 2, polygon: square(6.913, 122.061, 0.0002) };
    assert.equal(buildingAt([campus, lib], 6.9131, 122.0611).id, 2);
    assert.equal(buildingAt([campus, lib], 6.9125, 122.0605).id, 1);
    assert.equal(buildingAt([lib], 6.9200, 122.0700), null);
});

test('building floors run from the lowest basement to floors - 1', () => {
    assert.deepEqual(buildingFloors({ floors: 3 }), [0, 1, 2]);
    assert.deepEqual(buildingFloors({ floors: 1 }), [0]);
    assert.deepEqual(buildingFloors(null), []);
});

test('floor count labels', () => {
    assert.equal(floorCountLabel({ floors: 1 }), '1 floor');
    assert.equal(floorCountLabel({ floors: 4 }), '4 floors');
});

test('node place label names the building and floor', () => {
    const byId = new Map([[7, { id: 7, name: 'CCS', floors: 4 }]]);
    // Ground is the 1st floor, so level 2 is the 3rd floor.
    assert.equal(nodePlaceLabel({ building_id: 7, floor_level: 2 }, byId), 'CCS · Floor 3 of 4');
    assert.equal(nodePlaceLabel({ building_id: 7, floor_level: 0 }, byId), 'CCS · Ground floor of 4');
    assert.equal(nodePlaceLabel({ building_id: null }, byId), '');
});

test('osm refs prefer the tile feature id', () => {
    assert.equal(osmRef('building', 123, []), 'building:123');
    assert.equal(osmRef('road', undefined, [{ lat: 6.9, lng: 122.1 }]), 'road@6.90000,122.10000');
});

test('distance to a line', () => {
    const line = [{ lat: 6.913, lng: 122.061 }, { lat: 6.913, lng: 122.062 }];
    assert.ok(distanceToLineM(6.913, 122.0615, line) < 0.01);
    const d = distanceToLineM(6.91309, 122.0615, line);
    assert.ok(d > 9.9 && d < 10.1, `expected ~10 m, got ${d}`);
});

test('interiorPoint stays inside an L-shaped building whose centre is in the notch', async () => {
    const { interiorPoint } = await import('./campusGeometry.js');
    const L = [
        { lat: 6.9130, lng: 122.0610 }, { lat: 6.9130, lng: 122.0612 }, { lat: 6.91305, lng: 122.0612 },
        { lat: 6.91305, lng: 122.06105 }, { lat: 6.9132, lng: 122.06105 }, { lat: 6.9132, lng: 122.0610 },
    ];
    const c = polygonCentroid(L);
    assert.equal(pointInPolygon(c.lat, c.lng, L), false, 'premise: the centre is outside');
    const p = interiorPoint(L);
    assert.equal(pointInPolygon(p.lat, p.lng, L), true);
    const sq = [{ lat: 6.913, lng: 122.061 }, { lat: 6.913, lng: 122.0612 }, { lat: 6.9132, lng: 122.0612 }, { lat: 6.9132, lng: 122.061 }];
    assert.deepEqual(interiorPoint(sq), polygonCentroid(sq));
});
