// ── iPhone install check (/iphone-check) ────────────────────────────
// A short form for someone whose iPhone will not install or open ARNode. They
// tick how far they got and what went wrong; the page also checks what this
// phone supports (offline copy, home-screen mode, 3D), then builds a plain-text
// report they copy and send back in chat. Nothing is sent anywhere by itself.
//
// This file is the pure part (texts, detection from the user agent, the report)
// so it can be tested; src/iphoneCheckPage.js wires it to the page.

export const BROWSERS = ['Safari', 'Chrome', 'Brave', 'Other'];

/** The install path on an iPhone, in order: [step, hint]. */
export const STEPS = [
    ['Opened the ARNode link', ''],
    ['Saw the ngrok page', '"You are about to visit ... This website is served for free through ngrok.com"'],
    ['Tapped Visit Site and the ARNode sign-in screen appeared', ''],
    ['Signed in and saw the campus map', ''],
    ['Found Add to Home Screen', 'Share button at the bottom of Safari (square with an arrow), then Add to Home Screen'],
    ['The ARNode icon appeared on the home screen', ''],
    ['Opened ARNode from the home screen icon', ''],
    ['Signed in again inside the home-screen app and saw the map', "The home-screen app does not share Safari's sign-in"],
    ['Turned mobile data off and the app still opened', 'Open it once with data on first'],
];

export const PROBLEMS = [
    'Blank white or black screen',
    'Stuck on the ngrok "You are about to visit" page',
    'Tapping Visit Site did nothing',
    'No Add to Home Screen in the Share menu',
    'The home-screen icon opens a blank page',
    'Sign-in failed or showed an error',
    'Works with data on, not with data off',
    "3D or AR view doesn't work",
    'Something else',
];

/** iOS version from the user agent ("17.4", "16.6.1"), or '' when this is not an iPhone/iPad. */
export function detectIos(ua = '') {
    const m = /(?:iPhone|iPad|CPU) OS (\d+)_(\d+)(?:_(\d+))?/.exec(ua);
    return m ? [m[1], m[2], m[3]].filter(Boolean).join('.') : '';
}

/**
 * The browser as far as the user agent tells. Brave on iPhone reports itself
 * exactly like Safari, so it can only be told apart by asking.
 */
export function detectBrowser(ua = '') {
    if (/CriOS/.test(ua)) return 'Chrome';
    if (/FxiOS|EdgiOS/.test(ua)) return 'Other';
    return detectIos(ua) ? 'Safari' : '';
}

/** How many steps worked in a row from step 1 (the first gap is where it stopped). */
export function stepsInARow(done = []) {
    const set = new Set(done.map(Number));
    let n = 0;
    while (set.has(n + 1)) n += 1;
    return n;
}

/**
 * What kind of device opened this page, from the user agent. The checks only
 * describe the iPhone when the page is open on the iPhone (a report filled in
 * on a computer checked the computer). iPadOS can report itself as a Mac.
 */
export function deviceKind(ua = '') {
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android phone';
    if (/Windows/.test(ua)) return 'Windows PC';
    if (/Macintosh/.test(ua)) return 'Mac (or an iPad asking for desktop sites)';
    return 'other device';
}

/**
 * The report to send back.
 * @param {{ name?: string, ios?: string, model?: string, browser?: string, steps?: number[], problem?: string, said?: string }} answers
 * @param {{ label: string, value: string }[]} checks what this phone supports (from the page)
 * @param {string} ua the user agent
 */
export function buildReport(answers, checks = [], ua = '') {
    const a = answers || {};
    const done = [...new Set((a.steps || []).map(Number))].filter((n) => n >= 1 && n <= STEPS.length).sort((x, y) => x - y);
    // The furthest step that worked is how far they got; the next one is where it went wrong.
    const furthest = done.length ? done[done.length - 1] : 0;
    const detected = detectIos(ua);
    const kind = deviceKind(ua);
    const onIos = kind === 'iPhone' || kind === 'iPad';
    const lines = [
        'ARNode iPhone check',
        `Name: ${a.name || '-'}`,
        `iPhone: ${a.model || '-'}, iOS ${a.ios || '?'}${detected && detected !== a.ios ? ` (phone reports ${detected})` : ''}`,
        `Browser: ${a.browser || '-'}`,
        `Got as far as: ${furthest ? `${furthest}. ${STEPS[furthest - 1][0]}` : 'not step 1 (the link did not open)'}`,
        `Went wrong at: ${furthest < STEPS.length ? `${furthest + 1}. ${STEPS[furthest][0]}` : 'nothing, all steps worked'}`,
        `Steps ticked: ${done.length ? done.join(', ') : 'none'} (of ${STEPS.length})`,
        `Problem: ${a.problem || '-'}`,
        `Screen showed: ${a.said || '-'}`,
    ];
    if (checks.length) {
        lines.push(`Checked on: ${kind}${onIos ? '' : ' (not the iPhone: open this page on the iPhone to check it)'}`);
        for (const c of checks) lines.push(`  ${c.label}: ${c.value}`);
    }
    lines.push(`Device: ${ua || '-'}`);
    return lines.join('\n');
}
