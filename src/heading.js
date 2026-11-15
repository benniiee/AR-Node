// Compass heading helpers, shared by BOTH screens so the 2D POV cone and the
// 3D camera can never disagree about which way the phone is facing.
// Convention: 0° = north, increasing clockwise. Values come back in [0, 360);
// consumers normalise to whatever range they display.

/**
 * Tilt-compensated compass heading from raw deviceorientation angles.
 *
 * Plain `alpha` is only the heading while the phone lies flat — tip it and
 * the reading swings with the tilt. Correcting with beta/gamma keeps the
 * cone (and the 3D camera) pointed where the back of the phone actually
 * points, which is the whole point of a POV indicator.
 *
 * @param {number} alphaDeg rotation around the screen normal (0–360)
 * @param {number} betaDeg pitch — 0 flat on its back, 90 held upright
 * @param {number} gammaDeg roll
 * @returns {number} heading in [0, 360), 0 = north
 */
export function computeTiltCompensatedHeading(alphaDeg, betaDeg, gammaDeg) {
    const aRad = (alphaDeg * Math.PI) / 180;
    const bRad = (betaDeg * Math.PI) / 180;
    const gRad = (gammaDeg * Math.PI) / 180;
    const cA = Math.cos(aRad);
    const sA = Math.sin(aRad);
    const cB = Math.cos(bRad);
    const sB = Math.sin(bRad);
    const cG = Math.cos(gRad);
    const sG = Math.sin(gRad);
    const rA = -cA * sG - sA * sB * cG;
    const rB = -sA * sG + cA * sB * cG;
    let heading = Math.atan2(rA, rB);
    if (heading < 0) heading += 2 * Math.PI;
    return (heading * 180) / Math.PI;
}

/**
 * Heading from a `deviceorientation` / `deviceorientationabsolute` event.
 *
 * iOS ships `webkitCompassHeading` — already tilt-compensated and absolute —
 * and leaves alpha/beta/gamma null, so it takes priority. Falls back to the
 * tilt-compensated path, then to alpha alone (some browsers report nothing
 * else), and returns null when the event carries no usable data at all.
 *
 * @param {DeviceOrientationEvent} e
 * @returns {number|null} heading in [0, 360), or null if unavailable
 */
export function headingFromOrientationEvent(e) {
    if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
        return e.webkitCompassHeading;
    }
    if (e.alpha !== null && e.alpha !== undefined
        && e.beta !== null && e.beta !== undefined
        && e.gamma !== null && e.gamma !== undefined) {
        return computeTiltCompensatedHeading(e.alpha, e.beta, e.gamma);
    }
    if (e.alpha !== null && e.alpha !== undefined) {
        return (360 - e.alpha) % 360;
    }
    return null;
}

/**
 * 8-point compass label for a heading, so a readout says "234° SW" instead
 * of asking the reader to convert degrees in their head.
 *
 * @param {number} deg heading in degrees (either sign, any number of turns)
 * @returns {string} one of N, NE, E, SE, S, SW, W, NW
 */
export function compassLabel(deg) {
    const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const turns = (((deg % 360) + 360) % 360) / 45;
    return points[Math.round(turns) % 8];
}

// ── Compass confidence ───────────────────────────────────────────────

/**
 * Reported compass accuracy in degrees (± error), or null when the platform
 * doesn't say.
 *
 * Only iOS Safari exposes this, as `webkitCompassAccuracy` (some write-ups
 * call it `webkitCompassHeadingAccuracy`; both names are checked). A
 * NEGATIVE value means the compass is uncalibrated / invalid. Chrome on
 * Android reports no accuracy at all, so null there means "unknown", not
 * "good" — callers must not treat it as a pass.
 *
 * @param {DeviceOrientationEvent} e
 * @returns {number|null}
 */
export function headingAccuracyFromEvent(e) {
    const v = e.webkitCompassAccuracy ?? e.webkitCompassHeadingAccuracy;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export const COMPASS_GOOD_MAX_DEG = 15;
export const COMPASS_FAIR_MAX_DEG = 30;

/**
 * @param {number|null|undefined} accDeg from headingAccuracyFromEvent
 * @returns {'unknown'|'uncalibrated'|'good'|'fair'|'poor'}
 */
export function compassQuality(accDeg) {
    if (accDeg === null || accDeg === undefined || !Number.isFinite(accDeg)) return 'unknown';
    if (accDeg < 0) return 'uncalibrated';
    if (accDeg <= COMPASS_GOOD_MAX_DEG) return 'good';
    if (accDeg <= COMPASS_FAIR_MAX_DEG) return 'fair';

    return 'poor';
}

/**
 * User-facing warning for a quality bucket, or null when no warning is due.
 * Only 'poor' and 'uncalibrated' warn. 'fair' (16–30°) is common on healthy
 * iPhones and would nag constantly; 'unknown' (Android) means we can't tell.
 */
export function compassWarningText(quality, accDeg) {
    if (quality === 'uncalibrated') return 'Compass needs calibrating. Wave your phone in a figure 8, away from metal.';
    if (quality === 'poor') return `Compass unreliable (±${Math.round(accDeg)}°). Step away from metal or electronics and wave your phone in a figure 8.`;

    return null;
}

/**
 * Debounced compass-warning state for the UI. Raw accuracy flickers around
 * thresholds at ~60 Hz, so a banner driven directly by it would blink.
 * This only changes after the new state has persisted for `holdMs`, and a
 * 'poor' reading only clears once accuracy is back under CLEAR_BELOW_DEG.
 *
 *   const w = createCompassWatcher();
 *   const r = w.update(headingAccuracyFromEvent(e));
 *   if (r.changed) setWarning(r.warning);   // string | null
 */
const POOR_CLEAR_BELOW_DEG = 25;

export function createCompassWatcher({ holdMs = 1500, now = () => performance.now() } = {}) {
    let shown = 'ok';          // 'ok' | 'poor' | 'uncalibrated'
    let pending = null;
    let pendingSince = 0;

    const candidateFor = (acc) => {
        const q = compassQuality(acc);
        if (q === 'uncalibrated') return 'uncalibrated';
        if (q === 'poor') return 'poor';
        if (shown === 'poor' && acc !== null && acc > POOR_CLEAR_BELOW_DEG) return 'poor';

        return 'ok';
    };

    return {
        update(accDeg) {
            const cand = candidateFor(accDeg);
            if (cand === shown) {
                pending = null;

                return { changed: false, state: shown, warning: undefined };
            }
            const t = now();
            if (pending !== cand) {
                pending = cand;
                pendingSince = t;

                return { changed: false, state: shown, warning: undefined };
            }
            if (t - pendingSince < holdMs) return { changed: false, state: shown, warning: undefined };
            shown = cand;
            pending = null;

            return { changed: true, state: shown, warning: compassWarningText(shown === 'ok' ? 'good' : shown, accDeg) };
        },
    };
}
