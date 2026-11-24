import test from 'node:test';
import assert from 'node:assert/strict';
import {
    campusClock, formatTime, hoursOf, openState, summarizeHours, closedBuildingIds, weeklyHours,
    placeStatus, buildingTarget, placeTarget, covers, buildingStatus, placeStatusOf, nextOpening, announcements, formatWhen, closedMessage,
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

// ── Closures ──
const CCS = { id: 1, name: 'CCS', kind: 'college' };
const CASH = { id: 2, name: 'Cashier office', kind: 'office' };
const ccsHall = { id: 10, campus: 'B', category: 'school', department: CCS, opening_hours: CANTEEN };
const adminHall = { id: 11, campus: 'A', category: 'office', department: CASH, opening_hours: CANTEEN };
const byId = new Map([[10, ccsHall], [11, adminHall]]);
const cashier = { id: 100, building_id: 11, campus: 'A', department: CASH, opening_hours: CASHIER };
const lab = { id: 101, building_id: 10, campus: 'B', department: CCS };
const closure = (over) => ({ id: 1, kind: 'closed', reason: 'Maintenance', starts_at: at('2026-11-23T00:00:00').toISOString(), ends_at: at('2026-11-24T00:00:00').toISOString(), ...over });
const MON_10 = at('2026-11-23T10:00:00');

test('a closure covers what its fields name, all of them', () => {
    const lab_ = placeTarget(lab, byId);
    assert.ok(covers(closure({}), lab_), 'whole school');
    assert.ok(covers(closure({ building_category: 'school' }), lab_), 'every school building');
    assert.ok(!covers(closure({ building_category: 'office' }), lab_));
    assert.ok(covers(closure({ campus: 'B', building_category: 'school' }), lab_));
    assert.ok(!covers(closure({ campus: 'A', building_category: 'school' }), lab_));
    assert.ok(covers(closure({ building_id: 10 }), lab_), 'its building closes its rooms');
    assert.ok(covers(closure({ department_id: 1 }), lab_));
    assert.ok(!covers(closure({ node_id: 100 }), lab_), 'another room');
    assert.ok(!covers(closure({ node_id: 100 }), buildingTarget(adminHall)), 'a room never closes its building');
});

test('classes suspended: school buildings close, office buildings stay open', () => {
    const heat = [closure({ building_category: 'school', reason: 'Classes suspended: high heat index', ends_at: at('2026-11-23T17:00:00').toISOString() })];
    const s = buildingStatus(ccsHall, heat, MON_10);
    assert.equal(s.open, false);
    assert.equal(s.label, 'Closed · Classes suspended: high heat index · opens tomorrow 8 am', 'reopens with its weekly hours, not at 5 pm');
    assert.equal(placeStatusOf(lab, byId, heat, MON_10).open, false, 'its rooms too');
    assert.equal(buildingStatus(adminHall, heat, MON_10).open, true);
    assert.equal(placeStatusOf(cashier, byId, heat, MON_10).open, true);
    assert.deepEqual(closedBuildingIds([ccsHall, adminHall], MON_10, heat), [10]);
    assert.deepEqual(announcements(heat, MON_10).map((a) => a.text), ['Classes suspended: high heat index · All school buildings · until 5 pm']);
    // Not yet started / already over: no effect.
    assert.equal(buildingStatus(ccsHall, heat, at('2026-11-23T18:00:00')).open, false, 'after hours anyway');
    assert.equal(buildingStatus(ccsHall, heat, at('2026-11-24T10:00:00')).open, true, 'next day: over');
});

test('a room closed for an afternoon, and a special opening', () => {
    const maint = [closure({ node_id: 100, reason: 'System maintenance', starts_at: at('2026-11-23T13:00:00').toISOString(), ends_at: at('2026-11-23T15:00:00').toISOString() })];
    assert.equal(placeStatusOf(cashier, byId, maint, MON_10).open, true, 'before it');
    assert.equal(placeStatusOf(cashier, byId, maint, at('2026-11-23T14:00:00')).label, 'Closed · System maintenance · opens 3 pm');
    assert.equal(buildingStatus(adminHall, maint, at('2026-11-23T14:00:00')).open, true, 'the building stays open');

    const sunday = [closure({ kind: 'open', reason: null, node_id: 100, starts_at: at('2026-11-29T08:00:00').toISOString(), ends_at: at('2026-11-29T12:00:00').toISOString() })];
    assert.equal(placeStatusOf(cashier, byId, sunday, at('2026-11-29T09:00:00')).label, 'Open · special hours until 12 pm');
    // A wider closure still wins over a special opening.
    assert.equal(placeStatusOf(cashier, byId, [...sunday, closure({ starts_at: at('2026-11-29T00:00:00').toISOString(), ends_at: at('2026-11-30T00:00:00').toISOString(), reason: 'Typhoon' })], at('2026-11-29T09:00:00')).open, false);
});

test('next opening and when-words', () => {
    assert.equal(nextOpening(CANTEEN, at('2026-11-23T10:00:00')).toISOString(), at('2026-11-23T10:00:00').toISOString(), 'open now');
    assert.equal(nextOpening(CANTEEN, at('2026-11-28T18:00:00')).toISOString(), at('2026-11-30T08:00:00').toISOString(), 'Sat evening -> Mon');
    assert.equal(formatWhen(at('2026-11-23T17:00:00'), MON_10), '5 pm');
    assert.equal(formatWhen(at('2026-11-24T08:00:00'), MON_10), 'tomorrow 8 am');
    assert.equal(formatWhen(at('2026-11-27T08:00:00'), MON_10), 'Fri 8 am');
    assert.equal(formatWhen(at('2026-12-03T08:00:00'), MON_10), 'Dec 3');
    assert.equal(placeStatus(null, [], buildingTarget({ id: 9 }), MON_10), null, 'no hours, nothing covering: no status');
});

test('a closed building with no doors is still reachable, and a blocked way is named', async () => {
    const { computeRoute, pathwayWaypoints } = await import('./pathfinding.js');
    const { fromLocalMeters } = await import('./geo.js');
    const ll = (e, n) => { const p = fromLocalMeters(6.913, 122.061, e, n); return { lat: p.latitude, lng: p.longitude }; };
    // A walkway running into a closed hall with no doors or rooms (routes to it end on the walkway inside).
    const hall = { id: 7, status: 'existing', name: 'Misto', polygon: [ll(-10, 20), ll(10, 20), ll(10, 40), ll(-10, 40)], opening_hours: CANTEEN };
    const walk = { id: 1, kind: 'walkway', status: 'existing', coordinates: [ll(0, 0), ll(0, 30)] };
    const inside = pathwayWaypoints([walk]).at(-1);
    const start = ll(0, -2);
    // One real node, far away on another floor (no detour through it): the router needs a non-empty map.
    const far = (() => { const p = ll(500, 500); return [{ id: 99, type: 'route', latitude: p.lat, longitude: p.lng, floor_level: 5, elevation: 16, path_type: 'inside', building_id: null }]; })();
    const sunday = closedBuildingIds([hall], at('2026-11-29T10:00:00'));
    const opts = { buildings: [hall], pathways: [walk], closedBuildingIds: sunday };
    const r = computeRoute(far, inside.id, start.lat, start.lng, 0, [], opts);
    assert.equal(r.success, true, 'going to the closed hall itself');

    // Somewhere beyond it, reachable only through it: the message names the hall.
    const through = { id: 2, kind: 'walkway', status: 'existing', coordinates: [ll(0, 0), ll(0, 60)] };
    const beyond = pathwayWaypoints([through]).at(-1);
    const blocked = computeRoute(far, beyond.id, start.lat, start.lng, 0, [], { buildings: [hall], pathways: [through], closedBuildingIds: sunday });
    assert.equal(blocked.success, false);
    assert.equal(blocked.closed_building, true);
    assert.equal(blocked.message, 'The only way there goes through Misto, which is closed right now.');
});

test('the sentence for a closed destination (no route is drawn to it)', () => {
    assert.equal(closedMessage('Misto', openState(CANTEEN, at('2026-11-29T10:00:00'))), 'Misto is closed now. It opens tomorrow 8 am.');
    const heat = [closure({ building_category: 'school', reason: 'Classes suspended: high heat index', ends_at: at('2026-11-23T17:00:00').toISOString() })];
    assert.equal(closedMessage('CCS', buildingStatus(ccsHall, heat, MON_10)), 'CCS is closed now: Classes suspended: high heat index. It opens tomorrow 8 am.');
    assert.equal(closedMessage('Canteen', openState(CANTEEN, MON_10)), null, 'open: no message, the route is drawn');
    assert.equal(closedMessage('Hall', null), null, 'no hours: always open');
});

test('the campus is closed outside its daily hours (9 pm to 6 am), in campus time', async () => {
    const { campusClosed } = await import('./openingHours.js');
    const hours = { opens: '06:00', closes: '21:00' };
    assert.equal(campusClosed(hours, at('2026-11-23T20:59:00')), null, 'open until 9 pm');
    assert.deepEqual(campusClosed(hours, at('2026-11-23T21:00:00')), { opens: '6 am', closes: '9 pm' });
    assert.ok(campusClosed(hours, at('2026-11-24T05:59:00')), 'still closed before 6 am');
    assert.equal(campusClosed(hours, at('2026-11-24T06:00:00')), null);
    // A phone set to another time zone still uses campus time (21:30 in Manila = 13:30 UTC).
    assert.ok(campusClosed(hours, new Date('2026-11-23T13:30:00Z')));
    assert.equal(campusClosed(null, at('2026-11-23T23:00:00')), null, 'no hours: always open');
});
