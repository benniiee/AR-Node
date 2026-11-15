// ── Walking a route: which stop is next, and has the walker arrived ──
// A stop is passed when the walker is within REACH_M of it ON ITS FLOOR.
// Floors matter because a floor-2 room sits a few metres above the ground
// floor: standing under it is not being there, the stairs come first.
import { floorOf } from './floors.js';

/** Within this distance (metres, on the ground) a stop counts as reached. */
export const REACH_M = 8;

/**
 * Advance through `path` from stop `idx` for a walker at `user` on floor
 * `floor` (null = unknown floor: distance only). `distM(user, stop)` gives
 * the ground distance in metres.
 * @returns {{ idx: number, arrived: boolean }} the stop to head for next, and
 *   whether the destination (last stop) has been reached.
 */
export function advanceAlongRoute(path, idx, user, floor, distM) {
    if (!Array.isArray(path) || path.length < 2) return { idx: 1, arrived: false };
    const sameFloor = (p) => floor === null || floor === undefined || floorOf(p) === floor;
    let i = Math.min(Math.max(1, idx || 1), path.length - 1);
    const lastIdx = path.length - 1;
    const arrived = i === lastIdx && sameFloor(path[i]) && distM(user, path[i]) <= REACH_M;
    while (i < lastIdx) {
        if (distM(user, path[i]) > REACH_M || !sameFloor(path[i])) break;
        i += 1;
    }
    return { idx: i, arrived };
}
