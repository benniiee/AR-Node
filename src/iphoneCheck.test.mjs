import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIos, detectBrowser, stepsInARow, buildReport, deviceKind, STEPS } from './iphoneCheck.js';

const SAFARI_17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1';
const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const ANDROID ='Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

test('reads the iOS version and browser from the user agent', () => {
    assert.equal(detectIos(SAFARI_17), '17.4');
    assert.equal(detectIos(CHROME_IOS), '16.6.1');
    assert.equal(detectIos(ANDROID), '');
    assert.equal(detectBrowser(SAFARI_17), 'Safari');
    assert.equal(detectBrowser(CHROME_IOS), 'Chrome');
    assert.equal(detectBrowser(ANDROID), '');
});

test('the steps that worked count only in a row from step 1', () => {
    assert.equal(stepsInARow([]), 0);
    assert.equal(stepsInARow([1, 2, 3, 5]), 3);
    assert.equal(stepsInARow([2, 3]), 0);
    assert.equal(stepsInARow(STEPS.map((_, i) => i + 1)), STEPS.length);
});

test('the report says where it stopped and what this phone supports', () => {
    const report = buildReport(
        { name: 'Miguel', ios: '17.4', browser: 'Safari', steps: [3, 1, 2], problem: 'Blank white or black screen' },
        [{ label: 'Offline copy saved', value: 'no' }],
        SAFARI_17,
    );
    assert.match(report, /Got as far as: 3\. Tapped Visit Site/);
    assert.match(report, /Went wrong at: 4\. Signed in and saw the campus map/);
    assert.match(report, /Steps ticked: 1, 2, 3 \(of 9\)/);
    assert.match(report, /Problem: Blank white or black screen/);
    assert.match(report, /Checked on: iPhone\n {2}Offline copy saved: no/);
    assert.doesNotMatch(report, /phone reports/);
    // A typed version that differs from the phone's own is kept, with the phone's beside it.
    assert.match(buildReport({ ios: '17' }, [], SAFARI_17), /iOS 17 \(phone reports 17\.4\)/);
    assert.match(buildReport({ steps: STEPS.map((_, i) => i + 1) }), /Went wrong at: nothing, all steps worked/);
});

test('only ticking a later step still reports how far they got (the first real report)', () => {
    const report = buildReport({ steps: [2] }, [{ label: 'Internet right now', value: 'yes' }], WINDOWS_CHROME);
    assert.match(report, /Got as far as: 2\. Saw the ngrok page/);
    assert.match(report, /Went wrong at: 3\. Tapped Visit Site/);
    // Filled in on a computer: the checks describe the computer, and the report says so.
    assert.match(report, /Checked on: Windows PC \(not the iPhone/);
    assert.equal(deviceKind(SAFARI_17), 'iPhone');
    assert.equal(deviceKind(ANDROID), 'Android phone');
});
