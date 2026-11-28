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
    assert.equal(deck.length, CLOUD_COUNT);
    assert.equal(new Set(deck.map((cloud) => cloud.seed)).size, CLOUD_COUNT);
    assert.equal(new Set(deck.map(signatureOf)).size, CLOUD_COUNT);
});

test('the same seed always draws the same deck', () => {
    assert.deepEqual(cloudDeck(99), cloudDeck(99));
    assert.notDeepEqual(cloudDeck(99).map(signatureOf), cloudDeck(100).map(signatureOf));
});

test('clouds keep a readable size and a believable wind speed', () => {
    for (const cloud of cloudDeck(7)) {
        assert.ok(cloud.widthFrac >= 0.15 && cloud.widthFrac <= 0.3);
        assert.ok(cloud.speedMps >= 4 && cloud.speedMps <= 13);
        assert.ok(cloud.depth >= 0.2 && cloud.depth <= 1);
    }
});
