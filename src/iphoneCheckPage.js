// Wires the iPhone install check (iphone-check.html) to src/iphoneCheck.js:
// builds the options, keeps the answers on this phone (localStorage), checks
// what the phone supports and copies the report. Plain DOM: the page has to
// open even where the React app does not.
import { BROWSERS, STEPS, PROBLEMS, detectIos, detectBrowser, buildReport, deviceKind } from './iphoneCheck.js';

const KEY = 'arnode-iphone-check';
const $ = (id) => document.getElementById(id);
const ua = navigator.userAgent || '';
const detectedIos = detectIos(ua);
const detectedBrowser = detectBrowser(ua);
let checks = [];

function option(type, name, value, body) {
    const label = document.createElement('label');
    label.className = 'opt';
    const input = document.createElement('input');
    input.type = type;
    input.name = name;
    input.value = value;
    input.id = `${name}-${value.replace(/\W+/g, '-').toLowerCase()}`;
    const span = document.createElement('span');
    const box = document.createElement('i');
    box.className = 'box';
    box.setAttribute('aria-hidden', 'true');
    span.append(box, body);
    label.append(input, span);
    return label;
}

function plain(text) {
    const s = document.createElement('span');
    s.textContent = text;
    return s;
}

function buildOptions() {
    BROWSERS.forEach((b) => $('browser').append(option('radio', 'browser', b, plain(b))));
    STEPS.forEach(([title, note], i) => {
        const row = document.createElement('span');
        row.className = 'step';
        const n = document.createElement('span');
        n.className = 'step-n';
        n.textContent = String(i + 1);
        const text = document.createElement('span');
        text.className = 'step-t';
        text.append(plain(title));
        if (note) {
            const small = document.createElement('small');
            small.textContent = note;
            text.append(small);
        }
        row.append(n, text);
        $('steps').append(option('checkbox', 'step', String(i + 1), row));
    });
    PROBLEMS.forEach((p) => $('problem').append(option('radio', 'problem', p, plain(p))));
}

const answers = () => ({
    name: $('name').value.trim(),
    ios: $('ios').value.trim(),
    model: $('model').value.trim(),
    browser: document.querySelector('input[name="browser"]:checked')?.value || '',
    steps: [...document.querySelectorAll('input[name="step"]:checked')].map((e) => Number(e.value)),
    problem: document.querySelector('input[name="problem"]:checked')?.value || '',
    said: $('said').value.trim(),
});

function fill(a) {
    $('name').value = a.name || '';
    $('ios').value = a.ios || '';
    $('model').value = a.model || '';
    document.querySelectorAll('input[name="browser"]').forEach((e) => { e.checked = e.value === a.browser; });
    document.querySelectorAll('input[name="step"]').forEach((e) => { e.checked = (a.steps || []).includes(Number(e.value)); });
    document.querySelectorAll('input[name="problem"]').forEach((e) => { e.checked = e.value === a.problem; });
    $('said').value = a.said || '';
}

function render() {
    const a = answers();
    $('report').textContent = buildReport(a, checks, ua);
    try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* storage blocked: the form still works */ }
    $('status').textContent = '';
    $('status').className = 'status';
}

/** What this phone supports, read without asking for any permission. */
async function checkPhone() {
    const list = [];
    const add = (label, value, good) => list.push({ label, value, good });
    add('Secure connection (HTTPS)', window.isSecureContext ? 'yes' : 'no', window.isSecureContext);
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
    add('Opened from the home screen', standalone ? 'yes' : 'no (browser tab)', null);
    add('Internet right now', navigator.onLine ? 'yes' : 'no', null);
    const sw = 'serviceWorker' in navigator;
    add('Offline saving supported', sw ? 'yes' : 'no', sw);
    let saved = 'no';
    try {
        const reg = sw ? await navigator.serviceWorker.getRegistration('/map') : null;
        const names = window.caches ? await caches.keys() : [];
        const shell = names.some((n) => n.startsWith('arnode-shell-'));
        saved = reg?.active && shell ? 'yes' : reg ? 'saving or incomplete' : 'no';
    } catch {
        saved = 'could not check';
    }
    add('ARNode saved for offline', saved, saved === 'yes');
    try {
        const est = await navigator.storage?.estimate?.();
        if (est?.quota) add('Storage for this site', `${(est.usage / 1048576).toFixed(1)} MB used of ${Math.round(est.quota / 1048576)} MB`, null);
    } catch { /* not offered */ }
    let signedIn = 'no';
    try { signedIn = localStorage.getItem('student_token') ? 'yes' : 'no'; } catch { signedIn = 'storage blocked'; }
    add('Signed in here', signedIn, null);
    let webgl2 = false;
    try { webgl2 = Boolean(document.createElement('canvas').getContext('webgl2')); } catch { webgl2 = false; }
    add('3D support (WebGL 2)', webgl2 ? 'yes' : 'no', webgl2);
    const camera = Boolean(navigator.mediaDevices?.getUserMedia);
    add('Camera for AR', camera ? 'available' : 'not available', camera);
    const asksMotion = typeof window.DeviceOrientationEvent?.requestPermission === 'function';
    add('Compass permission', asksMotion ? 'asked when AR starts' : 'not needed', null);
    return list;
}

function showChecks(list) {
    // Filled in on a computer, these checks describe the computer, not the iPhone.
    const kind = deviceKind(ua);
    const note = $('device-note');
    if (kind !== 'iPhone' && kind !== 'iPad') {
        note.textContent = `This page is open on a ${kind}, so these checks describe it, not the iPhone. Open this page on the iPhone, in the browser you used for ARNode.`;
        note.hidden = false;
    }
    const ul = $('checks');
    ul.textContent = '';
    for (const c of list) {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = c.label;
        const value = document.createElement('span');
        value.className = `chip${c.good === true ? ' is-ok' : c.good === false ? ' is-bad' : ''}`;
        value.textContent = c.value;
        li.append(label, value);
        ul.append(li);
    }
}

async function copyReport() {
    const text = $('report').textContent;
    try {
        await navigator.clipboard.writeText(text);
        $('status').textContent = 'Copied. Paste it into the chat.';
        $('status').className = 'status ok';
    } catch {
        // No clipboard access: select the report so it can be copied by hand.
        const range = document.createRange();
        range.selectNodeContents($('report'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        $('status').textContent = 'Selected. Tap Copy on the menu.';
    }
}

buildOptions();
let saved = null;
try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
fill(saved || { ios: detectedIos, browser: detectedBrowser, steps: [] });
render();
document.addEventListener('input', render);
document.addEventListener('change', render);
$('copy').addEventListener('click', copyReport);
$('reset').addEventListener('click', () => { fill({ ios: detectedIos, browser: detectedBrowser, steps: [] }); render(); });
checkPhone().then((list) => {
    checks = list.map(({ label, value }) => ({ label, value }));
    showChecks(list);
    render();
});
