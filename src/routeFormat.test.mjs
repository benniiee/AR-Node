import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidanceFor } from './routeFormat.js';

test('guidance names the turn from the angle to the next stop', () => {
    assert.equal(guidanceFor({ relDeg: 5, distM: 12, isLast: false }).main, 'Walk straight');
    assert.equal(guidanceFor({ relDeg: 40, distM: 12, isLast: false }).main, 'Bear right');
    assert.equal(guidanceFor({ relDeg: -90, distM: 12, isLast: false }).main, 'Turn left');
    assert.equal(guidanceFor({ relDeg: 170, distM: 12, isLast: false }).main, 'Turn around');
});

test('the second line says how far, and names the destination on the last leg', () => {
    assert.equal(guidanceFor({ relDeg: 0, distM: 12.4, isLast: false }).sub, 'Next stop in 12 m');
    assert.equal(guidanceFor({ relDeg: 0, distM: 40, isLast: true, destName: 'Registrar' }).sub, 'Registrar in 40 m');
});

test('no compass yet, and arrival', () => {
    assert.equal(guidanceFor({ relDeg: null, distM: 12, isLast: false }).main, 'Head to the next stop');
    assert.deepEqual(guidanceFor({ arrived: true, destName: 'Registrar', relDeg: 0, distM: 1, isLast: true }), { main: 'You have arrived', sub: 'Registrar' });
});
