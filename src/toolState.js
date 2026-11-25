// One map tool at a time.
//
// The admin map used to keep four independent booleans (add node, move
// node, drop pin, draw wall) and every "start tool" handler had to remember
// to switch the other three off. Forget one and two tools armed the same tap.
// Here there is a single `tool` value, so two tools being active at once is
// not a state that can exist.

export const IDLE = 'idle';
export const TOOL_ADD = 'add';
export const TOOL_MOVE = 'move';
export const TOOL_PIN = 'pin';
export const TOOL_WALLS = 'walls';
// Campus features: label/outline a building, draw a road or walkway.
export const TOOL_BUILDING = 'building';
export const TOOL_PATHWAY = 'pathway';
// Bridges and other connectors: drawn like a building outline.
export const TOOL_BRIDGE = 'bridge';
// Campus areas: outline and name a campus (Campus A, Campus B, ...).
export const TOOL_AREA = 'area';
// Manage campus areas: the outlines are shown (and only here), tap one to edit it.
export const TOOL_AREAS = 'areas';
// Trees, benches, sheds and gates: pick one and tap the map to place it; tap a placed one to change it.
export const TOOL_OBJECTS = 'objects';

/** Turn tool `name` on or off. Turning one on replaces whatever was active;
 *  turning one off only matters if it is the active one. */
export function resolveTool(current, name, on) {
    if (on) return name;
    return current === name ? IDLE : current;
}

/** Legacy two-value mode: 'addNode' starts the add tool, anything else ends it. */
export function resolveMode(current, mode) {
    if (mode === 'addNode') return TOOL_ADD;
    return current === TOOL_ADD ? IDLE : current;
}

/** Which single surface the bottom stack shows for the current state. */
export function surfaceFor({ tool, hasPending, hasEditing, hasManaging = false }) {
    if (tool === TOOL_WALLS) return 'walls';
    if (tool === TOOL_BUILDING || tool === TOOL_PATHWAY || tool === TOOL_BRIDGE) return 'campus';
    if (tool === TOOL_AREA) return 'area';
    if (tool === TOOL_AREAS) return 'areas';
    if (tool === TOOL_OBJECTS) return 'objects';
    if (tool === TOOL_PIN) return 'pin';
    if (tool === TOOL_MOVE) return 'move';
    if (tool === TOOL_ADD) return hasPending ? 'add-form' : 'add-place';
    if (hasEditing) return 'edit-form';
    // Manage nodes (a building's nodes, floor by floor) sits under the
    // tools it opens: adding or editing a node returns to it.
    return hasManaging ? 'manage' : 'dock';
}
