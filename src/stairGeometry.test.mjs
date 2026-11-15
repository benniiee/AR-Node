import test from 'node:test';
import assert from 'node:assert/strict';
import {
    planStairs, planFromLink, fitYaw, stairWalkLength, flightsForShape, shapeIdOf,
    stairInstruction, landingTurns, footprint, meanAngle, normalizeFlights, bearingOf,
} from './stairGeometry.js';

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('straight stairs match the old formula (rise / sin angle) and head along yaw', () => {
    const plan = planStairs({ rise: 3, yawDeg: 90, angleDeg: 30 });
    near(plan.totalLength, 3 / Math.sin(Math.PI / 6));
    near(plan.end.e, 3 / Math.tan(Math.PI / 6)); // due east
    near(plan.end.n, 0, 1e-6);
    near(plan.end.u, 3);
    assert.equal(plan.segments.length, 1);
});

test('L-shape turning right: second flight heads 90 degrees clockwise', () => {
    const plan = planStairs({ rise: 3, yawDeg: 0, flights: flightsForShape('l-right', 40), landingM: 1.4 });
    const [f1, landing, f2] = plan.segments;
    assert.equal(landing.kind, 'landing');
    near(f1.yawDeg, 0); near(f2.yawDeg, 90);
    // flight 2 starts on the landing's right edge, level with the landing
    near(f2.from.u, f1.to.u);
    near(f2.from.e, f1.to.e + 0.7, 1e-6);       // half the landing width to the right
    near(f2.from.n, f1.to.n + 0.7, 1e-6);       // half the landing depth ahead
    near(plan.end.u, 3);
    assert.ok(plan.end.e > f2.from.e);          // keeps going east
});

test('U-shape: flights run side by side in opposite directions', () => {
    const plan = planStairs({ rise: 3, yawDeg: 0, flights: flightsForShape('u-left', 35) });
    const [f1, landing, f2] = plan.segments;
    near(f2.yawDeg, 180);
    near(f2.from.n, f1.to.n, 1e-6);             // second flight starts level with the first one's end
    near(f2.from.e, f1.to.e - 1.5, 1e-6);       // one lane (width + gap) to the LEFT
    assert.ok(landing.width > 2.8);             // landing spans both lanes
    // it climbs back toward where it started
    assert.ok(plan.end.n < f1.to.n);
});

test('mirror: left and right U-shapes are mirror images', () => {
    const l = planStairs({ rise: 3, yawDeg: 0, flights: flightsForShape('u-left', 35) });
    const r = planStairs({ rise: 3, yawDeg: 0, flights: flightsForShape('u-right', 35) });
    near(l.end.e, -r.end.e, 1e-6); near(l.end.n, r.end.n, 1e-6);
});

test('landing adds walking length, rise splits equally between flights', () => {
    const single = planStairs({ rise: 3, angleDeg: 40 });
    const l = planStairs({ rise: 3, flights: flightsForShape('l-left', 40) });
    assert.ok(l.totalLength > single.totalLength);
    near(l.segments[0].rise, 1.5); near(l.segments[2].rise, 1.5);
    near(stairWalkLength({ flights: flightsForShape('l-left', 40) }, 3), l.totalLength);
});

test('yaw only rotates the plan, never changes its size', () => {
    const a = planStairs({ rise: 3, yawDeg: 0, flights: flightsForShape('l-right', 40) });
    const b = planStairs({ rise: 3, yawDeg: 217, flights: flightsForShape('l-right', 40) });
    near(a.totalLength, b.totalLength, 1e-9);
    near(Math.hypot(a.end.e, a.end.n), Math.hypot(b.end.e, b.end.n), 1e-9);
});

test('fitYaw aims the stairs so they end on the top node', () => {
    const flights = flightsForShape('l-right', 38);
    const truth = planStairs({ rise: 3, yawDeg: 137, flights, landingM: 1.6 });
    const yaw = fitYaw({ rise: 3, topOffset: { e: truth.end.e, n: truth.end.n }, flights, landingM: 1.6 });
    near(yaw, 137, 0.2);
    assert.equal(fitYaw({ rise: 3, topOffset: { e: 0.1, n: 0.1 }, flights }), null); // stacked nodes
});

test('planFromLink: lower floor is the bottom; legacy links take yaw from the nodes', () => {
    const a = { latitude: 6.9, longitude: 122.0, elevation: 3, floor_level: 1 };
    const b = { latitude: 6.9, longitude: 122.00004, elevation: 0, floor_level: 0 }; // ~4.4 m east of a
    const res = planFromLink({ angle_deg: 40 }, a, b);
    assert.equal(res.bottom, b); assert.equal(res.top, a);
    assert.equal(res.yawSource, 'nodes');
    near(res.yawDeg, 270, 1);                    // bottom -> top is WEST
    const set = planFromLink({ angle_deg: 40, yaw_deg: 10 }, a, b);
    assert.equal(set.yawSource, 'set'); near(set.yawDeg, 10, 1e-9);
    const zero = planFromLink({ angle_deg: 40, yaw_deg: 0 }, a, b);
    assert.equal(zero.yawSource, 'set');         // 0 is a real heading (north), not "unset"
});

test('instructions mirror going down', () => {
    const flights = flightsForShape('l-right', 40);
    assert.equal(stairInstruction({ direction: 'up', flights, toLabel: 'floor 2' }),
        'Take the stairs up, turn right at the landing, then continue to floor 2.');
    assert.equal(stairInstruction({ direction: 'down', flights, toLabel: 'ground floor' }),
        'Take the stairs down, turn left at the landing, then continue to ground floor.');
    assert.equal(stairInstruction({ direction: 'up', flights: flightsForShape('straight') }), 'Take the stairs up.');
    assert.match(stairInstruction({ direction: 'up', flights: flightsForShape('u-left') }), /U-turn to the left/);
    assert.deepEqual(landingTurns('down', flightsForShape('u-right')), [-180]);
});

test('shape helpers', () => {
    assert.equal(shapeIdOf(flightsForShape('u-right')), 'u-right');
    assert.equal(shapeIdOf([{ turn_deg: 0 }, { turn_deg: 45 }]), 'custom');
    assert.equal(shapeIdOf(undefined), 'straight');
    assert.equal(normalizeFlights([{ angle_deg: 200, turn_deg: 50 }])[0].turn_deg, 0); // first turn forced to 0
    assert.equal(normalizeFlights(Array(9).fill({})).length, 4);
    near(meanAngle([{ angle_deg: 30 }, { angle_deg: 40, turn_deg: 90 }]), 35);
    near(bearingOf(1, 0), 90); near(bearingOf(0, -1), 180);
});

test('footprint yields one ring per flight/landing', () => {
    const plan = planStairs({ rise: 3, flights: flightsForShape('u-right', 35) });
    const fp = footprint(plan);
    assert.deepEqual(fp.map((f) => f.kind), ['flight', 'landing', 'flight']);
    assert.ok(fp.every((f) => f.ring.length === 4));
});

test('stairTreads climbs every step from the bottom to the full rise, with landings flat', async () => {
    const { planStairs: plan2, stairTreads } = await import('./stairGeometry.js');
    const plan = plan2({ rise: 3, yawDeg: 0, flights: [{ angle_deg: 35 }, { angle_deg: 35, turn_deg: 180 }], landingM: 1.2 });
    const treads = stairTreads(plan);
    const steps = treads.filter((t) => t.kind === 'tread');
    const landings = treads.filter((t) => t.kind === 'landing');
    assert.equal(landings.length, 1);
    assert.equal(steps.length, plan.segments.filter((s) => s.kind === 'flight').reduce((n, s) => n + s.steps, 0));
    assert.ok(Math.abs(steps[steps.length - 1].u - 3) < 1e-9, 'last tread at the full rise');
    for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i].u > steps[i - 1].u, 'treads keep climbing');
    assert.ok(Math.abs(landings[0].u - 1.5) < 1e-9, 'landing halfway up');
    // First flight heads north: its risers face south (towards the 2.5D viewer).
    assert.equal(steps[0].facingDeg, 180);
});

test('walkLine runs from the bottom node up every flight and landing to the full rise', async () => {
    const { planStairs: plan2, walkLine } = await import('./stairGeometry.js');
    const plan = plan2({ rise: 3, yawDeg: 0, flights: [{ angle_deg: 35 }, { angle_deg: 35, turn_deg: 180 }], landingM: 1.2 });
    const line = walkLine(plan);
    assert.deepEqual(line[0], { e: 0, n: 0, u: 0 });
    assert.ok(Math.abs(line[line.length - 1].u - 3) < 1e-9);
    for (let i = 1; i < line.length; i += 1) assert.ok(line[i].u >= line[i - 1].u - 1e-9, 'never goes down');
    assert.ok(line.some((p) => Math.abs(p.u - 1.5) < 1e-9), 'passes the landing');
});
