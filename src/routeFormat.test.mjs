import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidanceFor } from './routeFormat.js';

test('guidance names the turn in everyday words: go straight, turn left or right, turn around (never "bear")', () => {
    const say = (relDeg) => guidanceFor({ relDeg, distM: 12, isLast: false }).main;
    assert.equal(say(5), 'Go straight');
    assert.equal(say(-29), 'Go straight', 'a small wobble while walking is still straight on');
    assert.equal(say(30), 'Turn right', 'a slight turn is a turn (the card arrow shows how slight)');
    assert.equal(say(40), 'Turn right');
    assert.equal(say(-90), 'Turn left');
    assert.equal(say(150), 'Turn right');
    assert.equal(say(170), 'Turn around');
    assert.equal(say(-151), 'Turn around');
    for (let a = -180; a <= 180; a += 5) assert.ok(!/bear/i.test(say(a)), `no "bear" at ${a} degrees`);
});

test('the second line says how far, and names the destination on the last leg', () => {
    assert.equal(guidanceFor({ relDeg: 0, distM: 12.4, isLast: false }).sub, 'Next stop in 12 m');
    assert.equal(guidanceFor({ relDeg: 0, distM: 40, isLast: true, destName: 'Registrar' }).sub, 'Registrar in 40 m');
});

test('no compass yet, and arrival', () => {
    assert.equal(guidanceFor({ relDeg: null, distM: 12, isLast: false }).main, 'Follow the route');
    assert.deepEqual(guidanceFor({ arrived: true, destName: 'Registrar', relDeg: 0, distM: 1, isLast: true }), { main: "You've arrived", sub: 'Registrar' });
});
