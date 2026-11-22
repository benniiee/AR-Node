import test from 'node:test';
import assert from 'node:assert/strict';
import {
    campusClock, formatTime, hoursOf, openState, summarizeHours, closedBuildingIds, weeklyHours,
} from './openingHours.js';

// Campus time is UTC+8: 2026-11-23 is a Monday.
const at = (iso) => new Date(`${iso}+08:00`);
const CANTEEN = weeklyHours(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], '08:00', '17:00');
const CASHIER = weeklyHours(['mon', 'tue', 'wed', 'thu', 'fri'], '08:00', '16:00', ['12:00', '13:00']);

test('campus clock is UTC+8 whatever the phone zone', () => {
    assert.deepEqual(campusClock(at('2026-11-23T07:30:00')), { day: 'mon', minutes: 450 });
    // 23:30 UTC on Sunday is already Monday 7:30 on campus.
    assert.deepEqual(campusClock(new Date('2026-11-22T23:30:00Z')), { day: 'mon', minutes: 450 });
});

test('times read the way people say them', () => {
    assert.equal(formatTime('17:00'), '5 pm');
    assert.equal(formatTime('08:30'), '8:30 am');
    assert.equal(formatTime('12:00'), '12 pm');
    assert.equal(formatTime('24:00'), 'midnight');
});

test('open and closed, with when it closes or opens next', () => {
    assert.deepEqual(openState(CANTEEN, at('2026-11-23T10:00:00')), { open: true, short: 'Open', label: 'Open · closes 5 pm' });
    assert.equal(openState(CANTEEN, at('2026-11-23T07:00:00')).label, 'Closed · opens 8 am');
    assert.equal(openState(CANTEEN, at('2026-11-23T17:00:00')).label, 'Closed · opens tomorrow 8 am', 'closing time itself is closed');
    // Saturday evening: Sunday is closed, so the next opening is Monday.
    assert.equal(openState(CANTEEN, at('2026-11-28T18:00:00')).label, 'Closed · opens Mon 8 am');
    // Lunch break.
    assert.equal(openState(CASHIER, at('2026-11-23T12:30:00')).label, 'Closed · opens 1 pm');
    assert.equal(openState(CASHIER, at('2026-11-23T13:00:00')).open, true);
    // No set hours: no state (always open); closed every day: plain "Closed".
    assert.equal(openState(null), null);
    assert.equal(openState(weeklyHours([], '08:00', '17:00'), at('2026-11-23T10:00:00')).label, 'Closed');
});

test('a place follows its building unless it has its own hours', () => {
    const buildings = new Map([[1, { id: 1, opening_hours: CANTEEN }]]);
    assert.equal(hoursOf({ building_id: 1 }, buildings), CANTEEN);
    assert.equal(hoursOf({ building_id: 1, opening_hours: CASHIER }, buildings), CASHIER);
    assert.equal(hoursOf({ building_id: null }, buildings), null);
});

test('the week in a line', () => {
    assert.equal(summarizeHours(CANTEEN), 'Mon–Sat 8 am–5 pm');
    assert.equal(summarizeHours(CASHIER), 'Mon–Fri 8 am–12 pm, 1 pm–4 pm');
    assert.equal(summarizeHours({ ...CANTEEN, sat: [['08:00', '12:00']] }), 'Mon–Fri 8 am–5 pm · Sat 8 am–12 pm');
    assert.equal(summarizeHours(weeklyHours([], '08:00', '17:00')), 'Closed every day');
});

test('buildings closed right now (for routing around them)', () => {
    const buildings = [{ id: 1, opening_hours: CANTEEN }, { id: 2, opening_hours: null }, { id: 3, opening_hours: CASHIER }];
    assert.deepEqual(closedBuildingIds(buildings, at('2026-11-23T12:30:00')), [3]);
    assert.deepEqual(closedBuildingIds(buildings, at('2026-11-29T10:00:00')), [1, 3], 'Sunday');
});

test('a closed building is walked around, unless it is where you are going', async () => {
    const { computeRoute } = await import('./pathfinding.js');
    const { fromLocalMeters } = await import('./geo.js');
    const LAT = 6.913;
    const LNG = 122.061;
    const ll = (e, n) => { const p = fromLocalMeters(LAT, LNG, e, n); return { lat: p.latitude, lng: p.longitude }; };
    const node = (id, e, n, extra = {}) => { const p = ll(e, n); return { id, type: 'route', latitude: p.lat, longitude: p.lng, floor_level: 0, elevation: 0, path_type: 'outside', building_id: null, ...extra }; };
    // A 30 x 30 m hall with a door south and north and a corridor node inside; a longer way round its east side.
    const hall = { id: 1, status: 'existing', polygon: [ll(-15, 20), ll(15, 20), ll(15, 50), ll(-15, 50)], doors: [ll(0, 20), ll(0, 50)], opening_hours: CANTEEN };
    const nodes = [node(1, 0, 5), node(2, 25, 10), node(3, 25, 60), node(5, 0, 35, { path_type: 'inside', building_id: 1 }), node(9, 0, 70, { type: 'location' })];
    const start = ll(0, 0);
    const route = (dest, when) => computeRoute(nodes, dest, start.lat, start.lng, 0, [], {
        buildings: [hall], closedBuildingIds: closedBuildingIds([hall], at(when)),
    });

    const open = route(9, '2026-11-23T10:00:00');
    assert.ok(open.path.some((p) => p.id === 5), 'open: straight through the hall');
    const closed = route(9, '2026-11-23T19:00:00');
    assert.equal(closed.success, true);
    assert.ok(!closed.path.some((p) => p.building_id === 1), 'closed: not through it');
    assert.ok(closed.path.some((p) => p.id === 2), 'round the east side');
    // Going to the closed hall itself still routes there (you may wait for it to open).
    assert.equal(route(5, '2026-11-23T19:00:00').success, true);
});
