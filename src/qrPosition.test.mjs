import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrUrlFor, qrNodeIdFrom, isLocalAddress, qrBaseUrl } from './qrPosition.js';

test('a printed code links to the student map at that node', () => {
    assert.equal(qrUrlFor(42, 'https://campus.example'), 'https://campus.example/map?at=42');
    assert.equal(qrBaseUrl('https://campus.example/'), 'https://campus.example');
});

test('only a positive whole node id is read back from the link', () => {
    assert.equal(qrNodeIdFrom('?at=42'), 42);
    assert.equal(qrNodeIdFrom('?foo=1&at=7'), 7);
    assert.equal(qrNodeIdFrom('?at=0'), null);
    assert.equal(qrNodeIdFrom('?at=-3'), null);
    assert.equal(qrNodeIdFrom('?at=12abc'), null);
    assert.equal(qrNodeIdFrom(''), null);
});

test('codes made on a local address are flagged before printing', () => {
    assert.equal(isLocalAddress('http://localhost:5173'), true);
    assert.equal(isLocalAddress('http://192.168.1.20:8005'), true);
    assert.equal(isLocalAddress('https://campus.example'), false);
    assert.equal(isLocalAddress('not a url'), true);
});
