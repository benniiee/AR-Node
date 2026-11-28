import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOUD_COUNT, cloudDeck, cloudShape, cloudSkyMode } from './cloudSky.js';

const signatureOf = (cloud) => JSON.stringify(cloudShape(cloud.seed).lobes.map((lobe) => [
    lobe.x.toFixed(3), lobe.y.toFixed(3), lobe.z.toFixed(3), lobe.r.toFixed(3),
]));

test('rain now beats every other sky', () => {
    assert.equal(cloudSkyMode({ status: 'ok', raining_now: true, heat_mode: true, rain_mode: true }), 'rain');
});

test('heat mode shows the sun while it is dry', () => {
    assert.equal(cloudSkyMode({ status: 'ok', raining_now: false, heat_mode: true }), 'heat');
    assert.equal(cloudSkyMode({ status: 'ok', heat_mode: false, rain_mode: false }), 'clear');
});

test('rain likely is overcast, not rain', () => {
    assert.equal(cloudSkyMode({ status: 'ok', raining_now: false, rain_mode: true }), 'overcast');
});

test('stale or missing weather never invents a storm', () => {
    assert.equal(cloudSkyMode(null), 'clear');
    assert.equal(cloudSkyMode({ status: 'unavailable', raining_now: true }), 'clear');
    assert.equal(cloudSkyMode({ status: 'stale', raining_now: true }), 'clear');
});

test('a deck has one cloud per screen, each with its own shape', () => {
    const deck = cloudDeck(12345);
    assert.ok(CLOUD_COUNT >= 15 && CLOUD_COUNT <= 20, `deck size ${CLOUD_COUNT} is outside 15-20`);
    assert.equal(deck.length, CLOUD_COUNT);
    assert.equal(new Set(deck.map((cloud) => cloud.seed)).size, CLOUD_COUNT);
    assert.equal(new Set(deck.map(signatureOf)).size, CLOUD_COUNT);
});

test('the same seed always draws the same deck', () => {
    assert.deepEqual(cloudDeck(99), cloudDeck(99));
    assert.notDeepEqual(cloudDeck(99).map(signatureOf), cloudDeck(100).map(signatureOf));
});

test('shapes run from tall crowns to low streaks, all flat underneath', () => {
    const shapes = Array.from({ length: 60 }, (_, i) => cloudShape(i + 1));
    const profiles = new Set(shapes.map((shape) => shape.profile));
    assert.ok(profiles.size >= 3, `expected a mix of profiles, got ${[...profiles].join(', ')}`);
    const aspects = shapes.map((shape) => shape.aspect);
    assert.ok(Math.max(...aspects) > 2 * Math.min(...aspects));
    for (const shape of shapes) {
        assert.ok(shape.lobes.length >= 3 && shape.lobes.length <= 12);
        // Every puff rests on the same line, so a cloud has a flat base on the map.
        const lowest = Math.min(...shape.lobes.map((lobe) => lobe.y - lobe.r));
        assert.ok(Math.abs(lowest) < 0.05, `${shape.profile} underside floats at ${lowest}`);
        assert.ok(shape.height > 0 && shape.span > 0);
    }
});

test('clouds keep a readable size and a believable wind speed', () => {
    for (const cloud of cloudDeck(7)) {
        assert.ok(cloud.widthM >= 20 && cloud.widthM <= 78);
        assert.ok(cloud.speedMps >= 1.6 && cloud.speedMps <= 4);
        assert.ok(cloud.depth >= 0.2 && cloud.depth <= 1);
    }
});
