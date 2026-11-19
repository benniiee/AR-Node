import assert from 'node:assert/strict';
import { edgeRainFactor, nodeRainStatus, isRoutable, rainMultiplierOf, NODE_STATUS, noRouteMessage } from '../src/weatherCost.js';
import { computeRoute } from '../src/pathfinding.js';

// Weather-aware routing rules (spec A5, Node half). pathfinding.js imports
// ./geo with no extension, so Node's ESM resolver needs a bundle pass —
// same as tests/ar-improvements.test.mjs. Run:
//   npx esbuild tests/weather.test.mjs --bundle --platform=node --format=esm --outfile=<tmp>/weather.test.mjs && node <tmp>/weather.test.mjs
// weatherCost.js itself is plain JS with no imports, so its rules could also
// be exercised directly.
let pass = 0; const t = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('PASS', name); }, (e) => { console.log('FAIL', name, '\n  ', e.message); process.exitCode = 1; });
const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m || ''} expected ${b} ±${tol}, got ${a}`);

// ── edgeRainFactor: the walking cost of an edge in rain mode ─────────────
await t('edgeRainFactor table matches the PHP rule', () => {
  // Fully exposed edges take the whole penalty.
  near(edgeRainFactor('outside', 'outside', 2), 2, 1e-9);
  // Entrances take half of it, from either side.
  near(edgeRainFactor('outside', 'inside', 2), 1.5, 1e-9);
  near(edgeRainFactor('inside', 'outside', 2), 1.5, 1e-9);
  // Sheltered edges are never penalised.
  near(edgeRainFactor('inside', 'inside', 2), 1, 1e-9);
  near(edgeRainFactor(null, null, 2), 1, 1e-9);
  // Only the literal value 'outside' counts as exposed (legacy 'covered' is not).
  near(edgeRainFactor('covered', 'covered', 2), 1, 1e-9);
});
await t('edgeRainFactor: multiplier 1 (or less) and invalid values are no-ops', () => {
  near(edgeRainFactor('outside', 'outside', 1), 1, 1e-9);
  near(edgeRainFactor('outside', 'outside', 0.5), 1, 1e-9);
  near(edgeRainFactor('outside', 'outside', 0), 1, 1e-9);
  // Weather may never break routing: anything unparseable degrades to "dry".
  near(edgeRainFactor('outside', 'outside', NaN), 1, 1e-9);
  near(edgeRainFactor('outside', 'outside', undefined), 1, 1e-9);
  near(edgeRainFactor('outside', 'outside', null), 1, 1e-9);
  near(edgeRainFactor('outside', 'outside', '2'), 2, 1e-9); // numeric string still works
});

// ── nodeRainStatus / isRoutable ─────────────────────────────────────────
await t('nodeRainStatus: sheltered paths are always white (rain never affects them)', () => {
  assert.equal(nodeRainStatus('inside', { raining_now: true, rain_mode: true }), NODE_STATUS.WHITE);
  assert.equal(nodeRainStatus('covered', { raining_now: true, rain_mode: true }), NODE_STATUS.WHITE);
  assert.equal(nodeRainStatus(null, { raining_now: true, rain_mode: true }), NODE_STATUS.WHITE);
});
await t('nodeRainStatus: outside path colour tracks the weather state', () => {
  // Dry.
  assert.equal(nodeRainStatus('outside', { raining_now: false, rain_mode: false }), NODE_STATUS.WHITE);
  // Rain likely soon → yellow (warning).
  assert.equal(nodeRainStatus('outside', { raining_now: false, rain_mode: true }), NODE_STATUS.YELLOW);
  // Already raining → red (closed).
  assert.equal(nodeRainStatus('outside', { raining_now: true, rain_mode: true }), NODE_STATUS.RED);
  // No weather state at all → white (unpenalised).
  assert.equal(nodeRainStatus('outside', null), NODE_STATUS.WHITE);
});
await t('isRoutable: only red (raining, outside) paths are unroutable', () => {
  assert.equal(isRoutable('outside', { raining_now: true }), false);
  assert.equal(isRoutable('outside', { raining_now: false, rain_mode: true }), true); // yellow is still walkable
  assert.equal(isRoutable('inside', { raining_now: true }), true); // sheltered never closes
});
await t('rainMultiplierOf: reads the server penalty, degrades to 1', () => {
  near(rainMultiplierOf({ rain_multiplier: 2 }), 2, 1e-9);
  near(rainMultiplierOf({ rain_multiplier: 1.5 }), 1.5, 1e-9);
  near(rainMultiplierOf({}), 1, 1e-9);
  near(rainMultiplierOf(null), 1, 1e-9);
  near(rainMultiplierOf({ rain_multiplier: NaN }), 1, 1e-9);
});

// ── computeRoute red-exclusion (the user's added requirement) ───────────
// A tiny campus: user and an exposed shortcut (outside) vs a sheltered
// interior corridor (inside). While it is raining the outside path closes,
// so a destination that ONLY sits on it must return noRouteMessage({ rain: true }).
const DRY_NODES = [
  { id: 1, name: 'User start', type: 'route', latitude: 6.9100, longitude: 122.0700, elevation: 0, floor_level: 0, path_type: 'outside' },
  { id: 2, name: 'Outside corridor', type: 'route', latitude: 6.9100, longitude: 122.0703, elevation: 0, floor_level: 0, path_type: 'outside' },
  { id: 3, name: 'Room A', type: 'location', latitude: 6.9100, longitude: 122.0706, elevation: 0, floor_level: 0, path_type: 'outside' },
];
const SHELTERED_NODES = [
  { id: 1, name: 'User start', type: 'route', latitude: 6.9100, longitude: 122.0700, elevation: 0, floor_level: 0, path_type: 'outside' },
  { id: 10, name: 'Entrance', type: 'route', latitude: 6.9102, longitude: 122.0701, elevation: 0, floor_level: 0, path_type: 'inside' },
  { id: 11, name: 'Inside corridor', type: 'route', latitude: 6.9102, longitude: 122.0704, elevation: 0, floor_level: 0, path_type: 'inside' },
  { id: 12, name: 'Room B', type: 'location', latitude: 6.9102, longitude: 122.0706, elevation: 0, floor_level: 0, path_type: 'inside' },
];
const USER = { lat: 6.9100, lng: 122.0700 };

await t('computeRoute: dry weather routes normally through exposed paths', () => {
  const r = computeRoute(DRY_NODES, 3, USER.lat, USER.lng, 0, [], { rainMultiplier: 1, rainNow: false });
  assert.equal(r.success, true, r.message);
  assert.ok(r.path.length > 1);
});
await t('computeRoute: rain closes an exposed-only destination (the rain message)', () => {
  const r = computeRoute(DRY_NODES, 3, USER.lat, USER.lng, 0, [], { rainMultiplier: 2, rainNow: true });
  assert.equal(r.success, false);
  assert.equal(r.message, noRouteMessage({ rain: true }));
});
await t('computeRoute: rain still routes to a sheltered destination', () => {
  const r = computeRoute(SHELTERED_NODES, 12, USER.lat, USER.lng, 0, [], { rainMultiplier: 2, rainNow: true });
  assert.equal(r.success, true, r.message);
  // Every node past the entrance is sheltered, so nothing on the path is red.
  for (const n of r.path.slice(1)) {
    assert.ok(isRoutable(n.path_type, { raining_now: true }), `node ${n.id} should be routable`);
  }
});
await t('computeRoute: rain prefers the sheltered detour over the exposed shortcut', () => {
  // Both ways exist: an outside shortcut and an inside corridor. Dry picks
  // whichever is shorter; raining must never use the exposed one.
  const MIXED = [...DRY_NODES, ...SHELTERED_NODES.slice(1)];
  const wet = computeRoute(MIXED, 12, USER.lat, USER.lng, 0, [], { rainMultiplier: 2, rainNow: true });
  assert.equal(wet.success, true, wet.message);
  // path[0] is the synthetic user marker; every real node after it is sheltered.
  assert.ok(
    wet.path.slice(1).every((n) => n.path_type === 'inside'),
    'wet route must avoid exposed (outside) nodes'
  );
});
await t('computeRoute: an invalid rainMultiplier is treated as dry (never breaks routing)', () => {
  const r = computeRoute(DRY_NODES, 3, USER.lat, USER.lng, 0, [], { rainMultiplier: NaN, rainNow: false });
  assert.equal(r.success, true, r.message);
});

// Every t() above resolves before this line; a failure sets exitCode = 1.
console.log(`\n${pass} weather checks passed.`);
