import assert from 'node:assert/strict';
import { metersPerDegree, toLocalMeters, fromLocalMeters } from '../src/geo.js';
import { bearingAndDistance, anchorENU, enuToLatLon } from '../src/arMath.js';
import { snapToWalkGraph, closestOnSegment } from '../src/mapMatch.js';
import GpsPipeline from '../src/gpsPipeline.js';
import { effectiveVerticalFov } from '../src/cameraFov.js';
import { stallAction, GPS_WATCH_OPTS, GPS_POLL_AFTER_MS, GPS_RESTART_AFTER_MS } from '../src/gpsWatchdog.js';
import { compassQuality, compassWarningText, headingAccuracyFromEvent, createCompassWatcher } from '../src/heading.js';

// Run (no project setup needed beyond `npm i esbuild three`):
//   npx esbuild tests/ar-improvements.test.mjs --bundle --platform=node --format=esm \
//     --external:three --loader:.js=jsx --outfile=/tmp/ar.test.mjs && node /tmp/ar.test.mjs
let pass = 0; const t = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('PASS', name); }, (e) => { console.log('FAIL', name, '\n  ', e.message); process.exitCode = 1; });
const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m || ''} expected ${b} ±${tol}, got ${a}`);

await t('WGS84 degree lengths match published values (lat 0, 15, 45, 90)', () => {
  near(metersPerDegree(0).mLat, 110574, 1); near(metersPerDegree(0).mLng, 111320, 1);
  near(metersPerDegree(15).mLat, 110649, 2); near(metersPerDegree(15).mLng, 107551, 2);
  near(metersPerDegree(45).mLat, 111132, 2); near(metersPerDegree(45).mLng, 78847, 2);
  near(metersPerDegree(90).mLat, 111694, 2);
});
await t('north-south distance no longer ~0.6% too long at Philippine latitude', () => {
  const lat = 14.6, mLat = metersPerDegree(lat).mLat;
  const r = bearingAndDistance(lat, 121, lat + 100 / mLat, 121);
  near(r.dist, 100, 0.001); near(r.bearing, 0, 0.001);
  const oldDist = (100 / mLat) * 111320; // what the old constant produced
  assert.ok(oldDist - 100 > 0.55, `old error was ${oldDist - 100} m per 100 m`);
});
await t('east-west distance and bearing correct', () => {
  const lat = 14.6, mLng = metersPerDegree(lat).mLng;
  const r = bearingAndDistance(lat, 121, lat, 121 + 50 / mLng);
  near(r.dist, 50, 0.001); near(r.bearing, 90, 0.001);
});
await t('anchorENU ↔ enuToLatLon round trip', () => {
  const a = { latitude: 14.6, longitude: 121.0 }, p = { latitude: 14.6013, longitude: 121.0021 };
  const e = anchorENU(a, p); const back = enuToLatLon(a.latitude, a.longitude, e.x, e.z);
  near(back.latitude, p.latitude, 1e-9); near(back.longitude, p.longitude, 1e-9);
});
await t('toLocalMeters / fromLocalMeters inverse', () => {
  const [e, n] = toLocalMeters(14.601, 121.002, 14.6, 121.0); const p = fromLocalMeters(14.6, 121.0, e, n);
  near(p.latitude, 14.601, 1e-10); near(p.longitude, 121.002, 1e-10);
});

// ---- map matching: a straight walkway of 3 route nodes running east, 20 m apart
const lat0 = 14.6, lng0 = 121.0, { mLat, mLng } = metersPerDegree(lat0);
const node = (id, eastM, northM = 0, type = 'route') => ({ id, type, latitude: lat0 + northM / mLat, longitude: lng0 + eastM / mLng, elevation: 0 });
const nodes = [node(1, 0), node(2, 20), node(3, 40), node(4, 20, 30)]; // 4 = branch going north from node 2
const fixAt = (eastM, northM, accuracy = 8) => ({ latitude: lat0 + northM / mLat, longitude: lng0 + eastM / mLng, accuracy });
await t('closestOnSegment geometry', () => {
  const c = closestOnSegment(-10, 5, 10, 5); near(c.dist, 5, 1e-9); near(c.t, 0.5, 1e-9);
  const d = closestOnSegment(5, 0, 10, 0); near(d.t, 0, 1e-9); near(d.dist, 5, 1e-9); // clamps to endpoint
});
await t('fix 4 m off the walkway snaps onto it', () => {
  const m = snapToWalkGraph(fixAt(30, 4), nodes, []);
  assert.equal(m.snapped, true); near(m.offsetM, 4, 0.05);
  const [e, n] = toLocalMeters(m.latitude, m.longitude, lat0, lng0); near(n, 0, 0.05); near(e, 30, 0.05);
});
await t('fix far from any walkway (60 m) is NOT snapped', () => {
  const m = snapToWalkGraph(fixAt(20, -60), nodes, []);
  assert.equal(m.snapped, false); assert.equal(m.latitude, fixAt(20, -60).latitude);
});
await t('gate scales with accuracy: 18 m off snaps at ±15 m accuracy, not at ±5 m', () => {
  assert.equal(snapToWalkGraph(fixAt(30, -18, 5), nodes, []).snapped, false);
  assert.equal(snapToWalkGraph(fixAt(30, -18, 15), nodes, []).snapped, true);
});
await t('hysteresis keeps previous edge when two are about equally close', () => {
  const f = fixAt(25, 3); // near the junction: east-west edge (3 m) vs north branch (5 m away)
  const first = snapToWalkGraph(f, nodes, []);
  const branchKey = snapToWalkGraph(fixAt(21, 15), nodes, []).edgeKey; // clearly on the branch
  const sticky = snapToWalkGraph(f, nodes, [], { prevEdgeKey: branchKey });
  assert.notEqual(first.edgeKey, branchKey);
  assert.equal(sticky.edgeKey, branchKey, 'should stay on branch when within hysteresis');
});

// ---- GPS pipeline
const pos = (lat, lng, acc, ts) => ({ coords: { latitude: lat, longitude: lng, accuracy: acc, altitude: 5, altitudeAccuracy: 3 }, timestamp: ts });
await t('pipeline smooths stationary noise (error shrinks vs raw)', () => {
  const p = new GpsPipeline({ enableMapMatch: false });
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  let rawErr = 0, fErr = 0, k = 0;
  for (let i = 0; i < 60; i++) {
    const nE = rnd() * 8, nN = rnd() * 8;
    const fix = p.process(pos(lat0 + nN / mLat, lng0 + nE / mLng, 8, 1000 * i), {});
    if (i >= 10) { const [fe, fn] = toLocalMeters(fix.latitude, fix.longitude, lat0, lng0); rawErr += Math.hypot(nE, nN); fErr += Math.hypot(fe, fn); k++; }
  }
  assert.ok(fErr / k < 0.6 * (rawErr / k), `filtered ${fErr / k} vs raw ${rawErr / k}`);
});
await t('pipeline resets on a teleport instead of crawling', () => {
  const p = new GpsPipeline({ enableMapMatch: false });
  for (let i = 0; i < 10; i++) p.process(pos(lat0, lng0, 5, 1000 * i), {});
  const far = p.process(pos(lat0 + 500 / mLat, lng0, 5, 11000), {});
  const [, n] = toLocalMeters(far.latitude, far.longitude, lat0, lng0); near(n, 500, 0.5);
});
await t('pipeline passes raw coords, altitude, and snap info through', () => {
  const p = new GpsPipeline(); const raw = fixAt(30, 4);
  const fix = p.process(pos(raw.latitude, raw.longitude, 8, 1), { nodes, borders: [] });
  assert.equal(fix.snapped, true); assert.equal(fix.rawLatitude, raw.latitude); assert.equal(fix.elevation, 5); assert.equal(fix.source, 'gps');
});
await t('pipeline drops non-finite fixes', () => { assert.equal(new GpsPipeline().process(pos(NaN, 1, 5, 1), {}), null); });

// (The WebXR heading-calibration tests went with src/headingCalibration.js: the app no longer has that path.)

// ---- FOV
await t('FOV: portrait phone, tall screen → full vertical FOV (long side = 65°)', () => {
  near(effectiveVerticalFov({ videoW: 1080, videoH: 1920, containerW: 1080, containerH: 2340 }), 65, 0.01);
});
await t('FOV: container wider than video → vertical crop gives a SMALLER FOV than 65°', () => {
  const f = effectiveVerticalFov({ videoW: 1080, videoH: 1920, containerW: 1080, containerH: 1600 });
  near(f, 56.2, 0.3);
});
await t('FOV: 4:3 stream and bad inputs', () => {
  const f = effectiveVerticalFov({ videoW: 1080, videoH: 1440, containerW: 1080, containerH: 1440 }); near(f, 65, 0.01);
  assert.equal(effectiveVerticalFov({ videoW: 0, videoH: 1, containerW: 1, containerH: 1 }), null);
});

// ---- compass quality
await t('compass quality buckets + property names', () => {
  assert.equal(compassQuality(null), 'unknown'); assert.equal(compassQuality(-1), 'uncalibrated');
  assert.equal(compassQuality(10), 'good'); assert.equal(compassQuality(25), 'fair'); assert.equal(compassQuality(50), 'poor');
  assert.equal(compassWarningText('good', 5), null); assert.equal(compassWarningText('unknown'), null);
  assert.match(compassWarningText('poor', 50), /±50°/);
  assert.equal(headingAccuracyFromEvent({ webkitCompassAccuracy: 12 }), 12);
  assert.equal(headingAccuracyFromEvent({ webkitCompassHeadingAccuracy: 20 }), 20);
  assert.equal(headingAccuracyFromEvent({}), null);
});

// ---- second-pass audit fixes
const wall = [{ coordinates: [
  { lat: lat0 + 2 / mLat, lng: lng0 - 5 / mLng }, { lat: lat0 + 2 / mLat, lng: lng0 + 45 / mLng } ] }]; // wall 2 m north of the walkway
await t('map match: will NOT snap through a building wall to the far-side walkway', () => {
  assert.equal(snapToWalkGraph(fixAt(30, 4), nodes.slice(0, 3), wall).snapped, false, 'wall between fix and path');
  assert.equal(snapToWalkGraph(fixAt(30, -4), nodes.slice(0, 3), wall).snapped, true, 'same side as wall → fine');
});
await t('map match: bad input does not throw', () => {
  assert.equal(snapToWalkGraph(null, nodes, []).snapped, false);
  assert.equal(snapToWalkGraph({ latitude: NaN, longitude: 1 }, nodes, []).snapped, false);
  assert.equal(snapToWalkGraph(fixAt(30, 4), [], []).snapped, false);
});
await t('pipeline reports RAW accuracy (filter posterior is over-confident)', () => {
  const p = new GpsPipeline({ enableMapMatch: false });
  let last; for (let i = 0; i < 40; i++) last = p.process(pos(lat0, lng0, 12, 1000 * i), {});
  assert.equal(last.accuracy, 12); assert.ok(last.filteredAccuracy < 12, `filtered ${last.filteredAccuracy}`);
});
await t('compass warning: "fair" no longer warns; poor and uncalibrated do', () => {
  assert.equal(compassWarningText('fair', 25), null);
  assert.ok(compassWarningText('poor', 45)); assert.ok(compassWarningText('uncalibrated', -1));
});
await t('compass watcher: debounced, hysteresis on clear, ignores unknown (Android)', () => {
  let clock = 0; const w = createCompassWatcher({ holdMs: 1000, now: () => clock });
  assert.equal(w.update(null).changed, false);                 // unknown → ok, nothing
  assert.equal(w.update(45).changed, false);                   // poor seen, not held yet
  clock = 500; assert.equal(w.update(10).changed, false);      // flicker back to good resets the timer
  clock = 600; w.update(45); clock = 1500; assert.equal(w.update(45).changed, false, 'only 900 ms held');
  clock = 1700; const on = w.update(45); assert.equal(on.changed, true); assert.match(on.warning, /unreliable/);
  clock = 1800; assert.equal(w.update(28).changed, false);     // 28° is above clear threshold (25) → stays poor
  clock = 1900; w.update(20); clock = 3000; const off = w.update(20);
  assert.equal(off.changed, true); assert.equal(off.warning, null);
  clock = 3100; w.update(-1); clock = 4200; const unc = w.update(-1); assert.equal(unc.changed, true); assert.match(unc.warning, /calibrat/);
});

// ---- realtime / stall recovery
await t('watch options never accept cached fixes', () => {
  assert.equal(GPS_WATCH_OPTS.maximumAge, 0); assert.equal(GPS_WATCH_OPTS.enableHighAccuracy, true);
});
await t('stall watchdog: healthy → none; 3 s silent → poll; 7 s silent → restart', () => {
  const base = { lastPollAt: 0, lastRestartAt: 0, hasFix: true };
  assert.equal(stallAction({ ...base, now: 10000, lastFixAt: 9200 }), 'none');
  assert.equal(stallAction({ ...base, now: 10000, lastFixAt: 10000 - GPS_POLL_AFTER_MS }), 'poll');
  assert.equal(stallAction({ ...base, now: 10000, lastFixAt: 10000 - GPS_RESTART_AFTER_MS }), 'restart');
});
await t('stall watchdog: throttled (no poll storm, no restart storm) and quiet before first fix', () => {
  assert.equal(stallAction({ now: 10000, lastFixAt: 5000, lastPollAt: 9000, lastRestartAt: 9500, hasFix: true }), 'none');
  assert.equal(stallAction({ now: 20000, lastFixAt: 1000, lastPollAt: 0, lastRestartAt: 0, hasFix: false }), 'none');
});
await t('stall recovery simulation: dead watch is revived within ~7 s, polls keep dot moving at ~1 per 3 s', () => {
  let lastFixAt = 0, lastPollAt = 0, lastRestartAt = 0, polls = 0, restartedAt = null;
  for (let now = 1000; now <= 12000; now += 1000) {
    if (now < 1500) lastFixAt = now;                       // watch dies after t = 1 s
    const a = stallAction({ now, lastFixAt, lastPollAt, lastRestartAt, hasFix: true });
    if (a === 'poll') { polls++; lastPollAt = now; lastFixAt = now; }   // a poll succeeds
    if (a === 'restart') { restartedAt = now; lastRestartAt = now; lastFixAt = now; }
  }
  assert.ok(polls >= 3, `polls ${polls}`); // fixes keep arriving even with the watch dead
});

// Walking east at 1.4 m/s, GPS noise σ≈4 m, reported accuracy 8 m, 1 Hz.
const walk = (mkPipe, reportSpeed) => {
  const p = mkPipe(); let seed = 11; const g = () => { let u = 0; for (let i = 0; i < 6; i++) { seed = (seed * 16807) % 2147483647; u += seed / 2147483647; } return (u - 3) * 1.41 * 4 / 1.0 / 1.2; };
  let lag = 0, abs = 0, k = 0;
  for (let i = 0; i < 90; i++) {
    const trueE = 1.4 * i, nE = g(), nN = g();
    const fix = p.process({ coords: { latitude: lat0 + nN / mLat, longitude: lng0 + (trueE + nE) / mLng, accuracy: 8, speed: reportSpeed ? 1.4 : null }, timestamp: 1000 * i }, {});
    if (i >= 20) { const [e, n] = toLocalMeters(fix.latitude, fix.longitude, lat0, lng0); lag += trueE - e; abs += Math.hypot(trueE - e, n); k++; }
  }
  return { lag: lag / k, err: abs / k };
};
await t('walking: new speed-adaptive filter trails the user far less than the old fixed-Q=2 one', () => {
  const oldCfg = walk(() => new GpsPipeline({ processNoise: 2, enableMapMatch: false }), false);
  const newCfg = walk(() => new GpsPipeline({ enableMapMatch: false }), true);
  const raw = walk(() => new GpsPipeline({ enableFilter: false, enableMapMatch: false }), true);
  console.log(`     lag behind user: old ${oldCfg.lag.toFixed(1)} m | new ${newCfg.lag.toFixed(1)} m | raw ${raw.lag.toFixed(1)} m`);
  console.log(`     mean position error: old ${oldCfg.err.toFixed(1)} m | new ${newCfg.err.toFixed(1)} m | raw ${raw.err.toFixed(1)} m`);
  assert.ok(newCfg.lag < oldCfg.lag * 0.6, 'lag should drop a lot');
  assert.ok(newCfg.err < raw.err, 'still smoother than raw GPS');
});
await t('standing still: adaptive filter still smooths hard (speed 0)', () => {
  const p = new GpsPipeline({ enableMapMatch: false }); let seed = 5; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  let rawE = 0, fE = 0, k = 0;
  for (let i = 0; i < 80; i++) { const nE = r() * 8, nN = r() * 8;
    const fix = p.process({ coords: { latitude: lat0 + nN / mLat, longitude: lng0 + nE / mLng, accuracy: 8, speed: 0 }, timestamp: 1000 * i }, {});
    if (i >= 15) { const [e, n] = toLocalMeters(fix.latitude, fix.longitude, lat0, lng0); rawE += Math.hypot(nE, nN); fE += Math.hypot(e, n); k++; } }
  assert.ok(fE / k < 0.5 * (rawE / k), `filtered ${fE / k} raw ${rawE / k}`);
});
console.log(`\n${pass} passed`);
