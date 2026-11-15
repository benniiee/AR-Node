import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easeK, orientRate, ORIENT_RATE_MIN, ORIENT_RATE_MAX } from './arMath.js';

// The AR camera must feel the same at any display rate: simulate one second of
// easing toward a fixed target at 30, 60, 90, 120 and 144 frames a second.
const RATES = [30, 60, 90, 120, 144];

const simulate = (hz, seconds, stepFn) => {
    let gap = 1;
    const dt = 1 / hz;
    const frames = Math.round(seconds * hz);
    for (let i = 0; i < frames; i += 1) gap -= gap * stepFn(dt);
    return gap;
};

test('position easing settles equally fast at every frame rate', () => {
    // Whatever the frame rate, the gap left after N frames equals exp(-elapsed / tau):
    // the result depends on time only (whole frames, so 144 Hz is not cut mid-frame).
    for (const hz of RATES) {
        const frames = Math.round(0.1 * hz);
        const left = simulate(hz, frames / hz, (dt) => easeK(dt, 0.04));
        assert.ok(Math.abs(left - Math.exp(-(frames / hz) / 0.04)) < 1e-9, `${hz} Hz: ${left}`);
    }
    // And it is quick: after 0.1 s less than 10 % of a GPS step is left.
    assert.ok(Math.exp(-0.1 / 0.04) < 0.1);
});

test('the old per-frame easing was frame-rate dependent (the bug this replaces)', () => {
    const at60 = simulate(60, 0.1, () => 0.35);
    const at120 = simulate(120, 0.1, () => 0.35);
    assert.ok(at60 / at120 > 10, 'per-frame 0.35 converges far faster at 120 Hz');
});

test('orientation smoothing filters noise and opens up on a turn', () => {
    assert.equal(orientRate(0.3), ORIENT_RATE_MIN);
    assert.equal(orientRate(1), ORIENT_RATE_MIN);
    assert.ok(orientRate(4) > ORIENT_RATE_MIN && orientRate(4) < ORIENT_RATE_MAX);
    assert.equal(orientRate(20), ORIENT_RATE_MAX);
    // A turn: the pose is within 5 % of the sensor after 50 ms at any frame rate.
    for (const hz of RATES) {
        const left = simulate(hz, 0.05, (dt) => easeK(dt, 1 / ORIENT_RATE_MAX));
        assert.ok(left < 0.05, `${hz} Hz left ${left}`);
    }
});

test('a zero or missing frame time never stalls or overshoots', () => {
    assert.equal(easeK(0, 0.04), 1);
    assert.ok(easeK(10, 0.04) <= 1);
    assert.ok(easeK(0.016, 0.04) > 0 && easeK(0.016, 0.04) < 1);
});
