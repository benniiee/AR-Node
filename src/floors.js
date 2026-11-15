// Floor helpers shared by the 2D map and the 3D AR view.
//
// `floor_level` already exists on every node (0 = ground, positive = upper
// floors, negative = basements) and is returned by /api/map-data. Students
// pick the floor they are on; both views then show only that floor's nodes.
// Keep the parsing in one place so a missing/invalid value is always ground
// instead of `undefined` slipping into a comparison and hiding a node.

/** Numeric floor for a node (missing/invalid → ground floor 0). */
export function floorOf(node) {
    const value = Number(node?.floor_level);
    return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** Sorted unique floors present in a node list (basements first). */
export function collectFloors(nodes) {
    if (!Array.isArray(nodes)) return [];
    const set = new Set();
    for (const node of nodes) set.add(floorOf(node));
    return [...set].sort((a, b) => a - b);
}

// Labels count the ground floor as the 1st floor (the local convention):
// floor_level 0 = G (Ground floor), 1 = 2 (Floor 2), 2 = 3 ... Only the LABELS
// shift; stored floor_level values stay 0-based everywhere (API, routing).

/** Number people say for a level: ground = 1, the next one up = 2. */
export function floorNumber(floor) {
    return floor >= 0 ? floor + 1 : floor;
}

/** Compact chip label: G for ground, B1 for basements, 2/3/… for upper floors. */
export function floorTag(floor) {
    if (floor === 0) return 'G';
    if (floor < 0) return `B${Math.abs(floor)}`;
    return String(floorNumber(floor));
}

/** Spoken/accessible label for a floor chip. */
export function floorAria(floor) {
    if (floor === 0) return 'Ground floor';
    if (floor < 0) return `Basement ${Math.abs(floor)}`;
    return `Floor ${floorNumber(floor)}`;
}
