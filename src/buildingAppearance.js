// How a building looks outside (Building Studio): its roof, walls, front and entrance, shared by the
// Studio, the 2.5D map and the 3D views. Stored as buildings.appearance (BuildingController validates
// the same lists); null = the plain look every building had before.

export const ROOF_STYLES = [
    { value: 'flat', label: 'Flat' },
    { value: 'hip', label: 'Hip' },
    { value: 'gable', label: 'Gable' },
    { value: 'shed', label: 'Shed' },
    { value: 'curved', label: 'Curved' },
];

/** What the roof is made of: it changes the ribs, rows or plain face it is drawn with. */
export const ROOF_MATERIALS = [
    { value: 'metal', label: 'Metal sheet' },
    { value: 'tile', label: 'Clay tile' },
    { value: 'shingle', label: 'Shingle' },
    { value: 'concrete', label: 'Concrete' },
];

export const FACADES = [
    { value: 'none', label: 'None' },
    { value: 'windows', label: 'Windows' },
    { value: 'arches', label: 'Arches' },
    { value: 'pillars', label: 'Pillars' },
    { value: 'balcony', label: 'Balcony' },
    { value: 'glass', label: 'Glass front' },
    { value: 'louvres', label: 'Wood slats' },
];

/** The shape of the canopy over the doors. */
export const CANOPY_SHAPES = [
    { value: 'slab', label: 'Flat slab' },
    { value: 'curved', label: 'Curved' },
];

/** What the doors themselves are made of. */
export const DOOR_STYLES = [
    { value: 'glass', label: 'Glass doors' },
    { value: 'wood', label: 'Wooden doors' },
    { value: 'sliding', label: 'Sliding glass' },
    { value: 'double_wood', label: 'Double wood' },
    { value: 'arched', label: 'Arched door' },
    { value: 'steel', label: 'Steel security' },
    { value: 'roll_up', label: 'Roll-up shutter' },
];

/** Colours a window frame / door leaf may be given; any colour is allowed too. */
export const FRAME_COLORS = [
    { value: '#2f6fb3', label: 'Blue' },
    { value: '#1f2937', label: 'Charcoal' },
    { value: '#7a2430', label: 'Maroon' },
    { value: '#d6d2c8', label: 'White' },
    { value: '#6b4834', label: 'Brown' },
];

/** Colours seen on campus (WMSU Campus B photos): roofs, walls and the accents on them. */
export const ROOF_COLORS = [
    { value: '#7a2430', label: 'Maroon' },
    { value: '#b3262e', label: 'Red' },
    { value: '#8b4a32', label: 'Rusty' },
    { value: '#6f757c', label: 'Grey' },
    { value: '#2f5f8a', label: 'Blue' },
    { value: '#d6d2c8', label: 'Concrete' },
];
export const WALL_COLORS = [
    { value: '#f1eee7', label: 'White' },
    { value: '#ecdfb8', label: 'Cream' },
    { value: '#dcc58f', label: 'Yellow' },
    { value: '#d8c3a5', label: 'Beige' },
    { value: '#c9c6bf', label: 'Grey' },
    { value: '#e7a483', label: 'Salmon' },
];
export const ACCENT_COLORS = [
    { value: '#7a2430', label: 'Maroon' },
    { value: '#e3957a', label: 'Salmon' },
    { value: '#6b4834', label: 'Brown' },
    { value: '#2f6fb3', label: 'Blue' },
    { value: '#1f2937', label: 'Charcoal' },
];

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** One bay of a building's front (a window or an arch), metres along the wall. */
export const BAY_M = 3.5;
/** Same as Building::SIGN_MAX. */
export const SIGN_MAX = 60;
/** Most individually placed items one building may have (mirrors Building::MAX_ITEMS). */
export const MAX_ITEMS = 80;

export const ITEM_CATEGORIES = [
    { value: 'windows', label: 'Windows' },
    { value: 'pillars', label: 'Pillars & trim' },
    { value: 'doors', label: 'Doors & entry' },
    { value: 'signs', label: 'Signs' },
    { value: 'misc', label: 'Misc' },
];

/**
 * Individually placeable building items (windows, pillars, doors, signs, accessories)
 * modelled after the campus buildings in the reference photos.
 */
export const ITEM_CATALOG = [
    // Windows
    { type: 'window_standard', label: 'Framed window', category: 'windows', placement: 'wall', defaultWidth: 1.6, defaultHeight: 1.5, defaultDepth: 0.16, minWidth: 0.6, maxWidth: 8, minHeight: 0.5, maxHeight: 4, hasAwning: true, defaultColor: '#1f2937', defaultAccent: '#2f6fb3' },
    { type: 'window_tall', label: 'Tall casement', category: 'windows', placement: 'wall', defaultWidth: 1.1, defaultHeight: 2.1, defaultDepth: 0.16, minWidth: 0.6, maxWidth: 4, minHeight: 1.0, maxHeight: 4.5, hasAwning: true, defaultColor: '#1f2937', defaultAccent: '#2f6fb3' },
    { type: 'window_ribbon', label: 'Ribbon window', category: 'windows', placement: 'wall', defaultWidth: 3.8, defaultHeight: 1.1, defaultDepth: 0.16, minWidth: 1.5, maxWidth: 12, minHeight: 0.5, maxHeight: 3, hasAwning: true, defaultColor: '#1f2937', defaultAccent: '#d6d2c8' },
    { type: 'window_grille', label: 'Grille window', category: 'windows', placement: 'wall', defaultWidth: 2.8, defaultHeight: 1.3, defaultDepth: 0.14, minWidth: 0.8, maxWidth: 10, minHeight: 0.6, maxHeight: 3.5, hasAwning: true, defaultColor: '#1f2937', defaultAccent: '#d6d2c8' },
    { type: 'window_diamond', label: 'Diamond grille', category: 'windows', placement: 'wall', defaultWidth: 3.2, defaultHeight: 1.3, defaultDepth: 0.14, minWidth: 1.0, maxWidth: 12, minHeight: 0.6, maxHeight: 3.5, hasAwning: true, defaultColor: '#1f2937', defaultAccent: '#d6d2c8' },
    { type: 'window_jalousie', label: 'Jalousie slats', category: 'windows', placement: 'wall', defaultWidth: 1.8, defaultHeight: 1.4, defaultDepth: 0.16, minWidth: 0.8, maxWidth: 6, minHeight: 0.6, maxHeight: 3.5, hasAwning: true, defaultColor: '#374151', defaultAccent: '#d6d2c8' },
    { type: 'window_clerestory', label: 'Tilted vent', category: 'windows', placement: 'wall', defaultWidth: 2.6, defaultHeight: 0.65, defaultDepth: 0.16, minWidth: 0.8, maxWidth: 8, minHeight: 0.4, maxHeight: 1.6, hasAwning: false, defaultColor: '#31424f', defaultAccent: '#1f2937' },
    { type: 'window_grid', label: 'Grid pane', category: 'windows', placement: 'wall', defaultWidth: 2.0, defaultHeight: 1.2, defaultDepth: 0.14, minWidth: 0.8, maxWidth: 6, minHeight: 0.6, maxHeight: 3, hasAwning: false, defaultColor: '#2b2420', defaultAccent: '#4a321f' },
    { type: 'window_awning', label: 'Louver vent', category: 'windows', placement: 'wall', defaultWidth: 2.2, defaultHeight: 0.7, defaultDepth: 0.14, minWidth: 0.6, maxWidth: 6, minHeight: 0.4, maxHeight: 2, hasAwning: false, defaultColor: '#1f2937', defaultAccent: '#1f2937' },
    { type: 'window_arch', label: 'Arch opening', category: 'windows', placement: 'wall', defaultWidth: 3.2, defaultHeight: 2.4, defaultDepth: 0.25, minWidth: 1.2, maxWidth: 8, minHeight: 1.2, maxHeight: 5, hasAwning: false, defaultColor: '#1f2937', defaultAccent: '#ecdfb8' },
    // Pillars & structure
    { type: 'pillar_square', label: 'Square pillar', category: 'pillars', placement: 'wall', defaultWidth: 0.7, defaultHeight: 3.2, defaultDepth: 0.55, minWidth: 0.3, maxWidth: 2.5, minHeight: 1, maxHeight: 16, defaultColor: '#e3957a', defaultAccent: null },
    { type: 'pillar_round', label: 'Round column', category: 'pillars', placement: 'wall', defaultWidth: 0.6, defaultHeight: 3.2, defaultDepth: 0.6, minWidth: 0.3, maxWidth: 2, minHeight: 1, maxHeight: 16, defaultColor: '#f1eee7', defaultAccent: null },
    { type: 'spandrel_ribbed', label: 'Ribbed band', category: 'pillars', placement: 'wall', defaultWidth: 4.0, defaultHeight: 0.9, defaultDepth: 0.2, minWidth: 1, maxWidth: 20, minHeight: 0.4, maxHeight: 2.5, defaultColor: '#ecdfb8', defaultAccent: '#7a2430' },
    { type: 'louvre_screen', label: 'Wood slats', category: 'pillars', placement: 'wall', defaultWidth: 2.4, defaultHeight: 3.0, defaultDepth: 0.25, minWidth: 0.8, maxWidth: 10, minHeight: 1, maxHeight: 12, defaultColor: '#8b5a2b', defaultAccent: null },
    { type: 'balcony_parapet', label: 'Balcony rail', category: 'pillars', placement: 'wall', defaultWidth: 3.6, defaultHeight: 1.1, defaultDepth: 0.3, minWidth: 1, maxWidth: 16, minHeight: 0.6, maxHeight: 2.2, defaultColor: '#ecdfb8', defaultAccent: '#7a2430' },
    // Doors & entrances
    { type: 'door_glass', label: 'Glass door', category: 'doors', placement: 'wall', defaultWidth: 2.0, defaultHeight: 2.2, defaultDepth: 0.16, minWidth: 0.8, maxWidth: 6, minHeight: 1.8, maxHeight: 3.5, defaultColor: '#22303c', defaultAccent: '#1f2937' },
    { type: 'door_wood', label: 'Wood door', category: 'doors', placement: 'wall', defaultWidth: 1.2, defaultHeight: 2.2, defaultDepth: 0.14, minWidth: 0.7, maxWidth: 4, minHeight: 1.8, maxHeight: 3.2, defaultColor: '#6b4a2f', defaultAccent: '#4a321f' },
    { type: 'door_sliding', label: 'Sliding glass', category: 'doors', placement: 'wall', defaultWidth: 2.6, defaultHeight: 2.2, defaultDepth: 0.16, minWidth: 1.2, maxWidth: 6, minHeight: 1.8, maxHeight: 3.5, defaultColor: '#26404f', defaultAccent: '#c9ccd1' },
    { type: 'door_double_wood', label: 'Double wood', category: 'doors', placement: 'wall', defaultWidth: 2.0, defaultHeight: 2.2, defaultDepth: 0.16, minWidth: 1.2, maxWidth: 5, minHeight: 1.8, maxHeight: 3.5, defaultColor: '#6b4a2f', defaultAccent: '#3d2817' },
    { type: 'door_arched', label: 'Arched door', category: 'doors', placement: 'wall', defaultWidth: 2.0, defaultHeight: 2.5, defaultDepth: 0.18, minWidth: 1.0, maxWidth: 5, minHeight: 2.0, maxHeight: 4.0, defaultColor: '#22303c', defaultAccent: '#ecdfb8' },
    { type: 'door_steel', label: 'Steel door', category: 'doors', placement: 'wall', defaultWidth: 1.2, defaultHeight: 2.2, defaultDepth: 0.16, minWidth: 0.8, maxWidth: 4, minHeight: 1.8, maxHeight: 3.2, defaultColor: '#6f757c', defaultAccent: '#1f2937' },
    { type: 'door_roll_up', label: 'Roll-up shutter', category: 'doors', placement: 'wall', defaultWidth: 3.0, defaultHeight: 2.5, defaultDepth: 0.22, minWidth: 1.4, maxWidth: 8, minHeight: 1.8, maxHeight: 4.5, defaultColor: '#9aa3a8', defaultAccent: '#4b5563' },
    { type: 'canopy_slab', label: 'Slab canopy', category: 'doors', placement: 'wall', defaultWidth: 3.6, defaultHeight: 0.22, defaultDepth: 1.8, minWidth: 1.2, maxWidth: 14, minHeight: 0.12, maxHeight: 0.8, defaultColor: '#7a2430', defaultAccent: '#4a1820' },
    { type: 'canopy_curved', label: 'Curved canopy', category: 'doors', placement: 'wall', defaultWidth: 3.6, defaultHeight: 0.45, defaultDepth: 1.8, minWidth: 1.2, maxWidth: 14, minHeight: 0.2, maxHeight: 1.2, defaultColor: '#7a2430', defaultAccent: '#4a1820' },
    { type: 'steps', label: 'Entrance steps', category: 'doors', placement: 'wall', defaultWidth: 3.2, defaultHeight: 0.45, defaultDepth: 1.2, minWidth: 1.2, maxWidth: 12, minHeight: 0.2, maxHeight: 1.5, defaultColor: '#c9c6bf', defaultAccent: null },
    { type: 'ramp', label: 'Wheelchair ramp', category: 'doors', placement: 'wall', defaultWidth: 4.5, defaultHeight: 0.9, defaultDepth: 1.4, minWidth: 2, maxWidth: 10, minHeight: 0.5, maxHeight: 1.5, defaultColor: '#b9b5ac', defaultAccent: '#c9ccd1' },
    // Signs
    { type: 'sign_board', label: 'Signboard', category: 'signs', placement: 'wall', defaultWidth: 4.5, defaultHeight: 0.8, defaultDepth: 0.16, minWidth: 1.2, maxWidth: 16, minHeight: 0.4, maxHeight: 2.5, hasLabel: true, defaultColor: '#7a2430', defaultAccent: '#ffffff' },
    { type: 'banner', label: 'Wall banner', category: 'signs', placement: 'wall', defaultWidth: 2.6, defaultHeight: 1.0, defaultDepth: 0.08, minWidth: 1, maxWidth: 10, minHeight: 0.5, maxHeight: 3, hasLabel: true, defaultColor: '#2f5f8a', defaultAccent: '#ffffff' },
    // Misc & accessories
    { type: 'ac_unit', label: 'AC unit', category: 'misc', placement: 'wall', defaultWidth: 0.95, defaultHeight: 0.65, defaultDepth: 0.42, minWidth: 0.5, maxWidth: 2.2, minHeight: 0.4, maxHeight: 1.5, defaultColor: '#dadde0', defaultAccent: '#6f757c' },
    { type: 'planter', label: 'Planter box', category: 'misc', placement: 'wall', defaultWidth: 1.8, defaultHeight: 0.75, defaultDepth: 0.65, minWidth: 0.6, maxWidth: 6, minHeight: 0.4, maxHeight: 1.6, defaultColor: '#c9c4b8', defaultAccent: '#4f7a3a' },
    { type: 'bunting', label: 'Bunting flags', category: 'misc', placement: 'wall', defaultWidth: 4.5, defaultHeight: 0.45, defaultDepth: 0.4, minWidth: 1.5, maxWidth: 16, minHeight: 0.25, maxHeight: 1.0, defaultColor: '#b3262e', defaultAccent: '#2f9e5f' },
    { type: 'kiosk', label: 'Info kiosk', category: 'misc', placement: 'wall', defaultWidth: 0.75, defaultHeight: 1.45, defaultDepth: 0.55, minWidth: 0.5, maxWidth: 1.6, minHeight: 1.0, maxHeight: 2.2, defaultColor: '#7a2430', defaultAccent: '#1f2937' },
    { type: 'bench', label: 'Bench', category: 'misc', placement: 'wall', defaultWidth: 1.6, defaultHeight: 0.75, defaultDepth: 0.6, minWidth: 0.9, maxWidth: 3.5, minHeight: 0.45, maxHeight: 1.2, defaultColor: '#6b4834', defaultAccent: '#1f2937' },
    { type: 'lamp', label: 'Wall light', category: 'misc', placement: 'wall', defaultWidth: 0.35, defaultHeight: 0.5, defaultDepth: 0.35, minWidth: 0.2, maxWidth: 1.0, minHeight: 0.25, maxHeight: 1.2, defaultColor: '#1f2937', defaultAccent: '#fff6d6' },
    { type: 'water_tank', label: 'Roof tank', category: 'misc', placement: 'roof', defaultWidth: 1.8, defaultHeight: 1.9, defaultDepth: 1.8, minWidth: 0.8, maxWidth: 5, minHeight: 1.0, maxHeight: 5, defaultColor: '#9aa3a8', defaultAccent: '#6f757c' },
];

export const ITEM_BY_TYPE = Object.fromEntries(ITEM_CATALOG.map((item) => [item.type, item]));
export const ITEM_TYPES = ITEM_CATALOG.map((item) => item.type);

/** What the map draws when a colour is not chosen. */
export const DEFAULT_WALL = '#d8d3c8';
export const DEFAULT_FLAT_ROOF = '#d6d2c8';
export const DEFAULT_SLOPED_ROOF = '#7a2430';
export const DEFAULT_CANOPY = '#7a2430';
export const DEFAULT_DOOR = '#22303c';
export const DEFAULT_BAND = null;

/**
 * A building's look, complete and safe to draw: unknown styles fall back to the defaults, bad colours
 * to null (the map's own colour), the sign is cut to SIGN_MAX. Every section is optional, so a look
 * saved by an older Studio still reads: missing parts take their defaults.
 *
 * @returns {{ roof: {style: string, color: string|null, material: string},
 *   walls: {color: string|null, accent: string|null, band: string|null},
 *   facade: string, windows: {awning: boolean, frame: string|null},
 *   entrance: {canopy: boolean, canopyShape: string, color: string, sign: string, ramp: boolean,
 *              steps: boolean, door: string, doorColor: string|null},
 *   decor: {planters: boolean, ac: boolean, tank: boolean, bunting: boolean} }}
 */
export function normalizeItem(raw, index = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const spec = ITEM_BY_TYPE[raw.type];
    if (!spec) return null;
    const clamp = (v, lo, hi, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    };
    const hex = (v) => (typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : null);
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 32) : `item_${index}`;
    return {
        id,
        type: spec.type,
        edge: Math.max(0, Math.floor(Number(raw.edge) || 0)),
        t: clamp(raw.t, 0, 1, 0.5),
        floor: Math.max(0, Math.min(49, Math.floor(Number(raw.floor) || 0))),
        y_offset: Math.round(clamp(raw.y_offset, -10, 50, 0) * 100) / 100,
        rx: Number.isFinite(Number(raw.rx)) ? Math.round(Number(raw.rx) * 100) / 100 : 0,
        rz: Number.isFinite(Number(raw.rz)) ? Math.round(Number(raw.rz) * 100) / 100 : 0,
        width_m: Math.round(clamp(raw.width_m, spec.minWidth, spec.maxWidth, spec.defaultWidth) * 100) / 100,
        height_m: Math.round(clamp(raw.height_m, spec.minHeight, spec.maxHeight, spec.defaultHeight) * 100) / 100,
        depth_m: Math.round(clamp(raw.depth_m, 0.05, 5, spec.defaultDepth) * 100) / 100,
        color: hex(raw.color),
        accent: hex(raw.accent),
        awning: Boolean(raw.awning),
        label: typeof raw.label === 'string' ? raw.label.slice(0, SIGN_MAX) : '',
    };
}

export function appearanceOf(building) {
    const a = building?.appearance || {};
    const pick = (v, list, fallback) => (list.some((o) => o.value === v) ? v : fallback);
    const hex = (v, fallback = null) => (typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : fallback);
    const flag = (v) => Boolean(v);
    const items = Array.isArray(a.items)
        ? a.items.map((item, i) => normalizeItem(item, i)).filter(Boolean).slice(0, MAX_ITEMS)
        : [];
    return {
        roof: {
            style: pick(a.roof?.style, ROOF_STYLES, 'flat'),
            color: hex(a.roof?.color),
            material: pick(a.roof?.material, ROOF_MATERIALS, 'metal'),
        },
        walls: { color: hex(a.walls?.color), accent: hex(a.walls?.accent), band: hex(a.walls?.band) },
        facade: pick(a.facade, FACADES, 'windows'),
        windows: { awning: flag(a.windows?.awning), frame: hex(a.windows?.frame) },
        entrance: {
            canopy: flag(a.entrance?.canopy),
            canopyShape: pick(a.entrance?.canopyShape, CANOPY_SHAPES, 'slab'),
            color: hex(a.entrance?.color, DEFAULT_CANOPY),
            sign: typeof a.entrance?.sign === 'string' ? a.entrance.sign.slice(0, SIGN_MAX) : '',
            ramp: flag(a.entrance?.ramp),
            steps: flag(a.entrance?.steps),
            door: pick(a.entrance?.door, DOOR_STYLES, 'glass'),
            doorColor: hex(a.entrance?.doorColor),
        },
        decor: {
            planters: flag(a.decor?.planters),
            ac: flag(a.decor?.ac),
            tank: flag(a.decor?.tank),
            bunting: flag(a.decor?.bunting),
        },
        items,
    };
}

/** The colour the roof is drawn in. */
export const roofColorOf = (look) => look.roof.color || (look.roof.style === 'flat' ? DEFAULT_FLAT_ROOF : DEFAULT_SLOPED_ROOF);

/** Ready-made looks, from buildings on campus: one tap in the Studio. */
export const STYLE_PRESETS = [
    {
        name: 'Maroon bands & pillars', hint: 'like CCS',
        appearance: {
            roof: { style: 'curved', color: '#7a2430', material: 'metal' },
            walls: { color: '#f1eee7', accent: '#e3957a', band: '#7a2430' }, facade: 'pillars',
            entrance: { canopy: true, canopyShape: 'slab', color: '#7a2430', sign: '', ramp: true, steps: true, door: 'glass' },
            decor: { bunting: true, planters: true },
        },
    },
    {
        name: 'Arched gallery, rusty roof', hint: 'like CAIS',
        appearance: {
            roof: { style: 'hip', color: '#8b4a32', material: 'metal' },
            walls: { color: '#dcc58f', accent: null, band: '#c8b07f' }, facade: 'arches',
            windows: { awning: false },
            entrance: { canopy: false, color: '#7a2430', sign: '', ramp: true, door: 'glass' },
            decor: { planters: true },
        },
    },
    {
        name: 'Red hip roof, cream walls', hint: 'like the College of Medicine',
        appearance: {
            roof: { style: 'hip', color: '#b3262e', material: 'metal' },
            walls: { color: '#ecdfb8', accent: '#7a2430', band: null }, facade: 'balcony',
            entrance: { canopy: true, canopyShape: 'curved', color: '#7a2430', sign: '', ramp: true, steps: true, door: 'sliding' },
        },
    },
    {
        name: 'White, red roof, blue frames', hint: 'like the new building by CCS',
        appearance: {
            roof: { style: 'gable', color: '#b3262e', material: 'metal' },
            walls: { color: '#f1eee7', accent: null, band: null }, facade: 'windows',
            windows: { awning: true, frame: '#2f6fb3' },
            entrance: { canopy: false, color: '#7a2430', sign: '', ramp: false, steps: true, door: 'glass' },
        },
    },
    {
        name: 'Concrete offices, glass front', hint: 'like the registrar',
        appearance: {
            roof: { style: 'flat', color: '#d6d2c8', material: 'concrete' },
            walls: { color: '#e6e3da', accent: '#6f757c', band: null }, facade: 'glass',
            entrance: { canopy: true, canopyShape: 'slab', color: '#6f757c', sign: '', ramp: true, steps: true, door: 'sliding' },
            decor: { ac: true },
        },
    },
    {
        name: 'Cream arches, shed roof', hint: 'like the high school block',
        appearance: {
            roof: { style: 'shed', color: '#8b4a32', material: 'tile' },
            walls: { color: '#ecdfb8', accent: '#7a2430', band: null }, facade: 'arches',
            windows: { awning: true },
            entrance: { canopy: true, canopyShape: 'slab', color: '#7a2430', sign: '', ramp: false, steps: true, door: 'wood', doorColor: '#6b4834' },
            decor: { tank: true },
        },
    },
];

// ── Roof shapes ─────────────────────────────────────────────────────
// Rings in metres ({x: east, y: north}) at heights above the top of the walls. A sloped roof is the
// outline moved inwards to a ridge; a curved one climbs to it along a quarter circle. Works for any
// outline (L-shapes included): each ring is the outline moved in by the same distance on every side.

const area2 = (ring) => ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return s + p.x * q.y - q.x * p.y;
}, 0);
const perimeter = (ring) => ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return s + Math.hypot(q.x - p.x, q.y - p.y);
}, 0);

function segmentsCross(a, b, c, d) {
    const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = side(c, d, a);
    const d2 = side(c, d, b);
    const d3 = side(a, b, c);
    const d4 = side(a, b, d);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** True when no two non-neighbouring sides of the ring cross. */
export function isSimpleRing(ring) {
    const n = ring.length;
    for (let i = 0; i < n; i += 1) {
        for (let j = i + 2; j < n; j += 1) {
            if (i === 0 && j === n - 1) continue;
            if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return false;
        }
    }
    return true;
}

/**
 * The counter-clockwise ring moved `d` metres inwards on every side (negative: outwards), the corners
 * where the moved sides meet. Null when it turned inside out or crossed itself (moved too far).
 */
export function offsetRing(ring, d) {
    const n = ring.length;
    const lines = [];
    for (let i = 0; i < n; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-6) return null;
        const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
        // Inwards of a counter-clockwise ring is the left of each side.
        lines.push({ p: { x: a.x - dir.y * d, y: a.y + dir.x * d }, dir });
    }
    const out = [];
    for (let i = 0; i < n; i += 1) {
        const L1 = lines[(i - 1 + n) % n];
        const L2 = lines[i];
        const cross = L1.dir.x * L2.dir.y - L1.dir.y * L2.dir.x;
        if (Math.abs(cross) < 1e-9) { out.push(L2.p); continue; }
        const t = ((L2.p.x - L1.p.x) * L2.dir.y - (L2.p.y - L1.p.y) * L2.dir.x) / cross;
        out.push({ x: L1.p.x + L1.dir.x * t, y: L1.p.y + L1.dir.y * t });
    }
    const before = area2(ring);
    const after = area2(out);
    if (!(after > 0) || (d > 0 ? after >= before : after <= before) || !isSimpleRing(out)) return null;
    // Moved past its middle, a side flips round (a square turned through itself still looks valid otherwise).
    for (let i = 0; i < n; i += 1) {
        const p = out[i];
        const q = out[(i + 1) % n];
        if ((q.x - p.x) * lines[i].dir.x + (q.y - p.y) * lines[i].dir.y < -1e-9) return null;
    }
    return out;
}

/** How far the outline can move in before it collapses (to within ~2 %). */
function maxInset(ring) {
    let lo = 0;
    let hi = (2.2 * Math.abs(area2(ring)) / 2) / Math.max(1e-6, perimeter(ring));
    for (let k = 0; k < 14; k += 1) {
        const mid = (lo + hi) / 2;
        if (offsetRing(ring, mid)) lo = mid; else hi = mid;
    }
    return lo;
}

/** Direction of the outline's longest side: a gable's ridge and a shed's high edge run along it. */
function longAxis(ring) {
    let best = 0;
    let c = 1;
    let s = 0;
    for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len > best) {
            best = len;
            const angle = Math.atan2(b.y - a.y, b.x - a.x);
            c = Math.cos(angle);
            s = Math.sin(angle);
        }
    }
    return { c, s };
}

/** Half the outline's breadth across `axis` (metres). */
function halfBreadth(ring, { c, s }) {
    const v = ring.map((p) => -p.x * s + p.y * c);
    return (Math.max(...v) - Math.min(...v)) / 2;
}

/**
 * The outline pulled across `axis` into a thin ridge: down the middle for a gable (two slopes meeting at
 * the ridge), against its low edge for a shed (one slope rising from the far eave to it). Same corner
 * count and order as the outline, so the roof faces join up exactly as the ring-based roofs do.
 */
function ridgeRing(ring, { c, s }, toMiddle, keep = 0.04) {
    const uv = ring.map((p) => ({ u: p.x * c + p.y * s, v: -p.x * s + p.y * c }));
    const vs = uv.map((q) => q.v);
    const base = toMiddle ? (Math.min(...vs) + Math.max(...vs)) / 2 : Math.min(...vs);
    return uv.map((q) => {
        const v = base + (q.v - base) * keep;
        return { x: q.u * c - v * s, y: q.u * s + v * c };
    });
}

const EAVE_M = 0.5;
const HIP_SLOPE = 0.5;
const CURVE_RISE = 0.7;
const MAX_RISE_M = 6;

/**
 * The roof of an outline (metres, either winding) in `style`: rings from the eave up to the top, each
 * with its height `h` above the top of the walls. The eave reaches EAVE_M past the walls on a sloped
 * or curved roof. Faces join ring k to ring k+1 side by side (same corner order); the last ring is the
 * flat top. A flat roof (or an outline too odd to slope) is the outline itself.
 *
 * @returns {{ rings: Array<{ pts: Array<{x:number,y:number}>, h: number }>, rise: number }}
 */
export function roofLayers(outline, style = 'flat') {
    const ring = area2(outline) < 0 ? [...outline].reverse() : outline;
    const flat = { rings: [{ pts: ring, h: 0 }], rise: 0 };
    if (style === 'flat' || ring.length < 3) return flat;
    const depth = maxInset(ring) * 0.94;
    if (!(depth > 0.5)) return flat;
    const eave = offsetRing(ring, -EAVE_M) || ring;
    if (style === 'gable' || style === 'shed') {
        const axis = longAxis(ring);
        const breadth = halfBreadth(ring, axis);
        const across = style === 'gable' ? breadth : breadth * 2;
        if (!(across > 0.6)) return flat;
        return {
            rings: [{ pts: eave, h: -0.15 }, { pts: ridgeRing(ring, axis, style === 'gable'), h: Math.min(MAX_RISE_M, across * HIP_SLOPE) }],
            rise: Math.min(MAX_RISE_M, across * HIP_SLOPE),
        };
    }
    if (style === 'curved') {
        const rise = Math.min(MAX_RISE_M, depth * CURVE_RISE);
        const rings = [{ pts: eave, h: -0.15 }];
        for (const t of [0.2, 0.45, 0.7, 1]) {
            const pts = offsetRing(ring, depth * t);
            if (!pts) break;
            // A quarter circle: steep at the eave, level at the top.
            rings.push({ pts, h: rise * Math.sqrt(1 - (1 - t) ** 2) });
        }
        return rings.length > 1 ? { rings, rise } : flat;
    }
    const top = offsetRing(ring, depth);
    if (!top) return flat;
    const rise = Math.min(MAX_RISE_M, depth * HIP_SLOPE);
    return { rings: [{ pts: eave, h: -0.15 }, { pts: top, h: rise }], rise };
}
