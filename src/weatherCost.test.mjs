import assert from 'node:assert/strict';
import {
    edgeRainFactor, nodeRainStatus, nodeRainLabel, rainRiskOf, cachedWeather, NODE_STATUS, WEATHER_MAX_STALE_MINUTES,
} from './weatherCost.js';

// ---- graded penalties: the server now sends values between 1 and the maximum
assert.equal(edgeRainFactor('outside', 'outside', 1.25), 1.25);
assert.equal(edgeRainFactor('outside', 'inside', 1.25), 1.125);   // entrance: half the penalty
assert.equal(edgeRainFactor('inside', 'inside', 1.25), 1);        // sheltered never changes
assert.equal(edgeRainFactor('outside', 'outside', 1), 1);
assert.equal(edgeRainFactor('outside', 'outside', 'junk'), 1);    // unparseable degrades to dry

// ---- node status follows the server flags (which now follow the AI probability)
const dry = { raining_now: false, rain_mode: false, rain_probability: 4 };
const possible = { raining_now: false, rain_mode: true, rain_probability: 27, probability_horizon_minutes: 20 };
const raining = { raining_now: true, rain_mode: true, rain_probability: 80 };
assert.equal(nodeRainStatus('outside', dry), NODE_STATUS.WHITE);
assert.equal(nodeRainStatus('outside', possible), NODE_STATUS.YELLOW);
assert.equal(nodeRainStatus('outside', raining), NODE_STATUS.RED);
for (const w of [dry, possible, raining]) assert.equal(nodeRainStatus('inside', w), NODE_STATUS.WHITE);

// ---- labels
assert.equal(nodeRainLabel('outside', dry), 'Open');
assert.equal(nodeRainLabel('outside', possible), 'Rain possible · 27% in the next 20 min');
assert.equal(nodeRainLabel('outside', { ...possible, probability_horizon_minutes: null }), 'Rain possible · 27%');
assert.equal(nodeRainLabel('outside', { raining_now: false, rain_mode: true }), 'Rain possible');
assert.equal(nodeRainLabel('outside', raining), 'Closed: raining now');
assert.equal(nodeRainLabel('inside', raining), 'Open · sheltered');
assert.equal(nodeRainLabel('covered', possible), 'Open · sheltered');
assert.equal(nodeRainLabel('outside', null), 'Open');

// ---- risk display
assert.equal(rainRiskOf({ rain_probability: 26.6 }), 27);
assert.equal(rainRiskOf({ rain_probability: 140 }), 100);
assert.equal(rainRiskOf({ rain_probability: null }), null);
assert.equal(rainRiskOf(undefined), null);

// ---- offline cache: keep the last good state with its age, then drop it
const NOW = Date.parse('2026-11-04T10:00:00+08:00');
const good = (minutesAgo, extra = {}) => ({
    status: 'ok', rain_mode: true, raining_now: false, rain_multiplier: 1.4, rain_probability: 30,
    fetched_at: new Date(NOW - minutesAgo * 60000).toISOString(), ...extra,
});
let c = cachedWeather(good(12), NOW);
assert.equal(c.status, 'cached'); assert.equal(c.age_minutes, 12);
assert.equal(c.rain_multiplier, 1.4);                              // penalty kept while still fresh enough
assert.equal(cachedWeather(good(WEATHER_MAX_STALE_MINUTES), NOW).age_minutes, 60);
assert.equal(cachedWeather(good(WEATHER_MAX_STALE_MINUTES + 1), NOW), null);   // too old: caller drops to no-weather
assert.equal(cachedWeather(null, NOW), null);
assert.equal(cachedWeather(good(5, { status: 'stale' }), NOW), null);
assert.equal(cachedWeather(good(5, { status: 'unavailable' }), NOW), null);
assert.equal(cachedWeather(good(5, { fetched_at: 'not a date' }), NOW), null);
assert.equal(cachedWeather(good(-3), NOW).age_minutes, 0);          // clock skew never gives a negative age

console.log('weatherCost tests passed');
