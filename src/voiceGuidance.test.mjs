import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceGuide, spokenText, STEADY_MS, MIN_GAP_MS } from './voiceGuidance.js';

test('only the direction is spoken, not the distance to the next stop', () => {
    assert.equal(spokenText({ main: 'Turn left', sub: 'Next stop in 20 m' }), 'Turn left.');
    assert.equal(spokenText({ main: 'Walk straight', sub: 'Library in 1.2 km' }), 'Walk straight.');
});

test('a direction is spoken once it is steady, not while the phone swings around', () => {
    const said = [];
    const v = createVoiceGuide((t) => said.push(t));
    const turn = { main: 'Turn left', sub: 'Next stop in 20 m' };
    v.update(turn, 0);
    v.update({ main: 'Walk straight', sub: 'Next stop in 20 m' }, 400);   // flicker while turning
    v.update(turn, 800);
    v.update(turn, 800 + STEADY_MS - 1);
    assert.deepEqual(said, []);
    v.update(turn, 800 + STEADY_MS);
    assert.deepEqual(said, ['Turn left.']);
    v.update({ ...turn, sub: 'Next stop in 15 m' }, 5000);                // same direction, closer: silent
    assert.equal(said.length, 1);
});

test('a new direction waits for the minimum gap; arrival is said once and ends guidance', () => {
    const said = [];
    const v = createVoiceGuide((t) => said.push(t));
    v.update({ main: 'Turn left', sub: '' }, 0);
    v.update({ main: 'Turn left', sub: '' }, STEADY_MS);                  // spoken at 1500
    v.update({ main: 'Turn right', sub: '' }, STEADY_MS + 100);
    v.update({ main: 'Turn right', sub: '' }, STEADY_MS + 100 + STEADY_MS); // steady, but within the gap
    assert.equal(said.length, 1);
    v.update({ main: 'Turn right', sub: '' }, STEADY_MS + MIN_GAP_MS);
    assert.deepEqual(said, ['Turn left.', 'Turn right.']);
    v.arrive('CCS');
    v.arrive('CCS');
    v.update({ main: 'Walk straight', sub: '' }, 99999);
    assert.deepEqual(said.slice(2), ['You have arrived at CCS.']);
});

test('switching Voice on says the current direction at once', () => {
    const said = [];
    const v = createVoiceGuide((t) => said.push(t));
    v.repeat({ main: 'Bear right', sub: 'Next stop in 8 m' }, 0);
    v.update({ main: 'Bear right', sub: 'Next stop in 8 m' }, 5000);     // already said: not again
    assert.deepEqual(said, ['Bear right.']);
});
