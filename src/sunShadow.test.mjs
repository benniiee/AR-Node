import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunPosition, shadowOffsetM, shadowRings, buildingHeightM, shadowOpacity, penumbraLayers, shadowColor, MAX_SHADOW_FACTOR, PENUMBRA_FRACTIONS, visibleWalls, roofLiftM, wallLight, skyTint } from './sunShadow.js';

// Campus (Zamboanga City), UTC+8. Local solar noon there is ~11:52.
const LAT = 6.913;
const LNG = 122.062;
const at = (iso) => new Date(iso);

test('June solstice noon: sun high and to the NORTH (campus is south of 23.4 N)', () => {
    const s = sunPosition(at('2026-06-21T11:52:00+08:00'), LAT, LNG);
    assert.ok(Math.abs(s.altitudeDeg - 73.5) < 1.5, `altitude ${s.altitudeDeg}`);
    assert.ok(s.azimuthDeg < 15 || s.azimuthDeg > 345, `azimuth ${s.azimuthDeg}`);
});

test('December solstice noon: sun lower and to the SOUTH', () => {
    const s = sunPosition(at('2026-12-21T11:55:00+08:00'), LAT, LNG);
    assert.ok(Math.abs(s.altitudeDeg - 59.6) < 1.5, `altitude ${s.altitudeDeg}`);
    assert.ok(Math.abs(s.azimuthDeg - 180) < 10, `azimuth ${s.azimuthDeg}`);
});

test('morning sun is in the east, evening sun in the west, midnight sun is down', () => {
    const morning = sunPosition(at('2026-03-20T07:30:00+08:00'), LAT, LNG);
    const evening = sunPosition(at('2026-03-20T16:30:00+08:00'), LAT, LNG);
    const night = sunPosition(at('2026-03-20T23:30:00+08:00'), LAT, LNG);
    assert.ok(morning.altitudeDeg > 0 && Math.abs(morning.azimuthDeg - 90) < 15, JSON.stringify(morning));
    assert.ok(evening.altitudeDeg > 0 && Math.abs(evening.azimuthDeg - 270) < 15, JSON.stringify(evening));
    assert.ok(night.altitudeDeg < 0);
});

test('shadow falls away from the sun with length h / tan(altitude)', () => {
    const off = shadowOffsetM(10, { altitudeDeg: 45, azimuthDeg: 90 }); // sun due east
    assert.ok(Math.abs(off.length - 10) < 1e-9);
    assert.ok(off.east < -9.99 && Math.abs(off.north) < 1e-9); // shadow points west
});

test('no shadow at night or with the sun on the horizon; long shadows are capped', () => {
    assert.equal(shadowOffsetM(10, { altitudeDeg: -5, azimuthDeg: 0 }), null);
    assert.equal(shadowOffsetM(10, { altitudeDeg: 1, azimuthDeg: 0 }), null);
    // A low sun would cast 30 m / tan(5 deg) = 343 m; capped at 1.75 x height.
    assert.equal(shadowOffsetM(30, { altitudeDeg: 5, azimuthDeg: 0 }).length, MAX_SHADOW_FACTOR * 30);
    // A high sun stays physically exact (under the cap).
    assert.ok(Math.abs(shadowOffsetM(10, { altitudeDeg: 60, azimuthDeg: 0 }).length - 10 / Math.tan(Math.PI / 3)) < 1e-9);
    assert.equal(shadowOpacity({ altitudeDeg: -1, azimuthDeg: 0 }), 0);
});

test('shadow rings: footprint + roof shadow + one quad per lit wall, all counter-clockwise', () => {
    const square = [
        { lat: 6.913, lng: 122.061 }, { lat: 6.913, lng: 122.0612 },
        { lat: 6.9132, lng: 122.0612 }, { lat: 6.9132, lng: 122.061 },
    ];
    const rings = shadowRings(square, buildingHeightM({ floors: 3 }), { altitudeDeg: 50, azimuthDeg: 135 });
    assert.equal(rings.length, 2 + 4);
    for (const ring of rings) {
        let a = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) a += ring[j].lng * ring[i].lat - ring[i].lng * ring[j].lat;
        assert.ok(a > 0, 'ring must be counter-clockwise');
    }
    // Sun in the south-east, so the roof shadow moved north-west.
    assert.ok(rings[1][0].lat > square[0].lat || rings[1].some((p) => p.lat > 6.9132));
    assert.ok(rings[1].every((p) => p.lng < 122.0612));
});

test('penumbra copies stack to the requested darkness at the wall', () => {
    const layers = penumbraLayers(0.4);
    assert.equal(layers.length, PENUMBRA_FRACTIONS.length);
    // Most of the shadow is one even shade: the shortest copy still covers 60%.
    assert.ok(Math.min(...layers.map((l) => l.fraction)) >= 0.6);
    assert.equal(layers[0].fraction, 1);
    const atWall = 1 - layers.reduce((keep, l) => keep * (1 - l.opacity), 1);
    assert.ok(Math.abs(atWall - 0.4) < 1e-9, `stacked opacity ${atWall}`);
    // The tip (only the longest copy) is much lighter than the wall.
    assert.ok(layers[0].opacity < 0.15);
    assert.deepEqual(penumbraLayers(0), []);
});

test('shadow tint is cool at midday and warmer at a low sun', () => {
    assert.notEqual(shadowColor({ altitudeDeg: 60 }), shadowColor({ altitudeDeg: 6 }));
});

test('building height comes from its floors unless a measured height is set', () => {
    assert.equal(buildingHeightM({ floors: 4 }), 12.8);
    assert.equal(buildingHeightM({}), 3.2);
    assert.equal(buildingHeightM({ floors: 1, height_m: 11.5 }), 11.5);
    assert.equal(buildingHeightM({ floors: 2, height_m: null }), 6.4);
});

test('2.5D: only the south-facing walls of a square show, roof lifted north', () => {
    const square = [
        { lat: 6.913, lng: 122.061 }, { lat: 6.913, lng: 122.0612 },
        { lat: 6.9132, lng: 122.0612 }, { lat: 6.9132, lng: 122.061 },
    ];
    const walls = visibleWalls(square);
    assert.equal(walls.length, 1);
    assert.ok(Math.abs(walls[0].normalDeg - 180) < 1e-6, `normal ${walls[0].normalDeg}`);
    // Same answer for a clockwise ring.
    assert.equal(visibleWalls([...square].reverse()).length, 1);
    assert.ok(Math.abs(roofLiftM(10) - 4.5) < 1e-9);
});

test('a wall facing the sun is lit, one facing away is in shade', () => {
    const sun = { altitudeDeg: 30, azimuthDeg: 180 };
    assert.ok(wallLight(180, sun) > 0.6);
    assert.equal(wallLight(0, sun), 0.18);
    assert.equal(wallLight(180, { altitudeDeg: -10, azimuthDeg: 180 }), 0.18);
});

test('roof inset: a square shrinks by the rim width on every side', async () => {
    const { insetPolygon } = await import('./sunShadow.js');
    // ~22 m square.
    const sq = [
        { lat: 6.913, lng: 122.061 }, { lat: 6.913, lng: 122.0612 },
        { lat: 6.9132, lng: 122.0612 }, { lat: 6.9132, lng: 122.061 },
    ];
    const inner = insetPolygon(sq, 1);
    assert.equal(inner.length, 4);
    const widthM = (inner[1].lng - inner[0].lng) * 111320 * Math.cos(6.913 * Math.PI / 180);
    const fullM = 0.0002 * 111320 * Math.cos(6.913 * Math.PI / 180);
    assert.ok(Math.abs(widthM - (fullM - 2)) < 0.05, `inner width ${widthM} vs ${fullM - 2}`);
    // A 1 m wide sliver cannot keep a roof inside a 1 m rim.
    const thin = [{ lat: 6.913, lng: 122.061 }, { lat: 6.913, lng: 122.0612 }, { lat: 6.913009, lng: 122.0612 }, { lat: 6.913009, lng: 122.061 }];
    assert.equal(insetPolygon(thin, 1), null);
});

test('parapet shadow falls only from the sun-facing rim, and not at night', async () => {
    const { parapetShadowQuads, roofLight } = await import('./sunShadow.js');
    const sq = [
        { lat: 6.913, lng: 122.061 }, { lat: 6.913, lng: 122.0612 },
        { lat: 6.9132, lng: 122.0612 }, { lat: 6.9132, lng: 122.061 },
    ];
    // Sun due south: only the south edge's rim shades the roof (one strip).
    assert.equal(parapetShadowQuads(sq, { altitudeDeg: 40, azimuthDeg: 180 }).length, 1);
    // Sun in the south-east: south and east rims.
    assert.equal(parapetShadowQuads(sq, { altitudeDeg: 40, azimuthDeg: 135 }).length, 2);
    assert.equal(parapetShadowQuads(sq, { altitudeDeg: -5, azimuthDeg: 180 }).length, 0);
    assert.ok(roofLight({ altitudeDeg: 80 }) > roofLight({ altitudeDeg: 10 }));
});

test('rim shadow strips never leave the roof (regression: slanted strips overhung the corners)', async () => {
    const { parapetShadowQuads, insetPolygon, PARAPET_H, MAX_SHADOW_FACTOR } = await import('./sunShadow.js');
    // An L-shaped roof (like CCS), ~22 m arms.
    const L = [
        { lat: 6.9130, lng: 122.0610 }, { lat: 6.9130, lng: 122.0612 }, { lat: 6.91305, lng: 122.0612 },
        { lat: 6.91305, lng: 122.06105 }, { lat: 6.9132, lng: 122.06105 }, { lat: 6.9132, lng: 122.0610 },
    ];
    const inner = insetPolygon(L, 0.45);
    const inside = (p) => {
        let c = false;
        for (let i = 0, j = inner.length - 1; i < inner.length; j = i, i += 1) {
            const a = inner[i]; const b = inner[j];
            if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) c = !c;
        }
        return c;
    };
    const kx = 111320 * Math.cos(6.913 * Math.PI / 180);
    const nearEdge = (p) => inner.some((a, i) => {
        const b = inner[(i + 1) % inner.length];
        const ax = (a.lng - p.lng) * kx; const ay = (a.lat - p.lat) * 111320;
        const bx = (b.lng - p.lng) * kx; const by = (b.lat - p.lat) * 111320;
        const dx = bx - ax; const dy = by - ay;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
        return Math.hypot(ax + t * dx, ay + t * dy) < 0.01;
    });
    for (const az of [100, 135, 200, 250, 300]) {
        const strips = parapetShadowQuads(inner, { altitudeDeg: 12, azimuthDeg: az });
        assert.ok(strips.length > 0, `az ${az}: some rim faces the sun`);
        for (const strip of strips) {
            for (const p of strip) {
                // Inside the roof, or on its edge (within 1 cm).
                assert.ok(inside(p) || nearEdge(p),
                    `az ${az}: strip point ${p.lat},${p.lng} outside the roof`);
            }
        }
    }
    // Width capped like building shadows: 0.7 m rim -> at most 1.75 x 0.7 m.
    const low = parapetShadowQuads(inner, { altitudeDeg: 3, azimuthDeg: 180 });
    const maxDLat = Math.max(...low.flat().map((p) => p.lat)) - Math.min(...low.flat().map((p) => p.lat));
    assert.ok(maxDLat * 111320 <= PARAPET_H * MAX_SHADOW_FACTOR + 0.01, `rim shadow ${maxDLat * 111320} m`);
});

test('skyTint: clear by day, warm at sunset, navy and darkest at night', () => {
    assert.equal(skyTint(45).opacity, 0);
    const sunset = skyTint(0);
    assert.equal(sunset.color, '#f59e5e');
    assert.ok(Math.abs(sunset.opacity - 0.18) < 1e-9);
    const night = skyTint(-30);
    assert.equal(night.color, '#1e2a5a');
    assert.ok(Math.abs(night.opacity - 0.6) < 1e-9);
    assert.ok(skyTint(-6).opacity > sunset.opacity && skyTint(-6).opacity < night.opacity);
    assert.equal(skyTint(NaN).opacity, 0);
});
