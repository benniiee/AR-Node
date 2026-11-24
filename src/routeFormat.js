// Human-friendly route numbers, shared by the 2D and 3D screens so both
// always say the same thing. Raw backend values like "185.1 m" read as noise
// to a walker: whole metres are enough, long routes read better in km, and
// "how long will this take" is the number people actually plan around.

/** Typical campus walking pace, metres per minute (~4.7 km/h). */
export const WALK_M_PER_MIN = 78;

/** 185.1 -> "185 m", 1240 -> "1.2 km". Non-numbers give an em dash. */
export function formatDistance(meters) {
    const m = Number(meters);
    if (!Number.isFinite(m) || m < 0) return '-';
    if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m)} m`;
}

/** Whole minutes to walk `meters`, rounded up; null when unknown. */
export function walkMinutes(meters) {
    const m = Number(meters);
    if (!Number.isFinite(m) || m < 0) return null;
    return Math.max(1, Math.ceil(m / WALK_M_PER_MIN));
}

/** "~3 min walk", or "Under a minute" for very short routes. */
export function formatWalkTime(meters) {
    const m = Number(meters);
    if (!Number.isFinite(m) || m < 0) return '';
    if (m < WALK_M_PER_MIN * 0.5) return 'Under a minute';
    return `~${walkMinutes(m)} min walk`;
}

/** Within this angle (degrees) of straight ahead, the stop counts as ahead: small wobbles while walking say nothing new. */
export const STRAIGHT_DEG = 30;
/** Beyond this angle the stop is behind you. */
export const BEHIND_DEG = 150;

/**
 * The 3D view's guidance for the next stop, shown on the direction card and spoken as it is: a few
 * everyday words ("Go straight", "Turn left", "Turn around"), no jargon such as "bear". The card's
 * arrow turns to the exact angle, so a slight turn still looks slight.
 *
 * @param {{ relDeg: number|null, distM: number, isLast: boolean, destName?: string, arrived?: boolean }} g
 *   relDeg: signed angle from where the phone faces to the stop (+ = right),
 *   null while there is no compass heading yet.
 * @returns {{ main: string, sub: string }}
 */
export function guidanceFor({ relDeg, distM, isLast, destName = '', arrived = false }) {
    const place = destName || 'your destination';
    if (arrived) return { main: "You've arrived", sub: place };
    const d = formatDistance(distM);
    const sub = isLast ? `${place} in ${d}` : `Next stop in ${d}`;
    if (relDeg === null || !Number.isFinite(relDeg)) return { main: 'Follow the route', sub };
    const abs = Math.abs(relDeg);
    let main;
    if (abs < STRAIGHT_DEG) main = 'Go straight';
    else if (abs > BEHIND_DEG) main = 'Turn around';
    else main = relDeg > 0 ? 'Turn right' : 'Turn left';
    return { main, sub };
}
