// Stall detection for the GPS stream.
//
// The Geolocation API gives no guarantee that watchPosition keeps delivering:
// browsers silently stop it after a timeout error, when the tab is
// backgrounded, or after a network/permission hiccup. Pure decision function
// (no timers, no DOM) so it can be unit-tested; MobileNav runs it once a
// second and acts on the answer.
//
//   'poll'    → no fix for a few seconds: ask for ONE fresh position now
//               (keeps the dot moving even if the watch is dead)
//   'restart' → no fix for longer: tear the watch down and create a new one
//   'none'    → healthy, or nothing sensible to do yet
export const GPS_POLL_AFTER_MS = 3000;
export const GPS_RESTART_AFTER_MS = 7000;

// Shared watch options. maximumAge 0 = never accept a cached position
// (the old 5000 let the browser re-serve fixes up to 5 s old).
export const GPS_WATCH_OPTS = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 };
export const GPS_POLL_OPTS = { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 };

/**
 * @param {Object} s
 * @param {number} s.now           ms clock
 * @param {number} s.lastFixAt     ms time of the last fix (or watch start if none yet)
 * @param {number} s.lastPollAt    ms time we last asked for a one-shot
 * @param {number} s.lastRestartAt ms time we last restarted the watch
 * @param {boolean} s.hasFix       false before the very first fix: the cold-start
 *   path has its own retry logic, and restarting a cold receiver can only slow it
 * @returns {'none'|'poll'|'restart'}
 */
export function stallAction({ now, lastFixAt, lastPollAt, lastRestartAt, hasFix }) {
    if (!hasFix) return 'none';
    const since = now - lastFixAt;
    if (since >= GPS_RESTART_AFTER_MS && now - lastRestartAt >= GPS_RESTART_AFTER_MS) return 'restart';
    if (since >= GPS_POLL_AFTER_MS && now - lastPollAt >= GPS_POLL_AFTER_MS) return 'poll';

    return 'none';
}
