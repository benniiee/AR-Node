import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    heatIndexF, heatIndexC, heatCategory, heatLabel, heatSummary, campusHourLabel, isHeatWarning,
} from './heatIndex.js';

const grid = JSON.parse(readFileSync(new URL('../tests/fixtures/heat_index_grid.json', import.meta.url), 'utf8'));

test('matches the Python/PHP grid exactly', () => {
    assert.ok(grid.cases.length > 50);
    for (const c of grid.cases) {
        const v = heatIndexC(c.t_c, c.rh);
        assert.ok(Math.abs(v - c.heat_index_c) < 1e-5, `${c.t_c} C ${c.rh} %: ${v} vs ${c.heat_index_c}`);
        assert.equal(heatCategory(v), c.category, `${c.t_c} C ${c.rh} %`);
    }
});

test('NWS chart points (deg F)', () => {
    for (const [t, rh, chart] of [[80, 40, 80], [86, 90, 105], [90, 50, 95], [96, 65, 121], [104, 55, 137]]) {
        assert.ok(Math.abs(heatIndexF(t, rh) - chart) <= 1, `${t} F ${rh} %`);
    }
});

test('PAGASA bounds', () => {
    assert.equal(heatCategory(26.9), 'none');
    assert.equal(heatCategory(27), 'caution');
    assert.equal(heatCategory(33), 'extreme_caution');
    assert.equal(heatCategory(42), 'danger');
    assert.equal(heatCategory(52), 'extreme_danger');
    assert.equal(heatLabel('none'), null);
    assert.equal(heatLabel('extreme_caution'), 'Extreme caution');
    assert.equal(isHeatWarning('caution'), false);
    assert.equal(isHeatWarning('danger'), true);
});

test('campus hour label reads the server string, not the phone clock', () => {
    assert.equal(campusHourLabel('2026-04-10T14:00:00+08:00'), '2 pm');
    assert.equal(campusHourLabel('2026-04-10T00:00:00+08:00'), '12 am');
    assert.equal(campusHourLabel('2026-04-10T12:00:00+08:00'), '12 pm');
    assert.equal(campusHourLabel(null), null);
});

test('summary: rising, easing, steady, missing', () => {
    const base = { heat_index_c: 38.2, heat_category: 'extreme_caution' };
    const rising = heatSummary({ ...base, heat_forecast: [
        { hours_ahead: 1, at: '2026-04-10T13:00:00+08:00', heat_index_c: 39.4 },
        { hours_ahead: 2, at: '2026-04-10T14:00:00+08:00', heat_index_c: 41.1 },
        { hours_ahead: 3, at: '2026-04-10T15:00:00+08:00', heat_index_c: 40.2 },
    ] });
    assert.equal(rising.short, 'Feels like 38°C, Extreme caution');
    assert.equal(rising.outlook, '41°C expected at 2 pm');
    assert.equal(rising.warning, true);

    const easing = heatSummary({ ...base, heat_forecast: [
        { hours_ahead: 1, at: '2026-04-10T17:00:00+08:00', heat_index_c: 36.0 },
        { hours_ahead: 3, at: '2026-04-10T19:00:00+08:00', heat_index_c: 31.0 },
    ] });
    assert.equal(easing.outlook, 'easing to 31°C by 7 pm');

    const steady = heatSummary({ ...base, heat_forecast: [{ hours_ahead: 1, at: '2026-04-10T13:00:00+08:00', heat_index_c: 38.4 }] });
    assert.equal(steady.outlook, 'about the same for the next 3 hours');

    assert.equal(heatSummary({ ...base }).outlook, null);
    assert.equal(heatSummary({ heat_index_c: null }), null);
    assert.equal(heatSummary(null), null);
});
